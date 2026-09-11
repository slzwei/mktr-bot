import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import test, { type TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { DeepgramSpeechToText } from "./deepgram.js";
import type { Utterance } from "./speech-to-text.js";
import { waitFor } from "../server/test-support/fake-esl.js";

async function upstream(t: TestContext) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  let peer: WebSocket | undefined; let bytes = 0;
  server.on("connection", (socket) => { peer = socket; socket.on("message", (data, binary) => { if (binary) bytes += Buffer.byteLength(data as Buffer); }); });
  const endpoint = `ws://127.0.0.1:${(server.address() as { port: number }).port}/v1/listen`;
  return { endpoint, peer: () => peer!, bytes: () => bytes };
}

async function stalledUpgrade(t: TestContext, action?: (socket: Duplex) => void) {
  const server = http.createServer(); const peers = new Set<Duplex>(); let upgrades = 0;
  server.on("upgrade", (_request, socket) => { peers.add(socket); upgrades++; socket.on("error", () => undefined); socket.on("close", () => peers.delete(socket)); action?.(socket); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { for (const socket of peers) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { endpoint: `ws://127.0.0.1:${(server.address() as { port: number }).port}/v1/listen`, upgrades: () => upgrades };
}

const final = (text: string, end?: number) => ({ type: "Results", is_final: true, speech_final: true, start: 0, duration: 1, channel: { alternatives: [{ transcript: text, ...(end !== undefined ? { words: [{ end }] } : {}) }] } });

test("Deepgram final latency follows the word end across silence and includes buffered audio time", async (t) => {
  const fake = await upstream(t); const utterances: Utterance[] = []; let time = 1500;
  const provider = new DeepgramSpeechToText({ apiKey: "fake-provider-key", endpoint: fake.endpoint, now: () => time });
  const stream = await provider.open({ onUtterance: (value) => utterances.push(value), onError: (error) => assert.fail(error.message) });
  t.after(() => stream.close());
  // A 20 ms frame reached the worker at 1000 ms, before the provider opened.
  stream.write(Buffer.alloc(320), 1000);
  for (let arrival = 1020; arrival <= 1800; arrival += 20) stream.write(Buffer.alloc(320), arrival);
  time = 1850;
  await waitFor(() => fake.bytes() === 13_120);
  // Real Deepgram wire shapes: Metadata first, SpeechStarted and UtteranceEnd carry `channel` as an index array.
  fake.peer().send(JSON.stringify({ type: "Metadata", transaction_key: "deprecated", request_id: "req-1", sha256: "x", created: "2026-09-11T00:00:00Z", duration: 0, channels: 1 }));
  fake.peer().send(JSON.stringify({ type: "SpeechStarted", channel: [0, 1], timestamp: 0.01 }));
  fake.peer().send(JSON.stringify(final("can lah", 0.02)));
  fake.peer().send(JSON.stringify(final("duplicate after end", 0.02)));
  fake.peer().send(JSON.stringify({ type: "UtteranceEnd", channel: [0, 1], last_word_end: 0.02 }));
  await waitFor(() => utterances.length === 1);
  assert.deepEqual(utterances, [{ transcript: "can lah", latencyMs: 850 }]);
});

for (const wordEnd of [undefined, 300]) test(`Deepgram omits latency for ${wordEnd === undefined ? "missing" : "inconsistent"} word timing`, async (t) => {
  const fake = await upstream(t); const utterances: Utterance[] = [];
  const stream = await new DeepgramSpeechToText({ apiKey: "fake-provider-key", endpoint: fake.endpoint }).open({ onUtterance: (value) => utterances.push(value), onError: (error) => assert.fail(error.message) });
  t.after(() => stream.close()); stream.write(Buffer.alloc(320));
  fake.peer().send(JSON.stringify(final("later", wordEnd)));
  await waitFor(() => utterances.length === 1);
  assert.deepEqual(utterances, [{ transcript: "later" }]);
});

test("Deepgram reports abrupt provider closure once and rejects writes after closure", async (t) => {
  const fake = await upstream(t); const errors: Error[] = [];
  const stream = await new DeepgramSpeechToText({ apiKey: "fake-provider-key", endpoint: fake.endpoint }).open({ onUtterance: () => assert.fail("Unexpected utterance"), onError: (error) => errors.push(error) });
  fake.peer().terminate(); await waitFor(() => errors.length === 1);
  assert.throws(() => stream.write(Buffer.alloc(320)), /stream is closed/);
  stream.close(); assert.equal(errors.length, 1);
});

for (const frame of ["not JSON", JSON.stringify({ type: "Error", message: "Private upstream failure" }), JSON.stringify(final("x".repeat(2001)))]) test(`Deepgram rejects ${frame === "not JSON" ? "malformed JSON" : frame.includes('"Error"') ? "provider errors" : "oversized transcripts"} without emitting an utterance`, async (t) => {
  const fake = await upstream(t); const errors: Error[] = []; let utterances = 0;
  const stream = await new DeepgramSpeechToText({ apiKey: "fake-provider-key", endpoint: fake.endpoint }).open({ onUtterance: () => { utterances++; }, onError: (error) => errors.push(error) });
  t.after(() => stream.close()); fake.peer().send(frame);
  await waitFor(() => errors.length === 1);
  assert.equal(utterances, 0); assert.doesNotMatch(errors[0].message, /Private upstream failure/);
});

test("Deepgram bounds outbound audio backlog before sending an oversized write", async (t) => {
  const fake = await upstream(t); const errors: Error[] = [];
  const stream = await new DeepgramSpeechToText({ apiKey: "fake-provider-key", endpoint: fake.endpoint }).open({ onUtterance: () => assert.fail("Unexpected utterance"), onError: (error) => errors.push(error) });
  t.after(() => stream.close()); stream.write(Buffer.alloc(256_002));
  await waitFor(() => errors.length === 1);
  assert.match(errors[0].message, /backpressure/); assert.equal(fake.bytes(), 0);
});

test("a caller abort cancels Deepgram while its WebSocket handshake is still pending", async (t) => {
  const fake = await stalledUpgrade(t); const controller = new AbortController(); const errors: Error[] = [];
  const pending = new DeepgramSpeechToText({ apiKey: "fake-provider-key", endpoint: fake.endpoint }).open({ onUtterance() {}, onError: (error) => errors.push(error) }, controller.signal);
  const rejected = assert.rejects(pending, /connection was cancelled/);
  await waitFor(() => fake.upgrades() === 1); const start = performance.now(); controller.abort(); await rejected;
  assert.ok(performance.now() - start < 200); assert.equal(errors.length, 0);
});

for (const response of ["disconnect", "reject", "hang"]) test(`Deepgram ${response} before open rejects its opening promise within the handshake deadline`, async (t) => {
  const fake = await stalledUpgrade(t, response === "disconnect" ? (socket) => socket.destroy() : response === "reject" ? (socket) => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n") : undefined);
  const errors: Error[] = []; const started = performance.now();
  await assert.rejects(new DeepgramSpeechToText({ apiKey: "fake-provider-key", endpoint: fake.endpoint, connectTimeoutMs: 30 }).open({ onUtterance() {}, onError: (error) => errors.push(error) }), /Deepgram|connect/);
  assert.ok(performance.now() - started < 1000); assert.equal(errors.length, 0);
});

test("Deepgram options reach the wire and invalid values are rejected before any connection", async (t) => {
  const stalled = await stalledUpgrade(t);
  const seen: URLSearchParams[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  server.on("connection", (_socket, request) => seen.push(new URL(request.url!, "http://fixture.test").searchParams));
  const endpoint = `ws://127.0.0.1:${(server.address() as { port: number }).port}/v1/listen`;
  const stream = await new DeepgramSpeechToText({ apiKey: "fake-provider-key", endpoint, model: "nova-2", endpointingMs: 10, utteranceEndMs: 1500, language: "en-GB" }).open({ onUtterance() {}, onError: (error) => assert.fail(error.message) });
  t.after(() => stream.close());
  assert.equal(seen[0].get("model"), "nova-2"); assert.equal(seen[0].get("endpointing"), "10"); assert.equal(seen[0].get("utterance_end_ms"), "1500"); assert.equal(seen[0].get("language"), "en-GB");
  for (const options of [{ endpointingMs: -1 }, { endpointingMs: 1.5 }, { utteranceEndMs: 999 }, { model: "../x" }]) {
    await assert.rejects(new DeepgramSpeechToText({ apiKey: "fake-provider-key", endpoint: stalled.endpoint, ...options }).open({ onUtterance() {}, onError() {} }), /Deepgram (endpointing|utterance end|model)/);
  }
  assert.equal(stalled.upgrades(), 0);
});
