import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import pino from "pino";
import request from "supertest";
import { CALLER_IDS, type TestCallInput } from "../src/lib/domain.js";
import { createApp } from "./app.js";
import { hashPassword, InMemoryAuthStore } from "./auth.js";
import { CampaignDialer, createCampaign } from "./campaigns.js";
import { importContacts } from "./contacts.js";
import { RuleClassifier } from "./classifier.js";
import { ConsentPolicy, DNC_VALIDITY_MS } from "./compliance.js";
import { permissionSummary } from "./permission-summary.js";
import { CallOrchestrator } from "./orchestrator.js";
import { InMemoryStore } from "./store.js";
import type { TelephonyAdapter } from "./telephony.js";

const phone = "+6591234500";
const input: TestCallInput = { destination: phone, callerId: CALLER_IDS[0], flowId: "flow-prospect-intake" };
const now = new Date("2026-09-11T01:00:00Z");
const consent = (store: InMemoryStore) => store.saveConsent({ id: randomUUID(), phone, purpose: "voice_marketing", source: "Fake provider test consent evidence", consentedAt: "2026-09-01T00:00:00Z", recordedAt: now.toISOString() });
const clearance = (store: InMemoryStore, age: number, cleared = true) => store.saveDncClearance({ id: randomUUID(), phone, source: "Singapore DNC Registry", reference: "Fake test result only", checkedAt: new Date(now.getTime() - age).toISOString(), recordedAt: now.toISOString(), cleared });
function fixture(store = new InMemoryStore()) {
  let originates = 0;
  const adapter: TelephonyAdapter = { mode: "freeswitch", configured: true, async originate(_input, providerCallId) { originates++; return { providerCallId: providerCallId! }; }, async hangup() {}, async playClip() {} };
  const calls = new CallOrchestrator(store, adapter, new RuleClassifier(), () => 0, undefined, new ConsentPolicy(store, () => now));
  return { store, adapter, calls, originates: () => originates };
}

test("every dial refuses absent, expired, negative or future DNC evidence without originating", async () => {
  for (const [age, cleared, message] of [[undefined, true, /No recorded voice consent/], [DNC_VALIDITY_MS, true, /expired/], [0, false, /No Voice Call Register/], [-1000, true, /expired/]] as const) {
    const f = fixture();
    try {
      if (age !== undefined) clearance(f.store, age, cleared);
      await assert.rejects(f.calls.start(input), message);
      assert.equal(f.originates(), 0); assert.equal(f.calls.activeCallCount(), 0);
    } finally { await f.calls.shutdown(); }
  }
  const f = fixture();
  try {
    clearance(f.store, DNC_VALIDITY_MS - 1);
    const call = await f.calls.start(input);
    assert.equal(call.dialAuthorization?.basis, "dnc"); assert.equal(f.originates(), 1);
  } finally { await f.calls.shutdown(); }
});

test("recorded consent authorizes calls; voice opt-out overrides clearance and cannot be erased by older consent", async () => {
  const f = fixture();
  const flow = f.store.getFlow(input.flowId)!;
  f.store.saveFlow({ ...flow, version: 4, nodes: [flow.nodes[0], { id: "listen", type: "listen", data: { label: "Reply" }, position: { x: 10, y: 0 } }, { id: "end", type: "end", data: { label: "End" }, position: { x: 20, y: 0 } }], edges: [{ id: "s-l", source: "start", target: "listen" }, { id: "l-e", source: "listen", target: "end", condition: { fallback: true } }] });
  try {
    const recorded = consent(f.store);
    const call = await f.calls.start(input); assert.equal(call.dialAuthorization?.recordId, recorded.id);
    await f.calls.markAnswered(call.id);
    await f.calls.submitTranscript(call.id, "don't call me back");
    assert.ok(f.store.getConsent(phone)?.revokedAt);
    clearance(f.store, 0);
    await assert.rejects(f.calls.start(input), /opted out/);
    assert.equal(f.originates(), 1);
    assert.throws(() => consent(f.store), /after the recorded opt-out/);
  } finally { await f.calls.shutdown(); }
});

test("consent is rechecked after durability before originate and a concurrent withdrawal blocks the provider effect", async () => {
  class DelayedStore extends InMemoryStore {
    release!: () => void;
    private readonly barrier = new Promise<void>((resolve) => { this.release = resolve; });
    override async flush() { await this.barrier; }
  }
  const store = new DelayedStore(), f = fixture(store); consent(store);
  const pending = f.calls.start(input);
  const rejected = assert.rejects(pending, /opted out/);
  const prior = store.getConsent(phone)!;
  store.saveConsent({ ...prior, id: randomUUID(), revokedAt: now.toISOString() });
  store.release!();
  await rejected; assert.equal(f.originates(), 0);
  await f.calls.shutdown();
});

test("HTTP evidence is authenticated and a campaign records a visible consent skip reason", async (t) => {
  const f = fixture(); t.after(() => f.calls.shutdown());
  const authStore = new InMemoryAuthStore(), password = randomBytes(24).toString("hex");
  await authStore.saveUser({ id: randomUUID(), email: "compliance@example.test", passwordHash: await hashPassword(password), role: "operator" });
  const dialer = new CampaignDialer(f.store, f.calls, { now: () => now }); t.after(() => dialer.close());
  const { app } = createApp({ ...f, classifier: new RuleClassifier(), authStore, campaignDialer: dialer, logger: pino({ level: "silent" }) });
  await request(app).post("/api/compliance/consent").send({}).expect(401);
  const login = await request(app).post("/api/auth/login").send({ email: "compliance@example.test", password }).expect(200);
  const cookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  const refused = await request(app).post("/api/calls").set("Cookie", cookie).send(input).expect(409);
  assert.equal(refused.body.code, "DIAL_NOT_PERMITTED"); assert.equal(f.originates(), 0);
  const imported = await importContacts(f.store, `phone\n${phone}`);
  const campaign = await createCampaign(f.store, { name: "No consent", flowId: input.flowId, callerId: input.callerId, contactIds: [imported.contacts[0].id] });
  await dialer.control(campaign.id, "start"); await dialer.tick(); await dialer.tick();
  const result = await request(app).get(`/api/campaigns/${campaign.id}`).set("Cookie", cookie).expect(200);
  assert.equal(result.body.contacts[0].status, "skipped"); assert.match(result.body.contacts[0].skipReason, /No recorded voice consent/); assert.equal(f.originates(), 0);
  const evidence = { phone, source: "Isolated HTTP fixture evidence", purpose: "voice_marketing", consentedAt: "2026-09-01T00:00:00Z" };
  await request(app).post("/api/compliance/consent").set("Cookie", cookie).send({ ...evidence, consentedAt: "2099-01-01T00:00:00Z" }).expect(400);
  await request(app).post("/api/compliance/consent").set("Cookie", cookie).send(evidence).expect(201);
  assert.equal((await request(app).get(`/api/compliance/${phone}`).set("Cookie", cookie).expect(200)).body.allowed, true);
  await request(app).post("/api/compliance/opt-out").set("Cookie", cookie).send({ phone, source: "Test withdrawal" }).expect(201);
  assert.equal((await request(app).get(`/api/compliance/${phone}`).set("Cookie", cookie).expect(200)).body.allowed, false);
});


test("a withdrawal or shutdown while ESL is busy prevents a queued originate reaching its socket", async () => {
  const { EslClient } = await import("./esl.js");
  const { FreeSwitchEslAdapter } = await import("./telephony.js");
  const { FakeEslServer, fixtureEslPassword, waitFor } = await import("./test-support/fake-esl.js");
  for (const action of ["withdraw", "shutdown"] as const) {
    const fake = await new FakeEslServer().start();
    let release!: () => void;
    const hold = new Promise<string>((resolve) => { release = () => resolve("+OK"); });
    fake.respond = (command) => command === "api status" ? hold : "+OK";
    const adapter = new FreeSwitchEslAdapter(new EslClient({ host: "127.0.0.1", port: fake.port, password: fixtureEslPassword }), true);
    const store = new InMemoryStore(); const record = consent(store);
    const calls = new CallOrchestrator(store, adapter, new RuleClassifier());
    try {
      const busy = adapter.client.command("api status");
      await waitFor(() => fake.commands.includes("api status"));
      const pending = calls.start(input);
      const rejected = assert.rejects(pending, action === "withdraw" ? /opted out/ : /stopped before originate/);
      await waitFor(() => calls.activeCallCount() === 1);
      if (action === "withdraw") { store.saveConsent({ ...record, id: randomUUID(), revokedAt: new Date().toISOString() }); await store.flush(); }
      else calls.beginShutdown();
      release(); await busy; await rejected;
      assert.equal(fake.commands.filter((command) => command.startsWith("bgapi originate")).length, 0);
    } finally { release(); await calls.shutdown(); await fake.close(); }
  }
});

test("older DNC clearance cannot overwrite a newer refusal", () => {
  const store = new InMemoryStore(); clearance(store, 0, false);
  assert.throws(() => clearance(store, 1000), /predates/);
  assert.throws(() => clearance(store, 0), /newer Registry check/);
  assert.throws(() => new ConsentPolicy(store, () => now).authorize(phone), /No Voice Call Register/);
});


test("backdated consent cannot replace the last withdrawal even after a later valid re-consent", () => {
  const store = new InMemoryStore(); const record = consent(store);
  store.saveConsent({ ...record, id: randomUUID(), revokedAt: "2026-09-02T00:00:00Z" });
  store.saveConsent({ ...record, id: randomUUID(), consentedAt: "2026-09-03T00:00:00Z" });
  assert.throws(() => consent(store), /after the recorded opt-out/);
  assert.equal(new ConsentPolicy(store, () => now).authorize(phone).basis, "consent");
});

test("the permission summary surfaces all three registers and the check date from one paid lookup", () => {
  // PDPC bills once per number and returns voice, text and fax together. Withholding
  // two of the three discards data already paid for.
  const store = new InMemoryStore();
  const phone = "+6591234567";
  store.saveDncClearance({
    id: randomUUID(), phone, checkedAt: new Date().toISOString(), recordedAt: new Date().toISOString(),
    cleared: true, source: "Singapore DNC Registry", reference: "105976942",
    evidence: { statusCode: "S000", createdTime: "2026-09-11 16:00:02", validUntil: "2026-10-02T15:59:59.000Z", noVoiceCall: false, noTextMessage: true, noFax: false },
  } as never);

  const [permission] = permissionSummary(store, [phone]);
  assert.equal(permission.dialable, true, "text registration must not block a voice call");
  assert.equal(permission.basis, "dnc");
  assert.deepEqual(permission.registers, { noVoiceCall: false, noTextMessage: true, noFax: false });
  assert.equal(permission.reference, "105976942");
  assert.ok(permission.checkedAt, "the operator must be able to see when it was checked");
});

test("a voice-registered number reports blocked but still shows its registers and reference", () => {
  const store = new InMemoryStore();
  const phone = "+6591234568";
  store.saveDncClearance({
    id: randomUUID(), phone, checkedAt: new Date().toISOString(), recordedAt: new Date().toISOString(),
    cleared: false, source: "Singapore DNC Registry", reference: "105976943",
    evidence: { statusCode: "S000", createdTime: null, validUntil: null, noVoiceCall: true, noTextMessage: false, noFax: false },
  } as never);

  const [permission] = permissionSummary(store, [phone]);
  assert.equal(permission.dialable, false);
  assert.equal(permission.skipReason, "Number is listed on the No Voice Call Register.");
  assert.deepEqual(permission.registers, { noVoiceCall: true, noTextMessage: false, noFax: false });
  assert.equal(permission.reference, "105976943");
});

test("consent-based permission reports the consent date and no registers", () => {
  const store = new InMemoryStore();
  const phone = "+6591234569";
  const consentedAt = new Date(Date.now() - 60_000).toISOString();
  store.saveConsent({ id: randomUUID(), phone, source: "Signed consent form", purpose: "voice_marketing", consentedAt, recordedAt: new Date().toISOString() });

  const [permission] = permissionSummary(store, [phone]);
  assert.equal(permission.basis, "consent");
  assert.equal(permission.checkedAt, consentedAt);
  assert.equal(permission.registers, null, "consent carries no Registry verdict");
  assert.equal(permission.reference, "Signed consent form");
});
