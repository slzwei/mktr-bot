import { createHmac, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import type { DncCheckResult, DncRegistryEvidence } from "../src/lib/domain.js";
import { ConsentPolicy, DialConsentError, DNC_VALIDITY_MS, type DncClearance, type DialPermissionStore } from "./compliance.js";
import { logger as defaultLogger } from "./logger.js";

export type DncConfig = { enabled: boolean; gatewayUrl: string; gatewaySecret: string };
export type RegistryClearance = DncClearance & { evidence: DncRegistryEvidence };
export interface DncStore extends DialPermissionStore {
  saveDncClearance(record: DncClearance): DncClearance;
  flush(): Promise<void>;
}

export function dncConfig(environment: Record<string, string | undefined>): DncConfig {
  return {
    enabled: environment.MKTR_DNC_ENABLED === "true",
    gatewayUrl: environment.MKTR_DNC_GATEWAY_URL ?? "",
    gatewaySecret: environment.MKTR_DNC_GATEWAY_SECRET ?? ""
  };
}

/** Pure eligibility shared by preview and paid execution. A fresh negative result is covered too. */
export function previewDnc(store: DialPermissionStore, phones: string[], date = new Date()) {
  const numbers: string[] = [];
  let skippedAlreadyCovered = 0, skippedNotSingapore = 0;
  const policy = new ConsentPolicy(store, () => date);
  for (const phone of new Set(phones)) {
    if (!/^\+65\d{8}$/.test(phone)) { skippedNotSingapore++; continue; }
    let consent = false;
    try { consent = policy.authorize(phone).basis === "consent"; }
    catch (error) { if (!(error instanceof DialConsentError)) throw error; }
    const record = store.getDncClearance(phone);
    const age = date.getTime() - Date.parse(record?.checkedAt ?? "");
    const fresh = record?.phone === phone && record.source.trim() && record.reference.trim()
      && Number.isFinite(age) && age >= 0 && age < DNC_VALIDITY_MS;
    if (consent || fresh) skippedAlreadyCovered++;
    else numbers.push(phone.slice(3));
  }
  return { numbers, skippedAlreadyCovered, skippedNotSingapore };
}

const resultSchema = z.object({
  success: z.literal(true),
  data: z.object({
    statusCode: z.literal("S000"),
    transactionId: z.string().trim().min(1).max(500),
    createdTime: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    validUntil: z.string().datetime({ offset: true }),
    results: z.array(z.object({
      number: z.string().regex(/^\d{8}$/),
      noVoiceCall: z.boolean(), noTextMessage: z.boolean(), noFax: z.boolean()
    })).min(1).max(100)
  })
});
const statusSchema = z.object({ statusCode: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() });
function statusCode(body: unknown): string | undefined {
  const envelope = z.object({ data: z.unknown().optional(), error: z.unknown().optional() }).safeParse(body);
  for (const value of [body, envelope.success ? envelope.data.data : undefined, envelope.success ? envelope.data.error : undefined]) {
    const parsed = statusSchema.safeParse(value);
    if (parsed.success && parsed.data.statusCode) return parsed.data.statusCode;
    if (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)) return value;
  }
  return undefined;
}
const reasons: Record<string, string> = {
  S301: "The Registry has insufficient prepaid credits.",
  S401: "Registry authentication failed.", S402: "Registry authentication failed.", S404: "Registry authentication failed.",
  S501: "The Registry is unavailable.",
  dnc_unavailable: "Registry checking is unavailable or not configured on the gateway.",
  budget_exceeded: "The gateway's batch checking budget has been exceeded."
};
class CheckFailure extends Error {
  constructor(readonly details: NonNullable<DncCheckResult["failure"]>) { super(details.message); }
}
function invalidReply(httpStatus: number): CheckFailure {
  return new CheckFailure({ statusCode: "invalid_response", httpStatus, message: "The gateway did not return a complete, unambiguous S000 result for this batch.", billingUncertain: true });
}
async function readReply(response: Response): Promise<unknown> {
  if (!response.body) throw invalidReply(response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 128_000) { await reader.cancel(); throw invalidReply(response.status); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw invalidReply(response.status); }
}

/** One instance per API/store: serialize runs, recheck coverage, never retry a paid POST. */
export class DncChecker {
  private operation: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly logger: Logger;
  readonly enabled: boolean;
  constructor(private readonly store: DncStore, private readonly options: DncConfig & { now?: () => Date; timeoutMs?: number; logger?: Logger }) {
    this.enabled = options.enabled;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? defaultLogger;
  }

  scrubPhones(phones: string[], maxCredits: number): Promise<DncCheckResult> {
    const pending = this.operation.then(() => this.run([...phones], maxCredits));
    this.operation = pending.then(() => undefined);
    return pending;
  }

  private async run(phones: string[], maxCredits: number): Promise<DncCheckResult> {
    const result: DncCheckResult = { checked: 0, cleared: 0, registered: 0, skippedAlreadyCovered: 0, skippedNotSingapore: 0, failed: 0, submitted: 0 };
    let remaining = new Set(phones.filter((phone) => /^\+65\d{8}$/.test(phone))).size;
    let phase: "prepare" | "gateway" | "evidence" = "prepare";
    try {
      if (!this.enabled) return result;
      await this.store.flush();
      const preview = previewDnc(this.store, phones, this.now());
      result.skippedAlreadyCovered = preview.skippedAlreadyCovered;
      result.skippedNotSingapore = preview.skippedNotSingapore;
      remaining = preview.numbers.length;
      if (!remaining) return result;
      if (!Number.isSafeInteger(maxCredits) || maxCredits < remaining || maxCredits > 1000) {
        throw new CheckFailure({ statusCode: "preview_changed", message: "More numbers need checking than the confirmed credit count. Preview again before spending; no Registry request was sent." });
      }
      let gateway: URL;
      try { gateway = new URL(this.options.gatewayUrl); }
      catch { throw new CheckFailure({ statusCode: "dnc_unavailable", message: "The Registry gateway URL is not configured correctly." }); }
      const loopback = gateway.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(gateway.hostname);
      if ((!loopback && gateway.protocol !== "https:") || gateway.username || gateway.password || gateway.hash || this.options.gatewaySecret.length < 32) {
        throw new CheckFailure({ statusCode: "dnc_unavailable", message: "Registry checking requires an HTTPS gateway URL and a dedicated shared secret of at least 32 characters." });
      }
      for (let offset = 0; offset < preview.numbers.length; offset += 100) {
        // Consent or manual evidence may have arrived while the preceding batch was in flight.
        const current = previewDnc(this.store, preview.numbers.slice(offset, offset + 100).map((number) => `+65${number}`), this.now());
        result.skippedAlreadyCovered += current.skippedAlreadyCovered;
        remaining -= current.skippedAlreadyCovered;
        const numbers = current.numbers;
        if (!numbers.length) continue;
        const raw = JSON.stringify({ timestamp: this.now().toISOString(), caller: "mktr-bot", numbers });
        const signature = createHmac("sha256", this.options.gatewaySecret).update(raw).digest("hex");
        phase = "gateway";
        result.submitted += numbers.length;
        const response = await fetch(gateway, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Signature": `sha256=${signature}` },
          body: raw, redirect: "manual", signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000)
        });
        const body = await readReply(response);
        const receivedAt = this.now().toISOString();
        const code = statusCode(body);
        if (code && code !== "S000") throw new CheckFailure({ statusCode: code, httpStatus: response.status, message: reasons[code] ?? `Registry check failed (${code}).` });
        const parsed = resultSchema.safeParse(body);
        if (response.status !== 200 || !parsed.success) throw invalidReply(response.status);
        const data = parsed.data.data;
        const returned = new Set(data.results.map((entry) => entry.number));
        if (data.results.length !== numbers.length || returned.size !== numbers.length || numbers.some((number) => !returned.has(number))) throw invalidReply(response.status);
        // Validate the WHOLE batch before creating any evidence. Partial S000 is not a result.
        const records: RegistryClearance[] = data.results.map((entry) => ({
          id: randomUUID(), phone: `+65${entry.number}`, checkedAt: receivedAt, recordedAt: this.now().toISOString(),
          cleared: !entry.noVoiceCall, source: "Singapore DNC Registry", reference: data.transactionId,
          evidence: { statusCode: "S000", createdTime: data.createdTime, validUntil: data.validUntil, noVoiceCall: entry.noVoiceCall, noTextMessage: entry.noTextMessage, noFax: entry.noFax }
        }));
        phase = "evidence";
        for (const record of records) {
          const prior = this.store.getDncClearance(record.phone);
          if (prior && (Date.parse(prior.checkedAt) > Date.parse(record.checkedAt) || (!prior.cleared && record.cleared && Date.parse(prior.checkedAt) === Date.parse(record.checkedAt)))) {
            throw new CheckFailure({ statusCode: "evidence_conflict", message: "A newer or conflicting Registry record already exists. Review the stored evidence before checking again." });
          }
        }
        for (const record of records) this.store.saveDncClearance(record);
        await this.store.flush();
        result.checked += records.length;
        result.cleared += records.filter((record) => record.cleared).length;
        result.registered += records.filter((record) => !record.cleared).length;
        remaining -= records.length;
      }
    } catch (error) {
      result.failed = remaining;
      result.failure = error instanceof CheckFailure ? error.details : phase === "gateway"
        ? { statusCode: "gateway_unreachable", message: "The Registry gateway could not be reached or its reply timed out. Submitted credits may have been billed; no automatic retry was made.", billingUncertain: true }
        : { statusCode: "evidence_unavailable", message: "Registry evidence could not be read or saved. Ask the administrator to check durable storage before retrying." };
      // Never log bodies, numbers, gateway URLs or secrets.
      this.logger.warn({ statusCode: result.failure.statusCode, httpStatus: result.failure.httpStatus, checked: result.checked, failed: result.failed, submitted: result.submitted }, "Registry check stopped; import and previously confirmed evidence are retained");
    }
    return result;
  }
}
