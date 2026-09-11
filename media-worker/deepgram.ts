import WebSocket from "ws";
import { z } from "zod";
import type { SpeechCallbacks, SpeechStream, SpeechToText } from "./speech-to-text.js";

const alternativesSchema = z.object({ alternatives: z.array(z.object({
  transcript: z.string().max(2000), words: z.array(z.object({ end: z.number().finite().nonnegative() })).max(2000).optional()
})).max(5) });

// Deepgram's live API uses one field name for two shapes: Results carries `channel`
// as an object of alternatives, while UtteranceEnd and SpeechStarted carry it as a
// channel index array such as [0, 1]. Both must parse or a real call fails at the
// first end-of-utterance marker.
const resultSchema = z.object({
  type: z.string(), is_final: z.boolean().optional(), speech_final: z.boolean().optional(),
  start: z.number().finite().nonnegative().optional(), duration: z.number().finite().nonnegative().optional(),
  last_word_end: z.number().finite().optional(),
  channel: z.union([alternativesSchema, z.array(z.number().int().nonnegative()).max(8)]).optional()
});

export class DeepgramSpeechToText implements SpeechToText {
  readonly provider = "deepgram";
  constructor(private readonly options: { apiKey: string; language?: string; endpoint?: string; connectTimeoutMs?: number; now?: () => number }) {}

  async open(callbacks: SpeechCallbacks, signal?: AbortSignal): Promise<SpeechStream> {
    if (!this.options.apiKey) throw new Error("DEEPGRAM_API_KEY is required for streaming transcription.");
    signal?.throwIfAborted();
    const endpoint = new URL(this.options.endpoint ?? "wss://api.deepgram.com/v1/listen");
    // Deepgram does not list en-SG as a supported wire code; en is its English model.
    const locale = this.options.language ?? "en-SG";
    endpoint.search = new URLSearchParams({ model: "nova-3", language: locale === "en-SG" ? "en" : locale,
      encoding: "linear16", sample_rate: "8000", channels: "1", interim_results: "true", endpointing: "750", utterance_end_ms: "1000", smart_format: "true" }).toString();
    const socket = new WebSocket(endpoint, { headers: { Authorization: `Token ${this.options.apiKey}` }, handshakeTimeout: this.options.connectTimeoutMs ?? 3000, maxPayload: 1024 * 1024, perMessageDeflate: false });
    const now = this.options.now ?? (() => performance.now());
    let closed = false;
    let opened = false;
    let completed = false;
    let pieces: string[] = [];
    const seen = new Set<string>();
    let audioOriginAt: number | undefined;
    let audioSeconds = 0;
    let lastWordEnd: number | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let rejectOpening: (error: Error) => void = () => undefined;
    const cleanup = () => { clearInterval(heartbeat); signal?.removeEventListener("abort", cancel); };
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
        socket.send(JSON.stringify({ type: "CloseStream" }));
        socket.close(1000);
        const deadline = setTimeout(() => socket.terminate(), 1000); deadline.unref();
        socket.once("close", () => clearTimeout(deadline));
      } else socket.terminate();
    };
    const cancel = () => {
      if (!opened) fail(new Error("Deepgram streaming connection was cancelled."));
      else close();
    };
    const finishUtterance = () => {
      const transcript = pieces.join(" ").trim();
      if (!transcript || completed) return;
      completed = true;
      pieces = [];
      // Word times refer to the submitted audio timeline. Anchor that timeline
      // to the original first PCM arrival, including time buffered during open.
      // Omit unknown/inconsistent timing rather than report a misleading zero.
      const estimated = audioOriginAt !== undefined && lastWordEnd !== undefined && lastWordEnd <= audioSeconds + 0.1
        ? now() - (audioOriginAt + lastWordEnd * 1000) : undefined;
      const latencyMs = estimated !== undefined && estimated >= 0 && estimated <= 60_000 ? Math.round(estimated) : undefined;
      callbacks.onUtterance({ transcript, ...(latencyMs !== undefined ? { latencyMs } : {}) });
    };
    socket.on("message", (data) => {
      if (closed || completed) return;
      try {
        const result = resultSchema.parse(JSON.parse(data.toString()));
        if (result.type === "Results") {
          const alternative = Array.isArray(result.channel) ? undefined : result.channel?.alternatives[0];
          const transcript = alternative?.transcript.trim();
          const key = `${result.start}:${result.duration}:${transcript}`;
          if (result.is_final && transcript && !seen.has(key)) {
            seen.add(key);
            pieces.push(transcript);
            if (pieces.join(" ").length > 2000) { fail(new Error("Deepgram utterance exceeded the transcript limit.")); return; }
            for (const word of alternative?.words ?? []) lastWordEnd = Math.max(lastWordEnd ?? 0, word.end);
          }
          if (result.speech_final) finishUtterance();
        } else if (result.type === "UtteranceEnd") {
          if (result.last_word_end !== undefined && result.last_word_end >= 0) lastWordEnd = Math.max(lastWordEnd ?? 0, result.last_word_end);
          finishUtterance();
        } else if (result.type === "Error") fail(new Error("Deepgram reported a transcription error."));
      } catch (error) {
        fail(new Error("Invalid Deepgram streaming response.", { cause: error }));
      }
    });
    socket.on("error", (error) => fail(new Error(opened ? "Deepgram WebSocket failed." : "Could not connect to Deepgram streaming transcription.", { cause: error })));
    socket.on("close", () => fail(new Error(opened ? "Deepgram closed before the listen window ended." : "Deepgram closed before its WebSocket opened.")));
    socket.on("unexpected-response", (_request, response) => {
      response.destroy();
      fail(new Error(`Deepgram rejected its WebSocket upgrade with HTTP ${response.statusCode ?? "unknown"}.`));
    });
    await new Promise<void>((resolve, reject) => {
      rejectOpening = reject;
      socket.once("open", () => { opened = true; resolve(); });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    if (closed) throw new Error("Deepgram streaming connection ended while opening.");
    heartbeat = setInterval(() => {
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      try { socket.send(JSON.stringify({ type: "KeepAlive" }), (error) => { if (error) fail(new Error("Deepgram keepalive failed.", { cause: error })); }); }
      catch (error) { fail(new Error("Deepgram keepalive failed.", { cause: error })); }
    }, 3000);
    heartbeat.unref();
    return {
      write(pcm, receivedAt = now()) {
        if (closed || socket.readyState !== WebSocket.OPEN) throw new Error("Deepgram speech stream is closed.");
        if (pcm.length === 0) return;
        if (pcm.length % 2) throw new Error("Deepgram requires complete linear16 samples.");
        if (socket.bufferedAmount + pcm.length > 256_000) { fail(new Error("Deepgram audio backpressure exceeded the bounded buffer.")); return; }
        audioOriginAt ??= receivedAt - pcm.length / 16;
        audioSeconds += pcm.length / 16_000;
        try { socket.send(pcm, { binary: true }, (error) => { if (error) fail(new Error("Deepgram audio write failed.", { cause: error })); }); }
        catch (error) { fail(new Error("Deepgram audio write failed.", { cause: error })); }
      },
      close
    };
  }
}
