import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import type { FlowDefinition } from "../../src/lib/domain.js";
import { reconcileClipStorage } from "../clip-reconciliation.js";
import { FixtureCallOrchestrator as CallOrchestrator } from "./fixture-orchestrator.js";
import { PrismaStore } from "../prisma-store.js";
import type { TelephonyAdapter } from "../telephony.js";
import { CampaignDialer, createCampaign } from "../campaigns.js";
import { importContacts } from "../contacts.js";
import type { RegistryClearance } from "../dnc.js";
import { OutcomeDispatcher } from "../outcome-delivery.js";

const databaseUrl = process.env.DATABASE_TEST_URL;
if (!databaseUrl) throw new Error("Run this suite through npm run test:db with a disposable test database.");
const nextId = () => randomUUID();
const flow = (): FlowDefinition => ({
  id: nextId(), name: "Durable two-node reply", status: "published", version: 1, startNodeId: "start", updatedAt: new Date().toISOString(),
  nodes: [
    { id: "start", type: "start", data: { label: "Start" }, position: { x: 0, y: 0 } },
    { id: "listen", type: "listen", data: { label: "Reply" }, position: { x: 200, y: 0 } },
    { id: "original-end", type: "end", data: { label: "Original ending" }, position: { x: 400, y: 0 } }
  ],
  edges: [{ id: "start-listen", source: "start", target: "listen" }, { id: "fallback", source: "listen", target: "original-end", label: "Original route", condition: { fallback: true } }]
});
const fakeAdapter = (): TelephonyAdapter => ({ mode: "freeswitch", configured: true,
  async originate(_input, providerCallId) { return { providerCallId: providerCallId! }; }, async playClip() {}, async hangup() {} });

// Node's top-level tests run sequentially; each test owns unique IDs and cleanup.
test("PrismaStore restores active calls and routes with their immutable published graph after restart", async () => {
  const store = await PrismaStore.connect(databaseUrl);
  const original = store.saveFlow(flow());
  await store.flush();
  const adapter = fakeAdapter();
  const calls = new CallOrchestrator(store, adapter);
  const call = await calls.start({ flowId: original.id, destination: "+6591234567", callerId: "+6562773211" });
  await calls.markAnswered(call.id);
  await store.flush();
  const active = store.getCall(call.id)!;
  assert.equal(active.status, "listening");
  const revised = { ...original, name: "Revised after origination", nodes: original.nodes.map((node) => node.id === "original-end" ? { ...node, id: "new-end" } : node), edges: original.edges.map((edge) => edge.target === "original-end" ? { ...edge, target: "new-end", label: "Revised route" } : edge), version: 2 };
  store.saveFlow(revised);
  await store.flush();
  await store.close();

  const restored = await PrismaStore.connect(databaseUrl);
  const recoveredCalls = new CallOrchestrator(restored, adapter);
  try {
    assert.equal(recoveredCalls.activeCallCount(), 1);
    assert.deepEqual(JSON.parse(JSON.stringify(recoveredCalls.get(call.id))), JSON.parse(JSON.stringify(active)));
    assert.deepEqual(restored.getFlowVersion(original.id, 1), original);
    const ended = await recoveredCalls.submitTranscript(call.id, "yes");
    await restored.flush();
    assert.ok(ended.events.some((event) => event.type === "branch_selected" && event.title === "Branch selected: Original route"));
    assert.ok(!ended.events.some((event) => event.title === "Branch selected: Revised route"));
    assert.equal(ended.status, "ended");
    assert.equal(ended.flowVersion, 1);
    assert.equal(recoveredCalls.activeCallCount(), 0);
    assert.throws(() => restored.saveFlow({ ...original, name: "Rewrite history" }), /immutable/);
  } finally { await restored.close(); }

  const sql = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const rows = await sql.callEvent.findMany({ where: { callId: call.id } });
    assert.equal(rows.filter((event) => event.type === "queued").length, 1);
    await assert.rejects(sql.flowVersion.update({ where: { flowId_version: { flowId: original.id, version: 1 } }, data: { graph: {} } }), /immutable/);
  } finally { await sql.$disconnect(); }
});

test("boot orphan sweep preserves referenced bytes, quarantines orphan bytes, and archives missing clip records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-db-clips-"));
  const store = await PrismaStore.connect(databaseUrl);
  const file = `${nextId()}.wav`;
  const missing = `${nextId()}.wav`;
  const orphan = `${nextId()}.wav`;
  const bytes = Buffer.from("fixture audio bytes retained exactly");
  try {
    await writeFile(path.join(directory, file), bytes);
    await writeFile(path.join(directory, orphan), bytes);
    const kept = store.createClip("Present", 2, { format: "wav", assetUrl: `/media/clips/${file}`, originalFilename: "present.wav" });
    const archived = store.createClip("Missing", 2, { format: "wav", assetUrl: `/media/clips/${missing}`, originalFilename: "missing.wav" });
    await store.flush();
    const result = await reconcileClipStorage(store, directory);
    assert.ok(result.archivedClipIds.includes(archived.id));
    assert.equal(result.quarantinedFiles.length, 1);
    assert.deepEqual(await readFile(path.join(directory, file)), bytes);
    assert.deepEqual(await readFile(path.join(directory, "orphaned", result.quarantinedFiles[0])), bytes);
    assert.equal(store.getClip(kept.id)?.status, "ready");
    await store.close();
    const restored = await PrismaStore.connect(databaseUrl);
    try { assert.equal(restored.getClip(archived.id)?.status, "archived"); assert.equal(restored.getClip(kept.id)?.assetUrl, `/media/clips/${file}`); }
    finally { await restored.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed event transaction rolls back call state and closes the durability gate until restart", async () => {
  const sql = new PrismaClient({ datasourceUrl: databaseUrl });
  const store = await PrismaStore.connect(databaseUrl);
  const original = store.saveFlow(flow());
  await store.flush();
  const id = nextId();
  try {
    // External database fault injection at the event-write boundary, after the Call upsert.
    await sql.$executeRawUnsafe('CREATE FUNCTION mktr_test_reject_event() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION \'Injected event storage failure\'; END; $$ LANGUAGE plpgsql');
    await sql.$executeRawUnsafe('CREATE TRIGGER mktr_test_reject_event BEFORE INSERT ON "CallEvent" FOR EACH ROW EXECUTE FUNCTION mktr_test_reject_event()');
    store.saveCall({ id, providerCallId: nextId(), destination: "+6591234567", callerId: "+6562773211", flowId: original.id, flowVersion: 1, status: "queued", createdAt: new Date().toISOString(), events: [{ id: nextId(), type: "queued", timestamp: new Date().toISOString(), title: "Queued" }] });
    await assert.rejects(store.flush(), /Postgres write failed/);
    assert.throws(() => store.createDraft("Must not be acknowledged"), /Postgres write failed/);
    assert.equal(await sql.call.findUnique({ where: { id } }), null);
    await assert.rejects(store.close(), /Postgres write failed/);
  } finally {
    await sql.$executeRawUnsafe('DROP TRIGGER IF EXISTS mktr_test_reject_event ON "CallEvent"');
    await sql.$executeRawUnsafe('DROP FUNCTION IF EXISTS mktr_test_reject_event()');
    await sql.$disconnect();
  }
});

async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port; await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "exit"); child.kill("SIGTERM"); await closed;
}

test("API startup migrates and authenticated flow, clip, call and session survive process restart; version endpoint is exact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-db-api-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString("hex");
  const email = `${nextId()}@example.test`;
  let child: ChildProcess | undefined;
  let output = "";
  const start = async () => {
    child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { env: { ...process.env, DATABASE_URL: databaseUrl, MKTR_STORE: "prisma", MKTR_TELEPHONY_MODE: "simulated", MKTR_ADMIN_EMAIL: email, MKTR_ADMIN_PASSWORD: password, PORT: String(port), MKTR_CLIP_STORAGE_DIR: directory, MKTR_CLASSIFIER_MODE: "rules", LOG_LEVEL: "error" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk) => { output += String(chunk); }); child.stderr?.on("data", (chunk) => { output += String(chunk); });
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(`API exited before readiness: ${output}`);
      try { if ((await fetch(`${base}/api/health`)).ok) return; }
      catch (error) { if (!(error instanceof TypeError)) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`API readiness timed out: ${output}`);
  };
  try {
    await start();
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const api = async (route: string, method = "GET", body?: unknown) => {
      const response = await fetch(base + route, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.ok(response.ok, `${method} ${route}: ${response.status} ${await response.clone().text()}`);
      return response.json();
    };
    const draft = await api("/api/flows", "POST", { name: "API survives restart" }) as FlowDefinition;
    const edited = await api(`/api/flows/${draft.id}`, "PUT", { ...flow(), id: draft.id, name: "An edited durable graph" }) as FlowDefinition;
    const publication = await api(`/api/flows/${draft.id}/publish`, "POST", {});
    await api("/api/compliance/consent", "POST", { phone: "+6591234567", source: "Isolated simulator restart fixture", consentedAt: new Date(Date.now() - 1000).toISOString(), purpose: "voice_marketing" });
    const call = await api("/api/calls", "POST", { destination: "+6591234567", callerId: "+6562773211", flowId: draft.id });
    await api(`/api/calls/${call.id}/end`, "POST", {});
    const clip = await api("/api/clips", "POST", { name: "Durable clip metadata", durationSeconds: 2 });
    await stop(child!);
    await start();
    assert.equal((await api("/api/auth/session")).user.email, email);
    assert.equal((await api(`/api/flows/${draft.id}`)).name, edited.name);
    assert.deepEqual(await api(`/api/flows/${draft.id}/versions/${call.flowVersion}`), publication.flow);
    assert.equal((await api(`/api/calls/${call.id}`)).flowVersion, publication.flow.version);
    assert.ok((await api("/api/bootstrap")).clips.some((entry: { id: string }) => entry.id === clip.id));
    await api("/api/auth/logout", "POST", {});
    assert.equal((await fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    if (child) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("flow deletion preserves published history and referenced clips while unreferenced clip deletion is durable", async () => {
  const store = await PrismaStore.connect(databaseUrl);
  const clip = store.createClip("Published historical clip", 2);
  const disposable = store.createClip("Unreferenced clip", 2);
  const definition = flow();
  definition.nodes.push({ id: "historical-clip", type: "playClip", data: { label: "Historical audio", clipId: clip.id }, position: { x: 300, y: 0 } });
  const original = store.saveFlow(definition);
  await store.flush();
  assert.equal(store.isClipReferencedByPublishedVersion(clip.id), true);
  assert.throws(() => store.deleteClip(clip.id), /Archive/);
  store.saveClip({ ...clip, status: "archived" });
  assert.equal(store.deleteFlow(original.id)?.id, original.id);
  assert.equal(store.deleteClip(disposable.id)?.id, disposable.id);
  await store.flush();
  await store.close();
  const restored = await PrismaStore.connect(databaseUrl);
  try {
    assert.equal(restored.getFlow(original.id), undefined);
    assert.deepEqual(restored.getFlowVersion(original.id, 1), original);
    assert.equal(restored.getClip(clip.id)?.status, "archived");
    assert.equal(restored.getClip(disposable.id), undefined);
  } finally { await restored.close(); }
});

test("campaign contacts, pins, attempt state and linked call survive Postgres restart with attempt persisted before originate", async () => {
  const store = await PrismaStore.connect(databaseUrl);
  const sql = new PrismaClient({ datasourceUrl: databaseUrl });
  const original = store.saveFlow(flow());
  await store.flush();
  const imported = await importContacts(store, `name,phone\nDurable campaign contact,+658${String(Date.now()).slice(-7)}`);
  const campaign = await createCampaign(store, { name: "Durable campaign", flowId: original.id, callerId: "+6562773211", contactIds: [imported.contacts[0].id] });
  let persistedBeforeOriginate = false;
  const calls = new CallOrchestrator(store, { ...fakeAdapter(), async originate(_input, providerCallId) {
    const attempt = await sql.campaignContact.findFirst({ where: { campaignId: campaign.id } });
    persistedBeforeOriginate = attempt?.status === "dialing" && attempt.attempts === 1;
    return { providerCallId: providerCallId! };
  } });
  const dialer = new CampaignDialer(store, calls, { now: () => new Date("2026-09-11T01:00:00Z") });
  await dialer.control(campaign.id, "start"); await dialer.tick();
  assert.equal(persistedBeforeOriginate, true);
  await dialer.control(campaign.id, "pause");
  const entry = store.listCampaignContacts(campaign.id)[0];
  await calls.stop(entry.lastCallId!);
  const call = store.getCall(entry.lastCallId!)!;
  // Public store contract preserves campaign metadata as well as all call history.
  store.saveCall({ ...call, campaignId: campaign.id, contactId: imported.contacts[0].id });
  store.saveCampaignContact({ ...entry, status: "pending", outcome: "busy", nextAttemptAt: "2026-09-11T01:01:00Z" });
  await store.flush();
  const expectedCampaign = store.getCampaign(campaign.id), expectedContact = store.listCampaignContacts(campaign.id)[0];
  await dialer.close(); await calls.shutdown(); await store.close();
  const restored = await PrismaStore.connect(databaseUrl);
  try {
    assert.deepEqual(restored.getCampaign(campaign.id), expectedCampaign);
    assert.deepEqual(restored.listCampaignContacts(campaign.id)[0], JSON.parse(JSON.stringify(expectedContact)));
    assert.equal(restored.findContactByPhone(imported.contacts[0].phone)?.id, imported.contacts[0].id);
    assert.equal(restored.getCall(call.id)?.campaignId, campaign.id);
    const row = await sql.call.findUniqueOrThrow({ where: { id: call.id }, include: { campaign: true, contact: true } });
    assert.equal(row.campaign?.flowVersion, original.version); assert.equal(row.contact?.phone, imported.contacts[0].phone);
    assert.equal(restored.getCampaign(campaign.id)?.status, "paused");
  } finally { await restored.close(); await sql.$disconnect(); }
});

test("append-only consent and DNC evidence survive Postgres restart and a withdrawal remains authoritative", async () => {
  const { ConsentPolicy } = await import("../compliance.js");
  const store = await PrismaStore.connect(databaseUrl), sql = new PrismaClient({ datasourceUrl: databaseUrl });
  const phone = "+6587345601", now = new Date().toISOString();
  const consent = store.saveConsent({ id: randomUUID(), phone, source: "Isolated database fixture", consentedAt: now, recordedAt: now, purpose: "voice_marketing" });
  store.saveDncClearance({ id: randomUUID(), phone, checkedAt: now, recordedAt: now, cleared: true, source: "Singapore DNC Registry", reference: "Fake fixture only" });
  await store.flush();
  assert.equal(new ConsentPolicy(store).authorize(phone).basis, "consent");
  const withdrawal = store.saveConsent({ ...consent, id: randomUUID(), revokedAt: now }); await store.flush();
  await assert.rejects(sql.consentRecord.update({ where: { id: consent.id }, data: { phone: "+6587345602" } }), /append-only/);
  await store.close();
  const restored = await PrismaStore.connect(databaseUrl);
  try {
    assert.deepEqual(restored.getConsent(phone), withdrawal);
    assert.equal(restored.getDncClearance(phone)?.cleared, true);
    assert.throws(() => new ConsentPolicy(restored).authorize(phone), /opted out/);
    assert.equal(await sql.consentRecord.count({ where: { phone } }), 2);
  } finally { await restored.close(); await sql.$disconnect(); }
});

test("automatic S000 Registry evidence survives Postgres restart in the append-only JSON snapshot", async () => {
  const { DncChecker } = await import("../dnc.js");
  const { FakeDncGateway } = await import("./fake-dnc.js");
  const gateway = await new FakeDncGateway().start();
  const store = await PrismaStore.connect(databaseUrl);
  const sql = new PrismaClient({ datasourceUrl: databaseUrl });
  const phone = "+6587345699";
  let closed = false;
  try {
    const result = await new DncChecker(store, gateway.config()).scrubPhones([phone], 1);
    assert.equal(result.checked, 1);
    const record = store.getDncClearance(phone)!;
    const row = await sql.dncClearance.findUniqueOrThrow({ where: { id: record.id } });
    assert.deepEqual(row.snapshot, record);
    assert.deepEqual((row.snapshot as RegistryClearance).evidence, { statusCode: "S000", createdTime: "2026-09-11 16:00:02", validUntil: "2026-10-11T15:59:59.000Z", noVoiceCall: false, noTextMessage: false, noFax: false });
    await assert.rejects(sql.dncClearance.update({ where: { id: record.id }, data: { snapshot: {} } }), /append-only/);
    await store.close();
    closed = true;
    const restored = await PrismaStore.connect(databaseUrl);
    try { assert.deepEqual(restored.getDncClearance(phone), record); }
    finally { await restored.close(); }
  } finally { if (!closed) await store.close(); await sql.$disconnect(); await gateway.close(); }
});

test("outcome outbox survives Postgres restart with stable signed payload and persisted retry count", async () => {
  const store = await PrismaStore.connect(databaseUrl);
  const original = store.saveFlow(flow()); await store.flush();
  const contact = (await importContacts(store, `phone\n+659${String(Date.now()).slice(-7)}`)).contacts[0];
  const campaign = await createCampaign(store, { name: "Durable outcomes", flowId: original.id, callerId: "+6562773211", contactIds: [contact.id] });
  store.saveCampaign({ ...campaign, outcomeWebhookUrl: "https://receiver.example.test/outcomes", outcomeWebhookEnabledAt: "2026-09-11T01:00:00Z" });
  const callId = nextId();
  store.saveCall({ id: callId, providerCallId: nextId(), destination: contact.phone, callerId: campaign.callerId, flowId: original.id, flowVersion: 1, campaignId: campaign.id, contactId: contact.id, createdAt: "2026-09-11T01:01:00Z", endedAt: "2026-09-11T01:02:00Z", status: "ended", endReason: "USER_BUSY", outcome: "busy", events: [] });
  await store.flush();
  const secret = randomBytes(32).toString("hex"), allowedHosts = ["receiver.example.test"];
  const first = new OutcomeDispatcher(store, { secret, allowedHosts, now: () => new Date("2026-09-11T01:03:00Z"), async fetch() { return new Response(null, { status: 503 }); } });
  await first.tick(); await first.close();
  const expected = store.listOutcomeDeliveries(campaign.id)[0]; assert.equal(expected.attempts, 1); assert.equal(expected.status, "pending");
  await store.close();
  const restored = await PrismaStore.connect(databaseUrl);
  let sent = 0;
  const second = new OutcomeDispatcher(restored, { secret, allowedHosts, now: () => new Date("2026-09-11T01:04:00Z"), async fetch(_url, init) {
    sent++; assert.equal(String(init?.body), expected.payload); assert.equal(new Headers(init?.headers).get("X-MKTR-Delivery"), expected.id);
    const sql = new PrismaClient({ datasourceUrl: databaseUrl });
    try { assert.equal((await sql.outcomeDelivery.findUniqueOrThrow({ where: { id: expected.id } })).attempts, 2); }
    finally { await sql.$disconnect(); }
    return new Response(null, { status: 204 });
  } });
  try {
    assert.equal(restored.getCampaign(campaign.id)?.outcomeWebhookUrl, "https://receiver.example.test/outcomes");
    assert.equal(restored.getCall(callId)?.outcome, "busy");
    await second.tick(); await second.tick(); assert.equal(sent, 1);
    assert.equal(restored.listOutcomeDeliveries(campaign.id)[0].status, "delivered");
    assert.throws(() => restored.saveOutcomeDelivery({ ...restored.listOutcomeDeliveries(campaign.id)[0], payload: "{}" }), /immutable/);
  } finally { await second.close(); await restored.close(); }
});
