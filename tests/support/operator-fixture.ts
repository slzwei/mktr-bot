import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { createApp } from "../../server/app";
import { hashPassword, InMemoryAuthStore } from "../../server/auth";
import { RuleClassifier } from "../../server/classifier";
import { CallOrchestrator } from "../../server/orchestrator";
import { InMemoryStore } from "../../server/store";
import { SimulatedTelephonyAdapter } from "../../server/telephony";
import { CALLER_IDS, type CallEvent, type CallOutcome, type CallSession } from "../../src/lib/domain";

export async function operatorFixture() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const store = new InMemoryStore(), authStore = new InMemoryAuthStore();
  const password = randomBytes(32).toString("hex"), email = "operator-ui@example.test";
  await authStore.saveUser({ id: randomUUID(), email, passwordHash: await hashPassword(password), role: "operator" });
  const adapter = new SimulatedTelephonyAdapter(), classifier = new RuleClassifier();
  const calls = new CallOrchestrator(store, adapter, classifier);
  const { app, closeSseStreams } = createApp({ store, authStore, adapter, classifier, calls, dnc: { enabled: false, gatewayUrl: "", gatewaySecret: "" }, webOrigin: origin, logger: pino({ level: "silent" }) });
  server.on("request", app);
  return { origin, store, calls, closeStreams: closeSseStreams, email, password, close: async () => {
    closeSseStreams(); await calls.shutdown(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

export function seedPermissions(store: InMemoryStore, count = 500) {
  const names = ["Aisha Tan", "Benjamin Teo", "Chloe Ong", "Daniel Lim", "Evelyn Lee", "Farah Ahmad", "Grace Chen", "Harish Kumar"];
  const surnames = ["Tan", "Lim", "Lee", "Wong", "Chen", "Goh", "Ng", "Teo"];
  const firstNames = ["James", "Jia Min", "Joanne", "Jonathan", "Joseph", "Joyce", "Julian", "Justin"];
  const now = new Date().toISOString();
  const contacts = store.saveContacts(Array.from({ length: count }, (_, index) => ({ id: randomUUID(), name: names[index] ?? `${firstNames[index % 8]} ${surnames[Math.floor(index / 8) % 8]} ${String(index).padStart(3, "0")}`, phone: `+65${91000000 + index}`, createdAt: now, updatedAt: now })));
  contacts.forEach((contact, index) => {
    if (index === 3) return; // No evidence is never clear.
    if (index === 2 || index >= 8 && index % 3 === 0) {
      store.saveConsent({ id: randomUUID(), phone: contact.phone, source: `Signed voice consent · CRM-${2100 + index}`, consentedAt: new Date(Date.now() - 2 * 86400000).toISOString(), recordedAt: now, purpose: "voice_marketing" });
      return;
    }
    const age = index === 5 ? 19 : index === 6 ? 23 : 2;
    const voice = index === 1 || index > 8 && index % 10 === 0;
    const evidence = index === 4 ? undefined : { statusCode: "S000" as const, createdTime: null, validUntil: null, noVoiceCall: voice, noTextMessage: index % 2 === 0, noFax: index % 4 === 0 };
    const clearance = { id: randomUUID(), phone: contact.phone, checkedAt: new Date(Date.now() - age * 86400000).toISOString(), recordedAt: now, cleared: !voice, source: "Singapore DNC Registry", reference: `PDPC-SEP-${String(index + 1).padStart(5, "0")}`, evidence };
    store.saveDncClearance(clearance);
  });
  return contacts;
}

export function seedHistory(store: InMemoryStore, count = 57) {
  const contacts = store.listContacts().length ? store.listContacts() : seedPermissions(store, Math.max(count, 8));
  const flow = store.listFlows()[0];
  const campaignId = randomUUID(), otherCampaignId = randomUUID();
  const base = Date.parse("2026-09-10T02:45:00.000Z");
  for (const [id, name] of [[campaignId, "September customer outreach"], [otherCampaignId, "Enquiry follow-up"]]) store.saveCampaign({ id, name, flowId: flow.id, flowVersion: flow.version, callerId: CALLER_IDS[0], status: "completed", callingHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "20:00", timeZone: "Asia/Singapore" }, maxAttempts: 1, retryDelaySeconds: 60, dialIntervalMs: 1000, createdAt: new Date(base).toISOString(), updatedAt: new Date(base).toISOString() });
  const outcomes: CallOutcome[] = ["interested", "no_answer", "callback", "completed", "busy", "not_interested", "voicemail"];
  const records = Array.from({ length: count }, (_, index) => {
    const createdAt = new Date(base - index * 180_000).toISOString();
    const outcome = outcomes[index % outcomes.length];
    const event = (type: CallEvent["type"], seconds: number, title: string, detail: string, latencyMs?: number): CallEvent => ({ id: randomUUID(), type, timestamp: new Date(Date.parse(createdAt) + seconds * 1000).toISOString(), title, detail, latencyMs });
    const events = ["no_answer", "busy"].includes(outcome) ? [] : [
      event("clip_playing", 4, "Opening greeting", "Hello, this is MKTR calling about your recent enquiry. Is now a good time to talk?"),
      event("transcript_final", 12, "Caller response", "Yes, I have a few minutes. I’d like to know what happens next.", 420),
      event("classified", 13, "Intent classified", "Interested · positive sentiment"),
      event("clip_playing", 16, "Interested response", "Our team can walk you through the options and answer your questions. We’ll arrange a time that works for you."),
      event("transcript_final", 28, "Caller response", "Tomorrow afternoon would be good, after two. Thank you.", 0)
    ];
    const call: CallSession = { id: randomUUID(), providerCallId: randomUUID(), destination: contacts[index % contacts.length].phone, contactId: contacts[index % contacts.length].id, callerId: CALLER_IDS[index % CALLER_IDS.length], flowId: flow.id, flowVersion: flow.version, campaignId: index % 2 === 0 ? campaignId : otherCampaignId, status: "ended", outcome, createdAt, endedAt: new Date(Date.parse(createdAt) + 90_000).toISOString(), endReason: outcome === "no_answer" ? "No answer before timeout" : "Flow completed", events, dialAuthorization: { basis: index % 2 === 0 ? "consent" : "dnc", recordId: randomUUID(), checkedAt: createdAt }, ...(index % 3 === 0 ? { recordingFile: `${randomUUID()}.wav`, recordingExpiresAt: new Date(Date.now() + 28 * 86400000).toISOString() } : {}) };
    store.saveCall(call);
    return call;
  });
  return { records, campaignId, otherCampaignId, contacts };
}
