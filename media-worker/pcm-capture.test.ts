import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import WebSocket from "ws";
import { createPcmCapture, type CaptureSidecar } from "./pcm-capture.js";
import type { SpeechCallbacks } from "./speech-to-text.js";
import { createMediaWorker } from "./worker.js";
import { waitFor } from "../server/test-support/fake-esl.js";

const token = "pcm-capture-fixture-token-only";

async function fixture(t: TestContext, options: { capture?: boolean; openDelayMs?: number; callId?: string } = {}) {
  const callId = options.callId ?? randomUUID(); const windowId = randomUUID();
  const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-pcm-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const errors: { error: Error; context: { callId: string; windowId: string } }[] = [];
  const captureErrors: { error: Error; context: { callId: string; windowId: string } }[] = [];
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const providerBytes: Buffer[] = [];
  let callbacks: SpeechCallbacks | undefined;
  const worker = createMediaWorker({
    token, apiUrl: "http://api.fixture",
    stt: { provider: "fake", async open(value) {
      callbacks = value;
      if (options.openDelayMs) await new Promise((resolve) => setTimeout(resolve, options.openDelayMs));
      return { write(pcm) { providerBytes.push(pcm); }, close() {} };
    } },
    fetch: async (input, init) => {
      if (init?.method === "POST") { posts.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init.body)) }); return Response.json({ status: "playing" }); }
      return Response.json({ status: "listening", listenWindowId: windowId });
    },
    capture: options.capture ? createPcmCapture({ directory, onError: (error, context) => captureErrors.push({ error, context }) }) : undefined,
    onError: (error, context) => errors.push({ error, context })
  });
  worker.server.listen(0, "127.0.0.1"); await once(worker.server, "listening"); t.after(() => worker.close());
  const { port } = worker.server.address() as { port: number };
  return {
    callId, windowId, directory, errors, captureErrors, posts, providerBytes, callbacks: () => callbacks!,
    async connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/audio/${callId}/${windowId}`, { headers: { Authorization: `Bearer ${token}` } });
      await once(socket, "open"); return socket;
    },
    async health() { return await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { pcmCapture: boolean; windows: number }; },
    async sidecar() {
      const file = path.join(directory, callId, `${windowId}.json`);
      await waitFor(() => existsSync(file));
      return JSON.parse(await readFile(file, "utf8")) as CaptureSidecar;
    }
  };
}

test("capture tees every accepted frame byte-for-byte with its arrival time, including audio buffered before the provider opens", async (t) => {
  const f = await fixture(t, { capture: true, openDelayMs: 60 });
  assert.equal((await f.health()).pcmCapture, true);
  const first = Buffer.alloc(320, 0x01); const second = Buffer.alloc(640, 0x02);
  const socket = await f.connect();
  socket.send(first); // arrives while the fake provider is still opening
  await new Promise((resolve) => setTimeout(resolve, 30));
  socket.send(second);
  await waitFor(() => f.providerBytes.length === 2);
  f.callbacks().onUtterance({ transcript: "can lah", latencyMs: 850 });
  await waitFor(() => f.posts.length === 1);
  const sidecar = await f.sidecar();
  assert.deepEqual(await readFile(path.join(f.directory, f.callId, `${f.windowId}.pcm`)), Buffer.concat([first, second]));
  assert.deepEqual(Buffer.concat(f.providerBytes), Buffer.concat([first, second]), "capture and provider input are identical");
  assert.equal(sidecar.version, 1); assert.equal(sidecar.callId, f.callId); assert.equal(sidecar.windowId, f.windowId);
  assert.deepEqual([sidecar.encoding, sidecar.sampleRate, sidecar.channels, sidecar.totalBytes], ["linear16", 8000, 1, 960]);
  assert.deepEqual(sidecar.frames.map(({ offset, bytes }) => ({ offset, bytes })), [{ offset: 0, bytes: 320 }, { offset: 320, bytes: 640 }]);
  assert.ok(sidecar.frames[0].t >= 0 && sidecar.frames[0].t < 50, `first frame arrived at ${sidecar.frames[0].t} ms`);
  assert.ok(sidecar.frames[1].t - sidecar.frames[0].t >= 25, "arrival spacing is preserved");
  assert.equal(sidecar.utterance?.transcript, "can lah"); assert.equal(sidecar.utterance?.latencyMs, 850);
  assert.ok(sidecar.utterance!.t >= sidecar.frames[1].t);
  assert.ok(Date.parse(sidecar.closedAt) >= Date.parse(sidecar.openedAt));
  assert.deepEqual(f.errors, []); assert.deepEqual(f.captureErrors, []);
  assert.equal((await f.health()).windows, 0);
});

test("capture is off unless configured, and an unwritable capture location is reported once per window without affecting the transcript", async (t) => {
  const off = await fixture(t);
  assert.equal((await off.health()).pcmCapture, false);
  const socket = await off.connect(); socket.send(Buffer.alloc(320));
  await waitFor(() => off.providerBytes.length === 1);
  off.callbacks().onUtterance({ transcript: "no need" });
  await waitFor(() => off.posts.length === 1);
  assert.deepEqual(await readdir(off.directory), []);

  const callId = randomUUID();
  const f = await fixture(t, { capture: true, callId });
  await writeFile(path.join(f.directory, callId), "a file where the call directory must go");
  const blocked = await f.connect(); blocked.send(Buffer.alloc(320));
  await waitFor(() => f.providerBytes.length === 1);
  f.callbacks().onUtterance({ transcript: "can" });
  await waitFor(() => f.posts.length === 1);
  await waitFor(() => f.captureErrors.length === 1);
  assert.deepEqual(f.captureErrors[0].context, { callId, windowId: f.windowId });
  assert.match(f.captureErrors[0].error.message, /EEXIST|ENOTDIR|not a directory|file already exists/i);
  assert.equal(f.posts[0].path, `/api/calls/${callId}/transcript`);
  assert.deepEqual(f.errors, [], "capture failure is not a media failure");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.captureErrors.length, 1);
  assert.equal(existsSync(path.join(f.directory, callId, `${f.windowId}.json`)), false);
});
