import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import pino from "pino";
import request from "supertest";
import { CALLER_IDS, type CallSession } from "../src/lib/domain.js";
import { createApp } from "./app.js";
import { hashPassword, InMemoryAuthStore } from "./auth.js";
import { createCampaign } from "./campaigns.js";
import { RuleClassifier } from "./classifier.js";
import { importContacts } from "./contacts.js";
import { OutcomeDispatcher, outcomeWebhookConfig, signOutcome, validateOutcomeWebhook } from "./outcome-delivery.js";
import { campaignCsv, outcomeForCall } from "./outcomes.js";
import { CallOrchestrator } from "./orchestrator.js";
import { InMemoryStore } from "./store.js";
import { SimulatedTelephonyAdapter } from "./telephony.js";

const secret = randomBytes(32).toString("hex");
const allowedHosts = ["receiver.example.test"];
const logger = pino({ level: "silent" });
async function fixture(count = 1) {
  const store = new InMemoryStore();
  const imported = await importContacts(store, "name,phone\n" + Array.from({ length: count }, (_, index) => `Fixture ${index},9123410${index}`).join("\n"));
  const campaign = await createCampaign(store, { name: "Outcome fixture", flowId: "flow-prospect-intake", callerId: CALLER_IDS[0], contactIds: imported.contacts.map((contact) => contact.id) });
  store.saveCampaign({ ...campaign, outcomeWebhookUrl: "https://receiver.example.test/outcomes", outcomeWebhookEnabledAt: "2026-09-11T01:00:00Z" });
  const calls = imported.contacts.map((contact): CallSession => ({ id: randomUUID(), providerCallId: randomUUID(), campaignId: campaign.id, contactId: contact.id, flowId: campaign.flowId, flowVersion: campaign.flowVersion, callerId: campaign.callerId, destination: contact.phone, createdAt: "2026-09-11T01:01:00Z", endedAt: "2026-09-11T01:02:00Z", status: "ended", endReason: "Flow completed", outcome: "interested", events: [] }));
  calls.forEach((call) => store.saveCall(call));
  let time = Date.parse("2026-09-11T01:03:00Z");
  return { store, campaign, calls, now: () => new Date(time), advance: (ms: number) => { time += ms; } };
}

test("cause mapping distinguishes busy, no-answer, voicemail, stopped and unknown failures", () => {
  for (const cause of ["USER_BUSY", "BUSY_EVERYWHERE"]) assert.equal(outcomeForCall(cause, "ended"), "busy");
  for (const cause of ["NO_ANSWER", "NO_USER_RESPONSE", "RECOVERY_ON_TIMER_EXPIRE"]) assert.equal(outcomeForCall(cause, "failed"), "no_answer");
  assert.equal(outcomeForCall("AMD_VOICEMAIL", "ended"), "voicemail");
  assert.equal(outcomeForCall("Stopped by operator", "ended"), "stopped");
  assert.equal(outcomeForCall("Unrecognized provider failure", "ended"), "failed");
  assert.equal(outcomeForCall("Flow completed", "ended", "callback"), "callback");
});

test("outcome delivery persists before send, signs exact bytes, retries with a stable ID/body, and deduplicates overlapping ticks", async () => {
  const f = await fixture();
  const receipts: { body: string; id: string; timestamp: string }[] = [];
  const dispatcher = new OutcomeDispatcher(f.store, { secret, allowedHosts, now: f.now, logger, async fetch(url, init) {
    assert.equal(url, "https://receiver.example.test/outcomes"); assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers), body = String(init?.body), timestamp = headers.get("X-MKTR-Timestamp")!;
    const expected = "v1=" + createHmac("sha256", secret).update(Buffer.from(timestamp + "." + body, "utf8")).digest("hex");
    assert.equal(headers.get("X-MKTR-Signature"), expected);
    const stored = f.store.listOutcomeDeliveries()[0];
    assert.equal(stored.attempts, receipts.length + 1); assert.equal(stored.payload, body); assert.equal(stored.id, headers.get("X-MKTR-Delivery"));
    assert.ok(init?.signal instanceof AbortSignal);
    receipts.push({ body, id: stored.id, timestamp });
    return new Response(null, { status: receipts.length === 1 ? 503 : 204 });
  } });
  await Promise.all([dispatcher.tick(), dispatcher.tick(), dispatcher.tick()]);
  assert.equal(receipts.length, 1); assert.equal(f.store.listOutcomeDeliveries()[0].status, "pending");
  f.advance(1999); await dispatcher.tick(); assert.equal(receipts.length, 1);
  f.advance(1); await dispatcher.tick(); assert.equal(receipts.length, 2);
  assert.equal(receipts[0].body, receipts[1].body); assert.equal(receipts[0].id, receipts[1].id); assert.notEqual(receipts[0].timestamp, receipts[1].timestamp);
  assert.equal(f.store.listOutcomeDeliveries()[0].status, "delivered");
  f.advance(60_000); await dispatcher.tick(); assert.equal(receipts.length, 2);
  await dispatcher.close();
});

test("eight failed attempts become terminal and a crash after reserving attempt eight never sends attempt nine", async () => {
  const f = await fixture(); let sends = 0;
  const fail: typeof fetch = async () => { sends++; return new Response(null, { status: 500 }); };
  const dispatcher = new OutcomeDispatcher(f.store, { secret, allowedHosts, now: f.now, logger, fetch: fail });
  for (let attempt = 0; attempt < 8; attempt++) { await dispatcher.tick(); f.advance(3_600_000); }
  await dispatcher.tick(); assert.equal(sends, 8); assert.equal(f.store.listOutcomeDeliveries()[0].status, "failed");
  await dispatcher.close();
  const crash = await fixture();
  const original = new OutcomeDispatcher(crash.store, { secret, allowedHosts, now: crash.now, logger, fetch: fail });
  await original.tick(); await original.close();
  crash.store.saveOutcomeDelivery({ ...crash.store.listOutcomeDeliveries()[0], attempts: 8 });
  const restarted = new OutcomeDispatcher(crash.store, { secret, allowedHosts, now: crash.now, logger, fetch: fail });
  const sentBefore = sends; await restarted.tick(); await restarted.close();
  assert.equal(sends, sentBefore); assert.equal(crash.store.listOutcomeDeliveries()[0].attempts, 8);
  assert.match(crash.store.listOutcomeDeliveries()[0].lastError!, /final attempt was not acknowledged/);
});

test("endpoint and signing configuration fail closed; revoked hosts do not initiate network requests", async () => {
  for (const url of ["http://receiver.example.test/outcomes", "https://other.example.test", "https://receiver.example.test:8443", "https://user:password@receiver.example.test", "https://receiver.example.test/path#fragment", "not a URL"]) assert.throws(() => validateOutcomeWebhook(url, allowedHosts));
  assert.equal(validateOutcomeWebhook("https://receiver.example.test/path?q=1", allowedHosts), "https://receiver.example.test/path?q=1");
  assert.throws(() => signOutcome("short", "1", "{}"));
  assert.throws(() => outcomeWebhookConfig({ MKTR_OUTCOME_WEBHOOK_SECRET: secret }));
  assert.throws(() => outcomeWebhookConfig({ MKTR_OUTCOME_WEBHOOK_SECRET: secret, MKTR_OUTCOME_WEBHOOK_ALLOWED_HOSTS: "*.example.test" }));
  assert.deepEqual(outcomeWebhookConfig({}), { secret: "", allowedHosts: [] });
  const f = await fixture(); let sent = 0;
  const dispatcher = new OutcomeDispatcher(f.store, { secret, allowedHosts: ["other.example.test"], now: f.now, logger, async fetch() { sent++; return new Response(null, { status: 204 }); } });
  await dispatcher.tick(); await dispatcher.close();
  assert.equal(sent, 0); assert.equal(f.store.listOutcomeDeliveries()[0].status, "failed");
});

test("disabled hooks and historical completions are not queued, while shutdown waits for a pending delivery", async () => {
  const f = await fixture(2);
  f.store.saveCall({ ...f.calls[0], endedAt: "2026-09-11T00:59:00Z" });
  let started!: () => void, finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  const dispatcher = new OutcomeDispatcher(f.store, { secret, allowedHosts, now: f.now, logger, async fetch() { started(); await pending; return new Response(null, { status: 204 }); } });
  dispatcher.start();
  const tick = dispatcher.tick(); await began;
  let closed = false; const closing = dispatcher.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); finish(); await tick; await closing;
  assert.equal(f.store.listOutcomeDeliveries().length, 1); assert.equal(f.store.listOutcomeDeliveries()[0].callId, f.calls[1].id);
  const disabled = await fixture(); disabled.store.saveCampaign({ ...disabled.store.getCampaign(disabled.campaign.id)!, outcomeWebhookUrl: undefined });
  const off = new OutcomeDispatcher(disabled.store, { secret, allowedHosts, logger }); await off.tick(); await off.close(); assert.equal(disabled.store.listOutcomeDeliveries().length, 0);
});

test("webhook transport is aborted at three seconds and exposes a bounded retry instead of hanging", async () => {
  const f = await fixture();
  const keepAlive = setTimeout(() => undefined, 3500);
  const dispatcher = new OutcomeDispatcher(f.store, { secret, allowedHosts, now: f.now, logger, async fetch(_url, init) {
    return new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); });
  } });
  try { await dispatcher.tick(); assert.equal(f.store.listOutcomeDeliveries()[0].status, "pending"); assert.match(f.store.listOutcomeDeliveries()[0].lastError!, /timed out/); }
  finally { clearTimeout(keepAlive); await dispatcher.close(); }
});

test("CSV exports one physical row per call and escapes quotes, newlines and spreadsheet formulas", async () => {
  const f = await fixture(2);
  const csv = campaignCsv([{ ...f.calls[0], endReason: '=HYPERLINK("invalid")\r\nsecond line' }, f.calls[1]]);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 3); assert.match(lines[1], /"'=HYPERLINK\(""invalid""\) second line"/); assert.match(csv, /"'\+659/);
  assert.equal((csv.match(/"interested"/g) ?? []).length, 2);
});

test("campaign export and delivery status require a session and webhook settings require an administrator", async () => {
  const f = await fixture();
  const authStore = new InMemoryAuthStore(), password = randomBytes(24).toString("hex"), hash = await hashPassword(password);
  await authStore.saveUser({ id: "outcome-admin", email: "admin@example.test", passwordHash: hash, role: "admin" });
  await authStore.saveUser({ id: "outcome-operator", email: "operator@example.test", passwordHash: hash, role: "operator" });
  const adapter = new SimulatedTelephonyAdapter(); const calls = new CallOrchestrator(f.store, adapter);
  const { app } = createApp({ store: f.store, authStore, calls, adapter, classifier: new RuleClassifier(), logger, outcomeWebhook: { secret, allowedHosts } });
  const login = async (email: string) => (await request(app).post("/api/auth/login").send({ email, password }).expect(200)).headers["set-cookie"][0].split(";")[0];
  const route = `/api/campaigns/${f.campaign.id}`;
  await request(app).get(`${route}/export.csv`).expect(401);
  const operator = await login("operator@example.test");
  await request(app).put(`${route}/outcome-webhook`).set("Cookie", operator).send({ url: "https://receiver.example.test/new" }).expect(403);
  const administrator = await login("admin@example.test");
  await request(app).put(`${route}/outcome-webhook`).set("Cookie", administrator).send({ url: "http://receiver.example.test" }).expect(400);
  await request(app).put(`${route}/outcome-webhook`).set("Cookie", administrator).send({ url: "https://receiver.example.test/new" }).expect(200);
  const csv = await request(app).get(`${route}/export.csv`).set("Cookie", operator).expect(200);
  assert.match(csv.headers["content-type"], /text\/csv/); assert.match(csv.headers["content-disposition"], /attachment/); assert.equal(csv.text.trimEnd().split("\r\n").length, 2);
  const status = await request(app).get(`${route}/outcome-deliveries`).set("Cookie", operator).expect(200); assert.equal(status.body.configured, true); assert.equal(JSON.stringify(status.body).includes(secret), false);
  await request(app).put(`${route}/outcome-webhook`).set("Cookie", administrator).send({ url: null }).expect(200);
  assert.equal(f.store.getCampaign(f.campaign.id)?.outcomeWebhookUrl, undefined);
  await calls.shutdown();
});
