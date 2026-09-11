import { CALLER_IDS, type CallerId } from "../src/lib/domain.js";

type Environment = Record<string, string | undefined>;
const boolean = (environment: Environment, name: string, fallback = false) => {
  const value = environment[name];
  if (value === undefined || value === "") return fallback;
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false.`);
  return value === "true";
};
const integer = (environment: Environment, name: string, fallback: number, maximum: number) => {
  const raw = environment[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return value;
};
export const recordingFilePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.wav$/i;

export function callbackCallerId(value: string | undefined): CallerId | undefined {
  const normalized = value?.startsWith("+") ? value : `+${value}`;
  return CALLER_IDS.find((callerId) => callerId === normalized);
}

export function inboundConfiguration(environment: Environment = process.env) {
  const enabled = boolean(environment, "MKTR_INBOUND_CALLBACK_ENABLED");
  const clipFile = environment.MKTR_INBOUND_CLIP_FILE || "disabled.wav";
  if ((enabled || environment.MKTR_INBOUND_CLIP_FILE) && !recordingFilePattern.test(clipFile)) throw new Error("MKTR_INBOUND_CLIP_FILE must name an uploaded canonical UUID.wav clip before callbacks are enabled.");
  const recordMessage = boolean(environment, "MKTR_INBOUND_RECORD_MESSAGE");
  if (recordMessage && !enabled) throw new Error("Inbound message recording requires callbacks to be enabled.");
  return {
    enabled, clipFile, recordMessage,
    maxMessageSeconds: integer(environment, "MKTR_INBOUND_MAX_MESSAGE_SECONDS", 60, 120),
    maxCallSeconds: integer(environment, "MKTR_MAX_CALL_SECONDS", 180, 1800),
    maxConcurrentCalls: integer(environment, "MKTR_MAX_CONCURRENT_CALLS", 5, 5),
    retentionDays: integer(environment, "MKTR_RECORDING_RETENTION_DAYS", 30, 365),
    destinationExpression: `^\\+?(${CALLER_IDS.map((id) => id.slice(1)).join("|")})$`
  };
}
