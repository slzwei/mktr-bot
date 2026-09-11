import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { CallSession, FlowDefinition } from "../src/lib/domain.js";
import type { EslClient, EslEvent } from "./esl.js";
import { callbackCallerId, inboundConfiguration, recordingFilePattern } from "./inbound-config.js";
import { logger as defaultLogger } from "./logger.js";
import { voiceMetrics, type VoiceMetrics } from "./metrics.js";
import type { Store } from "./store.js";
import { FreeSwitchEslAdapter, type TelephonyAdapter } from "./telephony.js";

const callbackFlowId = "mktr-internal-inbound-callback";
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const terminal = (call: CallSession) => ["ended", "failed"].includes(call.status);
const callerNumber = (value = "") => /^\+?[1-9]\d{7,14}$/.test(value) ? (value.startsWith("+") ? value : `+${value}`) : "withheld";

type Options = {
  environment?: Record<string, string | undefined>;
  now?: () => number;
  logger?: Logger;
  metrics?: Pick<VoiceMetrics, "observeCall">;
};

/** Provider-owned inbound calls never run through the outbound flow executor. */
export class InboundCallbackTracker {
  private pending: Promise<void> = Promise.resolve();
  private failure?: Error;
  private readonly unsubscribe: () => void;
  private readonly settings;
  private readonly now;
  private readonly logger;
  private readonly metrics;
  private flow?: FlowDefinition;

  constructor(private readonly client: Pick<EslClient, "onEvent" | "command">, private readonly store: Store, options: Options = {}) {
    this.settings = inboundConfiguration(options.environment);
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? defaultLogger;
    this.metrics = options.metrics ?? voiceMetrics;
    if (this.settings.enabled) this.flow = this.ensureFlow();
    this.unsubscribe = client.onEvent((event) => {
      if (event.headers.variable_mktr_direction !== "inbound_callback" || !["CHANNEL_ANSWER", "CHANNEL_HANGUP_COMPLETE"].includes(event.name)) return;
      this.pending = this.pending.then(() => this.receive(event)).catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.logger.error({ err: this.failure, providerCallId: event.headers["unique-id"] }, "Inbound callback persistence failed");
      });
    });
  }

  async flush() { await this.pending; if (this.failure) throw this.failure; }
  async close() { this.unsubscribe(); await this.flush(); }

  private async receive(event: EslEvent) {
    const providerCallId = event.headers["unique-id"];
    const callerId = callbackCallerId(event.headers.variable_mktr_callback_to);
    if (!uuidPattern.test(providerCallId ?? "") || !callerId) {
      this.logger.warn({ providerCallId }, "Ignoring inbound callback event without an approved destination and UUID");
      return;
    }
    const prior = this.store.getCall(providerCallId);
    if (prior && prior.direction !== "inbound_callback") throw new Error("Inbound UUID conflicts with an existing outbound call.");
    if (prior && terminal(prior)) {
      // An operator stop can persist the terminal state before FreeSWITCH reports
      // the final recording duration; retain that late metadata without a second outcome.
      if (event.name === "CHANNEL_HANGUP_COMPLETE" && !prior.recordingFile && this.attachRecording(prior, event)) {
        this.store.saveCall(prior);
        await this.store.flush();
      }
      return;
    }
    if (event.name === "CHANNEL_ANSWER" && prior) return;
    const timestamp = new Date(this.now()).toISOString();
    this.flow ??= this.ensureFlow();
    const call: CallSession = prior ?? {
      id: providerCallId, providerCallId, flowId: this.flow.id, flowVersion: this.flow.version,
      callerId, destination: callerNumber(event.headers["caller-caller-id-number"] ?? event.headers.variable_caller_id_number),
      direction: "inbound_callback", outcome: "inbound_callback", status: "answered", createdAt: timestamp,
      events: [{ id: randomUUID(), type: "inbound_callback", timestamp, title: "Inbound callback", detail: "Answered by the configured FreeSWITCH callback dialplan." }]
    };
    if (event.name === "CHANNEL_HANGUP_COMPLETE") {
      call.status = "ended";
      call.endedAt = timestamp;
      call.endReason = `Inbound callback: ${/^[A-Z_0-9]{1,80}$/.test(event.headers["hangup-cause"] ?? "") ? event.headers["hangup-cause"] : "NORMAL_CLEARING"}`;
      call.events.push({ id: randomUUID(), type: "ended", timestamp, title: "Inbound callback ended", detail: call.endReason });
      this.attachRecording(call, event);
    }
    const occupied = this.store.listCalls().filter((item) => !terminal(item)).length;
    this.store.saveCall(call);
    await this.store.flush();
    this.metrics.observeCall(call);
    if (event.name === "CHANNEL_ANSWER" && occupied >= this.settings.maxConcurrentCalls) {
      // The gateway also enforces max-sessions, including incoming legs. Keep the
      // conservative occupied slot if termination cannot be confirmed.
      await this.client.command(`api uuid_kill ${providerCallId} USER_BUSY`);
      call.status = "failed";
      call.endedAt = new Date(this.now()).toISOString();
      call.endReason = "Inbound callback rejected: trunk capacity reached";
      call.events.push({ id: randomUUID(), type: "error", timestamp: call.endedAt, title: "Inbound callback rejected", detail: call.endReason });
      this.store.saveCall(call);
      await this.store.flush();
      this.metrics.observeCall(call);
    }
  }

  private ensureFlow(): FlowDefinition {
    const clip = this.store.listClips().find((item) => item.telephonyAssetUrl?.split("/").at(-1) === this.settings.clipFile);
    if (this.settings.enabled && (!clip || clip.status !== "ready")) throw new Error("Inbound callback greeting must be a ready uploaded clip in the durable store.");
    const versions = this.store.listFlowVersions().filter((flow) => flow.id === callbackFlowId).sort((left, right) => right.version - left.version);
    const current = versions[0];
    if (current && current.nodes.find((node) => node.id === "greeting")?.data.clipId === clip?.id) return current;
    const flow: FlowDefinition = {
      id: callbackFlowId, name: "System: inbound callback dialplan", version: (current?.version ?? 0) + 1, status: "published", startNodeId: "start", updatedAt: new Date(this.now()).toISOString(),
      nodes: [
        { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Inbound callback", description: "Routing is owned by telephony/freeswitch/conf/dialplan/public.xml." } },
        ...(clip ? [{ id: "greeting", type: "playClip" as const, position: { x: 250, y: 0 }, data: { label: "Callback greeting", clipId: clip.id } }] : []),
        { id: "end", type: "end", position: { x: 500, y: 0 }, data: { label: "Callback completed" } }
      ],
      edges: clip ? [{ id: "start-greeting", source: "start", target: "greeting" }, { id: "greeting-end", source: "greeting", target: "end" }] : [{ id: "provider-owned", source: "start", target: "end" }]
    };
    this.store.saveFlow(flow);
    return flow;
  }

  private attachRecording(call: CallSession, event: EslEvent): boolean {
    const recording = event.headers.variable_mktr_recording_file;
    const duration = Number(event.headers.variable_record_ms);
    if (!this.settings.recordMessage || recording !== `${call.providerCallId}.wav` || !recordingFilePattern.test(recording) || !Number.isFinite(duration) || duration <= 0) return false;
    call.recordingFile = recording;
    call.recordingExpiresAt = new Date(Date.parse(call.endedAt ?? call.createdAt) + this.settings.retentionDays * 86_400_000).toISOString();
    return true;
  }
}

export async function attachInboundCallbacks(adapter: TelephonyAdapter, store: Store, options: Options = {}): Promise<InboundCallbackTracker | undefined> {
  if (!(adapter instanceof FreeSwitchEslAdapter)) return undefined;
  const tracker = new InboundCallbackTracker(adapter.client, store, options);
  await store.flush();
  return tracker;
}
