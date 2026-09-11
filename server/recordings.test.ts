import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
