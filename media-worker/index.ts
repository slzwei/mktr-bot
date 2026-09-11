import path from "node:path";
import pino from "pino";
import { DeepgramSpeechToText, deepgramListenUrl } from "./deepgram.js";
import { createPcmCapture } from "./pcm-capture.js";
import { createMediaWorker } from "./worker.js";

const logger = pino({ redact: ["token", "apiKey", "authorization"] });
const enabled = process.env.MKTR_TELEPHONY_MODE === "freeswitch";
const provider = process.env.MKTR_STT_PROVIDER || "deepgram";
if (provider !== "deepgram") throw new Error("MKTR_STT_PROVIDER must name an implemented provider: deepgram.");
const token = process.env.MKTR_MEDIA_GATEWAY_TOKEN ?? "";
if (enabled && (token.length < 16 || !process.env.DEEPGRAM_API_KEY)) throw new Error("The media worker requires a bearer token and DEEPGRAM_API_KEY when enabled.");
// Region selection: Deepgram's Sydney origin unless the env names another; an invalid value fails startup in every mode.
const deepgramEndpoint = deepgramListenUrl(process.env.MKTR_DEEPGRAM_BASE_URL || undefined);
// The worker's audio lifetime matches the API's own answered-call limit.
const maxCallSeconds = Number(process.env.MKTR_MAX_CALL_SECONDS || 180);
if (!Number.isSafeInteger(maxCallSeconds) || maxCallSeconds < 1 || maxCallSeconds > 1800) throw new Error("MKTR_MAX_CALL_SECONDS must be an integer from 1 to 1800.");
// Opt-in replay corpus: raw callee PCM per call plus arrival timing, for scripts/replay-stt.ts.
const captureDirectory = process.env.MKTR_PCM_CAPTURE_ENABLED === "true"
  ? process.env.MKTR_PCM_CAPTURE_DIR || path.join(process.cwd(), "storage", "pcm-capture") : undefined;
const worker = createMediaWorker({
  enabled, token, apiUrl: process.env.MKTR_API_INTERNAL_URL || "http://api:8787", maxCallMs: maxCallSeconds * 1000,
  stt: new DeepgramSpeechToText({ apiKey: process.env.DEEPGRAM_API_KEY ?? "", language: process.env.MKTR_STT_LANGUAGE || "en-SG", endpoint: deepgramEndpoint }),
  capture: captureDirectory === undefined ? undefined : createPcmCapture({ directory: captureDirectory, onError(error, context) { logger.error({ err: error, ...context }, "PCM capture failure"); } }),
  onError(error, context) { logger.error({ err: error, ...context }, "Media worker failure"); }
});
const port = Number(process.env.MKTR_MEDIA_WORKER_PORT || 8090);
worker.server.listen(port, "0.0.0.0", () => logger.info({ port, enabled, provider, deepgramEndpoint, maxCallSeconds, pcmCapture: captureDirectory ?? false }, "Media worker ready"));
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void worker.close().catch((error) => { logger.error({ err: error }, "Media worker shutdown failed"); process.exitCode = 1; });
});
