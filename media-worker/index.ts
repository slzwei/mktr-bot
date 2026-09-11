import pino from "pino";
import { DeepgramSpeechToText } from "./deepgram.js";
import { createMediaWorker } from "./worker.js";

const logger = pino({ redact: ["token", "apiKey", "authorization"] });
const enabled = process.env.MKTR_TELEPHONY_MODE === "freeswitch";
const provider = process.env.MKTR_STT_PROVIDER || "deepgram";
if (provider !== "deepgram") throw new Error("MKTR_STT_PROVIDER must name an implemented provider: deepgram.");
const token = process.env.MKTR_MEDIA_GATEWAY_TOKEN ?? "";
if (enabled && (token.length < 16 || !process.env.DEEPGRAM_API_KEY)) throw new Error("The media worker requires a bearer token and DEEPGRAM_API_KEY when enabled.");
const worker = createMediaWorker({
  enabled, token, apiUrl: process.env.MKTR_API_INTERNAL_URL || "http://api:8787",
  stt: new DeepgramSpeechToText({ apiKey: process.env.DEEPGRAM_API_KEY ?? "", language: process.env.MKTR_STT_LANGUAGE || "en-SG" }),
  onError(error, context) { logger.error({ err: error, ...context }, "Media worker failure"); }
});
const port = Number(process.env.MKTR_MEDIA_WORKER_PORT || 8090);
worker.server.listen(port, "0.0.0.0", () => logger.info({ port, enabled, provider }, "Media worker ready"));
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void worker.close().catch((error) => { logger.error({ err: error }, "Media worker shutdown failed"); process.exitCode = 1; });
});
