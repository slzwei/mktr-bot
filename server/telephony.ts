import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { EslClient, EslCommandError, type EslEvent } from "./esl.js";
import type { CallerId, Clip, TelephonyMode, TestCallInput, TrunkStatus } from "../src/lib/domain.js";
import { CALLER_IDS, RESERVED_CALLER_ID } from "../src/lib/domain.js";
import { config, isProductionGatewayConfigured } from "./config.js";

export type TelephonyCall = { providerCallId: string };
export type TelephonyEvent = {
  type: "dialing" | "ringing" | "answered" | "hangup" | "playbackStopped" | "originateFailed";
  providerCallId: string;
  cause?: string;
  playbackId?: string;
};
export interface TelephonyAdapter {
  readonly mode: TelephonyMode;
  readonly configured: boolean;
  originate(input: Pick<TestCallInput, "destination" | "callerId">, providerCallId?: string): Promise<TelephonyCall>;
  playClip(providerCallId: string, clip: Clip, playbackId?: string): Promise<void>;
  hangup(providerCallId: string): Promise<void>;
  startListening?(providerCallId: string, callId: string, windowId: string): Promise<void>;
  stopListening?(providerCallId: string): Promise<void>;
  onEvent?(listener: (event: TelephonyEvent) => void): () => void;
  close?(): void | Promise<void>;
}

export class SimulatedTelephonyAdapter implements TelephonyAdapter {
  readonly mode = "simulated" as const;
  readonly configured = true;
  async originate(_input?: Pick<TestCallInput, "destination" | "callerId">, providerCallId = randomUUID()): Promise<TelephonyCall> {
    return { providerCallId };
  }
  async hangup(): Promise<void> { return; }
  async playClip(): Promise<void> { return; }
}

export class FreeSwitchEslAdapter implements TelephonyAdapter {
  readonly mode = "freeswitch" as const;
  private readonly events = new EventEmitter();
  private readonly jobs = new Map<string, string>();
  private readonly earlyJobs = new Map<string, EslEvent>();
  private readonly seenEvents = new Set<string>();
  private readonly streams = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(
    readonly client = new EslClient(config.freeswitch),
    readonly configured = isProductionGatewayConfigured(),
    private readonly media = config.mediaGateway
  ) { this.unsubscribe = client.onEvent((event) => this.receive(event)); }

  onEvent(listener: (event: TelephonyEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async originate(input: Pick<TestCallInput, "destination" | "callerId">, providerCallId = randomUUID()): Promise<TelephonyCall> {
    if (!this.configured) throw new Error("FreeSWITCH mode requires complete gateway credentials and configuration.");
    assertAllowedCallerId(input.callerId);
    if (!/^\+[1-9]\d{7,14}$/.test(input.destination)) throw new Error("Destination must use E.164 format.");
    this.assertUuid(providerCallId);
    const variables = [
      `origination_uuid=${providerCallId}`,
      `origination_caller_id_number=${input.callerId}`,
      "origination_caller_id_name=MKTR", "absolute_codec_string=PCMA",
      "rtp_secure_media=true", "hangup_after_bridge=true",
      `originate_timeout=${config.originateTimeoutSeconds}`,
      `execute_on_answer='sched_hangup +${config.maxCallSeconds} ALLOTTED_TIMEOUT'`
    ].join(",");
    const frame = await this.client.command(`bgapi originate {${variables}}sofia/gateway/singtel/${input.destination} &park()`);
    const jobId = frame.headers["job-uuid"] ?? frame.headers["reply-text"]?.match(/Job-UUID:\s*(\S+)/)?.[1];
    if (!jobId) throw new Error("FreeSWITCH accepted originate without a Job-UUID; channel outcome is unknown.");
    this.jobs.set(jobId, providerCallId);
    this.emit({ type: "dialing", providerCallId });
    const early = this.earlyJobs.get(jobId);
    if (early) { this.earlyJobs.delete(jobId); this.jobResult(early); }
    return { providerCallId };
  }

  async hangup(providerCallId: string): Promise<void> {
    this.assertUuid(providerCallId);
    try { await this.client.command(`api uuid_kill ${providerCallId} NORMAL_CLEARING`); }
    catch (error) {
      // A remote hangup can win the race with this idempotent termination request.
      if (!(error instanceof EslCommandError) || !/No such channel|invalid uuid/i.test(error.reply)) throw error;
    }
  }

  async playClip(providerCallId: string, clip: Clip, playbackId = randomUUID()): Promise<void> {
    this.assertUuid(providerCallId);
    this.assertUuid(playbackId);
    if (!clip.assetUrl) throw new Error(`Live playback requires an uploaded file for ${clip.name}.`);
    const filename = clip.assetUrl.split("/").at(-1);
    if (!filename || !/^[a-f0-9-]+\.(wav|mp3)$/i.test(filename)) throw new Error("Clip media path is invalid.");
    if (!/^\/[a-zA-Z0-9/_-]+$/.test(config.freeswitch.mediaDirectory)) throw new Error("FreeSWITCH media directory is invalid.");
    await this.client.command(`api uuid_setvar ${providerCallId} mktr_playback_id ${playbackId}`);
    await this.client.command(`api uuid_broadcast ${providerCallId} ${config.freeswitch.mediaDirectory}/${filename} aleg`);
  }

  async startListening(providerCallId: string, callId: string, windowId: string): Promise<void> {
    [providerCallId, callId, windowId].forEach((id) => this.assertUuid(id));
    if (this.media.webhookToken.length < 16 || !/^[A-Za-z0-9_-]+$/.test(this.media.webhookToken)) {
      throw new Error("Media gateway token must have at least 16 URL-safe characters.");
    }
    const url = new URL(this.media.workerUrl);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^[a-zA-Z0-9.:/-]+$/.test(url.href)) {
      throw new Error("Media worker URL must be a plain ws or wss service URL.");
    }
    url.pathname = `/audio/${callId}/${windowId}`;
    await this.client.command(`api uuid_setvar ${providerCallId} STREAM_EXTRA_HEADERS ${JSON.stringify({ Authorization: `Bearer ${this.media.webhookToken}` })}`);
    // mono is the read (callee) leg; 8k is signed little-endian PCM on the supported Linux hosts.
    await this.client.command(`api uuid_audio_stream ${providerCallId} start ${url.href} mono 8k`);
    this.streams.add(providerCallId);
  }

  async stopListening(providerCallId: string): Promise<void> {
    this.assertUuid(providerCallId);
    if (!this.streams.delete(providerCallId)) return;
    await this.client.command(`api uuid_audio_stream ${providerCallId} stop`);
  }

  close(): void { this.unsubscribe(); this.client.close(); }

  private emit(event: TelephonyEvent): void { this.events.emit("event", event); }
  private assertUuid(uuid: string): void {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid)) throw new Error("Invalid provider call UUID.");
  }
  private jobResult(event: EslEvent): void {
    const job = event.headers["job-uuid"];
    const providerCallId = this.jobs.get(job);
    if (!providerCallId) {
      if (this.earlyJobs.size >= 128) this.earlyJobs.delete(this.earlyJobs.keys().next().value!);
      this.earlyJobs.set(job, event);
      return;
    }
    this.jobs.delete(job);
    const result = event.body.trim();
    this.emit(result.startsWith("+OK")
      ? { type: "ringing", providerCallId }
      : { type: "originateFailed", providerCallId, cause: result.replace(/^-ERR\s*/, "") || "ORIGINATE_FAILED" });
  }
  private receive(event: EslEvent): void {
    const sequence = event.headers["event-sequence"];
    if (sequence) {
      const key = `${event.headers["core-uuid"]}:${sequence}`;
      if (this.seenEvents.has(key)) return;
      if (this.seenEvents.size >= 2048) this.seenEvents.delete(this.seenEvents.values().next().value!);
      this.seenEvents.add(key);
    }
    if (event.name === "BACKGROUND_JOB") { this.jobResult(event); return; }
    const providerCallId = event.headers["unique-id"] ?? event.headers["variable_origination_uuid"];
    if (!providerCallId) return;
    if (event.name === "CHANNEL_CREATE") this.emit({ type: "dialing", providerCallId });
    if (event.name === "CHANNEL_PROGRESS") this.emit({ type: "ringing", providerCallId });
    if (event.name === "CHANNEL_ANSWER") this.emit({ type: "answered", providerCallId });
    if (event.name === "CHANNEL_HANGUP_COMPLETE") this.emit({ type: "hangup", providerCallId, cause: event.headers["hangup-cause"] ?? "NORMAL_CLEARING" });
    if (event.name === "PLAYBACK_STOP") this.emit({ type: "playbackStopped", providerCallId, playbackId: event.headers["variable_mktr_playback_id"] });
  }
}

export function createTelephonyAdapter(): TelephonyAdapter {
  return config.telephonyMode === "freeswitch"
    ? new FreeSwitchEslAdapter()
    : new SimulatedTelephonyAdapter();
}

export function getTrunkStatus(activeCalls: number, adapter: TelephonyAdapter): TrunkStatus {
  return {
    mode: adapter.mode,
    available: adapter.mode === "simulated" || adapter.configured,
    configured: adapter.configured,
    trunkUsername: config.singtel.username,
    endpoint: `${config.singtel.host} (${config.singtel.ip})`,
    signalingPort: config.singtel.pcmaPort,
    codecs: ["PCMA", "G.711u", "Opus"],
    media: `SRTP ${config.singtel.mediaIpRange}:${config.singtel.mediaPortRange}`,
    maxConcurrentCalls: config.maxConcurrentCalls,
    activeCalls,
    classifierMode: config.classifier.mode,
    callerIds: CALLER_IDS,
    reservedCallerId: RESERVED_CALLER_ID
  };
}

export function assertAllowedCallerId(callerId: string): asserts callerId is CallerId {
  if (callerId === RESERVED_CALLER_ID) {
    throw new Error(`${RESERVED_CALLER_ID} is reserved for Retell and cannot be used.`);
  }
  if (!(CALLER_IDS as readonly string[]).includes(callerId)) {
    throw new Error("Caller ID is not assigned to the MKTR bot pool.");
  }
}
