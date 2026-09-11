import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomBytes } from "node:crypto";
import pino from "pino";
import request from "supertest";
import { createApp } from "./app.js";
import { InMemoryAuthStore, seedAdmin } from "./auth.js";
import { RuleClassifier } from "./classifier.js";
import { config } from "./config.js";
import { SimulatedTelephonyAdapter } from "./telephony.js";
import { FixtureCallOrchestrator as CallOrchestrator } from "./test-support/fixture-orchestrator.js";

import { CALLER_IDS, type CallSession } from "../src/lib/domain.js";
import { InMemoryStore } from "./store.js";
import { purgeRecordings } from "./recordings.js";

test("recording purge removes expired and stale orphan audio, preserves active/current audio and clears durable metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-recording-purge-"));
  const store = new InMemoryStore();
  const now = Date.now(), old = new Date(now - 40 * 86_400_000).toISOString(), future = new Date(now + 86_400_000).toISOString();
  const call = (status: CallSession["status"], expired: boolean): CallSession => {
    const id = randomUUID();
    return { id, providerCallId: randomUUID(), callerId: CALLER_IDS[0], destination: "+6591234555", flowId: "flow-prospect-intake", flowVersion: 3, status, createdAt: expired ? old : new Date(now).toISOString(), recordingFile: `${id}.wav`, recordingExpiresAt: expired ? old : future, events: [] };
  };
  const expired = call("ended", true), active = call("listening", true), current = call("ended", false), orphan = `${randomUUID()}.wav`;
  try {
    for (const record of [expired, active, current]) { store.saveCall(record); await writeFile(path.join(directory, record.recordingFile!), "fixture audio"); }
    await writeFile(path.join(directory, orphan), "orphan audio"); await utimes(path.join(directory, orphan), new Date(old), new Date(old));
    assert.equal(await purgeRecordings(store, directory, 30, now), 2);
    await assert.rejects(readFile(path.join(directory, expired.recordingFile!)), { code: "ENOENT" });
    assert.equal(store.getCall(expired.id)?.recordingFile, undefined);
    assert.equal((await readFile(path.join(directory, active.recordingFile!))).toString(), "fixture audio");
    assert.equal((await readFile(path.join(directory, current.recordingFile!))).toString(), "fixture audio");
    assert.equal(await purgeRecordings(store, directory, 30, now), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a finished call's recording streams inline with byte ranges so it plays in the browser", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-recording-serve-"));
  const previous = config.recording.directory;
  config.recording.directory = directory;
  t.after(async () => { config.recording.directory = previous; await rm(directory, { recursive: true, force: true }); });

  const store = new InMemoryStore();
  const authStore = new InMemoryAuthStore();
  const password = randomBytes(24).toString("hex");
  const email = "recordings@example.test";
  await seedAdmin(authStore, { MKTR_ADMIN_EMAIL: email, MKTR_ADMIN_PASSWORD: password });
  const adapter = new SimulatedTelephonyAdapter();
  const calls = new CallOrchestrator(store, adapter);
  const { app } = createApp({ store, authStore, adapter, calls, classifier: new RuleClassifier(), logger: pino({ level: "silent" }) });
  const login = await request(app).post("/api/auth/login").send({ email, password }).expect(200);
  const cookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0];

  const id = randomUUID();
  const audio = Buffer.alloc(2048, 7);
  await writeFile(path.join(directory, `${id}.wav`), audio);
  store.saveCall({ id, providerCallId: randomUUID(), callerId: CALLER_IDS[0], destination: "+6591234555",
    flowId: "flow-prospect-intake", flowVersion: 3, status: "ended", createdAt: new Date().toISOString(),
    endedAt: new Date().toISOString(), recordingFile: `${id}.wav`,
    recordingExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), events: [] });
  await store.flush();

  const full = await request(app).get(`/api/calls/${id}/recording`).set("Cookie", cookie).expect(200);
  assert.match(full.headers["content-disposition"], /^inline;/, "an attachment disposition stops an audio element from playing it");
  assert.match(full.headers["content-type"], /audio\/wav/);
  assert.equal(full.headers["accept-ranges"], "bytes", "seeking needs range support");
  assert.equal(full.body.length, audio.length);

  // Scrubbing sends a range request; the browser needs a 206 with just that slice.
  const part = await request(app).get(`/api/calls/${id}/recording`).set("Cookie", cookie).set("Range", "bytes=100-199").expect(206);
  assert.equal(part.headers["content-range"], `bytes 100-199/${audio.length}`);
  assert.equal(part.body.length, 100);

  await request(app).get(`/api/calls/${id}/recording`).expect(401);
});
