import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import request from "supertest";
import { createApp } from "./app.js";
import { InMemoryAuthStore, seedAdmin } from "./auth.js";
import { RuleClassifier } from "./classifier.js";
import { reconcileClipStorage } from "./clip-reconciliation.js";
import { config } from "./config.js";
import { CallOrchestrator } from "./orchestrator.js";
import { InMemoryStore } from "./store.js";
import { SimulatedTelephonyAdapter } from "./telephony.js";

function wav() {
  const bytes = Buffer.alloc(44 + 16_000);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24); bytes.writeUInt32LE(16_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(16_000, 40);
  return bytes;
}

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-pipeline-test-"));
  const previous = config.clipStorageDir;
  config.clipStorageDir = directory;
  context.after(async () => { config.clipStorageDir = previous; await rm(directory, { recursive: true, force: true }); });
  const store = new InMemoryStore();
  const authStore = new InMemoryAuthStore();
  const password = randomBytes(24).toString("hex");
  const email = "media@example.test";
  await seedAdmin(authStore, { MKTR_ADMIN_EMAIL: email, MKTR_ADMIN_PASSWORD: password });
  const adapter = new SimulatedTelephonyAdapter();
  const calls = new CallOrchestrator(store, adapter);
  const { app } = createApp({ store, authStore, adapter, calls, classifier: new RuleClassifier(), logger: pino({ level: "silent" }) });
  const login = await request(app).post("/api/auth/login").send({ email, password }).expect(200);
  const cookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  const upload = async () => (await request(app).post("/api/clips/upload").set("Cookie", cookie).field("name", "Uploaded greeting").field("durationSeconds", "123").attach("file", wav(), { filename: "greeting.wav", contentType: "audio/wav" }).expect(201)).body;
  return { app, store, cookie, directory, upload };
}

test("upload derives duration from decoded audio and retains original and normalized files", async (context) => {
  const { app, cookie, directory, upload } = await fixture(context);
  const clip = await upload();
  assert.equal(clip.durationSeconds, 1);
  assert.notEqual(clip.assetUrl, clip.telephonyAssetUrl);
  assert.equal(clip.previewUrl, clip.assetUrl);
  assert.deepEqual(await readFile(path.join(directory, path.basename(clip.assetUrl))), wav());
  assert.equal((await request(app).get(clip.telephonyAssetUrl).set("Cookie", cookie).expect(200)).body.subarray(0, 4).toString(), "RIFF");
  assert.deepEqual(await readdir(path.join(directory, ".uploads")), []);
});

test("invalid magic, malformed multipart and oversized uploads return 400 or 413 and leave no temporary files", async (context) => {
  const { app, cookie, directory } = await fixture(context);
  await request(app).post("/api/clips/upload").set("Cookie", cookie).field("name", "Not audio").field("durationSeconds", "3").attach("file", Buffer.from("Text pretending to be WAV"), { filename: "pretend.wav", contentType: "audio/wav" }).expect(400);
  await request(app).post("/api/clips/upload").set("Cookie", cookie).field("name", "Wrong field").attach("unexpected", wav(), "greeting.wav").expect(400);
  await request(app).post("/api/clips/upload").set("Cookie", cookie).field("name", "Too large").attach("file", Buffer.alloc(10 * 1024 * 1024 + 1), { filename: "large.wav", contentType: "audio/wav" }).expect(413);
  await request(app).post("/api/clips/upload").set("Cookie", cookie).field("name", "").attach("file", wav(), "greeting.wav").expect(400);
  assert.deepEqual(await readdir(path.join(directory, ".uploads")), []);
  assert.deepEqual((await readdir(directory)).filter((name) => name !== ".uploads"), []);
});

test("malformed flow bodies cannot replace a stored graph", async (context) => {
  const { app, cookie, store } = await fixture(context);
  const original = store.getFlow("flow-prospect-intake")!;
  for (const changed of [
    { ...original, nodes: [{ id: 4, type: "shell", position: null, data: { label: "Invalid" } }] },
    { ...original, nodes: [...original.nodes, original.nodes[0]] },
    { ...original, nodes: original.nodes.map((node) => ({ ...node, data: { ...node.data, maxAttempts: -1 } })) },
    { ...original, extra: "unrecognized" }
  ]) await request(app).put(`/api/flows/${original.id}`).set("Cookie", cookie).send(changed).expect(400);
  assert.deepEqual(store.getFlow(original.id), original);
});

test("deleting an unpublished clip removes both files after removing metadata", async (context) => {
  const { app, cookie, directory, store, upload } = await fixture(context);
  const clip = await upload();
  const deleted = await request(app).delete(`/api/clips/${clip.id}`).set("Cookie", cookie).expect(200);
  assert.equal(deleted.body.archived, false);
  assert.equal(store.getClip(clip.id), undefined);
  for (const url of [clip.assetUrl, clip.telephonyAssetUrl]) await assert.rejects(stat(path.join(directory, path.basename(url))), { code: "ENOENT" });
});

test("published-version references archive media even after its current draft and flow are deleted", async (context) => {
  const { app, cookie, store, directory, upload } = await fixture(context);
  const clip = await upload();
  const created = await request(app).post("/api/flows").set("Cookie", cookie).send({ name: "Historical audio" }).expect(201);
  const flow = { ...created.body, nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } },
    { id: "greeting", type: "playClip", position: { x: 1, y: 0 }, data: { label: "Greeting", clipId: clip.id } },
    { id: "end", type: "end", position: { x: 2, y: 0 }, data: { label: "End" } }
  ], edges: [{ id: "start-greeting", source: "start", target: "greeting" }, { id: "greeting-end", source: "greeting", target: "end" }], startNodeId: "start" };
  await request(app).put(`/api/flows/${flow.id}`).set("Cookie", cookie).send(flow).expect(200);
  const published = await request(app).post(`/api/flows/${flow.id}/publish`).set("Cookie", cookie).expect(200);
  const draft = { ...published.body.flow, nodes: [flow.nodes[0], flow.nodes[2]], edges: [{ id: "start-end", source: "start", target: "end" }] };
  await request(app).put(`/api/flows/${flow.id}`).set("Cookie", cookie).send(draft).expect(200);
  await request(app).delete(`/api/flows/${flow.id}`).set("Cookie", cookie).expect(200);
  await request(app).get(`/api/flows/${flow.id}`).set("Cookie", cookie).expect(404);
  await request(app).get(`/api/flows/${flow.id}/versions/1`).set("Cookie", cookie).expect(200);
  const removed = await request(app).delete(`/api/clips/${clip.id}`).set("Cookie", cookie).expect(200);
  assert.equal(removed.body.archived, true);
  assert.equal(store.getClip(clip.id)?.status, "archived");
  for (const url of [clip.assetUrl, clip.telephonyAssetUrl]) assert.ok((await stat(path.join(directory, path.basename(url)))).isFile());
});

test("boot reconciliation quarantines interrupted temporary uploads without moving referenced media", async (context) => {
  const { store, directory, upload } = await fixture(context);
  const clip = await upload();
  await writeFile(path.join(directory, ".uploads", "interrupted.wav"), wav());
  const result = await reconcileClipStorage(store, directory);
  assert.equal(result.quarantinedFiles.length, 1);
  assert.match(result.quarantinedFiles[0], /interrupted\.wav$/);
  assert.deepEqual(await readdir(path.join(directory, ".uploads")), []);
  assert.deepEqual(await readFile(path.join(directory, path.basename(clip.assetUrl))), wav());
});
