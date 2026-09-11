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
import { CallOrchestrator } from "../orchestrator.js";
import { PrismaStore } from "../prisma-store.js";
import type { TelephonyAdapter } from "../telephony.js";

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
