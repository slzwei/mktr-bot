import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DeepgramSpeechToText, deepgramDefaults, deepgramListenUrl } from "../media-worker/deepgram.js";
import { detectSpeech, readCapture, replayCapture, type Capture, type ReplayResult } from "../media-worker/replay.js";
import type { SpeechToText } from "../media-worker/speech-to-text.js";

const usage = `Replay a media-worker PCM capture into a speech engine and time end of speech to usable transcript.

Usage: npx tsx scripts/replay-stt.ts <capture.pcm | capture.json | audio.wav> [options]

  --engine <name>            Speech engine: deepgram (default)
  --connect <mode>           concurrent: open the engine while audio streams, as the worker does (default)
                             first: open the engine before streaming, isolating engine latency
  --speech-end-ms <n>        Override the energy-based end of speech (milliseconds into the audio)
  --pad-silence-ms <n>       Real-time silence appended after the capture until the engine finalizes (default 10000; 0 disables)
  --runs <n>                 Repeat the replay and summarise (default 1)
  --json                     Print machine-readable JSON instead of text

Deepgram options (defaults are the production values):
  --model <name>             ${deepgramDefaults.model}
  --endpointing-ms <n>       ${deepgramDefaults.endpointingMs}
  --utterance-end-ms <n>     ${deepgramDefaults.utteranceEndMs}
  --language <code>          en-SG
  --endpoint <wss url>       Full listen URL for loopback fakes; otherwise MKTR_DEEPGRAM_BASE_URL or ${deepgramDefaults.baseUrl}

Environment: DEEPGRAM_API_KEY for the deepgram engine; MKTR_DEEPGRAM_BASE_URL selects its region as in production.
Captures come from a worker started with MKTR_PCM_CAPTURE_ENABLED=true.
`;

type Values = Record<string, string | boolean | undefined>;

const integer = (values: Values, name: string, fallback: number, min = 0): number => {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`--${name} must be an integer of at least ${min}.`);
  return value;
};

const engines: Record<string, (values: Values) => { engine: SpeechToText; description: string }> = {
  deepgram(values) {
    const apiKey = process.env.DEEPGRAM_API_KEY ?? "";
    if (!apiKey) throw new Error("DEEPGRAM_API_KEY is required for the deepgram engine.");
    const model = typeof values.model === "string" ? values.model : deepgramDefaults.model;
    const endpointingMs = integer(values, "endpointing-ms", deepgramDefaults.endpointingMs);
    const utteranceEndMs = integer(values, "utterance-end-ms", deepgramDefaults.utteranceEndMs);
    const language = typeof values.language === "string" ? values.language : "en-SG";
    const endpoint = typeof values.endpoint === "string" ? values.endpoint : deepgramListenUrl(process.env.MKTR_DEEPGRAM_BASE_URL || undefined);
    return {
      engine: new DeepgramSpeechToText({ apiKey, language, model, endpointingMs, utteranceEndMs, endpoint }),
      description: `deepgram ${model} language=${language} endpointing=${endpointingMs}ms utterance_end=${utteranceEndMs}ms endpoint=${new URL(endpoint).host}`
    };
  }
};

function describeCapture(capture: Capture): string {
  const seconds = (capture.frames.at(-1)?.t ?? 0) / 1000;
  const live = capture.sidecar?.utterance;
  return `${capture.source}: ${seconds.toFixed(2)} s of audio, ${capture.frames.length} frames, ${capture.pacing} pacing`
    + (live ? `; live transcript "${live.transcript}"${live.latencyMs !== undefined ? ` (worker estimate ${live.latencyMs} ms)` : ""}` : "");
}

function describeRun(result: ReplayResult, index: number, runs: number): string {
  const label = runs > 1 ? `run ${index + 1}/${runs}: ` : "";
  if (result.error) return `${label}error after ${result.audioMs + result.paddedSilenceMs} ms: ${result.error}`;
  const estimate = result.providerLatencyMs !== undefined ? ` (engine estimate ${result.providerLatencyMs} ms)` : "";
  const open = result.openMs !== undefined ? `open ${result.openMs} ms, ${result.framesBufferedBeforeOpen} frames buffered before open; ` : "";
  const padded = result.paddedSilenceMs ? `; needed ${result.paddedSilenceMs} ms of appended silence` : "";
  const timing = result.speechEndToTranscriptMs === undefined ? "transcript arrived before the end of speech was streamed" : `speech end -> transcript ${result.speechEndToTranscriptMs} ms${estimate}`;
  return `${label}${open}transcript "${result.transcript}"; ${timing}${padded}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    engine: { type: "string", default: "deepgram" }, connect: { type: "string", default: "concurrent" },
    "speech-end-ms": { type: "string" }, "pad-silence-ms": { type: "string" }, runs: { type: "string" }, json: { type: "boolean", default: false },
    model: { type: "string" }, "endpointing-ms": { type: "string" }, "utterance-end-ms": { type: "string" }, language: { type: "string" }, endpoint: { type: "string" },
    help: { type: "boolean", default: false }
  } });
  if (values.help || positionals.length !== 1) { process.stdout.write(usage); return values.help ? 0 : 2; }
  if (values.connect !== "concurrent" && values.connect !== "first") throw new Error("--connect must be concurrent or first.");
  const build = engines[values.engine ?? ""];
  if (!build) throw new Error(`Unknown engine ${values.engine}; available: ${Object.keys(engines).join(", ")}.`);
  const capture = await readCapture(positionals[0]);
  const bounds = detectSpeech(capture.pcm);
  const speechEndMs = values["speech-end-ms"] !== undefined ? integer(values, "speech-end-ms", 0) : bounds?.endMs;
  if (speechEndMs === undefined) throw new Error("No speech detected; pass --speech-end-ms.");
  const runs = integer(values, "runs", 1, 1);
  const padSilenceMs = integer(values, "pad-silence-ms", 10_000);
  const { engine, description } = build(values);
  const results: ReplayResult[] = [];
  if (!values.json) {
    process.stdout.write(`${describeCapture(capture)}\n`);
    process.stdout.write(bounds ? `speech ${bounds.startMs}-${bounds.endMs} ms by energy (threshold ${bounds.thresholdDb.toFixed(1)} dBFS, noise floor ${bounds.noiseFloorDb.toFixed(1)} dBFS, peak ${bounds.peakDb.toFixed(1)} dBFS)` : "speech bounds not detected by energy");
    process.stdout.write(values["speech-end-ms"] !== undefined ? `; using --speech-end-ms ${speechEndMs}\n` : "\n");
    process.stdout.write(`engine ${description}; connect=${values.connect}\n`);
  }
  for (let index = 0; index < runs; index++) {
    const result = await replayCapture(capture, engine, { connect: values.connect, speechEndMs, padSilenceMs });
    results.push(result);
    if (!values.json) process.stdout.write(`${describeRun(result, index, runs)}\n`);
  }
  const measured = results.flatMap((result) => result.speechEndToTranscriptMs !== undefined && !result.error ? [result.speechEndToTranscriptMs] : []);
  const summary = measured.length ? { runs, measured: measured.length, medianMs: median(measured), minMs: Math.min(...measured), maxMs: Math.max(...measured) } : { runs, measured: 0 };
  if (values.json) {
    process.stdout.write(JSON.stringify({ capture: { source: capture.source, pacing: capture.pacing, frames: capture.frames.length, audioMs: capture.frames.at(-1)?.t ?? 0, liveUtterance: capture.sidecar?.utterance }, speech: bounds, speechEndMs, engine: description, connect: values.connect, results, summary }, null, 2) + "\n");
  } else if (runs > 1) {
    process.stdout.write(measured.length ? `summary over ${measured.length}/${runs} runs: median ${summary.medianMs} ms, min ${summary.minMs} ms, max ${summary.maxMs} ms\n` : "summary: no successful runs\n");
  }
  return results.every((result) => !result.error) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
