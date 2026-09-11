import http from "node:http";
import type { Duplex } from "node:stream";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type { SpeechStream, SpeechToText, Utterance } from "./speech-to-text.js";

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const audioPath = new RegExp(`^/audio/(${uuid})/(${uuid})$`, "i");
const windowSchema = z.object({ status: z.string(), listenWindowId: z.string().optional() });
const utteranceSchema = z.object({ transcript: z.string().trim().min(1).max(2000), latencyMs: z.number().finite().min(0).max(60_000).optional() });
export type WorkerOptions = {
  token: string;
  apiUrl: string;
  stt: SpeechToText;
  enabled?: boolean;
  fetch?: typeof globalThis.fetch;
  apiTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxWindowMs?: number;
  onError?: (error: Error, context: { callId: string; windowId: string }) => void;
};

// Race the entire operation, including response-body decoding. Cancellation also
// bounds injected providers/transports that do not themselves honour the signal.
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("Media operation aborted."));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export function createMediaWorker(options: WorkerOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const sessions = new Map<string, () => void>();
  const activeWindows = new Set<string>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64_000, perMessageDeflate: false });
  const shutdown = new AbortController();
  let stopping = false;
  const server = http.createServer((request, response) => {
    if (request.url !== "/health") { response.writeHead(404).end(); return; }
    response.writeHead(stopping ? 503 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: !stopping, enabled: options.enabled !== false, provider: options.stt.provider, windows: activeWindows.size, pendingReceipts: sessions.size - activeWindows.size }));
  });
  const authorized = (header?: string) => options.token.length >= 16 && timingSafeEqual(
    createHash("sha256").update(header ?? "").digest(), createHash("sha256").update(`Bearer ${options.token}`).digest());
  const report = (error: unknown, callId: string, windowId: string) => options.onError?.(error instanceof Error ? error : new Error("Media operation failed."), { callId, windowId });
  const api = <T>(route: string, init: RequestInit | undefined, read: (response: Response) => Promise<T>, cancellation?: AbortSignal) => {
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(options.apiTimeoutMs ?? 3000), ...(cancellation ? [cancellation] : [])]);
    return abortable(Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const response = await transport(new URL(route, options.apiUrl), {
        ...init, headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" }, signal
      });
      return read(response);
    }), signal);
  };
  const post = (route: string, body: object) => api(route, { method: "POST", body: JSON.stringify(body) }, async (response) => {
    // Receipt payloads are not needed; release the HTTP connection promptly.
    await response.body?.cancel();
    return response.status;
  });
  const rejectUpgrade = (socket: Duplex, status: "401 Unauthorized" | "409 Conflict") => {
    socket.once("error", () => socket.destroy());
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
    const deadline = setTimeout(() => socket.destroy(), 1000); deadline.unref();
    socket.once("close", () => clearTimeout(deadline));
  };
  server.on("upgrade", (request, socket, head) => {
    const match = audioPath.exec(request.url ?? "");
    if (stopping || options.enabled === false || !match || !authorized(request.headers.authorization)) {
      rejectUpgrade(socket, "401 Unauthorized"); return;
    }
    const [, callId, windowId] = match;
    // A completed utterance releases its audio slot while its bounded HTTP
    // receipt remains reserved. This lets the API open the next listen before
    // returning its previous HTTP reply without permitting duplicate windows.
    if (sessions.has(windowId) || activeWindows.size >= 5 || sessions.size >= 25) { rejectUpgrade(socket, "409 Conflict"); return; }
    const pending = new AbortController();
    const release = () => {
      pending.abort();
      if (sessions.get(windowId) === dispose) { sessions.delete(windowId); activeWindows.delete(windowId); }
    };
    const dispose = () => { release(); socket.destroy(); };
    const socketError = (error: Error) => { report(error, callId, windowId); dispose(); };
    // Reserve before lookup and release even if the peer disconnects mid-upgrade.
    sessions.set(windowId, dispose);
    activeWindows.add(windowId);
    socket.once("close", release);
    socket.once("end", dispose);
    socket.once("error", socketError);
    void api(`/api/media/calls/${callId}/window`, undefined, async (response) => {
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Listen window lookup failed with HTTP ${response.status}.`); }
      return windowSchema.parse(await response.json());
    }, pending.signal).then((window) => {
      if (window.status !== "listening" || window.listenWindowId !== windowId) throw new Error("Audio socket refers to a closed listen window.");
      if (socket.destroyed || stopping || sessions.get(windowId) !== dispose) return;
      sockets.handleUpgrade(request, socket, head, (ws) => {
        socket.removeListener("close", release);
        socket.removeListener("end", dispose);
        socket.removeListener("error", socketError);
        openWindow(ws, callId, windowId);
      });
    }).catch((error: unknown) => {
      if (!pending.signal.aborted && !stopping) report(error, callId, windowId);
      release();
      if (!socket.destroyed) rejectUpgrade(socket, "409 Conflict");
    });
  });

  function openWindow(socket: WebSocket, callId: string, windowId: string) {
    let stream: SpeechStream | undefined;
    let phase: "collecting" | "submitting" | "finished" = "collecting";
    let inputClosed = false;
    const opening = new AbortController();
    const audio: { pcm: Buffer; receivedAt: number }[] = [];
    let bufferedBytes = 0;
    let totalBytes = 0;
    let connectionDeadline: NodeJS.Timeout | undefined;
    let windowDeadline: NodeJS.Timeout | undefined;
    const closeProvider = (provider: SpeechStream) => {
      try { provider.close(); } catch (error) { report(error, callId, windowId); }
    };
    const stopInput = () => {
      if (inputClosed) return;
      inputClosed = true;
      activeWindows.delete(windowId);
      clearTimeout(connectionDeadline);
      opening.abort();
      audio.length = 0;
      if (stream) closeProvider(stream);
      if (socket.readyState === WebSocket.CLOSED) return;
      socket.close(1000);
      const deadline = setTimeout(() => socket.terminate(), 1000); deadline.unref();
      socket.once("close", () => clearTimeout(deadline));
    };
    const finish = () => {
      if (phase === "finished") return;
      phase = "finished";
      clearTimeout(windowDeadline);
      if (sessions.get(windowId) === finish) sessions.delete(windowId);
      stopInput();
    };
    sessions.set(windowId, finish);
    const fail = (error: unknown) => {
      if (phase === "finished") return;
      report(error, callId, windowId);
      finish();
      if (!stopping) void post(`/api/media/calls/${callId}/error`, { windowId, error: "Speech transcription unavailable." })
        .then((status) => { if ((status < 200 || status >= 300) && status !== 409) throw new Error(`Media failure notification returned HTTP ${status}.`); })
        .catch((failure: unknown) => { if (!stopping) report(failure, callId, windowId); });
    };
    const providerFailed = (error: Error) => { if (phase === "collecting") fail(error); };
    const utterance = (value: Utterance) => {
      if (phase !== "collecting") return;
      const parsed = utteranceSchema.safeParse(value);
      if (!parsed.success) { fail(new Error("Speech provider returned an invalid utterance.")); return; }
      phase = "submitting";
      clearTimeout(windowDeadline);
      stopInput();
      const body = { transcript: parsed.data.transcript, windowId, utteranceId: randomUUID(), sttLatencyMs: parsed.data.latencyMs };
      // Input closure must not cancel this receipt: the API may stop audio before
      // its reply arrives, and a lost reply requires retrying the same receipt.
      void (async () => {
        for (let attempt = 0; attempt < 3 && !stopping; attempt++) {
          let failure: unknown;
          try {
            const status = await post(`/api/calls/${callId}/transcript`, body);
            if ((status >= 200 && status < 300) || status === 409) { finish(); return; }
            if (status < 500) { fail(new Error(`Transcript rejected with HTTP ${status}.`)); return; }
            failure = new Error(`Transcript delivery failed with HTTP ${status}.`);
          } catch (error) { failure = error; }
          if (attempt === 2) throw failure;
          await abortable(new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1))), shutdown.signal);
        }
      })().catch((error: unknown) => { if (!stopping) fail(error); });
    };
    const write = (pcm: Buffer, receivedAt: number) => {
      try { stream!.write(pcm, receivedAt); } catch (error) { fail(error); }
    };
    socket.on("error", (error) => { if (!inputClosed) fail(error); });
    socket.on("close", () => { if (phase === "collecting") finish(); });
    socket.on("message", (data, binary) => {
      if (phase !== "collecting" || !binary) return; // mod_audio_stream may send metadata before PCM.
      const pcm = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (pcm.length === 0) return;
      if (pcm.length % 2) { fail(new Error("PCM frame must contain complete 16-bit samples.")); return; }
      totalBytes += pcm.length;
      if (totalBytes > 960_000) { fail(new Error("Listen window exceeded sixty seconds of PCM audio.")); return; }
      const receivedAt = performance.now();
      if (stream) write(pcm, receivedAt);
      else {
        bufferedBytes += pcm.length;
        if (bufferedBytes > 32_000) { fail(new Error("STT connection exceeded the two-second audio buffer.")); return; }
        audio.push({ pcm, receivedAt });
      }
    });
    connectionDeadline = setTimeout(() => fail(new Error("Speech stream connection timed out.")), options.connectTimeoutMs ?? 3000);
    windowDeadline = setTimeout(() => fail(new Error("Speech listen window exceeded its lifetime.")), options.maxWindowMs ?? 65_000);
    connectionDeadline.unref(); windowDeadline.unref();
    void Promise.resolve().then(() => options.stt.open({ onUtterance: utterance, onError: providerFailed }, opening.signal)).then((opened) => {
      clearTimeout(connectionDeadline);
      if (phase !== "collecting") { closeProvider(opened); return; }
      stream = opened;
      for (const entry of audio) { if (phase !== "collecting") break; write(entry.pcm, entry.receivedAt); }
      audio.length = 0;
    }).catch((error: unknown) => { if (phase === "collecting") fail(error); });
  }
  return {
    server,
    async close() {
      stopping = true;
      shutdown.abort();
      for (const dispose of sessions.values()) dispose();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
