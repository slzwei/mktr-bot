import path from "node:path";
import type { ClassifierMode, TelephonyMode } from "../src/lib/domain.js";
import { assertGatewayStartupConfiguration } from "./gateway-security.js";

const int = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: int(process.env.PORT, 8787),
  webOrigin: process.env.MKTR_WEB_ORIGIN || "http://localhost:5173",
  trustProxy: (process.env.MKTR_TRUST_PROXY || "loopback").split(",").map((value) => value.trim()),
  telephonyMode: (process.env.MKTR_TELEPHONY_MODE === "freeswitch"
    ? "freeswitch"
    : "simulated") as TelephonyMode,
  maxConcurrentCalls: int(process.env.MKTR_MAX_CONCURRENT_CALLS, 5),
  clipStorageDir: process.env.MKTR_CLIP_STORAGE_DIR ?? path.join(process.cwd(), "storage", "clips"),
  classifier: {
    mode: process.env.MKTR_CLASSIFIER_MODE === "openai" && Boolean(process.env.OPENAI_API_KEY)
      ? "openai"
      : "rules" as ClassifierMode,
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    openaiModel: process.env.MKTR_OPENAI_CLASSIFIER_MODEL ?? "gpt-4o-mini"
  },
  mediaGateway: {
    webhookToken: process.env.MKTR_MEDIA_GATEWAY_TOKEN ?? ""
  },
  singtel: {
    host: process.env.MKTR_SINGTEL_SIP_HOST ?? "sipsg01.b3networks.com",
    ip: process.env.MKTR_SINGTEL_SIP_IP ?? "52.77.0.62",
    pcmaPort: int(process.env.MKTR_SINGTEL_PCMA_PORT, 5061),
    opusPort: int(process.env.MKTR_SINGTEL_OPUS_PORT, 5081),
    username: process.env.MKTR_SINGTEL_SIP_USERNAME ?? "sip69992409",
    password: process.env.MKTR_SINGTEL_SIP_PASSWORD ?? "",
    mediaIpRange: "54.251.255.196-54.251.255.211",
    mediaPortRange: "10000-30000",
    caCertificatePath: process.env.MKTR_SINGTEL_CA_CERT_PATH ?? ""
  },
  freeswitch: {
    host: process.env.MKTR_FREESWITCH_ESL_HOST ?? "127.0.0.1",
    port: int(process.env.MKTR_FREESWITCH_ESL_PORT, 8021),
    password: process.env.MKTR_FREESWITCH_ESL_PASSWORD ?? "",
    mediaDirectory: process.env.MKTR_FREESWITCH_MEDIA_DIR ?? "/var/lib/freeswitch/recordings/mktr"
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
