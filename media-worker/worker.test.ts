import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { createMediaWorker } from "./worker.js";
import { DeepgramSpeechToText } from "./deepgram.js";
import type { ListenSettings, SpeechCallbacks, SpeechToText } from "./speech-to-text.js";
import { waitFor } from "../server/test-support/fake-esl.js";

const token = "fixture-token-no-provider-secret";

/** One audio socket and one API stub per call, with the window control routes the API drives. */
async function call(t: { after(fn: () => unknown): void }, options: { lookup?: () => unknown; stt?: SpeechToText } = {}) {
  const callId = randomUUID();
  const opens: (ListenSettings | undefined)[] = [];
  const callbacks: SpeechCallbacks[] = [];
  const closes: number[] = [];
  const posts: { url: string; body: Record<string, unknown>; authorization: string }[] = [];
  let pcmBytes = 0;
  const stt: SpeechToText = options.stt ?? { provider: "fake", async open(value, _signal, listen) {
    const index = opens.length;
    opens.push(listen); callbacks.push(value);
    return { write(pcm) { pcmBytes += pcm.length; }, close() { closes.push(index); } };
  } };
  const worker = createMediaWorker({ token, apiUrl: "http://api.test", stt, fetch: async (input, init) => {
    if (init?.method === "POST") {
      posts.push({ url: String(input), body: JSON.parse(String(init.body)), authorization: new Headers(init.headers).get("authorization")! });
      return Response.json({ status: "playing" });
    }
    return Response.json(options.lookup?.() ?? { status: "playing", endpointingMs: 300 });
  } });
  worker.server.listen(0, "127.0.0.1"); await once(worker.server, "listening"); t.after(() => worker.close());
  const { port } = worker.server.address() as { port: number };
  const window = (method: "POST" | "DELETE", windowId: string, endpointingMs?: number) =>
    fetch(`http://127.0.0.1:${port}/calls/${callId}/window/${windowId}${endpointingMs === undefined ? "" : `?endpointingMs=${endpointingMs}`}`,
      { method, headers: { Authorization: `Bearer ${token}` } });
  return {
    worker, port, callId, opens, callbacks, closes, posts, stt, pcm: () => pcmBytes, window,
    async connect(id = callId) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/audio/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      socket.on("error", () => undefined);
      await once(socket, "open");
      return socket;
    },
    async health() {
      const { calls, windows, pendingReceipts } = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { calls: number; windows: number; pendingReceipts: number };
      return { calls, windows, pendingReceipts };
    }
  };
}

test("one speech stream carries a whole call: every listen window reuses it and each reply names its own window", async (t) => {
  const f = await call(t);
  const socket = await f.connect();
  // The stream and its provider are live during playback, before any window exists.
  await waitFor(() => f.opens.length === 1);
  assert.deepEqual(f.opens[0], { endpointingMs: 300 });
  socket.send(Buffer.alloc(320)); await waitFor(() => f.pcm() === 320);
  assert.deepEqual(await f.health(), { calls: 1, windows: 0, pendingReceipts: 0 });

  const first = randomUUID(); const second = randomUUID();
  assert.equal((await f.window("POST", first, 300)).status, 204);
  f.callbacks[0].onUtterance({ transcript: "can lah", latencyMs: 40, finalizedBy: "utterance_end" });
  await waitFor(() => f.posts.length === 1);
  assert.equal(f.posts[0].body.finalizedBy, "utterance_end", "the receipt says which marker ended the reply");
  assert.equal((await f.window("DELETE", first)).status, 204);

  socket.send(Buffer.alloc(640)); await waitFor(() => f.pcm() === 960);
  assert.equal((await f.window("POST", second, 300)).status, 204);
  f.callbacks[0].onUtterance({ transcript: "no need", latencyMs: 55 });
  await waitFor(() => f.posts.length === 2);

  assert.equal(f.opens.length, 1, "the second window reuses the provider connection opened during playback");
  assert.deepEqual(f.closes, []);
  assert.equal(socket.readyState, WebSocket.OPEN, "the audio socket outlives both windows");
  assert.deepEqual(f.posts.map((post) => [post.body.transcript, post.body.windowId]), [["can lah", first], ["no need", second]]);
  for (const post of f.posts) {
    assert.match(post.url, new RegExp(`/api/calls/${f.callId}/transcript$`));
    assert.equal(post.authorization, `Bearer ${token}`);
    assert.match(String(post.body.utteranceId), /^[a-f0-9-]{36}$/);
  }
  assert.notEqual(f.posts[0].body.utteranceId, f.posts[1].body.utteranceId);
});

test("a transcript finalized outside a listen window is discarded instead of submitted", async (t) => {
  const f = await call(t);
  await f.connect();
  await waitFor(() => f.opens.length === 1);
  // Speech during clip playback answers the previous prompt; it must not drive the next one.
  f.callbacks[0].onUtterance({ transcript: "hello hello", latencyMs: 30 });
  const windowId = randomUUID();
  await f.window("POST", windowId, 300);
  f.callbacks[0].onUtterance({ transcript: "can lah", latencyMs: 40 });
  await waitFor(() => f.posts.length === 1);
  // A window accepts one reply; whatever the caller adds afterwards waits for the next window.
  f.callbacks[0].onUtterance({ transcript: "actually no", latencyMs: 41 });
  await f.window("DELETE", windowId);
  f.callbacks[0].onUtterance({ transcript: "still talking", latencyMs: 42 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(f.posts.map((post) => post.body.transcript), ["can lah"]);
  assert.equal(f.opens.length, 1);
  assert.deepEqual(await f.health(), { calls: 1, windows: 0, pendingReceipts: 0 });
});

test("a listen node with its own endpointing reopens the provider for that node and keeps the audio socket", async (t) => {
  const f = await call(t);
  const socket = await f.connect();
  await waitFor(() => f.opens.length === 1);
  await f.window("POST", randomUUID(), 300);
  assert.equal(f.opens.length, 1, "a window matching the open connection costs no handshake");
  await f.window("POST", randomUUID(), 800);
  await waitFor(() => f.opens.length === 2);
  assert.deepEqual(f.opens[1], { endpointingMs: 800 });
  assert.deepEqual(f.closes, [0], "the previous connection is closed, not leaked");
  socket.send(Buffer.alloc(320)); await waitFor(() => f.pcm() === 320);
  f.callbacks[1].onUtterance({ transcript: "it depends on the premium", latencyMs: 700 });
  await waitFor(() => f.posts.length === 1);
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("a flow that never listens holds no provider connection and drops the callee audio", async (t) => {
  const f = await call(t, { lookup: () => ({ status: "playing" }) });
  const socket = await f.connect();
  socket.send(Buffer.alloc(3200));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(f.opens.length, 0);
  assert.equal(f.pcm(), 0);
  assert.deepEqual(await f.health(), { calls: 1, windows: 0, pendingReceipts: 0 });
});

test("window control refuses an unauthenticated caller, an unusable endpointing and an unknown route", async (t) => {
  const f = await call(t);
  await f.connect();
  const url = `http://127.0.0.1:${f.port}/calls/${f.callId}/window/${randomUUID()}?endpointingMs=300`;
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal((await fetch(url, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } })).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/calls/not-a-uuid/window/${randomUUID()}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } })).status, 404);
  for (const value of [undefined, 99, 1001, 300.5]) assert.equal((await f.window("POST", randomUUID(), value)).status, 400);
  assert.equal((await f.health()).windows, 0);
});

test("worker rejects unauthenticated audio and calls that are no longer running before opening STT", async (t) => {
  let opens = 0;
  const worker = createMediaWorker({ token, apiUrl: "http://api.test", stt: { provider: "fake", async open() { opens++; return { write() {}, close() {} }; } }, fetch: async () => Response.json({ status: "ended" }) });
  worker.server.listen(0, "127.0.0.1"); await once(worker.server, "listening"); t.after(() => worker.close());
  const { port } = worker.server.address() as { port: number };
  for (const [authorization, expected] of [["wrong", 401], [`Bearer ${token}`, 409]] as const) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/audio/${randomUUID()}`, { headers: { Authorization: authorization } });
    socket.on("error", () => undefined);
    const response = await new Promise<number>((resolve) => socket.on("unexpected-response", (_request, incoming) => { incoming.resume(); resolve(incoming.statusCode!); socket.terminate(); }));
    assert.equal(response, expected);
  }
  assert.equal(opens, 0);
});

test("a call already listening when its audio arrives adopts that window without an API push", async (t) => {
  const windowId = randomUUID();
  const f = await call(t, { lookup: () => ({ status: "listening", listenWindowId: windowId, endpointingMs: 220 }) });
  await f.connect();
  await waitFor(() => f.opens.length === 1);
  assert.deepEqual(f.opens[0], { endpointingMs: 220 });
  assert.equal((await f.health()).windows, 1);
  f.callbacks[0].onUtterance({ transcript: "can lah", latencyMs: 40 });
  await waitFor(() => f.posts.length === 1);
  assert.equal(f.posts[0].body.windowId, windowId);
});

test("a listening reply without a usable endpointing refuses the socket before STT opens", async (t) => {
  let opens = 0; const errors: Error[] = []; let reply: Record<string, unknown> = {};
  const worker = createMediaWorker({ token, apiUrl: "http://api.test", stt: { provider: "fake", async open() { opens++; return { write() {}, close() {} }; } }, fetch: async () => Response.json(reply), onError: (error) => errors.push(error) });
  worker.server.listen(0, "127.0.0.1"); await once(worker.server, "listening"); t.after(() => worker.close());
  const { port } = worker.server.address() as { port: number };
  for (const endpointingMs of [undefined, 99, 1001, 300.5]) {
    reply = { status: "listening", listenWindowId: randomUUID(), ...(endpointingMs === undefined ? {} : { endpointingMs }) };
    const socket = new WebSocket(`ws://127.0.0.1:${port}/audio/${randomUUID()}`, { headers: { Authorization: `Bearer ${token}` } });
    socket.on("error", () => undefined);
    const status = await new Promise<number>((resolve) => socket.on("unexpected-response", (_request, incoming) => { incoming.resume(); resolve(incoming.statusCode!); socket.terminate(); }));
    assert.equal(status, 409);
  }
  assert.equal(opens, 0); assert.equal(errors.length, 4);
  assert.match(errors[0].message, /omitted the node's endpointing/);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { calls: number }).calls, 0);
});

test("Deepgram wire provider streams 8 kHz linear16 and endpoints final segments once", async (t) => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  t.after(() => { for (const socket of upstream.clients) socket.terminate(); upstream.close(); });
  let frames = 0; let peer: WebSocket | undefined;
  upstream.on("connection", (socket, request) => {
    peer = socket;
    const query = new URL(request.url!, "http://fixture.test").searchParams;
    assert.equal(query.get("model"), "nova-3"); assert.equal(query.get("language"), "en");
    assert.equal(query.get("sample_rate"), "8000"); assert.equal(query.get("encoding"), "linear16"); assert.equal(query.get("endpointing"), "300");
    assert.equal(request.headers.authorization, "Token fake-deepgram-fixture");
    socket.on("message", (_data, binary) => { if (binary) frames++; });
  });
  const utterances: { transcript: string; finalizedBy?: string }[] = []; const errors: Error[] = [];
  const provider = new DeepgramSpeechToText({ apiKey: "fake-deepgram-fixture", endpoint: `ws://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/listen` });
  const stream = await provider.open({ onUtterance: (value) => utterances.push({ transcript: value.transcript, finalizedBy: value.finalizedBy }), onError: (error) => errors.push(error) }); t.after(() => stream.close());
  stream.write(Buffer.alloc(320)); await waitFor(() => frames === 1);
  const result = { type: "Results", is_final: true, speech_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: "can" }] } };
  peer!.send(JSON.stringify(result)); peer!.send(JSON.stringify(result));
  peer!.send(JSON.stringify({ ...result, speech_final: true, start: 1, channel: { alternatives: [{ transcript: "lah" }] } }));
  peer!.send(JSON.stringify({ type: "UtteranceEnd" }));
  await waitFor(() => utterances.length > 0);
  assert.deepEqual(utterances, [{ transcript: "can lah", finalizedBy: "endpoint" }]); assert.equal(errors.length, 0);
});

test("an utterance ended by Deepgram's fallback is reported as utterance_end, not as the endpoint", async (t) => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  t.after(() => { for (const socket of upstream.clients) socket.terminate(); upstream.close(); });
  let peer: WebSocket | undefined;
  upstream.on("connection", (socket) => { peer = socket; });
  const utterances: { transcript: string; finalizedBy?: string }[] = [];
  const provider = new DeepgramSpeechToText({ apiKey: "fake-deepgram-fixture", endpoint: `ws://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/listen` });
  const stream = await provider.open({ onUtterance: (value) => utterances.push({ transcript: value.transcript, finalizedBy: value.finalizedBy }), onError: () => undefined });
  t.after(() => stream.close());
  await waitFor(() => peer !== undefined);
  // A final segment that never carries speech_final: only the 1000 ms fallback can close it.
  peer!.send(JSON.stringify({ type: "Results", is_final: true, speech_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: "maybe next time" }] } }));
  peer!.send(JSON.stringify({ type: "UtteranceEnd" }));
  await waitFor(() => utterances.length > 0);
  assert.deepEqual(utterances, [{ transcript: "maybe next time", finalizedBy: "utterance_end" }]);
});
