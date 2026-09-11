import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import net from "node:net";
import test, { type TestContext } from "node:test";
import WebSocket from "ws";
import { createMediaWorker, type WorkerOptions } from "./worker.js";
import type { SpeechCallbacks, SpeechStream } from "./speech-to-text.js";
import { waitFor } from "../server/test-support/fake-esl.js";

const token = "media-lifecycle-fixture-token";
async function fixture(t: TestContext, custom: Partial<WorkerOptions> = {}) {
  const callId = randomUUID(); const windowId = randomUUID();
  const notifications: { path: string; body: Record<string, unknown> }[] = [];
  const errors: { error: Error; context: { callId: string; windowId?: string } }[] = [];
  let callbacks: SpeechCallbacks | undefined;
  let closed = 0;
  const worker = createMediaWorker({
    token, apiUrl: "http://api.fixture", stt: { provider: "fake", async open(value) { callbacks = value; return { write() {}, close() { closed++; } }; } },
    fetch: async (input, init) => {
      if (init?.method === "POST") { notifications.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init.body)) }); return Response.json({ ok: true }); }
      return Response.json({ status: "listening", listenWindowId: windowId, endpointingMs: 300 });
    },
    onError: (error, context) => errors.push({ error, context }), ...custom
  });
  worker.server.listen(0, "127.0.0.1"); await once(worker.server, "listening");
  t.after(() => worker.close());
  const { port } = worker.server.address() as { port: number };
  const raw = (call = callId) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/audio/${call}`, { headers: { Authorization: `Bearer ${token}` } });
    socket.on("error", () => undefined);
    return socket;
  };
  return {
    worker, port, callId, windowId, notifications, errors, raw, callbacks: () => callbacks!, closed: () => closed,
    async connect() { const socket = raw(); await once(socket, "open"); return socket; },
    window(method: "POST" | "DELETE", id = windowId, endpointingMs?: number) {
      return fetch(`http://127.0.0.1:${port}/calls/${callId}/window/${id}${endpointingMs === undefined ? "" : `?endpointingMs=${endpointingMs}`}`,
        { method, headers: { Authorization: `Bearer ${token}` } });
    },
    async health() { return await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { calls: number; windows: number; pendingReceipts: number }; }
  };
}

function rejected(socket: WebSocket) {
  return new Promise<number>((resolve) => socket.on("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode!); socket.terminate(); }));
}

async function waitForCalls(f: Awaited<ReturnType<typeof fixture>>, expected: number) {
  const deadline = performance.now() + 2000;
  while ((await f.health()).calls !== expected) {
    assert.ok(performance.now() < deadline, `Expected ${expected} active media calls`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a throwing provider audio write ends its turn and reports one authenticated media failure", async (t) => {
  let closes = 0;
  const f = await fixture(t, { stt: { provider: "fake", async open() { return { write() { throw new Error("Audio sink failed"); }, close() { closes++; } }; } } });
  const socket = await f.connect(); socket.send(Buffer.alloc(320));
  await waitFor(() => f.notifications.length === 1);
  assert.equal(closes, 1);
  assert.equal((await f.health()).windows, 0);
  assert.equal(f.notifications[0].path, `/api/media/calls/${f.callId}/error`);
  assert.deepEqual(f.notifications[0].body, { windowId: f.windowId, error: "Speech transcription unavailable." });
  assert.match(f.errors[0].error.message, /Audio sink failed/);
  assert.deepEqual(f.errors[0].context, { callId: f.callId, windowId: f.windowId });
});

test("caller disconnect cancels a pending provider open and closes any late stream without replaying buffered PCM", async (t) => {
  let resolveOpen: (value: SpeechStream) => void = () => undefined;
  let openingSignal: AbortSignal | undefined; let writes = 0; let closes = 0;
  const f = await fixture(t, { stt: { provider: "fake", open(_callbacks, signal) { openingSignal = signal; return new Promise((resolve) => { resolveOpen = resolve; }); } } });
  const socket = await f.connect(); socket.send(Buffer.alloc(320));
  const peerClosed = once(socket, "close"); socket.close(); await peerClosed;
  await waitFor(() => Boolean(openingSignal?.aborted));
  resolveOpen({ write() { writes++; }, close() { closes++; } });
  await waitFor(() => closes === 1);
  assert.equal(writes, 0); assert.equal(f.notifications.length, 0);
  await waitForCalls(f, 0);
});

test("provider open has a deadline even when it ignores abort, and throwing close cannot retain the window", async (t) => {
  let resolveOpen: (value: SpeechStream) => void = () => undefined;
  const f = await fixture(t, { connectTimeoutMs: 25, stt: { provider: "fake", open() { return new Promise((resolve) => { resolveOpen = resolve; }); } } });
  await f.connect();
  await waitFor(() => f.notifications.length === 1);
  assert.equal((await f.health()).windows, 0);
  assert.match(f.errors[0].error.message, /connection timed out/);
  resolveOpen({ write() { assert.fail("Expired opening must not receive PCM"); }, close() { throw new Error("Late provider close failed"); } });
  await waitFor(() => f.errors.some(({ error }) => error.message === "Late provider close failed"));
  assert.equal(f.notifications.length, 1);
});

test("buffered PCM retains arrival time and failures while flushing it cannot escape the worker", async (t) => {
  let resolveOpen: (value: SpeechStream) => void = () => undefined; let closes = 0;
  const arrivals: number[] = [];
  const f = await fixture(t, { stt: { provider: "fake", open() { return new Promise((resolve) => { resolveOpen = resolve; }); } } });
  const socket = await f.connect(); socket.send(Buffer.alloc(320));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const openedAt = performance.now();
  resolveOpen({ write(_pcm, receivedAt) { arrivals.push(receivedAt!); throw new Error("Buffered write failed"); }, close() { closes++; throw new Error("Provider close failed"); } });
  await waitFor(() => f.notifications.length === 1);
  assert.equal(closes, 1); assert.equal(arrivals.length, 1); assert.ok(openedAt - arrivals[0] >= 15);
  assert.equal((await f.health()).windows, 0);
  assert.deepEqual(f.errors.map(({ error }) => error.message), ["Buffered write failed", "Provider close failed"]);
});

test("lost transcript reply retries the same receipt after the call hangs up without a second classification", async (t) => {
  const receipts: Record<string, unknown>[] = []; const accepted = new Set<string>(); let effects = 0; let errorPosts = 0;
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, { fetch: async (input, init) => {
    if (String(input).endsWith("/window")) return Response.json({ status: "listening", listenWindowId: f.windowId, endpointingMs: 300 });
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    if (String(input).endsWith("/error")) { errorPosts++; return Response.json({ ok: true }); }
    const body = JSON.parse(String(init?.body)); receipts.push(body);
    if (!accepted.has(body.utteranceId)) { accepted.add(body.utteranceId); effects++; }
    if (receipts.length === 1) throw new Error("Reply was lost after commit");
    return Response.json({ status: "playing" });
  } });
  const socket = await f.connect();
  f.callbacks().onUtterance({ transcript: "can lah", latencyMs: 850 });
  f.callbacks().onUtterance({ transcript: "duplicate", latencyMs: 851 });
  await waitFor(() => receipts.length === 1);
  assert.equal((await f.health()).pendingReceipts, 1);
  // The channel clears while the receipt is still in flight; the receipt must survive it.
  const peerClosed = once(socket, "close"); socket.close(); await peerClosed;
  await waitFor(() => receipts.length === 2);
  assert.deepEqual(receipts[1], receipts[0]); assert.equal(effects, 1); assert.equal(errorPosts, 0); assert.equal(f.closed(), 1);
  assert.equal(receipts[0].windowId, f.windowId); assert.equal(receipts[0].sttLatencyMs, 850);
  await waitForCalls(f, 0);
  assert.equal((await f.health()).pendingReceipts, 0);
});

for (const status of [400, 503]) test(`transcript HTTP ${status} ends bounded delivery and reports a media error`, async (t) => {
  let attempts = 0; let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, { fetch: async (input, init) => {
    if (String(input).endsWith("/window")) return Response.json({ status: "listening", listenWindowId: f.windowId, endpointingMs: 300 });
    if (String(input).endsWith("/transcript")) { attempts++; return Response.json({ error: "Fixture failure" }, { status }); }
    f.notifications.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true });
  } });
  await f.connect(); f.callbacks().onUtterance({ transcript: "no need" });
  await waitFor(() => f.notifications.length === 1);
  assert.equal(attempts, status === 400 ? 1 : 3); assert.equal((await f.health()).windows, 0);
  assert.match(f.errors[0].error.message, new RegExp(`HTTP ${status}`));
});

test("provider error reports a failed error notification with call context and does not leak its window", async (t) => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, { fetch: async (input) => String(input).endsWith("/window")
    ? Response.json({ status: "listening", listenWindowId: f.windowId, endpointingMs: 300 }) : Response.json({ error: "Unavailable" }, { status: 503 }) });
  await f.connect(); f.callbacks().onError(new Error("Provider failed")); f.callbacks().onError(new Error("Duplicate provider failure"));
  await waitFor(() => f.errors.length === 2);
  assert.match(f.errors[1].error.message, /notification returned HTTP 503/);
  assert.deepEqual(f.errors[1].context, { callId: f.callId, windowId: f.windowId });
  assert.equal((await f.health()).windows, 0); assert.equal(f.closed(), 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.errors.length, 2, "a replaced provider's later callbacks are ignored");
});

test("a provider failure outside a listen window keeps the call and reconnects at the next window", async (t) => {
  const opens: number[] = []; const callbacks: SpeechCallbacks[] = [];
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, {
    stt: { provider: "fake", async open(value, _signal, listen) { opens.push(listen!.endpointingMs); callbacks.push(value); return { write() {}, close() {} }; } },
    fetch: async (input, init) => {
      if (String(input).endsWith("/window")) return Response.json({ status: "playing", endpointingMs: 300 });
      f.notifications.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }
  });
  const socket = await f.connect();
  await waitFor(() => opens.length === 1);
  callbacks[0].onError(new Error("Deepgram closed during playback"));
  await waitFor(() => f.errors.length === 1);
  assert.equal(f.notifications.length, 0, "no window was open, so the call is not failed");
  assert.equal(socket.readyState, WebSocket.OPEN);
  await f.window("POST", f.windowId, 300);
  await waitFor(() => opens.length === 2);
  callbacks[1].onUtterance({ transcript: "can lah" });
  await waitFor(() => f.notifications.some((post) => post.path.endsWith("/transcript")));
  const receipt = f.notifications.find((post) => post.path.endsWith("/transcript"))!;
  assert.equal(receipt.body.windowId, f.windowId);
  assert.deepEqual(opens, [300, 300]);
});

for (const bytes of [3, 32_002, 64_002]) test(`${bytes}-byte invalid or excessive PCM is rejected without opening an unbounded buffer`, async (t) => {
  const f = await fixture(t, { stt: { provider: "fake", async open() { return new Promise(() => undefined); } } });
  const socket = await f.connect(); socket.send(Buffer.alloc(bytes));
  await waitFor(() => f.notifications.length === 1);
  assert.equal((await f.health()).windows, 0); assert.equal(f.errors.length, 1);
});

test("a call whose audio outlives its maximum duration is ended and reported", async (t) => {
  const f = await fixture(t, { maxCallMs: 25 }); await f.connect();
  await waitFor(() => f.notifications.length === 1);
  assert.match(f.errors[0].error.message, /exceeded its maximum lifetime/);
  await waitForCalls(f, 0);
});

test("audio beyond the call's PCM budget is refused", async (t) => {
  const f = await fixture(t, { maxCallMs: 1000 });
  const socket = await f.connect();
  // 1 s of call allows 16 000 bytes plus a tenth of headroom; two 16 kB frames pass it.
  socket.send(Buffer.alloc(16_000)); socket.send(Buffer.alloc(16_000));
  await waitFor(() => f.notifications.length === 1);
  assert.match(f.errors[0].error.message, /exceeded the maximum call duration/);
  await waitForCalls(f, 0);
});

test("upgrade lookup timeout includes a stalled response body and releases its reservation", async (t) => {
  const f = await fixture(t, { apiTimeoutMs: 25, fetch: async () => new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "application/json" } }) });
  assert.equal(await rejected(f.raw()), 409);
  assert.equal((await f.health()).calls, 0);
  assert.match(f.errors[0].error.name, /TimeoutError/);
});

test("pending upgrades count toward the five-call ceiling and shutdown cancels transports that ignore abort", async (t) => {
  let lookups = 0;
  const f = await fixture(t, { fetch: async () => { lookups++; return new Promise(() => undefined); } });
  const peers = Array.from({ length: 5 }, () => f.raw(randomUUID()));
  await waitFor(() => lookups === 5);
  assert.equal(await rejected(f.raw(randomUUID())), 409); assert.equal(lookups, 5);
  assert.equal((await f.health()).calls, 5);
  peers[0].terminate();
  await waitForCalls(f, 4);
  const before = performance.now(); await f.worker.close();
  assert.ok(performance.now() - before < 500);
  assert.equal(f.errors.length, 0);
});

test("a call keeps its slot for one audio stream and releases it for the next call once its receipt settles", async (t) => {
  const ids = Array.from({ length: 6 }, () => randomUUID());
  let receipts = 0; const callbacks: SpeechCallbacks[] = [];
  const f = await fixture(t, {
    stt: { provider: "fake", async open(value) { callbacks.push(value); return { write() {}, close() {} }; } },
    fetch: async (input) => {
      if (String(input).endsWith("/window")) return Response.json({ status: "listening", listenWindowId: ids[0], endpointingMs: 300 });
      receipts++; return new Promise(() => undefined);
    }
  });
  const sockets = [];
  for (const id of ids.slice(0, 5)) { const socket = f.raw(id); await once(socket, "open"); sockets.push(socket); }
  assert.equal((await f.health()).calls, 5);
  assert.equal(await rejected(f.raw(ids[0])), 409, "one audio stream per call");
  assert.equal(await rejected(f.raw(ids[5])), 409, "the trunk ceiling holds across calls");
  for (const callback of callbacks) callback.onUtterance({ transcript: "can" });
  await waitFor(() => receipts === 5);
  assert.equal((await f.health()).pendingReceipts, 5);
  // Hanging up frees the call slot even though the receipt is still unanswered.
  sockets[0].close(); await once(sockets[0], "close");
  await waitForCalls(f, 4);
  assert.equal((await f.health()).pendingReceipts, 5);
  const next = f.raw(ids[5]); await once(next, "open");
  assert.equal((await f.health()).calls, 5);
  await f.worker.close();
});

test("a malformed authenticated WebSocket handshake cannot retain a call reservation", async (t) => {
  const f = await fixture(t);
  const socket = net.createConnection({ host: "127.0.0.1", port: f.port });
  await once(socket, "connect");
  const response: Buffer[] = []; socket.on("data", (data) => response.push(data));
  socket.write(`GET /audio/${f.callId} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: Bearer ${token}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 6\r\n\r\n`);
  await once(socket, "close");
  assert.match(Buffer.concat(response).toString(), /HTTP\/1.1 400/);
  assert.equal((await f.health()).calls, 0); assert.equal(f.closed(), 0);
});
