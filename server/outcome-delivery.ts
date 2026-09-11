import { createHmac, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Campaign, CallSession, OutcomeDelivery } from "../src/lib/domain.js";
import { HttpError } from "./http-error.js";
import { logger as defaultLogger } from "./logger.js";
import { outcomeForCall } from "./outcomes.js";

export type { OutcomeDelivery } from "../src/lib/domain.js";
export type OutcomeWebhookConfig = { secret: string; allowedHosts: string[] };
export interface OutcomeStore {
  listCalls(): CallSession[];
  getCampaign(id: string): Campaign | undefined;
  listOutcomeDeliveries(campaignId?: string): OutcomeDelivery[];
  saveOutcomeDelivery(delivery: OutcomeDelivery): OutcomeDelivery;
  flush(): Promise<void>;
}
export function outcomeWebhookConfig(environment: Record<string, string | undefined>): OutcomeWebhookConfig {
  const secret = environment.MKTR_OUTCOME_WEBHOOK_SECRET ?? "";
  const allowedHosts = [...new Set((environment.MKTR_OUTCOME_WEBHOOK_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean))];
  if (!secret && allowedHosts.length === 0) return { secret, allowedHosts };
  if (secret.length < 32 || allowedHosts.length === 0) throw new Error("Outcome webhooks require a secret of at least 32 characters and an explicit host allowlist.");
  for (const host of allowedHosts) {
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes("..") || new URL(`https://${host}`).hostname !== host) throw new Error("Outcome webhook allowlist must contain exact hostnames, without schemes, ports, paths or wildcards.");
  }
  return { secret, allowedHosts };
}
export function validateOutcomeWebhook(value: string, allowedHosts: string[]): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new HttpError(400, "Outcome webhook must be a valid HTTPS URL on an administrator-approved host."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !allowedHosts.includes(url.hostname) || (url.port && url.port !== "443")) throw new HttpError(400, "Outcome webhook must use HTTPS on an administrator-approved host, without credentials, fragments or custom ports.");
  return url.href;
}
export function signOutcome(secret: string, timestamp: string, body: string): string {
  if (secret.length < 32) throw new Error("Outcome webhook secret requires at least 32 characters.");
  return "v1=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Durable, at-least-once delivery: recipients deduplicate X-MKTR-Delivery.
 * One process serializes ticks. An attempt is committed before its network side effect. */
export class OutcomeDispatcher {
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private halted = false;
  private readonly now: () => Date;
  private readonly logger: Logger;
  constructor(private readonly store: OutcomeStore, private readonly options: OutcomeWebhookConfig & { fetch?: typeof fetch; now?: () => Date; logger?: Logger }) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? defaultLogger;
    if ((options.secret || options.allowedHosts.length) && (options.secret.length < 32 || options.allowedHosts.length === 0)) throw new Error("Outcome webhooks require a secret of at least 32 characters and an explicit host allowlist.");
  }
  start(): void {
    if (this.stopped || this.halted) throw new Error("Outcome dispatcher requires an API restart.");
    if (this.timer || !this.options.secret) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.halted = true;
        clearInterval(this.timer); this.timer = undefined;
        this.logger.error({ err: error }, "Outcome dispatcher halted; inspect durable storage before restarting the API");
      });
    }, 1000);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.stopped || this.halted || !this.options.secret) return Promise.resolve();
    if (this.running) return this.running;
    const task = this.dispatch();
    this.running = task;
    const release = () => { if (this.running === task) this.running = undefined; };
    // Callers retain the rejecting promise; this only releases the coalescing lock.
    void task.then(release, release);
    return task;
  }
  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer); this.timer = undefined;
    await this.running;
  }
  private async dispatch(): Promise<void> {
    const known = new Set(this.store.listOutcomeDeliveries().map((delivery) => delivery.callId));
    for (const call of this.store.listCalls()) {
      if (!call.campaignId || !["ended", "failed"].includes(call.status) || known.has(call.id)) continue;
      const campaign = this.store.getCampaign(call.campaignId);
      if (!campaign?.outcomeWebhookUrl || !campaign.outcomeWebhookEnabledAt || !call.endedAt || Date.parse(call.endedAt) < Date.parse(campaign.outcomeWebhookEnabledAt)) continue;
      const deliveryId = randomUUID();
      const payload = JSON.stringify({ type: "call.outcome", deliveryId, callId: call.id, campaignId: call.campaignId, contactId: call.contactId, destination: call.destination, callerId: call.callerId, flowId: call.flowId, flowVersion: call.flowVersion, direction: call.direction ?? "outbound", outcome: call.outcome ?? outcomeForCall(call.endReason ?? "UNKNOWN", call.status as "ended" | "failed", call.classifierResult?.intent), endReason: call.endReason, createdAt: call.createdAt, endedAt: call.endedAt });
      this.store.saveOutcomeDelivery({ id: deliveryId, callId: call.id, campaignId: call.campaignId, url: campaign.outcomeWebhookUrl, payload, attempts: 0, status: "pending", nextAttemptAt: this.now().toISOString(), createdAt: this.now().toISOString() });
      known.add(call.id);
    }
    await this.store.flush();
    const pending = this.store.listOutcomeDeliveries().filter((entry) => entry.status === "pending").sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt));
    let sent = 0;
    for (const delivery of pending) {
      if (this.stopped || sent >= 10) return;
      if (delivery.attempts >= 8) {
        this.store.saveOutcomeDelivery({ ...delivery, status: "failed", lastError: "The final attempt was not acknowledged before restart. Check the recipient using the delivery ID; no further attempts will be sent." });
        await this.store.flush();
        continue;
      }
      if (Date.parse(delivery.nextAttemptAt) > this.now().getTime()) continue;
      try { validateOutcomeWebhook(delivery.url, this.options.allowedHosts); }
      catch (error) {
        this.store.saveOutcomeDelivery({ ...delivery, status: "failed", lastError: "The saved endpoint is no longer permitted by the administrator host allowlist." });
        await this.store.flush();
        this.logger.warn({ deliveryId: delivery.id, callId: delivery.callId, err: error }, "Outcome delivery blocked by endpoint policy");
        continue;
      }
      const timestamp = String(Math.floor(this.now().getTime() / 1000));
      const signature = signOutcome(this.options.secret, timestamp, delivery.payload);
      const attempt: OutcomeDelivery = { ...delivery, attempts: delivery.attempts + 1, nextAttemptAt: new Date(this.now().getTime() + Math.min(3600, 2 ** (delivery.attempts + 1)) * 1000).toISOString() };
      this.store.saveOutcomeDelivery(attempt);
      await this.store.flush();
      sent++;
      try {
        const response = await (this.options.fetch ?? fetch)(attempt.url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", "X-MKTR-Signature": signature, "X-MKTR-Timestamp": timestamp, "X-MKTR-Delivery": attempt.id }, body: attempt.payload, signal: AbortSignal.timeout(3000) });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`Outcome endpoint returned HTTP ${response.status}.`);
        attempt.status = "delivered"; attempt.deliveredAt = this.now().toISOString(); attempt.lastError = undefined;
      } catch (error) {
        attempt.lastError = error instanceof Error && /^Outcome endpoint returned HTTP \d{3}\.$/.test(error.message) ? error.message : "Outcome request failed, timed out, or attempted a redirect.";
        if (attempt.attempts >= 8) attempt.status = "failed";
        this.logger.warn({ deliveryId: attempt.id, callId: attempt.callId, attempt: attempt.attempts, status: attempt.status }, "Outcome delivery failed; pending entries retry automatically, failed entries require recipient review");
      }
      this.store.saveOutcomeDelivery(attempt);
      await this.store.flush();
    }
  }
}
