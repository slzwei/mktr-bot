import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { createMediaWorker } from "./worker.js";
import { DeepgramSpeechToText } from "./deepgram.js";
import type { SpeechCallbacks, SpeechToText } from "./speech-to-text.js";
import { waitFor } from "../server/test-support/fake-esl.js";

const token = "fixture-token-no-provider-secret";
test("audio source delivers PCM to fake STT and exactly one authenticated transcript per listen window", async (t) => {
  const callId = randomUUID(); const windowId = randomUUID();
  let callback: SpeechCallbacks | undefined; let pcmBytes = 0; let providerClosed = false;
  const posts: { url: string; body: Record<string, unknown>; authorization: string }[] = [];
  const stt: SpeechToText = { provider: "fake", async open(callbacks) {
    callback = callbacks;
    return { write(pcm) { pcmBytes += pcm.length; }, close() { providerClosed = true; } };
  } };
  const worker = createMediaWorker({ token, apiUrl: "http://api.test", stt, fetch: async (input, init) => {
    if (init?.method === "POST") {
      posts.push({ url: String(input), body: JSON.parse(String(init.body)), authorization: new Headers(init.headers).get("authorization")! });
      return Response.json({ status: "ended" });
    }
    return Response.json({ status: "listening", listenWindowId: windowId });
  } });
  worker.server.listen(0, "127.0.0.1"); await once(worker.server, "listening"); t.after(() => worker.close());
  const address = worker.server.address() as { port: number };
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/audio/${callId}/${windowId}`, { headers: { Authorization: `Bearer ${token}` } });
  await once(socket, "open");
  socket.send(Buffer.alloc(320)); await waitFor(() => pcmBytes === 320);
  callback!.onUtterance({ transcript: "can lah", latencyMs: 40 });
  callback!.onUtterance({ transcript: "can lah", latencyMs: 41 });
  await waitFor(() => providerClosed);
  assert.equal(posts.length, 1); assert.match(posts[0].url, new RegExp(`/api/calls/${callId}/transcript$`));
  assert.equal(posts[0].body.transcript, "can lah"); assert.equal(posts[0].body.windowId, windowId);
  assert.equal(posts[0].authorization, `Bearer ${token}`); assert.match(String(posts[0].body.utteranceId), /^[a-f0-9-]{36}$/);
});

test("worker rejects unauthenticated audio and stale windows before opening STT", async (t) => {
  let opens = 0;
  const worker = createMediaWorker({ token, apiUrl: "http://api.test", stt: { provider: "fake", async open() { opens++; return { write() {}, close() {} }; } }, fetch: async () => Response.json({ status: "playing" }) });
  worker.server.listen(0, "127.0.0.1"); await once(worker.server, "listening"); t.after(() => worker.close());
  const { port } = worker.server.address() as { port: number };
  for (const [authorization, expected] of [["wrong", 401], [`Bearer ${token}`, 409]] as const) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/audio/${randomUUID()}/${randomUUID()}`, { headers: { Authorization: authorization } });
    socket.on("error", () => undefined);
    const response = await new Promise<number>((resolve) => socket.on("unexpected-response", (_request, incoming) => { incoming.resume(); resolve(incoming.statusCode!); socket.terminate(); }));
    assert.equal(response, expected);
  }
  assert.equal(opens, 0);
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
    assert.equal(query.get("sample_rate"), "8000"); assert.equal(query.get("encoding"), "linear16"); assert.equal(query.get("endpointing"), "750");
    assert.equal(request.headers.authorization, "Token fake-deepgram-fixture");
    socket.on("message", (_data, binary) => { if (binary) frames++; });
  });
  const utterances: string[] = []; const errors: Error[] = [];
  const provider = new DeepgramSpeechToText({ apiKey: "fake-deepgram-fixture", endpoint: `ws://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/listen` });
  const stream = await provider.open({ onUtterance: (value) => utterances.push(value.transcript), onError: (error) => errors.push(error) }); t.after(() => stream.close());
  stream.write(Buffer.alloc(320)); await waitFor(() => frames === 1);
  const result = { type: "Results", is_final: true, speech_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: "can" }] } };
  peer!.send(JSON.stringify(result)); peer!.send(JSON.stringify(result));
  peer!.send(JSON.stringify({ ...result, speech_final: true, start: 1, channel: { alternatives: [{ transcript: "lah" }] } }));
  peer!.send(JSON.stringify({ type: "UtteranceEnd" }));
  await waitFor(() => utterances.length > 0);
  assert.deepEqual(utterances, ["can lah"]); assert.equal(errors.length, 0);
});
