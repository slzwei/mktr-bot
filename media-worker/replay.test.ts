import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { BYTES_PER_MS, detectSpeech, readCapture, replayCapture, type Capture } from "./replay.js";
import type { CaptureSidecar } from "./pcm-capture.js";
import type { SpeechCallbacks, SpeechToText } from "./speech-to-text.js";

/** Deterministic 8 kHz audio: low noise, a loud tone, then low noise again. */
function synth(leadMs: number, toneMs: number, tailMs: number): Buffer {
  const pcm = Buffer.alloc((leadMs + toneMs + tailMs) * BYTES_PER_MS);
  let seed = 7;
  const noise = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return (seed % 101) - 50; };
  for (let sample = 0; sample < pcm.length / 2; sample++) {
    const ms = sample / 8;
    const value = ms >= leadMs && ms < leadMs + toneMs ? Math.round(8000 * Math.sin(2 * Math.PI * 440 * sample / 8000)) : noise();
    pcm.writeInt16LE(value, sample * 2);
  }
  return pcm;
}

function wav(pcm: Buffer, sampleRate = 8000, channels = 1, bits = 16): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * bits / 8, 28); header.writeUInt16LE(channels * bits / 8, 32); header.writeUInt16LE(bits, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** A four-byte LIST/INFO chunk as ffmpeg writes between fmt and data. */
const listChunk = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);

function syntheticCapture(source: string, pcm: Buffer): Capture {
  const frames: Capture["frames"] = [];
  for (let offset = 0; offset < pcm.length; offset += 320) frames.push({ offset, bytes: 320, t: (offset + 320) / BYTES_PER_MS });
  return { source, pcm, frames, pacing: "synthetic" };
}

async function scratch(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Emits one utterance a fixed audio interval after the end-of-speech byte has arrived, like an endpointing engine. */
function fakeEngine(endByte: number, silenceMs: number, openDelayMs = 0) {
  const writes: { bytes: number; receivedAt: number }[] = [];
  let openedAt: number | undefined;
  const engine: SpeechToText = { provider: "fake", async open(callbacks: SpeechCallbacks) {
    if (openDelayMs) await new Promise((resolve) => setTimeout(resolve, openDelayMs));
    openedAt = performance.now();
    let received = 0; let emitted = false;
    return {
      write(pcm, receivedAt) {
        writes.push({ bytes: pcm.length, receivedAt: receivedAt! });
        received += pcm.length;
        if (!emitted && received >= endByte + silenceMs * BYTES_PER_MS) { emitted = true; setTimeout(() => callbacks.onUtterance({ transcript: "fake yes", latencyMs: silenceMs + 10 }), 10); }
      },
      close() {}
    };
  } };
  return { engine, writes, openedAt: () => openedAt! };
}

test("energy-based speech bounds land on the tone edges and digital silence yields no speech", () => {
  const bounds = detectSpeech(synth(300, 400, 500))!;
  assert.equal(bounds.startMs, 300); assert.equal(bounds.endMs, 700);
  assert.ok(bounds.peakDb > -20 && bounds.noiseFloorDb < -55 && bounds.thresholdDb >= -50 && bounds.thresholdDb < -40, JSON.stringify(bounds));
  assert.equal(detectSpeech(Buffer.alloc(16_000)), undefined);
  assert.equal(detectSpeech(Buffer.alloc(0)), undefined);
});

test("captures read with sidecar pacing, bare PCM and WAV read with synthetic pacing, and inconsistent inputs are rejected", async (t) => {
  const directory = await scratch(t);
  const pcm = synth(100, 100, 100);
  const sidecar: CaptureSidecar = { version: 1, callId: "c", windowId: "w", encoding: "linear16", sampleRate: 8000, channels: 1, openedAt: "2026-09-12T00:00:00.000Z", closedAt: "2026-09-12T00:00:01.000Z", totalBytes: pcm.length,
    frames: [{ offset: 0, bytes: 1600, t: 12.5 }, { offset: 1600, bytes: 3200, t: 231 }], utterance: { transcript: "live", latencyMs: 900, t: 1150 } };
  await writeFile(path.join(directory, "w.pcm"), pcm);
  await writeFile(path.join(directory, "w.json"), JSON.stringify(sidecar));
  for (const name of ["w.pcm", "w.json"]) {
    const capture = await readCapture(path.join(directory, name));
    assert.equal(capture.pacing, "sidecar"); assert.deepEqual(capture.frames, sidecar.frames); assert.deepEqual(capture.pcm, pcm); assert.equal(capture.sidecar?.utterance?.transcript, "live");
  }
  await writeFile(path.join(directory, "bare.pcm"), pcm);
  const bare = await readCapture(path.join(directory, "bare.pcm"));
  assert.equal(bare.pacing, "synthetic"); assert.equal(bare.frames.length, 15);
  assert.deepEqual(bare.frames[0], { offset: 0, bytes: 320, t: 20 }); assert.deepEqual(bare.frames[14], { offset: 4480, bytes: 320, t: 300 });
  await writeFile(path.join(directory, "clip.wav"), Buffer.concat([wav(pcm).subarray(0, 36), listChunk, wav(pcm).subarray(36)]));
  const clip = await readCapture(path.join(directory, "clip.wav"));
  assert.deepEqual(clip.pcm, pcm); assert.equal(clip.pacing, "synthetic");
  await writeFile(path.join(directory, "wide.wav"), wav(pcm, 16_000));
  await assert.rejects(readCapture(path.join(directory, "wide.wav")), /8 kHz mono 16-bit/);
  await writeFile(path.join(directory, "short.json"), JSON.stringify({ ...sidecar, totalBytes: 1 }));
  await writeFile(path.join(directory, "short.pcm"), pcm);
  await assert.rejects(readCapture(path.join(directory, "short.json")), /describes/);
  await assert.rejects(readCapture(path.join(directory, "notes.txt")), /expected a \.pcm/);
});

test("replay paces frames on the wall clock, buffers audio while the engine opens, and measures end of speech to transcript", async () => {
  const capture = syntheticCapture("synthetic", synth(100, 200, 300));
  const endByte = 300 * BYTES_PER_MS;
  const fake = fakeEngine(endByte, 100, 80);
  const result = await replayCapture(capture, fake.engine, { connect: "concurrent" });
  assert.equal(result.error, undefined); assert.equal(result.transcript, "fake yes"); assert.equal(result.speechEndMs, 300);
  assert.equal(result.providerLatencyMs, 110); assert.equal(result.paddedSilenceMs, 0); assert.equal(result.audioMs, 600);
  assert.ok(result.openMs! >= 75, `open took ${result.openMs} ms`);
  assert.ok(result.framesBufferedBeforeOpen >= 2, `${result.framesBufferedBeforeOpen} frames buffered before open`);
  assert.ok(fake.writes[0].receivedAt < fake.openedAt(), "buffered frames keep their original arrival time");
  // Streaming stops at the utterance, as in the worker: at least the 400 ms of audio the engine needed went out.
  assert.ok(fake.writes.length >= 20 && fake.writes.length <= 22, `${fake.writes.length} frames written`);
  // Never early, and the timeline drifts by well under a frame over the run.
  fake.writes.forEach((write, index) => assert.ok(write.receivedAt - fake.writes[0].receivedAt >= 20 * index - 5, `frame ${index} arrived early`));
  const span = fake.writes[fake.writes.length - 1].receivedAt - fake.writes[0].receivedAt;
  assert.ok(span >= 20 * (fake.writes.length - 1) - 5 && span <= 20 * (fake.writes.length - 1) + 60, `${fake.writes.length} frames spanned ${span} ms`);
  // 100 ms of post-speech audio plus the engine's 10 ms finalization; timers only ever run late.
  assert.ok(result.speechEndToTranscriptMs! >= 105 && result.speechEndToTranscriptMs! <= 220, `measured ${result.speechEndToTranscriptMs} ms`);

  const first = fakeEngine(endByte, 100, 40);
  const isolated = await replayCapture(capture, first.engine, { connect: "first" });
  assert.equal(isolated.framesBufferedBeforeOpen, 0);
  assert.ok(first.writes[0].receivedAt >= first.openedAt(), "connect=first streams nothing before the socket is open");
  assert.ok(isolated.speechEndToTranscriptMs! >= 105 && isolated.speechEndToTranscriptMs! <= 220, `measured ${isolated.speechEndToTranscriptMs} ms`);
});

test("replay appends real-time silence when the capture ends before the engine finalizes, and bounds that padding", async () => {
  const capture = syntheticCapture("short", synth(100, 200, 40));
  const endByte = 300 * BYTES_PER_MS;
  const padded = await replayCapture(capture, fakeEngine(endByte, 200).engine, { connect: "first" });
  assert.equal(padded.transcript, "fake yes"); assert.equal(padded.error, undefined);
  assert.ok(padded.paddedSilenceMs >= 160 && padded.paddedSilenceMs <= 240, `padded ${padded.paddedSilenceMs} ms`);
  assert.ok(padded.speechEndToTranscriptMs! >= 205 && padded.speechEndToTranscriptMs! <= 320, `measured ${padded.speechEndToTranscriptMs} ms`);
  const bounded = await replayCapture(capture, fakeEngine(endByte, 200).engine, { connect: "first", padSilenceMs: 60 });
  assert.equal(bounded.transcript, undefined); assert.match(bounded.error!, /No transcript within 60 ms/);
  await assert.rejects(replayCapture({ ...capture, pcm: Buffer.alloc(capture.pcm.length) }, fakeEngine(endByte, 200).engine), /No speech detected/);
});

test("the replay CLI streams a capture through the Deepgram wire protocol and prints the measurement", async (t) => {
  const directory = await scratch(t);
  await writeFile(path.join(directory, "turn.pcm"), synth(100, 200, 500));
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  t.after(async () => { for (const socket of upstream.clients) socket.terminate(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });
  const queries: URLSearchParams[] = [];
  upstream.on("connection", (socket, request) => {
    queries.push(new URL(request.url!, "http://fixture.test").searchParams);
    let received = 0; let sent = false;
    socket.on("message", (data, binary) => {
      if (!binary) return;
      received += (data as Buffer).length;
      // Finalize once 200 ms of audio has followed the 300 ms speech end, with word timing on the audio timeline.
      if (!sent && received >= 500 * BYTES_PER_MS) { sent = true; socket.send(JSON.stringify({ type: "Results", is_final: true, speech_final: true, start: 0.1, duration: 0.2, channel: { alternatives: [{ transcript: "yes", words: [{ end: 0.3 }] }] } })); }
    });
  });
  const port = (upstream.address() as { port: number }).port;
  const { stdout } = await promisify(execFile)(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/replay-stt.ts", path.join(directory, "turn.pcm"), "--json", "--endpoint", `ws://127.0.0.1:${port}/v1/listen`, "--endpointing-ms", "200", "--model", "nova-2", "--connect", "first"],
    { env: { ...process.env, DEEPGRAM_API_KEY: "fake-replay-key" }, timeout: 30_000 });
  const report = JSON.parse(stdout);
  assert.equal(queries.length, 1); assert.equal(queries[0].get("endpointing"), "200"); assert.equal(queries[0].get("model"), "nova-2"); assert.equal(queries[0].get("utterance_end_ms"), "1000");
  assert.equal(report.capture.pacing, "synthetic"); assert.equal(report.speechEndMs, 300); assert.equal(report.connect, "first");
  assert.equal(report.results.length, 1); assert.equal(report.results[0].transcript, "yes"); assert.equal(report.results[0].error, undefined);
  assert.ok(report.results[0].speechEndToTranscriptMs >= 195 && report.results[0].speechEndToTranscriptMs <= 320, `measured ${report.results[0].speechEndToTranscriptMs} ms`);
  assert.ok(Math.abs(report.results[0].providerLatencyMs - report.results[0].speechEndToTranscriptMs) <= 40, "the engine estimate agrees with the wall-clock measurement");
  assert.deepEqual(report.summary, { runs: 1, measured: 1, medianMs: report.results[0].speechEndToTranscriptMs, minMs: report.results[0].speechEndToTranscriptMs, maxMs: report.results[0].speechEndToTranscriptMs });
  assert.doesNotMatch(stdout, /fake-replay-key/);
});
