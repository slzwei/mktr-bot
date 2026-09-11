import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type { SpeechStream, SpeechToText, Utterance } from "./speech-to-text.js";

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const audioPath = new RegExp(`^/audio/(${uuid})/(${uuid})$`, "i");
const windowSchema = z.object({ status: z.string(), listenWindowId: z.string().optional() });
export type WorkerOptions = {
  token: string;
  apiUrl: string;
  stt: SpeechToText;
  enabled?: boolean;
  fetch?: typeof globalThis.fetch;
  onError?: (error: Error, context: { callId: string; windowId: string }) => void;
};

export function createMediaWorker(options: WorkerOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  const sessions = new Map<string, () => void>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64_000, perMessageDeflate: false });
  let stopping = false;
  const server = http.createServer((request, response) => {
    if (request.url !== "/health") { response.writeHead(404).end(); return; }
    response.writeHead(stopping ? 503 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: !stopping, enabled: options.enabled !== false, provider: options.stt.provider, windows: sessions.size }));
  });
  const authorized = (header?: string) => options.token.length >= 16 && timingSafeEqual(
    createHash("sha256").update(header ?? "").digest(), createHash("sha256").update(`Bearer ${options.token}`).digest());
  const api = (route: string, init?: RequestInit) => transport(new URL(route, options.apiUrl), {
    ...init, headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(3000)
  });
  server.on("upgrade", (request, socket, head) => {
    const match = audioPath.exec(request.url ?? "");
    if (stopping || options.enabled === false || !match || !authorized(request.headers.authorization)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return;
    }
    const [, callId, windowId] = match;
    // Reservation precedes the HTTP await, preventing duplicate sockets for one window.
    if (sessions.has(windowId) || sessions.size >= 5) { socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n"); return; }
    sessions.set(windowId, () => socket.destroy());
    void (async () => {
      const response = await api(`/api/media/calls/${callId}/window`);
      if (!response.ok) throw new Error(`Listen window lookup failed with HTTP ${response.status}.`);
      const window = windowSchema.parse(await response.json());
      if (window.status !== "listening" || window.listenWindowId !== windowId) throw new Error("Audio socket refers to a closed listen window.");
      if (socket.destroyed || stopping) { sessions.delete(windowId); return; }
      sockets.handleUpgrade(request, socket, head, (ws) => openWindow(ws, callId, windowId));
    })().catch((error: unknown) => {
      sessions.delete(windowId);
      options.onError?.(error instanceof Error ? error : new Error("Audio upgrade failed."), { callId, windowId });
      socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
    });
  });

  function openWindow(socket: WebSocket, callId: string, windowId: string) {
    let stream: SpeechStream | undefined;
    let closed = false;
    let submitted = false;
    const audio: Buffer[] = [];
    let bufferedBytes = 0;
    const dispose = () => {
      if (closed) return;
      closed = true;
      sessions.delete(windowId);
      audio.length = 0;
      stream?.close();
      socket.close(1000);
      const deadline = setTimeout(() => socket.terminate(), 1000); deadline.unref();
      socket.once("close", () => clearTimeout(deadline));
    };
    sessions.set(windowId, dispose);
    const fail = (error: Error) => {
      if (closed) return;
      options.onError?.(error, { callId, windowId });
      dispose();
      void api(`/api/media/calls/${callId}/error`, { method: "POST", body: JSON.stringify({ windowId, error: "Speech transcription unavailable." }) })
        .then((response) => { if (!response.ok && response.status !== 409) throw new Error(`Media failure notification returned HTTP ${response.status}.`); })
        .catch((failure: unknown) => options.onError?.(failure instanceof Error ? failure : new Error("Media failure notification failed."), { callId, windowId }));
    };
    const utterance = (value: Utterance) => {
      if (closed || submitted || !value.transcript.trim()) return;
      submitted = true;
      const utteranceId = randomUUID();
      // The same receipt key is reused on retry so a lost HTTP reply cannot classify twice.
      void (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await api(`/api/calls/${callId}/transcript`, { method: "POST", body: JSON.stringify({ transcript: value.transcript, windowId, utteranceId, sttLatencyMs: value.latencyMs }) });
            if (response.ok || response.status === 409) { dispose(); return; }
            if (response.status < 500) throw new Error(`Transcript rejected with HTTP ${response.status}.`);
            if (attempt === 2) throw new Error(`Transcript delivery failed with HTTP ${response.status}.`);
          } catch (error) {
            if (attempt === 2) throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
      })().catch((error: unknown) => fail(error instanceof Error ? error : new Error("Transcript delivery failed.")));
    };
    socket.on("error", (error) => fail(error));
    socket.on("close", dispose);
    socket.on("message", (data, binary) => {
      if (closed || submitted) return;
      if (!binary) return; // mod_audio_stream may send a metadata text frame before PCM.
      const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (pcm.length % 2) { fail(new Error("PCM frame must contain complete 16-bit samples.")); return; }
      if (stream) stream.write(pcm);
      else {
        bufferedBytes += pcm.length;
        if (bufferedBytes > 32_000) { fail(new Error("STT connection exceeded the two-second audio buffer.")); return; }
        audio.push(pcm);
      }
    });
    void options.stt.open({ onUtterance: utterance, onError: fail }).then((opened) => {
      if (closed) { opened.close(); return; }
      stream = opened;
      for (const pcm of audio) stream.write(pcm);
      audio.length = 0;
    }).catch((error: unknown) => fail(error instanceof Error ? error : new Error("Speech stream could not start.")));
  }
  return {
    server,
    async close() {
      stopping = true;
      for (const dispose of sessions.values()) dispose();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
