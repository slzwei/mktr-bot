import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CaptureSidecar } from "./pcm-capture.js";
import type { SpeechStream, SpeechToText, UtteranceEnding } from "./speech-to-text.js";

/** 8 kHz signed 16-bit mono: sixteen bytes per millisecond. */
export const BYTES_PER_MS = 16;
const FRAME_MS = 20;
const FRAME_BYTES = FRAME_MS * BYTES_PER_MS;

export type CaptureFrame = { offset: number; bytes: number; t: number };
export type Capture = {
  source: string;
  pcm: Buffer;
  /** Frames in arrival order; `t` is milliseconds after the call's audio stream opened. */
  frames: CaptureFrame[];
  pacing: "sidecar" | "synthetic";
  sidecar?: CaptureSidecar;
};

const sidecarSchema = z.object({
  version: z.literal(1), callId: z.string(), streamId: z.string(), encoding: z.literal("linear16"), sampleRate: z.literal(8000), channels: z.literal(1),
  openedAt: z.string(), closedAt: z.string(), totalBytes: z.number().int().nonnegative(),
  frames: z.array(z.object({ offset: z.number().int().nonnegative(), bytes: z.number().int().positive(), t: z.number().finite().nonnegative() })),
  utterances: z.array(z.object({ transcript: z.string(), latencyMs: z.number().finite().nonnegative().optional(), t: z.number().finite().nonnegative(), windowId: z.string().optional(), finalizedBy: z.enum(["endpoint", "utterance_end"]).optional() })),
  utterancesTruncated: z.literal(true).optional()
});

function syntheticFrames(pcm: Buffer): CaptureFrame[] {
  const frames: CaptureFrame[] = [];
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    frames.push({ offset, bytes: Math.min(FRAME_BYTES, pcm.length - offset), t: (offset + Math.min(FRAME_BYTES, pcm.length - offset)) / BYTES_PER_MS });
  }
  return frames;
}

function wavData(file: Buffer, source: string): Buffer {
  if (file.length < 12 || file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${source} is not a RIFF WAVE file.`);
  let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | undefined;
  for (let offset = 12; offset + 8 <= file.length;) {
    const id = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(file.length, start + size);
    if (id === "fmt ") {
      if (size < 16) throw new Error(`${source} has a malformed fmt chunk.`);
      format = { audioFormat: file.readUInt16LE(start), channels: file.readUInt16LE(start + 2), sampleRate: file.readUInt32LE(start + 4), bits: file.readUInt16LE(start + 14) };
    } else if (id === "data") {
      if (!format) throw new Error(`${source} has a data chunk before its fmt chunk.`);
      if (format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 8000 || format.bits !== 16) {
        throw new Error(`${source} must be 8 kHz mono 16-bit PCM WAV (found format ${format.audioFormat}, ${format.channels} channel(s), ${format.sampleRate} Hz, ${format.bits}-bit).`);
      }
      return file.subarray(start, end);
    }
    offset = start + size + (size % 2);
  }
  throw new Error(`${source} has no data chunk.`);
}

/**
 * Reads a worker capture (`.pcm` with its `.json` sidecar, or the sidecar itself),
 * a bare `.pcm` file, or an 8 kHz mono 16-bit WAV. Files without a sidecar are
 * paced as contiguous real-time 20 ms frames.
 */
export async function readCapture(file: string): Promise<Capture> {
  const extension = path.extname(file).toLowerCase();
  const base = file.slice(0, file.length - extension.length);
  const source = path.basename(file);
  if (extension === ".wav") {
    const pcm = wavData(await readFile(file), source);
    if (pcm.length % 2) throw new Error(`${source} does not contain complete 16-bit samples.`);
    return { source, pcm, frames: syntheticFrames(pcm), pacing: "synthetic" };
  }
  if (extension !== ".pcm" && extension !== ".json") throw new Error(`${source}: expected a .pcm capture, its .json sidecar, or an 8 kHz mono 16-bit .wav file.`);
  const pcm = await readFile(`${base}.pcm`);
  if (pcm.length % 2) throw new Error(`${source} does not contain complete 16-bit samples.`);
  let sidecarText: string | undefined;
  try { sidecarText = await readFile(`${base}.json`, "utf8"); }
  catch (error) {
    if (extension === ".json" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (sidecarText === undefined) return { source, pcm, frames: syntheticFrames(pcm), pacing: "synthetic" };
  const sidecar = sidecarSchema.parse(JSON.parse(sidecarText));
  let expected = 0;
  for (const frame of sidecar.frames) {
    if (frame.offset !== expected) throw new Error(`${source}: sidecar frame at offset ${frame.offset} is not contiguous.`);
    expected += frame.bytes;
  }
  if (expected !== pcm.length || sidecar.totalBytes !== pcm.length) throw new Error(`${source}: sidecar describes ${expected} bytes but the capture holds ${pcm.length}.`);
  return { source, pcm, frames: sidecar.frames, pacing: "sidecar", sidecar };
}

export type SpeechBounds = { startMs: number; endMs: number; thresholdDb: number; noiseFloorDb: number; peakDb: number };

/**
 * Energy-based speech bounds, independent of any speech engine so both sides of
 * an A/B share the same anchor. Frame RMS in dBFS; the noise floor is the 20th
 * percentile frame, and speech is any frame at least `marginDb` above it and
 * above `minimumDb`. The end is the trailing edge of the last such frame.
 */
export function detectSpeech(pcm: Buffer, options: { frameMs?: number; marginDb?: number; minimumDb?: number } = {}): SpeechBounds | undefined {
  const frameMs = options.frameMs ?? FRAME_MS;
  const frameBytes = frameMs * BYTES_PER_MS;
  const levels: number[] = [];
  for (let offset = 0; offset + frameBytes <= pcm.length; offset += frameBytes) {
    let energy = 0;
    for (let index = 0; index < frameBytes; index += 2) {
      const sample = pcm.readInt16LE(offset + index) / 32768;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / (frameBytes / 2));
    levels.push(rms > 0 ? 20 * Math.log10(rms) : -120);
  }
  if (levels.length === 0) return undefined;
  const sorted = [...levels].sort((left, right) => left - right);
  const noiseFloorDb = sorted[Math.floor(sorted.length * 0.2)];
  const peakDb = sorted[sorted.length - 1];
  const thresholdDb = Math.max(noiseFloorDb + (options.marginDb ?? 12), options.minimumDb ?? -50);
  let start = -1;
  let end = -1;
  levels.forEach((level, index) => { if (level >= thresholdDb) { if (start < 0) start = index; end = index; } });
  if (start < 0) return undefined;
  return { startMs: start * frameMs, endMs: (end + 1) * frameMs, thresholdDb, noiseFloorDb, peakDb };
}

export type ReplayOptions = {
  /** `concurrent` opens the engine while audio streams, as the worker does; `first` waits for the socket before streaming. */
  connect?: "concurrent" | "first";
  /** Override the detected end of speech, in milliseconds into the audio. */
  speechEndMs?: number;
  /** Zero-filled real-time silence appended after the capture until the engine finalizes. 0 disables padding. Default 10 s. */
  padSilenceMs?: number;
};

export type ReplayResult = {
  transcript?: string;
  error?: string;
  speechEndMs: number;
  /** Wall-clock time from the end-of-speech sample reaching the engine input to the usable transcript. */
  speechEndToTranscriptMs?: number;
  /** The engine's own estimate of the same interval, when it reports one. */
  providerLatencyMs?: number;
  /** Which marker ended the reply: the configured endpoint, or the fixed 1000 ms UtteranceEnd fallback. */
  finalizedBy?: UtteranceEnding;
  openMs?: number;
  framesBufferedBeforeOpen: number;
  audioMs: number;
  paddedSilenceMs: number;
  utteranceAtMs?: number;
};

const sleepUntil = async (at: number) => {
  const delay = at - performance.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
};

/** Streams a capture into a speech engine at its recorded pacing and measures end of speech to usable transcript. */
export async function replayCapture(capture: Capture, engine: SpeechToText, options: ReplayOptions = {}): Promise<ReplayResult> {
  const speechEndMs = options.speechEndMs ?? detectSpeech(capture.pcm)?.endMs;
  if (speechEndMs === undefined) throw new Error("No speech detected in the capture; pass an explicit end of speech.");
  const endByte = Math.min(capture.pcm.length, Math.max(0, Math.round(speechEndMs * BYTES_PER_MS / 2) * 2));
  const padSilenceMs = options.padSilenceMs ?? 10_000;
  const audioMs = capture.frames.length ? capture.frames[capture.frames.length - 1].t : 0;
  const result: ReplayResult = { speechEndMs, framesBufferedBeforeOpen: 0, audioMs, paddedSilenceMs: 0 };
  const abort = new AbortController();
  const buffered: { pcm: Buffer; receivedAt: number }[] = [];
  let stream: SpeechStream | undefined;
  let speechEndAt: number | undefined;
  let settled = false;
  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { settle = () => { settled = true; resolve(); }; });
  const streamStartedAt = { value: 0 };
  const fail = (error: unknown) => {
    if (settled) return;
    result.error = error instanceof Error ? error.message : String(error);
    settle();
  };
  const openStartedAt = performance.now();
  const opening = engine.open({
    onUtterance(utterance) {
      if (settled) return;
      const at = performance.now();
      result.transcript = utterance.transcript;
      result.providerLatencyMs = utterance.latencyMs;
      result.finalizedBy = utterance.finalizedBy;
      result.utteranceAtMs = Math.round(at - streamStartedAt.value);
      if (speechEndAt !== undefined) result.speechEndToTranscriptMs = Math.round(at - speechEndAt);
      settle();
    },
    onError: fail
  }, abort.signal).then((opened) => {
    result.openMs = Math.round(performance.now() - openStartedAt);
    if (settled) { opened.close(); return; }
    stream = opened;
    result.framesBufferedBeforeOpen = buffered.length;
    for (const entry of buffered) stream.write(entry.pcm, entry.receivedAt);
    buffered.length = 0;
  }, fail);
  if (options.connect === "first") await opening;
  streamStartedAt.value = performance.now();
  const send = (pcm: Buffer) => {
    const receivedAt = performance.now();
    if (stream) stream.write(pcm, receivedAt);
    else buffered.push({ pcm, receivedAt });
    return receivedAt;
  };
  try {
    for (const frame of capture.frames) {
      if (settled) break;
      await sleepUntil(streamStartedAt.value + frame.t);
      if (settled) break;
      const receivedAt = send(capture.pcm.subarray(frame.offset, frame.offset + frame.bytes));
      // The frame arrives with its last sample; earlier samples in it are proportionally older.
      if (speechEndAt === undefined && frame.offset + frame.bytes >= endByte) speechEndAt = receivedAt - (frame.offset + frame.bytes - endByte) / BYTES_PER_MS;
    }
    const silence = Buffer.alloc(FRAME_BYTES);
    for (let padded = 0; !settled && padded < padSilenceMs; padded += FRAME_MS) {
      await sleepUntil(streamStartedAt.value + audioMs + padded + FRAME_MS);
      if (settled) break;
      send(silence);
      result.paddedSilenceMs = padded + FRAME_MS;
    }
    if (!settled) {
      if (padSilenceMs > 0) fail(new Error(`No transcript within ${padSilenceMs} ms of appended silence after the capture ended.`));
      else await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000).unref())]).then(() => { if (!settled) fail(new Error("No transcript within 5 s of the capture ending.")); });
    }
  } catch (error) {
    fail(error);
  } finally {
    abort.abort();
    stream?.close();
  }
  await done;
  return result;
}
