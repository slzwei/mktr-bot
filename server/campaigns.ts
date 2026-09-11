import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import { CALLER_IDS, type CallingHours, type Campaign, type CampaignContact, type CampaignDetail, type CallSession, type TestCallInput } from "../src/lib/domain.js";
import { config } from "./config.js";
import { HttpError } from "./http-error.js";
import { logger as defaultLogger } from "./logger.js";
import type { Store } from "./store.js";

export const DEFAULT_CALLING_HOURS: CallingHours = { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "20:00", timeZone: "Asia/Singapore" };
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export const callingHoursSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine((days) => new Set(days).size === days.length, "Calling days must be unique."),
  start: clockTime,
  end: z.union([clockTime, z.literal("24:00")]),
  timeZone: z.literal("Asia/Singapore")
}).strict().refine((hours) => minutes(hours.start) < minutes(hours.end), "Calling hours must end after they start on the same day.");
export const campaignInputSchema = z.object({
  name: z.string().trim().min(1).max(80), flowId: z.string().min(1).max(128), flowVersion: z.number().int().positive().optional(),
  callerId: z.enum(CALLER_IDS), contactIds: z.array(z.string().uuid()).min(1).max(1000).refine((ids) => new Set(ids).size === ids.length, "Contacts must be unique."),
  callingHours: callingHoursSchema.default(DEFAULT_CALLING_HOURS), maxAttempts: z.number().int().min(1).max(5).default(3),
  retryDelaySeconds: z.number().int().min(1).max(86_400).default(60), dialIntervalMs: z.number().int().min(100).max(60_000).default(1000)
}).strict();

const singaporeClock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function withinCallingHours(date: Date, hours: CallingHours): boolean {
  const parts = Object.fromEntries(singaporeClock.formatToParts(date).map((part) => [part.type, part.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return hours.days.includes(day) && minute >= minutes(hours.start) && minute < minutes(hours.end);
}

export async function createCampaign(store: Store, input: unknown, date = new Date()): Promise<Campaign> {
  const body = campaignInputSchema.parse(input);
  const current = store.getFlow(body.flowId);
  const version = body.flowVersion ?? (current?.status === "published" ? current.version : undefined);
  if (!version || !store.getFlowVersion(body.flowId, version)) throw new HttpError(409, "Choose a published flow version before creating a campaign.");
  if (body.contactIds.some((id) => !store.getContact(id))) throw new HttpError(400, "One or more selected contacts no longer exist.");
  const { contactIds, ...settings } = body;
  const timestamp = date.toISOString();
  const campaign: Campaign = { ...settings, id: randomUUID(), flowVersion: version, status: "draft", createdAt: timestamp, updatedAt: timestamp };
  const contacts: CampaignContact[] = contactIds.map((contactId, ordinal) => ({ id: randomUUID(), campaignId: campaign.id, contactId, ordinal, status: "pending", attempts: 0 }));
  store.saveCampaign(campaign, contacts);
  await store.flush();
  return campaign;
}

export function campaignDetail(store: Store, id: string, date = new Date()): CampaignDetail {
  const campaign = store.getCampaign(id);
  if (!campaign) throw new HttpError(404, "Campaign not found.");
  const contacts = store.listCampaignContacts(id).map((entry) => {
    const contact = store.getContact(entry.contactId);
    if (!contact) throw new Error(`Campaign ${id} has a missing contact record.`);
    return { ...entry, contact };
  });
  const progress = { total: contacts.length, pending: 0, dialing: 0, completed: 0, skipped: 0 };
  contacts.forEach((entry) => progress[entry.status]++);
  return { ...campaign, withinCallingHours: withinCallingHours(date, campaign.callingHours), contacts, progress };
}

type Calls = {
  start(input: TestCallInput): Promise<CallSession>;
  stop(id: string): Promise<CallSession>;
  get(id: string): CallSession | undefined;
  activeCallCount(): number;
};
const terminal = (call: CallSession) => call.status === "ended" || call.status === "failed";
const policyError = (error: unknown): error is { code: "DIAL_NOT_PERMITTED"; skipReason: string } => typeof error === "object" && error !== null && "code" in error && error.code === "DIAL_NOT_PERMITTED" && "skipReason" in error && typeof error.skipReason === "string";

function callOutcome(call: CallSession): string {
  // C3 supplies normalized outcomes. SIP causes remain useful before that migration.
  if ("outcome" in call && typeof call.outcome === "string") return call.outcome;
  if (/USER_BUSY|\bBUSY\b/i.test(call.endReason ?? "")) return "busy";
  if (/NO_ANSWER|NO_USER_RESPONSE|PROGRESS_TIMEOUT/i.test(call.endReason ?? "")) return "no_answer";
  if (call.status === "failed") return "failed";
  return call.classifierResult?.intent ?? "completed";
}

/** One scheduler per API process. All controls and ticks share a queue, and the
 * call service still enforces the trunk ceiling and every-dial consent policy. */
export class CampaignDialer {
  private operation: Promise<unknown> = Promise.resolve();
  private ticking?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private halted = false;
  private cursor = 0;
  private readonly now: () => Date;
  private readonly logger: Logger;
  private readonly ceiling: number;

  constructor(private readonly store: Store, private readonly calls: Calls, options: { now?: () => Date; logger?: Logger; maxConcurrentCalls?: number } = {}) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? defaultLogger;
    this.ceiling = Math.min(5, config.maxConcurrentCalls, options.maxConcurrentCalls ?? 5);
    if (!Number.isSafeInteger(this.ceiling) || this.ceiling < 1) throw new Error("Campaign call ceiling must be a positive integer.");
  }
  start(): void {
    if (this.closed || this.halted) throw new Error("Campaign scheduler requires an API restart.");
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.halted = true;
        clearInterval(this.timer); this.timer = undefined;
        this.logger.error({ err: error }, "Campaign scheduler halted; inspect storage/provider health and restart the API before resuming campaigns");
      });
    }, 250);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.closed || this.halted) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const task = this.serialize(() => this.processTick());
    this.ticking = task;
    const clear = () => { if (this.ticking === task) this.ticking = undefined; };
    // The caller retains the rejecting promise; this branch only releases the coalescing lock.
    void task.then(clear, clear);
    return task;
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer); this.timer = undefined;
    await this.operation;
  }
  control(id: string, action: "start" | "pause" | "stop"): Promise<CampaignDetail> {
    return this.serialize(async () => {
      if (this.closed || this.halted) throw new HttpError(503, "Campaign scheduler is unavailable. Inspect API logs before restarting.");
      const campaign = this.store.getCampaign(id);
      if (!campaign) throw new HttpError(404, "Campaign not found.");
      if (["completed", "stopped"].includes(campaign.status)) throw new HttpError(409, "This campaign has finished. Create a new campaign to call again.");
      const status = action === "start" ? "running" : action === "pause" ? "paused" : "stopped";
      this.store.saveCampaign({ ...campaign, status, updatedAt: this.now().toISOString() });
      await this.store.flush();
      if (action === "stop") {
        for (const entry of this.store.listCampaignContacts(id)) {
          if (entry.status === "pending") this.store.saveCampaignContact({ ...entry, status: "skipped", skipReason: "Campaign stopped by operator", outcome: "stopped" });
        }
        await this.store.flush();
        const failures: Error[] = [];
        for (const entry of this.store.listCampaignContacts(id).filter((item) => item.status === "dialing")) {
          if (!entry.lastCallId) continue;
          try { await this.calls.stop(entry.lastCallId); }
          catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            failures.push(failure);
            this.logger.error({ err: failure, campaignId: id, campaignContactId: entry.id, callId: entry.lastCallId }, "Campaign stop could not confirm channel termination");
          }
        }
        await this.reconcile();
        if (failures.length) throw new HttpError(503, "Campaign is stopped; one or more active calls could not be confirmed ended. Inspect call history and retry ending those calls.");
      }
      return campaignDetail(this.store, id, this.now());
    });
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action);
    // Individual callers receive failures; later controls must still be able to stop a campaign.
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
  private async reconcile(): Promise<void> {
    const date = this.now();
    for (const campaign of this.store.listCampaigns()) {
      for (const entry of this.store.listCampaignContacts(campaign.id).filter((item) => item.status === "dialing")) {
        const call = entry.lastCallId ? this.calls.get(entry.lastCallId) : this.store.listCalls().find((candidate) => candidate.campaignId === campaign.id && candidate.contactId === entry.contactId && (!entry.lastAttemptAt || candidate.createdAt >= entry.lastAttemptAt));
        if (!call) {
          this.store.saveCampaignContact({ ...entry, status: "skipped", outcome: "interrupted", skipReason: "API restarted during an unconfirmed attempt; review provider records before creating a new campaign." });
          continue;
        }
        if (!terminal(call)) {
          if (!entry.lastCallId) this.store.saveCampaignContact({ ...entry, lastCallId: call.id });
          continue;
        }
        const outcome = callOutcome(call);
        const retry = campaign.status !== "stopped" && ["busy", "no_answer"].includes(outcome) && entry.attempts < campaign.maxAttempts;
        this.store.saveCampaignContact({ ...entry, lastCallId: call.id, outcome, status: retry ? "pending" : "completed", nextAttemptAt: retry ? new Date(date.getTime() + campaign.retryDelaySeconds * 1000).toISOString() : undefined });
      }
      if (campaign.status === "running" && this.store.listCampaignContacts(campaign.id).every((entry) => entry.status === "completed" || entry.status === "skipped")) this.store.saveCampaign({ ...campaign, status: "completed", updatedAt: date.toISOString() });
    }
    await this.store.flush();
  }
  private async processTick(): Promise<void> {
    await this.reconcile();
    if (this.closed || this.calls.activeCallCount() >= this.ceiling) return;
    const date = this.now();
    const campaigns = this.store.listCampaigns().filter((campaign) => campaign.status === "running");
    for (let offset = 0; offset < campaigns.length; offset++) {
      const index = (this.cursor + offset) % campaigns.length;
      const campaign = campaigns[index];
      if (!withinCallingHours(date, campaign.callingHours) || campaign.lastDialAt && date.getTime() - Date.parse(campaign.lastDialAt) < campaign.dialIntervalMs) continue;
      const entry = this.store.listCampaignContacts(campaign.id).find((item) => item.status === "pending" && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= date.getTime()));
      if (!entry) continue;
      this.cursor = index + 1;
      if (entry.attempts >= campaign.maxAttempts) {
        this.store.saveCampaignContact({ ...entry, status: "completed", outcome: entry.outcome ?? "attempt_limit" });
        await this.store.flush(); return;
      }
      const contact = this.store.getContact(entry.contactId);
      if (!contact) throw new Error(`Campaign ${campaign.id} cannot dial a missing contact.`);
      const attempt: CampaignContact = { ...entry, status: "dialing", attempts: entry.attempts + 1, lastAttemptAt: date.toISOString(), nextAttemptAt: undefined, lastCallId: undefined, outcome: undefined, skipReason: undefined, lastError: undefined };
      this.store.saveCampaignContact(attempt);
      this.store.saveCampaign({ ...campaign, lastDialAt: date.toISOString(), updatedAt: date.toISOString() });
      await this.store.flush();
      if (this.closed || !withinCallingHours(this.now(), campaign.callingHours) || this.calls.activeCallCount() >= this.ceiling) {
        this.store.saveCampaignContact(entry);
        await this.store.flush();
        return;
      }
      try {
        const call = await this.calls.start({ destination: contact.phone, callerId: campaign.callerId, flowId: campaign.flowId, flowVersion: campaign.flowVersion, campaignId: campaign.id, contactId: contact.id });
        this.store.saveCampaignContact({ ...attempt, lastCallId: call.id });
        await this.store.flush();
      } catch (error) {
        if (policyError(error)) {
          this.store.saveCampaignContact({ ...attempt, attempts: entry.attempts, status: "skipped", outcome: "not_permitted", skipReason: error.skipReason });
          this.logger.info({ campaignId: campaign.id, campaignContactId: entry.id, skipReason: error.skipReason }, "Campaign contact skipped by the every-dial consent gate");
        } else if (error instanceof Error && /trunk is at its \d-call limit/.test(error.message)) {
          this.store.saveCampaignContact({ ...entry, nextAttemptAt: new Date(date.getTime() + campaign.dialIntervalMs).toISOString() });
        } else {
          this.logger.error({ err: error, campaignId: campaign.id, campaignContactId: entry.id }, "Campaign originate failed");
          const failed = this.store.listCalls().find((call) => call.campaignId === campaign.id && call.contactId === contact.id && call.createdAt >= date.toISOString());
          const outcome = failed ? callOutcome(failed) : "failed";
          const retry = ["busy", "no_answer"].includes(outcome) && attempt.attempts < campaign.maxAttempts;
          this.store.saveCampaignContact({ ...attempt, lastCallId: failed?.id, status: retry ? "pending" : "completed", outcome, lastError: "Call attempt failed. Review the call and API event logs.", nextAttemptAt: retry ? new Date(date.getTime() + campaign.retryDelaySeconds * 1000).toISOString() : undefined });
          this.store.saveCampaign({ ...this.store.getCampaign(campaign.id)!, lastError: "A contact attempt failed. Review campaign progress and API logs.", updatedAt: date.toISOString() });
        }
        await this.store.flush();
      }
      return; // At most one originate per scheduler tick, in addition to per-campaign spacing.
    }
  }
}
