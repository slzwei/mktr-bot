import http from "node:http";
import type { Duplex } from "node:stream";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { ACTIVE_CALL_STATUSES, LISTEN_ENDPOINTING, type CallStatus } from "../src/lib/domain.js";
import type { CaptureStream, PcmCapture } from "./pcm-capture.js";
import type { ListenSettings, SpeechStream, SpeechToText, Utterance } from "./speech-to-text.js";

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
/** One audio socket per call; it outlives every listen window on that call. */
const audioPath = new RegExp(`^/audio/(${uuid})$`, "i");
/** The API opens and closes listen windows here; the audio and the provider keep running. */
const windowPath = new RegExp(`^/calls/(${uuid})/window/(${uuid})$`, "i");
const endpointingMs = z.number().int().min(LISTEN_ENDPOINTING.minMs).max(LISTEN_ENDPOINTING.maxMs);
const callSchema = z.object({ status: z.string(), listenWindowId: z.string().optional(), endpointingMs: endpointingMs.optional() });
const utteranceSchema = z.object({ transcript: z.string().trim().min(1).max(2000), latencyMs: z.number().finite().min(0).max(60_000).optional(), finalizedBy: z.enum(["endpoint", "utterance_end"]).optional() });
/** Five concurrent calls matches the trunk ceiling; reservations outlive their audio only until receipts settle. */
const MAX_CALLS = 5;
const MAX_RESERVATIONS = 25;
/** 8 kHz signed 16-bit mono. */
const BYTES_PER_MS = 16;

export type WorkerOptions = {
  token: string;
  apiUrl: string;
  stt: SpeechToText;
  enabled?: boolean;
  fetch?: typeof globalThis.fetch;
  apiTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Lifetime of one call's audio, matching the API's MKTR_MAX_CALL_SECONDS. */
  maxCallMs?: number;
  /** Optional diagnostic tee of every accepted PCM frame; see pcm-capture.ts. */
  capture?: PcmCapture;
  onError?: (error: Error, context: { callId: string; windowId?: string }) => void;
};

type ListenWindowState = { id: string; endpointingMs: number };
type AudioSession = { retune(window: ListenWindowState): void; fail(error: unknown): void; close(): void };
type CallEntry = {
  readonly callId: string;
  /** The window the API last opened. Only a transcript for an open window is submitted. */
  window?: ListenWindowState;
  /** Present from the moment a FreeSWITCH socket is accepted until that socket closes. */
  audio?: AudioSession;
  /** Abandons an upgrade whose call lookup is still in flight; set only while one is. */
  connecting?: () => void;
  /** Transcript receipts still being delivered; the reservation outlives the audio until they settle. */
  receipts: number;
  lifetime: NodeJS.Timeout;
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
  const calls = new Map<string, CallEntry>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64_000, perMessageDeflate: false });
  const shutdown = new AbortController();
  const maxCallMs = options.maxCallMs ?? 180_000;
  // A tenth of headroom over the configured call length, so the worker never ends a call
  // the gateway's own scheduled duration limit is about to end anyway.
  const maxCallBytes = Math.ceil(maxCallMs * BYTES_PER_MS * 1.1);
  let stopping = false;

  const holdsCallSlot = (entry: CallEntry) => Boolean(entry.audio ?? entry.connecting);
  const count = (predicate: (entry: CallEntry) => boolean) => [...calls.values()].filter(predicate).length;
  const report = (error: unknown, callId: string, windowId?: string) =>
    options.onError?.(error instanceof Error ? error : new Error("Media operation failed."), { callId, windowId });

  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(stopping ? 503 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: !stopping, enabled: options.enabled !== false, provider: options.stt.provider, pcmCapture: Boolean(options.capture),
        calls: count(holdsCallSlot), windows: count((entry) => entry.window !== undefined), pendingReceipts: count((entry) => entry.receipts > 0)
      }));
      return;
    }
    const match = windowPath.exec((request.url ?? "").split("?")[0]);
    if (!match || (request.method !== "POST" && request.method !== "DELETE")) { response.writeHead(404).end(); return; }
    handleWindow(request, response, match[1], match[2]);
  });

  const authorized = (header?: string) => options.token.length >= 16 && timingSafeEqual(
    createHash("sha256").update(header ?? "").digest(), createHash("sha256").update(`Bearer ${options.token}`).digest());

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

  function reserve(callId: string): CallEntry | undefined {
    const existing = calls.get(callId);
    if (existing) return existing;
    if (calls.size >= MAX_RESERVATIONS) return undefined;
    const entry: CallEntry = { callId, receipts: 0, lifetime: undefined as unknown as NodeJS.Timeout };
    entry.lifetime = setTimeout(() => {
      entry.audio?.fail(new Error("Call audio exceeded its maximum lifetime."));
      entry.connecting?.();
      entry.window = undefined;
      release(entry);
    }, maxCallMs);
    entry.lifetime.unref();
    calls.set(callId, entry);
    return entry;
  }

  function release(entry: CallEntry) {
    if (entry.audio || entry.connecting || entry.receipts > 0 || entry.window) return;
    clearTimeout(entry.lifetime);
    if (calls.get(entry.callId) === entry) calls.delete(entry.callId);
  }

  function handleWindow(request: http.IncomingMessage, response: http.ServerResponse, callId: string, windowId: string) {
    if (stopping) { response.writeHead(503).end(); return; }
    if (options.enabled === false || !authorized(request.headers.authorization)) { response.writeHead(401).end(); return; }
    if (request.method === "DELETE") {
      const entry = calls.get(callId);
      // Closing an unknown or superseded window is a no-op: the API may retry, and only the
      // window the worker currently holds can produce a transcript.
      if (entry?.window?.id === windowId) { entry.window = undefined; release(entry); }
      response.writeHead(204).end();
      return;
    }
    const parsed = endpointingMs.safeParse(Number(new URL(request.url ?? "/", "http://media-worker.invalid").searchParams.get("endpointingMs")));
    if (!parsed.success) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: `endpointingMs must be an integer from ${LISTEN_ENDPOINTING.minMs} to ${LISTEN_ENDPOINTING.maxMs}.` }));
      return;
    }
    const entry = reserve(callId);
    if (!entry) { response.writeHead(409).end(); return; }
    const window: ListenWindowState = { id: windowId, endpointingMs: parsed.data };
    entry.window = window;
    // A node whose endpointing differs from the open connection needs a new one; Deepgram fixes
    // endpointing at connect. Flows that use one value across their listen nodes never reconnect.
    entry.audio?.retune(window);
    response.writeHead(204).end();
  }

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
    const [, callId] = match;
    const existing = calls.get(callId);
    // One audio stream per call, five calls at a time. A window opened before the gateway
    // connected already holds a reservation, so it does not need a second one.
    if ((existing && holdsCallSlot(existing)) || count(holdsCallSlot) >= MAX_CALLS) { rejectUpgrade(socket, "409 Conflict"); return; }
    const entry = reserve(callId);
    if (!entry) { rejectUpgrade(socket, "409 Conflict"); return; }
    const pending = new AbortController();
    const abandon = () => {
      if (entry.connecting !== dispose) return;
      entry.connecting = undefined;
      pending.abort();
      release(entry);
    };
    const dispose = () => { abandon(); socket.destroy(); };
    entry.connecting = dispose;
    const socketError = (error: Error) => { report(error, callId, entry.window?.id); dispose(); };
    socket.once("close", abandon);
    socket.once("end", dispose);
    socket.once("error", socketError);
    void api(`/api/media/calls/${callId}/window`, undefined, async (response) => {
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Call lookup failed with HTTP ${response.status}.`); }
      return callSchema.parse(await response.json());
    }, pending.signal).then((call) => {
      if (!ACTIVE_CALL_STATUSES.has(call.status as CallStatus)) throw new Error("Audio socket refers to a call that is no longer running.");
      if (call.status === "listening") {
        if (!call.listenWindowId) throw new Error("Listening call lookup omitted its listen window.");
        if (call.endpointingMs === undefined) throw new Error("Listen window lookup omitted the node's endpointing.");
        // A window pushed while this lookup was in flight is newer than the reply.
        entry.window ??= { id: call.listenWindowId, endpointingMs: call.endpointingMs };
      }
      if (socket.destroyed || stopping || entry.connecting !== dispose || calls.get(callId) !== entry) return;
      sockets.handleUpgrade(request, socket, head, (ws) => {
        socket.removeListener("close", abandon);
        socket.removeListener("end", dispose);
        socket.removeListener("error", socketError);
        entry.connecting = undefined;
        openAudio(ws, entry, call.endpointingMs);
      });
    }).catch((error: unknown) => {
      if (!pending.signal.aborted && !stopping) report(error, callId, entry.window?.id);
      abandon();
      if (!socket.destroyed) rejectUpgrade(socket, "409 Conflict");
    });
  });

  /**
   * Holds one call's audio and one provider connection for the life of the channel. Listen
   * windows open and close underneath it; audio keeps flowing through playback because gating
   * it on a window would deprive the speech model of the silence it uses for context.
   */
  function openAudio(socket: WebSocket, entry: CallEntry, warmupMs?: number) {
    const callId = entry.callId;
    const streamId = randomUUID();
    let stream: SpeechStream | undefined;
    let openedWith: number | undefined;
    let opening: AbortController | undefined;
    /** The provider attempt whose callbacks may still act; a replaced connection's cannot. */
    let owner: AbortController | undefined;
    let connectionDeadline: NodeJS.Timeout | undefined;
    let closed = false;
    const buffered: { pcm: Buffer; receivedAt: number }[] = [];
    let bufferedBytes = 0;
    let totalBytes = 0;
    let capture: CaptureStream | undefined;
    try { capture = options.capture?.open(callId, streamId, performance.now()); }
    catch (error) { report(error, callId); }

    const closeProvider = (provider: SpeechStream) => {
      try { provider.close(); } catch (error) { report(error, callId, entry.window?.id); }
    };
    const dropProvider = () => {
      clearTimeout(connectionDeadline); connectionDeadline = undefined;
      opening?.abort(); opening = undefined; owner = undefined;
      buffered.length = 0; bufferedBytes = 0;
      if (stream) { closeProvider(stream); stream = undefined; }
      openedWith = undefined;
    };
    const notifyApi = (windowId: string) => {
      if (stopping) return;
      void post(`/api/media/calls/${callId}/error`, { windowId, error: "Speech transcription unavailable." })
        .then((status) => { if ((status < 200 || status >= 300) && status !== 409) throw new Error(`Media failure notification returned HTTP ${status}.`); })
        .catch((failure: unknown) => { if (!stopping) report(failure, callId, windowId); });
    };
    /** A provider fault loses only the turn it lands in; between windows the next one reconnects. */
    const providerFailed = (error: unknown) => {
      if (closed) return;
      const window = entry.window;
      report(error, callId, window?.id);
      dropProvider();
      if (window) { entry.window = undefined; notifyApi(window.id); }
    };
    /** A malformed or overlong audio source ends the call's media, not just its turn. */
    const audioFailed = (error: unknown) => {
      if (closed) return;
      const window = entry.window;
      report(error, callId, window?.id);
      if (window) { entry.window = undefined; notifyApi(window.id); }
      closeAudio();
    };

    const deliver = (windowId: string, value: Utterance) => {
      const body = { transcript: value.transcript, windowId, utteranceId: randomUUID(), sttLatencyMs: value.latencyMs, finalizedBy: value.finalizedBy };
      entry.receipts += 1;
      // Neither the window closing nor the audio ending cancels this receipt: the API may move
      // on before its reply arrives, and a lost reply requires retrying the same receipt.
      void (async () => {
        for (let attempt = 0; attempt < 3 && !stopping; attempt++) {
          let failure: unknown;
          let retryable = true;
          try {
            const status = await post(`/api/calls/${callId}/transcript`, body);
            if ((status >= 200 && status < 300) || status === 409) return;
            // Only 5xx and transport faults are worth repeating; another 4xx would be rejected again.
            retryable = status >= 500;
            failure = new Error(retryable ? `Transcript delivery failed with HTTP ${status}.` : `Transcript rejected with HTTP ${status}.`);
          } catch (error) { failure = error; }
          if (!retryable || attempt === 2) throw failure;
          await abortable(new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1))), shutdown.signal);
        }
      })().catch((error: unknown) => {
        if (stopping) return;
        report(error, callId, windowId);
        notifyApi(windowId);
      }).finally(() => { entry.receipts -= 1; release(entry); });
    };

    const utterance = (value: Utterance) => {
      if (closed) return;
      const parsed = utteranceSchema.safeParse(value);
      if (!parsed.success) { providerFailed(new Error("Speech provider returned an invalid utterance.")); return; }
      const window = entry.window;
      capture?.utterance(parsed.data, performance.now(), window?.id);
      // Speech finalized outside a window answered the previous prompt or interrupted a clip.
      // The API's own status guard refuses anything that still slips through.
      if (!window) return;
      entry.window = undefined;
      deliver(window.id, parsed.data);
    };

    const write = (pcm: Buffer, receivedAt: number) => {
      try { stream!.write(pcm, receivedAt); } catch (error) { providerFailed(error); }
    };

    const openProvider = (listenMs: number) => {
      if (closed || openedWith === listenMs) return;
      dropProvider();
      openedWith = listenMs;
      const attempt = new AbortController();
      opening = attempt;
      owner = attempt;
      const listen: ListenSettings = { endpointingMs: listenMs };
      connectionDeadline = setTimeout(() => {
        if (opening === attempt) providerFailed(new Error("Speech stream connection timed out."));
      }, options.connectTimeoutMs ?? 3000);
      connectionDeadline.unref();
      const callbacks = {
        onUtterance: (value: Utterance) => { if (owner === attempt) utterance(value); },
        onError: (error: Error) => { if (owner === attempt) providerFailed(error); }
      };
      void Promise.resolve().then(() => options.stt.open(callbacks, attempt.signal, listen)).then((opened) => {
        if (closed || opening !== attempt) { closeProvider(opened); return; }
        clearTimeout(connectionDeadline); connectionDeadline = undefined;
        opening = undefined;
        stream = opened;
        for (const frame of buffered) { if (!stream) break; write(frame.pcm, frame.receivedAt); }
        buffered.length = 0; bufferedBytes = 0;
      }).catch((error: unknown) => { if (!closed && opening === attempt) providerFailed(error); });
    };

    function closeAudio() {
      if (closed) return;
      closed = true;
      dropProvider();
      capture?.close();
      if (entry.audio === session) entry.audio = undefined;
      // Without audio there is no listening, whatever the API last pushed.
      entry.window = undefined;
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.close(1000);
        const deadline = setTimeout(() => socket.terminate(), 1000); deadline.unref();
        socket.once("close", () => clearTimeout(deadline));
      }
      release(entry);
    }

    const session: AudioSession = { retune: (window) => openProvider(window.endpointingMs), fail: audioFailed, close: closeAudio };
    entry.audio = session;

    // A transport fault is the same class of failure as malformed audio: the call loses its media.
    socket.on("error", (error) => audioFailed(error));
    socket.on("close", () => closeAudio());
    socket.on("message", (data, binary) => {
      if (closed || !binary) return; // mod_audio_stream may send metadata before PCM.
      const pcm = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (pcm.length === 0) return;
      if (pcm.length % 2) { audioFailed(new Error("PCM frame must contain complete 16-bit samples.")); return; }
      totalBytes += pcm.length;
      if (totalBytes > maxCallBytes) { audioFailed(new Error("Call audio exceeded the maximum call duration.")); return; }
      const receivedAt = performance.now();
      // Tee at arrival so the capture matches the provider input even for frames buffered while it opens.
      capture?.frame(pcm, receivedAt);
      if (stream) { write(pcm, receivedAt); return; }
      // Without a provider there is nothing to listen for on this call, so the audio is dropped.
      if (!opening) return;
      bufferedBytes += pcm.length;
      if (bufferedBytes > 32_000) { providerFailed(new Error("STT connection exceeded the two-second audio buffer.")); return; }
      buffered.push({ pcm, receivedAt });
    });

    // Opening during playback is the point of one stream per call: the first reply costs no handshake.
    const initial = entry.window?.endpointingMs ?? warmupMs;
    if (initial !== undefined) openProvider(initial);
  }

  return {
    server,
    async close() {
      stopping = true;
      shutdown.abort();
      for (const entry of [...calls.values()]) {
        entry.connecting?.();
        entry.window = undefined;
        entry.audio?.close();
        clearTimeout(entry.lifetime);
        calls.delete(entry.callId);
      }
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
