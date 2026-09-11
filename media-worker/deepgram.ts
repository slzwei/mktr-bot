import WebSocket from "ws";
import { z } from "zod";
import type { SpeechCallbacks, SpeechStream, SpeechToText } from "./speech-to-text.js";

const resultSchema = z.object({
  type: z.string(), is_final: z.boolean().optional(), speech_final: z.boolean().optional(),
  start: z.number().optional(), duration: z.number().optional(),
  channel: z.object({ alternatives: z.array(z.object({ transcript: z.string() })) }).optional()
});

export class DeepgramSpeechToText implements SpeechToText {
  readonly provider = "deepgram";
  constructor(private readonly options: { apiKey: string; language?: string; endpoint?: string; connectTimeoutMs?: number }) {}

  async open(callbacks: SpeechCallbacks): Promise<SpeechStream> {
    if (!this.options.apiKey) throw new Error("DEEPGRAM_API_KEY is required for streaming transcription.");
    const endpoint = new URL(this.options.endpoint ?? "wss://api.deepgram.com/v1/listen");
    // Deepgram does not list en-SG as a supported wire code; en is its English model.
    const locale = this.options.language ?? "en-SG";
    endpoint.search = new URLSearchParams({ model: "nova-3", language: locale === "en-SG" ? "en" : locale,
      encoding: "linear16", sample_rate: "8000", channels: "1", interim_results: "true", endpointing: "750", utterance_end_ms: "1000", smart_format: "true" }).toString();
    const socket = new WebSocket(endpoint, { headers: { Authorization: `Token ${this.options.apiKey}` }, handshakeTimeout: this.options.connectTimeoutMs ?? 3000, maxPayload: 1024 * 1024 });
    let closed = false;
    let opened = false;
    let pieces: string[] = [];
    const seen = new Set<string>();
    let lastAudioAt = performance.now();
    let heartbeat: NodeJS.Timeout | undefined;
    const finishUtterance = () => {
      const transcript = pieces.join(" ").trim();
      pieces = [];
      if (transcript) callbacks.onUtterance({ transcript, latencyMs: Math.max(0, Math.round(performance.now() - lastAudioAt)) });
    };
    const fail = (error: Error) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      socket.terminate();
      callbacks.onError(error);
    };
    socket.on("message", (data) => {
      if (closed) return;
      try {
        const result = resultSchema.parse(JSON.parse(data.toString()));
        if (result.type === "Results") {
          const transcript = result.channel?.alternatives[0]?.transcript.trim() ?? "";
          const key = `${result.start}:${result.duration}:${transcript}`;
          if (result.is_final && transcript && !seen.has(key)) {
            seen.add(key);
            pieces.push(transcript);
          }
          if (result.speech_final) finishUtterance();
        } else if (result.type === "UtteranceEnd") finishUtterance();
        else if (result.type === "Error") fail(new Error("Deepgram reported a transcription error."));
      } catch (error) {
        fail(new Error("Invalid Deepgram streaming response.", { cause: error }));
      }
    });
    socket.on("error", (error) => { if (opened) fail(new Error("Deepgram WebSocket failed.", { cause: error })); });
    socket.on("close", () => { if (opened && !closed) fail(new Error("Deepgram closed before the listen window ended.")); });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => { opened = true; resolve(); });
      socket.once("error", () => reject(new Error("Could not connect to Deepgram streaming transcription.")));
    });
    heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "KeepAlive" }));
    }, 3000);
    heartbeat.unref();
    return {
      write(pcm) {
        if (closed || socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 256_000) { fail(new Error("Deepgram audio backpressure exceeded the bounded buffer.")); return; }
        lastAudioAt = performance.now();
        socket.send(pcm, { binary: true });
      },
      close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "CloseStream" }));
          socket.close(1000);
          const deadline = setTimeout(() => socket.terminate(), 1000); deadline.unref();
          socket.once("close", () => clearTimeout(deadline));
        } else socket.terminate();
      }
    };
  }
}
