import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import pino from "pino";
import request from "supertest";
import { CALLER_IDS } from "../src/lib/domain.js";
import { createApp } from "./app.js";
import { hashPassword, InMemoryAuthStore } from "./auth.js";
import { RuleClassifier } from "./classifier.js";
import { ConsentPolicy, DNC_VALIDITY_MS } from "./compliance.js";
import { importContacts } from "./contacts.js";
import { DncChecker, dncConfig, type RegistryClearance } from "./dnc.js";
import { CallOrchestrator } from "./orchestrator.js";
import { InMemoryStore } from "./store.js";
import { SimulatedTelephonyAdapter } from "./telephony.js";
import { FakeDncGateway, successfulDncReply } from "./test-support/fake-dnc.js";

const logger = pino({ level: "silent" });
const phones = (count: number) => Array.from({ length: count }, (_, index) => `+659${String(1000000 + index)}`);
const evidence = (store: InMemoryStore, phone: string, age = 0, cleared = true, now = new Date()) => store.saveDncClearance({
  id: randomUUID(), phone, checkedAt: new Date(now.getTime() - age).toISOString(), recordedAt: now.toISOString(),
  cleared, source: "Singapore DNC Registry", reference: "Isolated fake evidence"
});
const consent = (store: InMemoryStore, phone: string) => store.saveConsent({
  id: randomUUID(), phone, source: "Isolated recorded consent fixture", purpose: "voice_marketing",
  consentedAt: new Date(Date.now() - 1000).toISOString(), recordedAt: new Date().toISOString()
});
async function fixture(t: TestContext) {
  const gateway = await new FakeDncGateway().start(); t.after(() => gateway.close());
  const store = new InMemoryStore();
  const checker = new DncChecker(store, { ...gateway.config(), logger });
  return { gateway, store, checker };
}
async function httpFixture(t: TestContext, enabled = true) {
  const f = await fixture(t);
  const authStore = new InMemoryAuthStore(), password = randomBytes(24).toString("hex");
  await authStore.saveUser({ id: randomUUID(), email: "dnc@example.test", passwordHash: await hashPassword(password), role: "operator" });
  const adapter = new SimulatedTelephonyAdapter(), classifier = new RuleClassifier();
  const calls = new CallOrchestrator(f.store, adapter, classifier); t.after(() => calls.shutdown());
  const settings = enabled ? f.gateway.config() : dncConfig({ MKTR_DNC_GATEWAY_URL: f.gateway.url, MKTR_DNC_GATEWAY_SECRET: f.gateway.secret });
  const { app } = createApp({ store: f.store, adapter, classifier, calls, authStore, logger, dnc: settings });
  const login = await request(app).post("/api/auth/login").send({ email: "dnc@example.test", password }).expect(200);
  const cookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  const api = {
    get: (path: string) => request(app).get(path).set("Cookie", cookie),
    post: (path: string) => request(app).post(path).set("Cookie", cookie)
  };
  return { ...f, app, api, calls };
}

for (const count of [100, 101]) test(`DNC sends ${count === 100 ? "one signed batch for 100" : "two signed batches for 101"} and stores receipt-time evidence`, async (t) => {
  const f = await fixture(t);
  const before = Date.now();
  const result = await f.checker.scrubPhones(phones(count), count);
  assert.equal(result.checked, count); assert.equal(result.cleared, count); assert.equal(result.failed, 0);
  assert.deepEqual(f.gateway.requests.map((entry) => entry.body.numbers.length), count === 100 ? [100] : [100, 1]);
  for (const entry of f.gateway.requests) {
    assert.equal(entry.signatureValid, true); assert.equal(entry.body.caller, "mktr-bot");
    assert.equal(new Date(entry.body.timestamp).toISOString(), entry.body.timestamp);
    assert.ok(entry.body.numbers.every((number) => /^\d{8}$/.test(number)));
    assert.equal(new Set(entry.body.numbers).size, entry.body.numbers.length);
  }
  const record = f.store.getDncClearance(phones(1)[0]) as RegistryClearance;
  assert.ok(Date.parse(record.checkedAt) >= before && Date.parse(record.checkedAt) <= Date.now());
  assert.equal(record.source, "Singapore DNC Registry"); assert.equal(record.reference, "fixture-transaction-001");
  assert.deepEqual(record.evidence, { statusCode: "S000", createdTime: "2026-09-11 16:00:02", validUntil: "2026-10-11T15:59:59.000Z", noVoiceCall: false, noTextMessage: false, noFax: false });
  assert.throws(() => f.store.saveDncClearance(record), /append-only/);
});

test("recorded consent and fresh positive or negative results spend nothing, including duplicate input", async (t) => {
  const f = await fixture(t); const list = phones(3);
  consent(f.store, list[0]); evidence(f.store, list[1]); evidence(f.store, list[2], 0, false);
  const result = await f.checker.scrubPhones([...list, ...list, "+64212345678", "+64212345678"], 0);
  assert.deepEqual(result, { checked: 0, cleared: 0, registered: 0, skippedAlreadyCovered: 3, skippedNotSingapore: 1, failed: 0, submitted: 0 });
  assert.equal(f.gateway.requests.length, 0);
});

test("expired and future evidence do not hide paid eligibility; a stale credit count sends nothing", async (t) => {
  const f = await fixture(t); const list = phones(3); const now = new Date();
  evidence(f.store, list[0], DNC_VALIDITY_MS, true, now);
  evidence(f.store, list[1], -1000, true, now);
  f.store.saveConsent({ ...consent(f.store, list[2]), id: randomUUID(), consentedAt: new Date(Date.now() + 60_000).toISOString() });
  const result = await f.checker.scrubPhones(list, 0);
  assert.equal(result.failed, 3); assert.equal(result.failure?.statusCode, "preview_changed");
  assert.equal(f.gateway.requests.length, 0);
  const expired = await f.checker.scrubPhones([list[0]], 1);
  assert.equal(expired.checked, 1);
});

test("deduplication and simultaneous checks share coverage and spend only once", async (t) => {
  const f = await fixture(t); const list = phones(2);
  const results = await Promise.all([f.checker.scrubPhones([...list, ...list], 2), f.checker.scrubPhones(list, 2)]);
  assert.equal(f.gateway.requests.length, 1);
  assert.deepEqual(f.gateway.requests[0].body.numbers, list.map((phone) => phone.slice(3)));
  assert.equal(results[0].checked, 2); assert.equal(results[1].skippedAlreadyCovered, 2);
});

test("every non-S000 status writes zero clearances and stops before later batches", async (t) => {
  const f = await fixture(t);
  for (const [status, httpStatus] of [["S301", 402], ["S401", 502], ["S402", 502], ["S404", 502], ["S501", 503], ["dnc_unavailable", 503], ["budget_exceeded", 429], ["unexpected_status", 200]] as const) {
    for (const shape of ["top", "data", "error"] as const) {
      const before = f.gateway.requests.length;
      f.gateway.respond = (_body, response) => response.writeHead(httpStatus).end(JSON.stringify(shape === "top" ? { success: false, statusCode: status } : { success: false, [shape]: { statusCode: status } }));
      const result = await f.checker.scrubPhones(phones(101), 101);
      assert.equal(result.checked, 0); assert.equal(result.failed, 101);
      assert.equal(result.failure?.statusCode, status); assert.equal(result.failure?.httpStatus, httpStatus);
      assert.equal(f.gateway.requests.length - before, 1);
      assert.ok(phones(101).every((phone) => !f.store.getDncClearance(phone)));
    }
  }
});

test("partial, duplicate, extra, wrong-number and ambiguous S000 replies write zero clearance records", async (t) => {
  const f = await fixture(t);
  const valid = () => successfulDncReply(phones(2).map((phone) => phone.slice(3)));
  const partial = valid(); partial.data.results.pop();
  const duplicate = valid(); duplicate.data.results[1] = duplicate.data.results[0];
  const wrong = valid(); wrong.data.results[1].number = "89999999";
  const extra = valid(); extra.data.results.push({ ...extra.data.results[0], number: "89999999" });
  const missingVoice = valid() as unknown as { data: { results: Record<string, unknown>[] } }; delete missingVoice.data.results[0].noVoiceCall;
  const nullVoice = valid() as unknown as { data: { results: Record<string, unknown>[] } }; nullVoice.data.results[0].noVoiceCall = null;
  const stringVoice = valid() as unknown as { data: { results: Record<string, unknown>[] } }; stringVoice.data.results[0].noVoiceCall = "false";
  const noReference = valid(); noReference.data.transactionId = "";
  const noValidity = valid(); noValidity.data.validUntil = "unknown";
  for (const body of [partial, duplicate, wrong, extra, missingVoice, nullVoice, stringVoice, noReference, noValidity, { ...valid(), success: false }, { registered: false }]) {
    f.gateway.respond = (_request, response) => response.end(JSON.stringify(body));
    const result = await f.checker.scrubPhones(phones(2), 2);
    assert.equal(result.checked, 0); assert.equal(result.failure?.statusCode, "invalid_response");
    assert.ok(phones(2).every((phone) => !f.store.getDncClearance(phone)));
  }
  for (const [httpStatus, body] of [[200, "not JSON"], [503, JSON.stringify(valid())], [302, JSON.stringify(valid())], [200, " ".repeat(129000)]] as const) {
    f.gateway.respond = (_request, response) => response.writeHead(httpStatus, { Location: f.gateway.url }).end(body);
    const before = f.gateway.requests.length;
    const result = await f.checker.scrubPhones(phones(2), 2);
    assert.equal(f.gateway.requests.length, before + 1); assert.equal(result.checked, 0);
    assert.ok(phones(2).every((phone) => !f.store.getDncClearance(phone)));
  }
});

test("a later failed batch keeps only earlier complete S000 evidence and reports the unchecked remainder", async (t) => {
  const f = await fixture(t);
  f.gateway.respond = (body, response) => response.end(JSON.stringify(f.gateway.requests.length === 1 ? successfulDncReply(body.numbers) : { success: false, statusCode: "S301" }));
  const result = await f.checker.scrubPhones(phones(201), 201);
  assert.equal(f.gateway.requests.length, 2); assert.equal(result.checked, 100); assert.equal(result.failed, 101);
  assert.ok(phones(100).every((phone) => f.store.getDncClearance(phone)?.cleared));
  assert.ok(phones(201).slice(100).every((phone) => !f.store.getDncClearance(phone)));
});

test("voice registration refuses the existing dial gate; text and fax registration still allow a voice dial", async (t) => {
  const f = await fixture(t); const list = phones(3);
  f.gateway.respond = (body, response) => {
    const reply = successfulDncReply(body.numbers);
    reply.data.results[0].noVoiceCall = true;
    reply.data.results[1].noTextMessage = true; reply.data.results[1].noFax = true;
    response.end(JSON.stringify(reply));
  };
  const result = await f.checker.scrubPhones(list, 3);
  assert.equal(result.registered, 1); assert.equal(result.cleared, 2);
  assert.equal(f.store.getDncClearance(list[0])?.cleared, false);
  assert.throws(() => new ConsentPolicy(f.store).authorize(list[0]), { message: "Number is listed on the No Voice Call Register." });
  const calls = new CallOrchestrator(f.store, new SimulatedTelephonyAdapter(), new RuleClassifier()); t.after(() => calls.shutdown());
  await assert.rejects(calls.start({ destination: list[0], callerId: CALLER_IDS[0], flowId: "flow-prospect-intake" }), /Number is listed on the No Voice Call Register/);
  const call = await calls.start({ destination: list[1], callerId: CALLER_IDS[0], flowId: "flow-prospect-intake" });
  assert.equal(call.dialAuthorization?.basis, "dnc"); await calls.stop(call.id);
  f.store.saveConsent({ ...consent(f.store, list[2]), id: randomUUID(), revokedAt: new Date().toISOString() });
  await assert.rejects(calls.start({ destination: list[2], callerId: CALLER_IDS[0], flowId: "flow-prospect-intake" }), /opted out/);
});

test("free HTTP preview shares all CSV validation and deduplication with import and writes nothing", async (t) => {
  const f = await httpFixture(t); const list = phones(4);
  await importContacts(f.store, `phone\n${list[0]}`);
  consent(f.store, list[1]); evidence(f.store, list[2], 0, false);
  const csv = `\uFEFFname,phone\r\nExisting,${list[0]}\r\n"Jo, Tan",${list[1].slice(3)}\r\nDuplicate,${list[1]}\r\nCovered,${list[2]}\r\nNew,${list[3]}\r\nInternational,0064 212345678\r\n`;
  const preview = await f.api.post("/api/contacts/preview").send({ csv }).expect(200);
  assert.deepEqual(preview.body, { imported: 4, duplicates: 2, needsCheck: 1, alreadyCovered: 2, notSingapore: 1, credits: 1, dncEnabled: true });
  assert.equal(f.store.listContacts().length, 1); assert.equal(f.gateway.requests.length, 0); assert.equal(f.store.getDncClearance(list[3]), undefined);
  for (const csv of ["phone\n91234000\ninvalid", "name,phone\n\"Unclosed,91234004", "phone,phone\n91234001,91234002", "phone\n" + "91234000\n".repeat(1001)]) {
    const a = await f.api.post("/api/contacts/preview").send({ csv }).expect(400);
    const b = await f.api.post("/api/contacts/import").send({ csv, maxDncCredits: 1000 }).expect(400);
    assert.deepEqual(a.body, b.body);
  }
  const imported = await f.api.post("/api/contacts/import").send({ csv, maxDncCredits: preview.body.credits }).expect(201);
  assert.equal(imported.body.imported, preview.body.imported); assert.equal(imported.body.duplicates, preview.body.duplicates);
  assert.equal(imported.body.dnc.checked, 1); assert.equal(imported.body.dnc.skippedAlreadyCovered, 2);
  assert.equal(f.gateway.requests.length, 1);
});

test("with the flag unset, import retains its exact response and validation and never calls the gateway", async (t) => {
  const f = await httpFixture(t, false); const csv = "name,phone\nLegacy contact,91234444\nDuplicate,+6591234444";
  const imported = await f.api.post("/api/contacts/import").send({ csv }).expect(201);
  assert.deepEqual(Object.keys(imported.body), ["imported", "duplicates", "contacts"]);
  assert.deepEqual(imported.body, { imported: 1, duplicates: 1, contacts: f.store.listContacts() });
  const preview = await f.api.post("/api/contacts/preview").send({ csv: "phone\n91234445" }).expect(200);
  assert.equal(preview.body.credits, 0); assert.equal(preview.body.dncEnabled, false);
  await f.api.post("/api/contacts/import").send({ csv, maxDncCredits: 1 }).expect(400);
  await f.api.post("/api/compliance/dnc/check").send({ phone: "+6591234444", maxCredits: 1 }).expect(503);
  assert.equal(f.gateway.requests.length, 0); assert.equal(f.store.getDncClearance("+6591234444"), undefined);
});

test("an unreachable gateway never fails or rolls back an import and leaves new contacts undialable", async (t) => {
  const f = await httpFixture(t); await f.gateway.close();
  const result = await f.api.post("/api/contacts/import").send({ csv: "phone\n91234446", maxDncCredits: 1 }).expect(201);
  assert.equal(result.body.imported, 1); assert.equal(result.body.dnc.failed, 1);
  assert.equal(result.body.dnc.failure.statusCode, "gateway_unreachable");
  assert.equal(f.store.listContacts().length, 1); assert.equal(f.store.getDncClearance("+6591234446"), undefined);
  await f.api.post("/api/calls").send({ destination: "+6591234446", callerId: CALLER_IDS[0], flowId: "flow-prospect-intake" }).expect(409);
  assert.equal(f.calls.activeCallCount(), 0);
});

test("a lost or timed-out reply writes nothing and is never automatically retried", async (t) => {
  const f = await fixture(t);
  for (const mode of ["lost", "timeout"] as const) {
    f.gateway.respond = (_body, response) => { if (mode === "lost") response.destroy(); };
    const checker = new DncChecker(f.store, { ...f.gateway.config(), logger, timeoutMs: 100 });
    const before = f.gateway.requests.length;
    const result = await checker.scrubPhones(phones(101), 101);
    assert.equal(result.failure?.statusCode, "gateway_unreachable"); assert.equal(result.failure?.billingUncertain, true);
    assert.equal(result.checked, 0); assert.equal(result.failed, 101); assert.equal(f.gateway.requests.length, before + 1);
    assert.ok(phones(101).every((phone) => !f.store.getDncClearance(phone)));
  }
});

test("operator routes require sessions and explicit credit limits; summary covers every contact in one request", async (t) => {
  const f = await httpFixture(t); const list = phones(5);
  for (const [path, body] of [["/api/contacts/preview", { csv: "phone\n91234447" }], ["/api/compliance/dnc/check", { phone: list[0], maxCredits: 1 }]] as const) await request(f.app).post(path).send(body).expect(401);
  await request(f.app).get("/api/compliance/summary").expect(401);
  await f.api.post("/api/compliance/dnc/check").send({ phone: list[0] }).expect(400);
  await f.api.post("/api/compliance/dnc/check").send({ phone: "+64212345678", maxCredits: 1 }).expect(400);
  await f.api.post("/api/contacts/import").send({ csv: `phone\n${list[0]}` }).expect(400);
  assert.equal(f.gateway.requests.length, 0);
  await importContacts(f.store, "phone\n" + list.join("\n"));
  consent(f.store, list[0]);
  const expiring = evidence(f.store, list[1], 19 * 24 * 60 * 60 * 1000);
  evidence(f.store, list[2], 0, false);
  const granted = consent(f.store, list[4]); f.store.saveConsent({ ...granted, id: randomUUID(), revokedAt: new Date().toISOString() });
  const summary = await f.api.get("/api/compliance/summary").expect(200);
  assert.equal(summary.body.contacts.length, list.length);
  assert.deepEqual(summary.body.contacts.map((entry: { dialable: boolean }) => entry.dialable), [true, true, false, false, false]);
  assert.equal(summary.body.contacts[0].basis, "consent"); assert.equal(summary.body.contacts[1].basis, "dnc");
  assert.equal(summary.body.contacts[1].clearanceExpiresAt, new Date(Date.parse(expiring.checkedAt) + DNC_VALIDITY_MS).toISOString());
  assert.equal(summary.body.contacts[2].skipReason, "Number is listed on the No Voice Call Register.");
  assert.match(summary.body.contacts[4].skipReason, /opted out/);
  assert.ok(!JSON.stringify(summary.body).includes(f.gateway.secret));
  const single = await f.api.post("/api/compliance/dnc/check").send({ phone: list[3], maxCredits: 1 }).expect(200);
  assert.equal(single.body.checked, 1); assert.equal(f.gateway.requests.length, 1);
  const covered = await f.api.post("/api/compliance/dnc/check").send({ phone: list[3], maxCredits: 1 }).expect(200);
  assert.equal(covered.body.skippedAlreadyCovered, 1); assert.equal(f.gateway.requests.length, 1);
});

test("a permission change after preview cannot increase paid credits; the contacts still import", async (t) => {
  const f = await httpFixture(t); const phone = phones(1)[0]; const record = consent(f.store, phone);
  const csv = `phone\n${phone}`;
  const preview = await f.api.post("/api/contacts/preview").send({ csv }).expect(200);
  assert.equal(preview.body.credits, 0);
  f.store.saveConsent({ ...record, id: randomUUID(), revokedAt: new Date().toISOString() });
  const result = await f.api.post("/api/contacts/import").send({ csv, maxDncCredits: preview.body.credits }).expect(201);
  assert.equal(result.body.imported, 1); assert.equal(result.body.dnc.failure.statusCode, "preview_changed");
  assert.equal(f.gateway.requests.length, 0); assert.equal(f.store.getDncClearance(phone), undefined);
});
