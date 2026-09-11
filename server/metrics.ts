import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Logger } from "pino";
import type { CallSession } from "../src/lib/domain.js";
import type { TelephonyHealth } from "./health.js";
import { currentLogContext, logger as defaultLogger } from "./logger.js";

const outcomes = ["completed", "failed", "busy", "no_answer", "voicemail", "stopped", "interested", "not_interested", "callback", "unknown", "inbound_callback", "skipped"] as const;
type Outcome = typeof outcomes[number];
export type ClassifierFallbackReason = "timeout" | "provider_error" | "invalid_response";

/** A registry per application keeps tests isolated and labels bounded. */
export class VoiceMetrics {
  readonly registry = new Registry();
  private activeCallSource: () => number = () => 0;
  private readonly outcomes: Counter<"outcome">;
  private readonly classifierLatency: Histogram<"provider">;
  private readonly sttLatency: Histogram<"provider">;
  private readonly classifierFallbacks: Counter<"reason">;
  private readonly gatewayRegistered: Gauge<"mode">;
  private readonly seenCalls = new Map<string, { eventId?: string; terminal: boolean; requestId?: string }>();
  private lastGatewayState?: string;

  constructor(private readonly logger: Logger = defaultLogger) {
    const voice = this;
    new Gauge({ name: "mktr_active_calls", help: "Current occupied outbound trunk slots.", registers: [this.registry], collect() { this.set(voice.activeCallSource()); } });
    this.outcomes = new Counter({ name: "mktr_calls_total", help: "Calls reaching a terminal outcome since this API process started.", labelNames: ["outcome"], registers: [this.registry] });
    for (const outcome of outcomes) this.outcomes.inc({ outcome }, 0);
    this.classifierLatency = new Histogram({ name: "mktr_classifier_duration_seconds", help: "Transcript classification latency including any rules fallback.", labelNames: ["provider"], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 5], registers: [this.registry] });
    this.sttLatency = new Histogram({ name: "mktr_stt_duration_seconds", help: "Provider final-transcript delivery latency after the audio utterance ended.", labelNames: ["provider"], buckets: [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 5], registers: [this.registry] });
    for (const provider of ["rules", "openai"]) this.classifierLatency.zero({ provider });
    for (const provider of ["deepgram", "openai", "fake", "unknown"]) this.sttLatency.zero({ provider });
    this.classifierFallbacks = new Counter({ name: "mktr_classifier_fallbacks_total", help: "Classifier requests completed by rules after provider failure.", labelNames: ["reason"], registers: [this.registry] });
    for (const reason of ["timeout", "provider_error", "invalid_response"]) this.classifierFallbacks.inc({ reason }, 0);
    this.gatewayRegistered = new Gauge({ name: "mktr_gateway_registered", help: "Whether the last gateway readiness probe succeeded; simulator has no gateway dependency.", labelNames: ["mode"], registers: [this.registry] });
  }

  setActiveCallSource(source: () => number): void { this.activeCallSource = source; }

  observeCall(call: CallSession): void {
    const previous = this.seenCalls.get(call.id);
    const terminal = call.status === "ended" || call.status === "failed";
    const requestId = previous?.requestId ?? currentLogContext()?.requestId;
    const eventId = call.events.at(-1)?.id;
    if (!previous?.terminal && terminal) {
      const reported = (call as CallSession & { outcome?: string }).outcome ?? (call.status === "failed" ? "failed" : "completed");
      const outcome: Outcome = (outcomes as readonly string[]).includes(reported) ? reported as Outcome : "unknown";
      this.outcomes.inc({ outcome });
    }
    if (!previous || previous.eventId !== eventId || previous.terminal !== terminal) {
      this.logger.info({ requestId: requestId ?? `call:${call.id}`, callId: call.id, providerCallId: call.providerCallId, status: call.status, event: call.events.at(-1)?.type, nodeId: call.currentNodeId }, "Call state changed");
    }
    this.seenCalls.set(call.id, { eventId, terminal, requestId });
    // Bound correlation history; active calls are never evicted.
    if (this.seenCalls.size > 10_000) {
      const oldestFinished = [...this.seenCalls].find(([, value]) => value.terminal)?.[0];
      if (oldestFinished) this.seenCalls.delete(oldestFinished);
    }
  }

  observeClassifierLatency(milliseconds: number, provider: "rules" | "openai"): void {
    if (Number.isFinite(milliseconds) && milliseconds >= 0) this.classifierLatency.observe({ provider }, milliseconds / 1000);
  }
  observeSttLatency(milliseconds: number, provider: string): void {
    const label = ["deepgram", "openai", "fake"].includes(provider) ? provider : "unknown";
    if (Number.isFinite(milliseconds) && milliseconds >= 0) this.sttLatency.observe({ provider: label }, milliseconds / 1000);
  }
  observeClassifierFallback(reason: ClassifierFallbackReason): void { this.classifierFallbacks.inc({ reason }); }

  observeHealth(mode: "simulated" | "freeswitch", health: TelephonyHealth): void {
    this.gatewayRegistered.set({ mode }, Number(health.ok));
    const state = `${mode}:${health.esl}:${health.gateway}:${health.reason ?? "ready"}`;
    if (state === this.lastGatewayState) return;
    this.lastGatewayState = state;
    const fields = { mode, esl: health.esl, gateway: health.gateway, reason: health.reason };
    if (health.ok) this.logger.info(fields, "Gateway readiness changed");
    else this.logger.warn(fields, "Gateway readiness changed");
  }
}

export const voiceMetrics = new VoiceMetrics();
