import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
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
  const errors: { error: Error; context: { callId: string; windowId?: string } }[] = [];
  const captureErrors: { error: Error; context: { callId: string; streamId: string } }[] = [];
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
      return Response.json({ status: "listening", listenWindowId: windowId, endpointingMs: 300 });
    },
    capture: options.capture ? createPcmCapture({ directory, onError: (error, context) => captureErrors.push({ error, context }) }) : undefined,
    onError: (error, context) => errors.push({ error, context })
  });
  worker.server.listen(0, "127.0.0.1"); await once(worker.server, "listening"); t.after(() => worker.close());
  const { port } = worker.server.address() as { port: number };
  return {
    callId, windowId, directory, errors, captureErrors, posts, providerBytes, callbacks: () => callbacks!,
    async connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/audio/${callId}`, { headers: { Authorization: `Bearer ${token}` } });
      await once(socket, "open"); return socket;
    },
    window(method: "POST" | "DELETE", id: string, endpointingMs?: number) {
      return fetch(`http://127.0.0.1:${port}/calls/${callId}/window/${id}${endpointingMs === undefined ? "" : `?endpointingMs=${endpointingMs}`}`,
        { method, headers: { Authorization: `Bearer ${token}` } });
    },
    async health() { return await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { pcmCapture: boolean; calls: number }; },
    /** One capture per call, named by the stream the worker opened for it. */
    async sidecar() {
      const folder = path.join(directory, callId);
      await waitFor(() => existsSync(folder) && readdirSync(folder).some((name) => name.endsWith(".json")));
      const file = readdirSync(folder).find((name) => name.endsWith(".json"))!;
      return { sidecar: JSON.parse(await readFile(path.join(folder, file), "utf8")) as CaptureSidecar, streamId: file.replace(/\.json$/, "") };
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
  f.callbacks().onUtterance({ transcript: "can lah", latencyMs: 850, finalizedBy: "endpoint" });
  await waitFor(() => f.posts.length === 1);
  const closing = once(socket, "close"); socket.close(); await closing;
  const { sidecar, streamId } = await f.sidecar();
  assert.deepEqual(await readFile(path.join(f.directory, f.callId, `${streamId}.pcm`)), Buffer.concat([first, second]));
  assert.deepEqual(Buffer.concat(f.providerBytes), Buffer.concat([first, second]), "capture and provider input are identical");
  assert.equal(sidecar.version, 1); assert.equal(sidecar.callId, f.callId); assert.equal(sidecar.streamId, streamId);
  assert.deepEqual([sidecar.encoding, sidecar.sampleRate, sidecar.channels, sidecar.totalBytes], ["linear16", 8000, 1, 960]);
  assert.deepEqual(sidecar.frames.map(({ offset, bytes }) => ({ offset, bytes })), [{ offset: 0, bytes: 320 }, { offset: 320, bytes: 640 }]);
  assert.ok(sidecar.frames[0].t >= 0 && sidecar.frames[0].t < 50, `first frame arrived at ${sidecar.frames[0].t} ms`);
  assert.ok(sidecar.frames[1].t - sidecar.frames[0].t >= 25, "arrival spacing is preserved");
  assert.deepEqual(sidecar.utterances.map(({ transcript, latencyMs, windowId, finalizedBy }) => ({ transcript, latencyMs, windowId, finalizedBy })),
    [{ transcript: "can lah", latencyMs: 850, windowId: f.windowId, finalizedBy: "endpoint" }]);
  assert.ok(sidecar.utterances[0].t >= sidecar.frames[1].t);
  assert.ok(Date.parse(sidecar.closedAt) >= Date.parse(sidecar.openedAt));
  assert.deepEqual(f.errors, []); assert.deepEqual(f.captureErrors, []);
});

test("one capture covers the whole call and records which window each reply belonged to", async (t) => {
  const f = await fixture(t, { capture: true });
  const socket = await f.connect();
  socket.send(Buffer.alloc(320, 0x03));
  await waitFor(() => f.providerBytes.length === 1);
  f.callbacks().onUtterance({ transcript: "first", latencyMs: 100 });
  await waitFor(() => f.posts.length === 1);
  // Speech between windows is kept for diagnosis but carries no window and is never submitted.
  f.callbacks().onUtterance({ transcript: "during the clip", latencyMs: 120 });
  const second = randomUUID();
  await f.window("POST", second, 300);
  socket.send(Buffer.alloc(160, 0x04));
  await waitFor(() => f.providerBytes.length === 2);
  f.callbacks().onUtterance({ transcript: "second", latencyMs: 140 });
  await waitFor(() => f.posts.length === 2);
  const closing = once(socket, "close"); socket.close(); await closing;
  const { sidecar, streamId } = await f.sidecar();
  assert.deepEqual(await readdir(path.join(f.directory, f.callId)), [`${streamId}.json`, `${streamId}.pcm`].sort());
  assert.equal(sidecar.totalBytes, 480);
  assert.deepEqual(sidecar.utterances.map(({ transcript, windowId }) => ({ transcript, windowId })), [
    { transcript: "first", windowId: f.windowId },
    { transcript: "during the clip", windowId: undefined },
    { transcript: "second", windowId: second }
  ]);
  assert.deepEqual(f.posts.map((post) => post.body.windowId), [f.windowId, second]);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.captureErrors, []);
});

test("capture is off unless configured, and an unwritable capture location is reported once per call without affecting the transcript", async (t) => {
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
  assert.equal(f.captureErrors[0].context.callId, callId);
  assert.match(f.captureErrors[0].context.streamId, /^[a-f0-9-]{36}$/);
  assert.match(f.captureErrors[0].error.message, /EEXIST|ENOTDIR|not a directory|file already exists/i);
  assert.equal(f.posts[0].path, `/api/calls/${callId}/transcript`);
  assert.deepEqual(f.errors, [], "capture failure is not a media failure");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.captureErrors.length, 1);
});
