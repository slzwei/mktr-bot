import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Utterance } from "./speech-to-text.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Written beside each `<windowId>.pcm` once the window closes. `t` values are
 * milliseconds after `openedAt` on the worker's monotonic clock, taken at the
 * same instant the worker stamps the frame for the speech provider.
 */
export type CaptureSidecar = {
  version: 1;
  callId: string;
  windowId: string;
  encoding: "linear16";
  sampleRate: 8000;
  channels: 1;
  openedAt: string;
  closedAt: string;
  totalBytes: number;
  frames: { offset: number; bytes: number; t: number }[];
  utterance?: { transcript: string; latencyMs?: number; t: number };
};

export type CaptureWindow = {
  frame(pcm: Buffer, receivedAt: number): void;
  utterance(value: Utterance, receivedAt: number): void;
  close(): void;
};

export type PcmCapture = {
  readonly directory: string;
  open(callId: string, windowId: string, openedAt: number): CaptureWindow;
};

export type PcmCaptureOptions = {
  directory: string;
  onError: (error: Error, context: { callId: string; windowId: string }) => void;
  /** Unwritten bytes beyond this stop the capture for that window instead of growing memory. Default 1 MB. */
  maxPendingBytes?: number;
};

/**
 * Tees inbound callee PCM to `<directory>/<callId>/<windowId>.pcm` exactly as the
 * speech provider receives it, with a JSON sidecar of frame arrival times. This is
 * a diagnostic: a capture failure is reported with its call context and stops that
 * window's capture, never the call.
 */
export function createPcmCapture(options: PcmCaptureOptions): PcmCapture {
  const maxPending = options.maxPendingBytes ?? 1_048_576;
  return {
    directory: options.directory,
    open(callId, windowId, openedAt) {
      if (!uuid.test(callId) || !uuid.test(windowId)) throw new Error("PCM capture requires UUID call and window identifiers.");
      const context = { callId, windowId };
      const base = path.join(options.directory, callId, windowId);
      const sidecar: CaptureSidecar = { version: 1, callId, windowId, encoding: "linear16", sampleRate: 8000, channels: 1, openedAt: new Date().toISOString(), closedAt: "", totalBytes: 0, frames: [] };
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
            if (stream.writableLength > maxPending) fail(new Error("PCM capture fell behind the audio source; capture stopped for this window."));
          } else {
            queued.push(pcm);
            queuedBytes += pcm.length;
            if (queuedBytes > maxPending) fail(new Error("PCM capture directory was not ready in time; capture stopped for this window."));
          }
        },
        utterance(value, receivedAt) {
          if (failed || closing) return;
          sidecar.utterance = { transcript: value.transcript, ...(value.latencyMs !== undefined ? { latencyMs: value.latencyMs } : {}), t: Math.round((receivedAt - openedAt) * 1000) / 1000 };
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
