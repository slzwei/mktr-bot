import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import request from "supertest";
import { createApp } from "./app.js";
import { InMemoryAuthStore, seedAdmin } from "./auth.js";
import { RuleClassifier } from "./classifier.js";
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

test("authenticated WAV upload uses a generated path and serves audio ranges with operator authorization", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-upload-test-"));
  const previousDirectory = config.clipStorageDir;
  config.clipStorageDir = directory;
  context.after(async () => { config.clipStorageDir = previousDirectory; await rm(directory, { recursive: true, force: true }); });
  const store = new InMemoryStore();
  const authStore = new InMemoryAuthStore();
  const password = randomBytes(24).toString("hex");
  const email = "uploads@example.test";
  await seedAdmin(authStore, { MKTR_ADMIN_EMAIL: email, MKTR_ADMIN_PASSWORD: password });
  const adapter = new SimulatedTelephonyAdapter();
  const calls = new CallOrchestrator(store, adapter);
  const { app } = createApp({ store, authStore, adapter, calls, classifier: new RuleClassifier(), logger: pino({ level: "silent" }) });
  const login = await request(app).post("/api/auth/login").send({ email, password }).expect(200);
  const cookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  const uploaded = await request(app).post("/api/clips/upload").set("Cookie", cookie).field("name", "Test upload").field("durationSeconds", "1").attach("file", wav(), { filename: "user-name.wav", contentType: "audio/wav" }).expect(201);
  assert.match(uploaded.body.assetUrl, /^\/media\/clips\/[a-f0-9-]+\.wav$/);
  assert.equal(uploaded.body.durationSeconds, 1);
  const saved = await readFile(path.join(directory, uploaded.body.assetUrl.split("/").at(-1)));
  assert.equal(saved.subarray(0, 4).toString(), "RIFF");
  await request(app).get(uploaded.body.assetUrl).expect(401);
  const range = await request(app).get(uploaded.body.assetUrl).set("Cookie", cookie).set("Range", "bytes=0-15").expect(206);
  assert.match(range.headers["content-type"], /audio\/wav/);
  assert.equal(range.body.length, 16);
});
