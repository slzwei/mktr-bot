import WebSocket from "ws";
import { z } from "zod";
import type { UtteranceEnding } from "../src/lib/domain.js";
import { deepgramListenUrl } from "./deepgram.js";
import type { ListenSettings, SpeechCallbacks, SpeechStream, SpeechToText } from "./speech-to-text.js";

/**
 * Flux reports a turn rather than a transcript. `StartOfTurn` marks the caller beginning to speak,
 * `Update` revises the text as it arrives, and `EndOfTurn` says the model believes the caller has
 * finished, carrying the confidence that produced that decision and what triggered it.
 */
const wordSchema = z.object({
  word: z.string().max(200),
  confidence: z.number().finite().optional(),
  start: z.number().finite().nonnegative().optional(),
  end: z.number().finite().nonnegative().optional()
});
const messageSchema = z.object({
  type: z.string(),
  event: z.string().optional(),
  turn_index: z.number().int().nonnegative().optional(),
  transcript: z.string().max(4000).optional(),
  words: z.array(wordSchema).max(2000).optional(),
  end_of_turn_confidence: z.number().finite().optional(),
  trigger: z.string().max(40).optional(),
  audio_window_end: z.number().finite().nonnegative().optional()
});

export type DeepgramFluxOptions = {
  apiKey: string;
  /** Full v2 listen URL; production derives it from MKTR_DEEPGRAM_BASE_URL. */
  endpoint?: string;
  /** Three hyphen-separated parts, which carry the language: the v2 endpoint takes no `language`. */
  model?: string;
  /** Confidence at which the model calls the turn finished. Higher waits longer and interrupts less. */
  eotThreshold?: number;
  /** Hard stop on a turn whose confidence never reaches the threshold. */
  eotTimeoutMs?: number;
  connectTimeoutMs?: number;
  now?: () => number;
};

/** 0.7 matches the threshold Deepgram appears to apply by default; both live probes ended turns just above it. */
export const fluxDefaults = { model: "flux-general-en", eotThreshold: 0.7, eotTimeoutMs: 5000, path: "/v2/listen" } as const;

/**
 * Deepgram Flux. Unlike the `/v1/listen` models it decides a reply is complete from the conversation
 * rather than from a silence timer, so a listen node's `endpointingMs` has no counterpart here and is
 * deliberately ignored: the equivalent dial is `eotThreshold`, set per worker. The API's own
 * no-speech timeout still bounds a caller who never answers.
 */
export class DeepgramFluxSpeechToText implements SpeechToText {
  readonly provider = "deepgram";
  constructor(private readonly options: DeepgramFluxOptions) {}

  async open(callbacks: SpeechCallbacks, signal?: AbortSignal, _listen?: ListenSettings): Promise<SpeechStream> {
    if (!this.options.apiKey) throw new Error("DEEPGRAM_API_KEY is required for streaming transcription.");
    const model = this.options.model ?? fluxDefaults.model;
    const eotThreshold = this.options.eotThreshold ?? fluxDefaults.eotThreshold;
    const eotTimeoutMs = this.options.eotTimeoutMs ?? fluxDefaults.eotTimeoutMs;
    if (!/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/i.test(model)) throw new Error("Deepgram Flux models have three hyphen-separated parts, such as flux-general-en.");
    if (!Number.isFinite(eotThreshold) || eotThreshold <= 0 || eotThreshold >= 1) throw new Error("Deepgram Flux end-of-turn confidence must be between 0 and 1.");
    if (!Number.isSafeInteger(eotTimeoutMs) || eotTimeoutMs < 1000 || eotTimeoutMs > 60_000) throw new Error("Deepgram Flux end-of-turn timeout must be an integer from 1000 to 60000 milliseconds.");
    signal?.throwIfAborted();
    const endpoint = new URL(this.options.endpoint ?? deepgramListenUrl(undefined, fluxDefaults.path));
    endpoint.search = new URLSearchParams({
      model, encoding: "linear16", sample_rate: "8000",
      eot_threshold: String(eotThreshold), eot_timeout_ms: String(eotTimeoutMs)
    }).toString();
    const socket = new WebSocket(endpoint, { headers: { Authorization: `Token ${this.options.apiKey}` }, handshakeTimeout: this.options.connectTimeoutMs ?? 3000, maxPayload: 1024 * 1024, perMessageDeflate: false });
    const now = this.options.now ?? (() => performance.now());
    let closed = false;
    let opened = false;
    let speaking = false;
    let audioOriginAt: number | undefined;
    let audioSeconds = 0;
    let rejectOpening: (error: Error) => void = () => undefined;
    const cleanup = () => signal?.removeEventListener("abort", cancel);
    const fail = (error: Error) => {
      if (closed) return;
      closed = true;
      cleanup();
      socket.terminate();
      if (opened) callbacks.onError(error);
      else rejectOpening(error);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      cleanup();
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000);
        const deadline = setTimeout(() => socket.terminate(), 1000); deadline.unref();
        socket.once("close", () => clearTimeout(deadline));
      } else socket.terminate();
    };
    const cancel = () => {
      if (!opened) fail(new Error("Deepgram Flux streaming connection was cancelled."));
      else close();
    };

    socket.on("message", (data) => {
      if (closed) return;
      try {
        const message = messageSchema.parse(JSON.parse(data.toString()));
        if (message.type === "Error") { fail(new Error("Deepgram Flux reported a transcription error.")); return; }
        if (message.type !== "TurnInfo") return; // Connected and any later informational frames.
        const transcript = message.transcript?.trim() ?? "";
        if (message.event === "StartOfTurn" || (transcript && !speaking)) {
          if (!speaking) { speaking = true; callbacks.onSpeechStarted?.(); }
        }
        if (message.event !== "EndOfTurn") return;
        speaking = false;
        // A turn can end with nothing usable in it; there is no reply to route.
        if (!transcript) return;
        if (transcript.length > 2000) { fail(new Error("Deepgram Flux turn exceeded the transcript limit.")); return; }
        let lastWordEnd: number | undefined;
        for (const word of message.words ?? []) if (word.end !== undefined) lastWordEnd = Math.max(lastWordEnd ?? 0, word.end);
        lastWordEnd ??= message.audio_window_end;
        // Word times run along the submitted audio timeline, which spans the whole call, so the
        // anchor is the first PCM arrival exactly as on v1. Unknown timing produces no sample.
        const estimated = audioOriginAt !== undefined && lastWordEnd !== undefined && lastWordEnd <= audioSeconds + 0.1
          ? now() - (audioOriginAt + lastWordEnd * 1000) : undefined;
        const latencyMs = estimated !== undefined && estimated >= 0 && estimated <= 60_000 ? Math.round(estimated) : undefined;
        const finalizedBy: UtteranceEnding = message.trigger === "timeout" ? "timeout" : "turn";
        callbacks.onUtterance({ transcript, finalizedBy, ...(latencyMs !== undefined ? { latencyMs } : {}) });
      } catch (error) {
        fail(new Error("Invalid Deepgram Flux streaming response.", { cause: error }));
      }
    });
    socket.on("error", (error) => fail(new Error(opened ? "Deepgram Flux WebSocket failed." : "Could not connect to Deepgram Flux streaming transcription.", { cause: error })));
    socket.on("close", () => fail(new Error(opened ? "Deepgram Flux closed before the call ended." : "Deepgram Flux closed before its WebSocket opened.")));
    socket.on("unexpected-response", (_request, response) => {
      response.destroy();
      fail(new Error(`Deepgram Flux rejected its WebSocket upgrade with HTTP ${response.statusCode ?? "unknown"}.`));
    });

    await new Promise<void>((resolve, reject) => {
      rejectOpening = reject;
      socket.once("open", () => { opened = true; resolve(); });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    if (closed) throw new Error("Deepgram Flux streaming connection ended while opening.");
    // No keepalive: the call streams continuously from answer to hangup, silence included.
    return {
      write(pcm, receivedAt = now()) {
        if (closed || socket.readyState !== WebSocket.OPEN) throw new Error("Deepgram Flux speech stream is closed.");
        if (pcm.length === 0) return;
        if (pcm.length % 2) throw new Error("Deepgram Flux requires complete linear16 samples.");
        if (socket.bufferedAmount + pcm.length > 256_000) { fail(new Error("Deepgram Flux audio backpressure exceeded the bounded buffer.")); return; }
        audioOriginAt ??= receivedAt - pcm.length / 16;
        audioSeconds += pcm.length / 16_000;
        try { socket.send(pcm, { binary: true }, (error) => { if (error) fail(new Error("Deepgram Flux audio write failed.", { cause: error })); }); }
        catch (error) { fail(new Error("Deepgram Flux audio write failed.", { cause: error })); }
      },
      close
    };
  }
}
