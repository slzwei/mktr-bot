import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UtteranceEnding } from "../src/lib/domain.js";
import type { Utterance } from "./speech-to-text.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** A call's worth of replies with room to spare; a longer run stops appending rather than growing. */
const MAX_UTTERANCES = 200;

/**
 * Written beside each `<streamId>.pcm` once the call's audio ends. `t` values are
 * milliseconds after `openedAt` on the worker's monotonic clock, taken at the
 * same instant the worker stamps the frame for the speech provider.
 */
export type CaptureSidecar = {
  version: 1;
  callId: string;
  streamId: string;
  encoding: "linear16";
  sampleRate: 8000;
  channels: 1;
  openedAt: string;
  closedAt: string;
  totalBytes: number;
  frames: { offset: number; bytes: number; t: number }[];
  /** Every utterance the provider finalized on this stream. `windowId` is absent when no listen window was open, so the reply was discarded. */
  utterances: { transcript: string; latencyMs?: number; t: number; windowId?: string; finalizedBy?: UtteranceEnding }[];
  /** True when the call produced more utterances than the sidecar records. */
  utterancesTruncated?: true;
};

export type CaptureStream = {
  frame(pcm: Buffer, receivedAt: number): void;
  utterance(value: Utterance, receivedAt: number, windowId?: string): void;
  close(): void;
};

export type PcmCapture = {
  readonly directory: string;
  open(callId: string, streamId: string, openedAt: number): CaptureStream;
};

export type PcmCaptureOptions = {
  directory: string;
  onError: (error: Error, context: { callId: string; streamId: string }) => void;
  /** Unwritten bytes beyond this stop the capture for that call instead of growing memory. Default 1 MB. */
  maxPendingBytes?: number;
};

/**
 * Tees inbound callee PCM to `<directory>/<callId>/<streamId>.pcm` exactly as the
 * speech provider receives it, with a JSON sidecar of frame arrival times. One file
 * covers the whole call, because the worker holds one audio stream per call. This is
 * a diagnostic: a capture failure is reported with its call context and stops that
 * call's capture, never the call.
 */
export function createPcmCapture(options: PcmCaptureOptions): PcmCapture {
  const maxPending = options.maxPendingBytes ?? 1_048_576;
  return {
    directory: options.directory,
    open(callId, streamId, openedAt) {
      if (!uuid.test(callId) || !uuid.test(streamId)) throw new Error("PCM capture requires UUID call and stream identifiers.");
      const context = { callId, streamId };
      const base = path.join(options.directory, callId, streamId);
      const sidecar: CaptureSidecar = { version: 1, callId, streamId, encoding: "linear16", sampleRate: 8000, channels: 1, openedAt: new Date().toISOString(), closedAt: "", totalBytes: 0, frames: [], utterances: [] };
      let stream: WriteStream | undefined;
      let failed = false;
      let closing = false;
      const queued: Buffer[] = [];
      let queuedBytes = 0;
      const fail = (error: unknown) => {
        if (failed) return;
        failed = true;
        queued.length = 0;
        stream?.destroy();
        options.onError(error instanceof Error ? error : new Error("PCM capture failed."), context);
      };
      const finalize = () => {
        if (failed) return;
        sidecar.closedAt = new Date().toISOString();
        const sidecarJson = JSON.stringify(sidecar, null, 2) + "\n";
        const writeSidecar = () => { writeFile(`${base}.json`, sidecarJson, { flag: "wx" }).catch(fail); };
        if (stream) stream.end(writeSidecar);
        else writeSidecar();
      };
      mkdir(path.dirname(base), { recursive: true }).then(() => {
        if (failed) return;
        stream = createWriteStream(`${base}.pcm`, { flags: "wx" });
        stream.on("error", fail);
        for (const chunk of queued) stream.write(chunk);
        queued.length = 0;
        queuedBytes = 0;
        if (closing) finalize();
      }, fail);
      return {
        frame(pcm, receivedAt) {
          if (failed || closing) return;
          sidecar.frames.push({ offset: sidecar.totalBytes, bytes: pcm.length, t: Math.round((receivedAt - openedAt) * 1000) / 1000 });
          sidecar.totalBytes += pcm.length;
          if (stream) {
            stream.write(pcm);
            if (stream.writableLength > maxPending) fail(new Error("PCM capture fell behind the audio source; capture stopped for this call."));
          } else {
            queued.push(pcm);
            queuedBytes += pcm.length;
            if (queuedBytes > maxPending) fail(new Error("PCM capture directory was not ready in time; capture stopped for this call."));
          }
        },
        utterance(value, receivedAt, windowId) {
          if (failed || closing) return;
          if (sidecar.utterances.length >= MAX_UTTERANCES) { sidecar.utterancesTruncated = true; return; }
          sidecar.utterances.push({ transcript: value.transcript, ...(value.latencyMs !== undefined ? { latencyMs: value.latencyMs } : {}),
            ...(value.finalizedBy === undefined ? {} : { finalizedBy: value.finalizedBy }),
            t: Math.round((receivedAt - openedAt) * 1000) / 1000, ...(windowId === undefined ? {} : { windowId }) });
        },
        close() {
          if (closing) return;
          closing = true;
          // Before the directory exists the queued frames are flushed and finalized by the mkdir continuation.
          if (stream) finalize();
        }
      };
    }
  };
}
