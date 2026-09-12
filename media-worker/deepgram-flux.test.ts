import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { DeepgramFluxSpeechToText, fluxDefaults } from "./deepgram-flux.js";
import { deepgramListenUrl } from "./deepgram.js";
import type { Utterance } from "./speech-to-text.js";
import { waitFor } from "../server/test-support/fake-esl.js";

/** Stands in for Deepgram's /v2/listen, which speaks turns rather than transcripts. */
async function upstream(t: TestContext) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const peers: WebSocket[] = []; const queries: URLSearchParams[] = []; let frames = 0;
  server.on("connection", (socket, request) => {
    peers.push(socket);
    queries.push(new URL(request.url!, "http://fixture.test").searchParams);
    socket.on("message", (_data, binary) => { if (binary) frames++; });
    socket.send(JSON.stringify({ type: "Connected", request_id: "fixture" }));
  });
  t.after(async () => { for (const socket of peers) socket.terminate(); await new Promise<void>((r) => server.close(() => r())); });
  return {
    endpoint: `ws://127.0.0.1:${(server.address() as { port: number }).port}/v2/listen`,
    peer: () => peers[0], queries: () => queries, frames: () => frames
  };
}

const turn = (event: string, transcript: string, index = 0, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "TurnInfo", request_id: "fixture", event, turn_index: index, audio_window_start: 0, audio_window_end: 2,
  transcript, words: transcript ? [{ word: transcript, confidence: 1, start: 0, end: 0.02 }] : [],
  end_of_turn_confidence: event === "EndOfTurn" ? 0.73 : 0.2, sequence_id: 1, ...extra
});

test("Flux reports the caller speaking, then one reply per turn, marked as ended by the turn model", async (t) => {
  const fake = await upstream(t);
  const events: string[] = []; const utterances: Utterance[] = [];
  const stream = await new DeepgramFluxSpeechToText({ apiKey: "fixture-key", endpoint: fake.endpoint, now: () => 2000 }).open({
    onUtterance: (value) => { utterances.push(value); events.push(`reply:${value.transcript}`); },
    onError: (error) => assert.fail(error.message),
    onSpeechStarted: () => events.push("speaking")
  });
  t.after(() => stream.close());
  stream.write(Buffer.alloc(320), 1000);
  await waitFor(() => fake.frames() === 1);

  fake.peer().send(turn("StartOfTurn", "Yeah"));
  fake.peer().send(turn("Update", "Yeah. Okay"));
  fake.peer().send(turn("EndOfTurn", "Yeah. Okay."));
  await waitFor(() => utterances.length === 1);
  // A second turn on the same connection: this is the whole point of one stream per call.
  fake.peer().send(turn("StartOfTurn", "No", 1));
  fake.peer().send(turn("EndOfTurn", "No need.", 1));
  await waitFor(() => utterances.length === 2);

  assert.deepEqual(events, ["speaking", "reply:Yeah. Okay.", "speaking", "reply:No need."]);
  assert.deepEqual(utterances.map(({ transcript, finalizedBy }) => ({ transcript, finalizedBy })), [
    { transcript: "Yeah. Okay.", finalizedBy: "turn" },
    { transcript: "No need.", finalizedBy: "turn" }
  ]);
  // 320 bytes arrived at 1000 ms carrying 20 ms of audio, so the timeline starts at 980 ms and the
  // last word ends at its far edge, 1000 ms. A clock reading 2000 ms makes that a 1000 ms estimate.
  assert.equal(utterances[0].latencyMs, 1000);
});

test("a turn the model gives up on is reported as a timeout, and an empty turn produces no reply", async (t) => {
  const fake = await upstream(t);
  const utterances: Utterance[] = [];
  const stream = await new DeepgramFluxSpeechToText({ apiKey: "fixture-key", endpoint: fake.endpoint }).open({
    onUtterance: (value) => utterances.push(value), onError: (error) => assert.fail(error.message)
  });
  t.after(() => stream.close());
  fake.peer().send(turn("EndOfTurn", "", 0));
  fake.peer().send(turn("EndOfTurn", "Call me later.", 1, { trigger: "timeout" }));
  await waitFor(() => utterances.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(utterances.map(({ transcript, finalizedBy }) => ({ transcript, finalizedBy })), [{ transcript: "Call me later.", finalizedBy: "timeout" }]);
});

test("Flux settings reach the wire and the endpoint is v2, with invalid values refused before connecting", async (t) => {
  const fake = await upstream(t);
  const stream = await new DeepgramFluxSpeechToText({ apiKey: "fixture-key", endpoint: fake.endpoint, eotThreshold: 0.55, eotTimeoutMs: 4000, model: "flux-general-en" }).open({
    onUtterance: () => undefined, onError: () => undefined
  });
  t.after(() => stream.close());
  const query = fake.queries()[0];
  assert.equal(query.get("model"), "flux-general-en");
  assert.equal(query.get("encoding"), "linear16");
  assert.equal(query.get("sample_rate"), "8000");
  assert.equal(query.get("eot_threshold"), "0.55");
  assert.equal(query.get("eot_timeout_ms"), "4000");
  // The v2 endpoint takes no language parameter; the model name carries it.
  assert.equal(query.get("language"), null);

  for (const [options, message] of [
    [{ model: "flux" }, /three hyphen-separated parts/],
    [{ eotThreshold: 1.4 }, /between 0 and 1/],
    [{ eotTimeoutMs: 250 }, /1000 to 60000/],
    [{ apiKey: "" }, /DEEPGRAM_API_KEY is required/]
  ] as const) {
    await assert.rejects(new DeepgramFluxSpeechToText({ apiKey: "fixture-key", endpoint: fake.endpoint, ...options }).open({ onUtterance: () => undefined, onError: () => undefined }), message);
  }
});

test("Flux URLs are built from the same guarded origin as v1, on the v2 path", () => {
  assert.equal(deepgramListenUrl(undefined, fluxDefaults.path), "wss://api.au.deepgram.com/v2/listen");
  assert.equal(deepgramListenUrl("https://api.deepgram.com", fluxDefaults.path), "wss://api.deepgram.com/v2/listen");
  assert.throws(() => deepgramListenUrl("http://api.deepgram.com", fluxDefaults.path), /cleartext/);
  assert.throws(() => deepgramListenUrl("https://api.deepgram.com/v2/listen", fluxDefaults.path), /bare origin/);
});

test("a provider error and an abrupt close are each reported once", async (t) => {
  const fake = await upstream(t);
  const errors: Error[] = [];
  const stream = await new DeepgramFluxSpeechToText({ apiKey: "fixture-key", endpoint: fake.endpoint }).open({ onUtterance: () => undefined, onError: (error) => errors.push(error) });
  fake.peer().send(JSON.stringify({ type: "Error", description: "fixture" }));
  await waitFor(() => errors.length === 1);
  assert.match(errors[0].message, /reported a transcription error/);
  assert.throws(() => stream.write(Buffer.alloc(320)), /stream is closed/);
  stream.close();
  fake.peer().terminate();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(errors.length, 1);
});

test("a caller abort cancels Flux while its handshake is still pending", async () => {
  const control = new AbortController();
  const opening = new DeepgramFluxSpeechToText({ apiKey: "fixture-key", endpoint: "ws://127.0.0.1:9/v2/listen", connectTimeoutMs: 2000 })
    .open({ onUtterance: () => undefined, onError: () => undefined }, control.signal);
  control.abort();
  await assert.rejects(opening, /cancelled|Could not connect/);
});
