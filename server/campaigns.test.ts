import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import pino from "pino";
import request from "supertest";
import { CALLER_IDS } from "../src/lib/domain.js";
import { createApp } from "./app.js";
import { hashPassword, InMemoryAuthStore } from "./auth.js";
import { CampaignDialer, campaignDetail, createCampaign, DEFAULT_CALLING_HOURS, withinCallingHours } from "./campaigns.js";
import { RuleClassifier } from "./classifier.js";
import { importContacts, normalizePhone } from "./contacts.js";
import { EslClient } from "./esl.js";
import { FixtureCallOrchestrator as CallOrchestrator } from "./test-support/fixture-orchestrator.js";
import { InMemoryStore } from "./store.js";
import { FakeEslServer, fixtureEslPassword, waitFor } from "./test-support/fake-esl.js";
import { FreeSwitchEslAdapter } from "./telephony.js";

async function fixture(t: TestContext, options: { count?: number; ceiling?: number; maxAttempts?: number; retryDelaySeconds?: number; dialIntervalMs?: number; start?: string } = {}) {
  const fake = await new FakeEslServer().start();
  fake.respond = (command) => command === "api show channels as json" ? JSON.stringify({ row_count: 0, rows: [] }) : "+OK";
  const adapter = new FreeSwitchEslAdapter(new EslClient({ host: "127.0.0.1", port: fake.port, password: fixtureEslPassword }), true);
  const store = new InMemoryStore();
  const calls = new CallOrchestrator(store, adapter);
  await calls.initialize();
  let now = new Date(options.start ?? "2026-09-11T01:00:00Z");
  const dialer = new CampaignDialer(store, calls, { now: () => now, maxConcurrentCalls: options.ceiling ?? 2 });
  t.after(async () => { await dialer.close(); await calls.shutdown(); await fake.close(); });
  const imported = await importContacts(store, "name,phone\n" + Array.from({ length: options.count ?? 3 }, (_, index) => `Contact ${index + 1},9123400${index}`).join("\n"), now);
  const campaign = await createCampaign(store, { name: "Fixture campaign", flowId: "flow-prospect-intake", callerId: CALLER_IDS[0], contactIds: imported.contacts.map((contact) => contact.id), maxAttempts: options.maxAttempts ?? 2, retryDelaySeconds: options.retryDelaySeconds ?? 2, dialIntervalMs: options.dialIntervalMs ?? 1000 }, now);
  const end = async (cause: string) => {
    const call = store.listCalls().find((item) => !["ended", "failed"].includes(item.status))!;
    fake.event("CHANNEL_HANGUP_COMPLETE", { "Unique-ID": call.providerCallId, "Hangup-Cause": cause });
    await waitFor(() => ["ended", "failed"].includes(calls.get(call.id)!.status));
  };
  return { fake, store, calls, dialer, campaign, adapter, end, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, setDate: (date: string) => { now = new Date(date); }, originations: () => fake.commands.filter((command) => command.startsWith("bgapi originate")) };
}

test("CSV normalizes E.164, handles quoted names and BOM, deduplicates, and rejects the entire malformed import", async () => {
  const store = new InMemoryStore();
  const imported = await importContacts(store, '\uFEFFname,phone\r\n"Alex, Tan",9123 4000\r\n"Jo ""Jay""",+65 (8123) 4001\r\nDuplicate,6591234000\r\nInternational,0064 212345678\r\n');
  assert.equal(imported.imported, 3); assert.equal(imported.duplicates, 1);
  assert.deepEqual(imported.contacts.map((contact) => [contact.name, contact.phone]), [["Alex, Tan", "+6591234000"], ['Jo "Jay"', "+6581234001"], ["International", "+64212345678"]]);
  assert.equal((await importContacts(store, "phone\n91234000")).duplicates, 1);
  for (const csv of ["name,phone\nValid,91234999\nInvalid,9123ext4", "name,phone\n\"Unclosed,91234004", "name,phone\nExtra,91234004,column", "phone,phone\n91234001,91234002"]) await assert.rejects(importContacts(store, csv));
  assert.equal(store.listContacts().length, 3);
  for (const phone of ["+65 12345678", "91234", "1234567890", "++6591234000", "91234000;drop"]) assert.throws(() => normalizePhone(phone));
});

test("dialer coalesces overlapping ticks, spaces originates, and shares the configured trunk ceiling with other calls", async (t) => {
  const f = await fixture(t, { ceiling: 2 });
  await f.dialer.control(f.campaign.id, "start");
  await Promise.all([f.dialer.tick(), f.dialer.tick(), f.dialer.tick()]);
  assert.equal(f.originations().length, 1);
  f.advance(999); await f.dialer.tick(); assert.equal(f.originations().length, 1);
  f.advance(1);
  // An independently started operator call occupies the same capacity used by campaigns.
  const independent = await f.calls.start({ destination: "+6591234099", callerId: CALLER_IDS[1], flowId: f.campaign.flowId });
  await f.dialer.tick(); assert.equal(f.originations().length, 2);
  await f.calls.stop(independent.id);
  await f.dialer.tick(); assert.equal(f.originations().length, 3);
  f.advance(1000); await f.dialer.tick(); assert.equal(f.originations().length, 3);
  assert.equal(f.calls.activeCallCount(), 2);
  await f.end("NORMAL_CLEARING");
  await f.dialer.tick(); assert.equal(f.originations().length, 4);
  assert.equal(campaignDetail(f.store, f.campaign.id).progress.dialing, 2);
});

test("default hours allow Monday–Saturday 09:00 inclusive to 20:00 exclusive in Singapore and block Sunday", async (t) => {
  for (const [date, allowed] of [["2026-09-12T00:59:59Z", false], ["2026-09-12T01:00:00Z", true], ["2026-09-12T11:59:59Z", true], ["2026-09-12T12:00:00Z", false], ["2026-09-13T01:00:00Z", false], ["2026-09-14T01:00:00Z", true]] as const) assert.equal(withinCallingHours(new Date(date), DEFAULT_CALLING_HOURS), allowed, date);
  const f = await fixture(t, { start: "2026-09-13T01:00:00Z" });
  await f.dialer.control(f.campaign.id, "start");
  await f.dialer.tick(); assert.equal(f.originations().length, 0);
  f.setDate("2026-09-14T00:59:59Z"); await f.dialer.tick(); assert.equal(f.originations().length, 0);
  f.advance(1000); await f.dialer.tick(); assert.equal(f.originations().length, 1);
});

test("busy and no-answer retry only after the delay and stop at the per-contact attempt cap", async (t) => {
  const f = await fixture(t, { count: 1, maxAttempts: 2 });
  await f.dialer.control(f.campaign.id, "start"); await f.dialer.tick();
  await f.end("USER_BUSY"); await f.dialer.tick();
  let entry = f.store.listCampaignContacts(f.campaign.id)[0];
  assert.equal(entry.status, "pending"); assert.equal(entry.outcome, "busy"); assert.equal(entry.attempts, 1);
  f.advance(1999); await f.dialer.tick(); assert.equal(f.originations().length, 1);
  f.advance(1); await f.dialer.tick(); assert.equal(f.originations().length, 2);
  await f.end("NO_ANSWER"); await f.dialer.tick();
  entry = f.store.listCampaignContacts(f.campaign.id)[0];
  assert.equal(entry.status, "completed"); assert.equal(entry.outcome, "no_answer"); assert.equal(entry.attempts, 2);
  assert.equal(f.store.getCampaign(f.campaign.id)?.status, "completed");
  f.advance(86_400_000); await f.dialer.tick(); assert.equal(f.originations().length, 2);
});

test("pause lets in-flight calls continue; stop hangs up owned calls and marks remaining contacts skipped", async (t) => {
  const f = await fixture(t);
  await f.dialer.control(f.campaign.id, "start"); await f.dialer.tick();
  await f.dialer.control(f.campaign.id, "pause");
  f.advance(10_000); await f.dialer.tick();
  assert.equal(f.originations().length, 1); assert.equal(f.calls.activeCallCount(), 1);
  const stopped = await f.dialer.control(f.campaign.id, "stop");
  assert.equal(stopped.status, "stopped"); assert.equal(stopped.progress.completed, 1); assert.equal(stopped.progress.skipped, 2);
  assert.equal(f.calls.activeCallCount(), 0);
  assert.equal(f.fake.commands.filter((command) => command.startsWith("api uuid_kill")).length, 1);
  await assert.rejects(f.dialer.control(f.campaign.id, "start"), /finished/);
});

test("policy refusal records the skip reason without a dial attempt; provider failure is recorded and logged", async (t) => {
  const f = await fixture(t, { count: 1 });
  let logs = "";
  const logger = pino({}, new Writable({ write(chunk, _encoding, done) { logs += String(chunk); done(); } }));
  const denied = new CampaignDialer(f.store, { ...f.calls, activeCallCount: () => 0, get: (id) => f.calls.get(id), stop: (id) => f.calls.stop(id), async start() { throw Object.assign(new Error("Consent required"), { code: "DIAL_NOT_PERMITTED", skipReason: "No consent or fresh DNC clearance" }); } }, { now: () => new Date("2026-09-11T01:00:00Z"), logger });
  await denied.control(f.campaign.id, "start"); await denied.tick(); await denied.tick(); await denied.close();
  const skipped = f.store.listCampaignContacts(f.campaign.id)[0];
  assert.equal(skipped.status, "skipped"); assert.equal(skipped.attempts, 0); assert.match(skipped.skipReason!, /consent/); assert.equal(f.originations().length, 0);
  const failedCampaign = await createCampaign(f.store, { name: "Provider failure", flowId: f.campaign.flowId, callerId: CALLER_IDS[0], contactIds: [skipped.contactId] });
  const failing = new CampaignDialer(f.store, { activeCallCount: () => 0, get: (id) => f.calls.get(id), stop: (id) => f.calls.stop(id), async start() { throw new Error("Injected provider failure"); } }, { now: () => new Date("2026-09-11T01:00:00Z"), logger });
  await failing.control(failedCampaign.id, "start"); await failing.tick(); await failing.close();
  const failed = f.store.listCampaignContacts(failedCampaign.id)[0];
  assert.equal(failed.status, "completed"); assert.equal(failed.attempts, 1); assert.equal(failed.outcome, "failed"); assert.match(failed.lastError!, /Review/); assert.match(logs, /Injected provider failure/);
});

test("an interrupted unconfirmed attempt is surfaced for review and is never automatically dialed again", async (t) => {
  const f = await fixture(t, { count: 1 });
  const entry = f.store.listCampaignContacts(f.campaign.id)[0];
  f.store.saveCampaignContact({ ...entry, status: "dialing", attempts: 1, lastAttemptAt: "2026-09-11T01:00:00Z" });
  await f.dialer.control(f.campaign.id, "start"); await f.dialer.tick();
  assert.equal(f.originations().length, 0);
  assert.equal(f.store.listCampaignContacts(f.campaign.id)[0].outcome, "interrupted");
  assert.match(f.store.listCampaignContacts(f.campaign.id)[0].skipReason!, /review provider records/);
});

test("authenticated campaign HTTP routes validate imports and pin an immutable flow version and approved caller ID", async (t) => {
  const f = await fixture(t, { count: 1 });
  const authStore = new InMemoryAuthStore(), password = randomBytes(24).toString("hex");
  await authStore.saveUser({ id: "campaign-operator", email: "campaign@example.test", passwordHash: await hashPassword(password), role: "operator" });
  const { app } = createApp({ store: f.store, adapter: f.adapter, calls: f.calls, classifier: new RuleClassifier(), authStore, campaignDialer: f.dialer, logger: pino({ level: "silent" }) });
  await request(app).post("/api/contacts/import").send({ csv: "phone\n91234999" }).expect(401);
  await request(app).post(`/api/campaigns/${f.campaign.id}/start`).send({}).expect(401);
  const login = await request(app).post("/api/auth/login").send({ email: "campaign@example.test", password }).expect(200);
  const cookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  const imported = await request(app).post("/api/contacts/import").set("Cookie", cookie).send({ csv: "name,phone\nHTTP contact,91234999" }).expect(201);
  const payload = { name: "Pinned campaign", flowId: f.campaign.flowId, callerId: CALLER_IDS[0], contactIds: [imported.body.contacts[0].id] };
  const created = await request(app).post("/api/campaigns").set("Cookie", cookie).send(payload).expect(201);
  assert.equal(created.body.flowVersion, 3); assert.deepEqual(created.body.callingHours, DEFAULT_CALLING_HOURS);
  await request(app).post("/api/campaigns").set("Cookie", cookie).send({ ...payload, callerId: "+6562000000" }).expect(400);
  await request(app).post("/api/campaigns").set("Cookie", cookie).send({ ...payload, maxAttempts: 0 }).expect(400);
  await request(app).post("/api/campaigns").set("Cookie", cookie).send({ ...payload, callingHours: { ...DEFAULT_CALLING_HOURS, start: "20:00", end: "09:00" } }).expect(400);
  await request(app).post("/api/campaigns").set("Cookie", cookie).send({ ...payload, contactIds: [...payload.contactIds, ...payload.contactIds] }).expect(400);
  const definition = f.store.getFlow(payload.flowId)!;
  f.store.saveFlow({ ...definition, version: 4, name: "New publication after campaign creation" });
  assert.equal((await request(app).get(`/api/campaigns/${created.body.id}`).set("Cookie", cookie).expect(200)).body.flowVersion, 3);
  assert.throws(() => f.store.saveCampaign({ ...f.store.getCampaign(created.body.id)!, callerId: CALLER_IDS[1] }), /pinned/);
  f.store.deleteFlow(payload.flowId);
  await f.dialer.control(created.body.id, "start");
  await f.dialer.tick();
  const dialed = f.store.listCalls()[0];
  assert.equal(dialed.flowVersion, 3);
  assert.equal(dialed.campaignId, created.body.id);
  assert.equal(dialed.contactId, imported.body.contacts[0].id);
  assert.equal(f.originations().length, 1);
  await assert.rejects(f.calls.start({ destination: "+6591234998", callerId: CALLER_IDS[0], flowId: payload.flowId, flowVersion: 3, campaignId: created.body.id, contactId: dialed.contactId }), /must match/);
  assert.equal(f.originations().length, 1);
});
