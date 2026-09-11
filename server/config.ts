import path from "node:path";
import type { ClassifierMode, TelephonyMode } from "../src/lib/domain.js";
import { assertGatewayStartupConfiguration } from "./gateway-security.js";
import { outcomeWebhookConfig } from "./outcome-delivery.js";
import { dncConfig } from "./dnc.js";

const int = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Configuration requires an integer from ${min} to ${max}.`);
  return number;
}

export function classifierTimeoutFromEnvironment(environment: Record<string, string | undefined>): number {
  const value = environment.MKTR_CLASSIFIER_TIMEOUT_MS;
  if (!value) return 1500;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 30_000) throw new Error("MKTR_CLASSIFIER_TIMEOUT_MS must be an integer between 1 and 30000.");
  return Number(value);
}

export const config = {
  port: int(process.env.PORT, 8787),
  webOrigin: process.env.MKTR_WEB_ORIGIN || "http://localhost:5173",
  trustProxy: (process.env.MKTR_TRUST_PROXY || "loopback").split(",").map((value) => value.trim()),
  telephonyMode: (process.env.MKTR_TELEPHONY_MODE === "freeswitch"
    ? "freeswitch"
    : "simulated") as TelephonyMode,
  maxConcurrentCalls: boundedInteger(process.env.MKTR_MAX_CONCURRENT_CALLS, 5, 1, 5),
  originateTimeoutSeconds: boundedInteger(process.env.MKTR_ORIGINATE_TIMEOUT_SECONDS, 30, 1, 120),
  maxCallSeconds: boundedInteger(process.env.MKTR_MAX_CALL_SECONDS, 180, 1, 1800),
  outcomeWebhook: outcomeWebhookConfig(process.env),
  dnc: dncConfig(process.env),
  clipStorageDir: process.env.MKTR_CLIP_STORAGE_DIR || path.join(process.cwd(), "storage", "clips"),
  recording: {
    enabled: process.env.MKTR_RECORDING_ENABLED === "true",
    directory: process.env.MKTR_RECORDING_STORAGE_DIR || path.join(process.cwd(), "storage", "recordings"),
    retentionDays: boundedInteger(process.env.MKTR_RECORDING_RETENTION_DAYS, 30, 1, 365)
  },
  classifier: {
    mode: process.env.MKTR_CLASSIFIER_MODE === "openai"
      ? "openai"
      : "rules" as ClassifierMode,
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    openaiModel: process.env.MKTR_OPENAI_CLASSIFIER_MODEL || "gpt-4o-mini",
    timeoutMs: classifierTimeoutFromEnvironment(process.env)
  },
  mediaGateway: {
    workerUrl: process.env.MKTR_MEDIA_WORKER_URL || "ws://media-worker:8090",
    webhookToken: process.env.MKTR_MEDIA_GATEWAY_TOKEN ?? ""
  },
  singtel: {
    host: process.env.MKTR_SINGTEL_SIP_HOST || "sipsg01.b3networks.com",
    ip: process.env.MKTR_SINGTEL_SIP_IP || "52.77.0.62",
    pcmaPort: int(process.env.MKTR_SINGTEL_PCMA_PORT, 5061),
    opusPort: int(process.env.MKTR_SINGTEL_OPUS_PORT, 5081),
    username: process.env.MKTR_SINGTEL_SIP_USERNAME || "sip69992409",
    password: process.env.MKTR_SINGTEL_SIP_PASSWORD ?? "",
    mediaIpRange: "54.251.255.196-54.251.255.211",
    mediaPortRange: "10000-30000",
    caCertificatePath: process.env.MKTR_SINGTEL_CA_CERT_PATH ?? ""
  },
  freeswitch: {
    host: process.env.MKTR_FREESWITCH_ESL_HOST || "127.0.0.1",
    port: int(process.env.MKTR_FREESWITCH_ESL_PORT, 8021),
    password: process.env.MKTR_FREESWITCH_ESL_PASSWORD ?? "",
    mediaDirectory: process.env.MKTR_FREESWITCH_MEDIA_DIR || "/var/lib/freeswitch/recordings/mktr"
  }
};

// This runs before any adapter/socket is created by the API startup path.
assertGatewayStartupConfiguration(config);

export function isProductionGatewayConfigured(): boolean {
  return Boolean(
    config.singtel.password &&
      config.singtel.caCertificatePath &&
      config.freeswitch.password &&
      config.mediaGateway.webhookToken &&
      config.telephonyMode === "freeswitch"
  );
}
