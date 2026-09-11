import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { EslClient, EslCommandError, type EslEvent, type CommandGuard } from "./esl.js";
import type { CallerId, Clip, TelephonyMode, TestCallInput, TrunkStatus } from "../src/lib/domain.js";
import { CALLER_IDS, RESERVED_CALLER_ID } from "../src/lib/domain.js";
import { config, isProductionGatewayConfigured } from "./config.js";
import { FreeSwitchHealthProbe, type TelephonyHealth } from "./health.js";
import { logger } from "./logger.js";

export type TelephonyCall = { providerCallId: string };
export type ProviderChannel = { providerCallId: string; callerName: string };
export type TelephonyEvent = {
  type: "dialing" | "ringing" | "answered" | "hangup" | "playbackStopped" | "originateFailed" | "voicemail";
  providerCallId: string;
  cause?: string;
  playbackId?: string;
};
export interface TelephonyAdapter {
  readonly mode: TelephonyMode;
  readonly configured: boolean;
  originate(input: Pick<TestCallInput, "destination" | "callerId">, providerCallId?: string, guard?: CommandGuard): Promise<TelephonyCall>;
  playClip(providerCallId: string, clip: Clip, playbackId?: string): Promise<void>;
  hangup(providerCallId: string): Promise<void>;
  startAnsweringMachineDetection?(providerCallId: string): Promise<void>;
  startRecording?(providerCallId: string, callId: string): Promise<void>;
  /** Opens the call's single speech stream at answer. It closes with the channel at hangup. */
  startStreaming?(providerCallId: string, callId: string): Promise<void>;
  /** Tells the media worker a listen window is open and which endpointing its replies use. */
  startListening?(callId: string, windowId: string, endpointingMs: number): Promise<void>;
  /** Tells the media worker the window has closed. The audio stream keeps running. */
  stopListening?(callId: string, windowId: string): Promise<void>;
  listChannels?(): Promise<ProviderChannel[]>;
  onConnection?(listener: (connected: boolean) => void): () => void;
  onEvent?(listener: (event: TelephonyEvent) => void): () => void;
  close?(): void | Promise<void>;
  health?(): Promise<TelephonyHealth>;
}

export class SimulatedTelephonyAdapter implements TelephonyAdapter {
  readonly mode = "simulated" as const;
  readonly configured = true;
  async originate(_input?: Pick<TestCallInput, "destination" | "callerId">, providerCallId = randomUUID(), guard?: CommandGuard): Promise<TelephonyCall> {
    await guard?.prepare(); guard?.check();
    return { providerCallId };
  }
  async hangup(): Promise<void> { return; }
  async playClip(): Promise<void> { return; }
  async health(): Promise<TelephonyHealth> { return { ok: true, esl: "n/a", gateway: "n/a" }; }
}

export class FreeSwitchEslAdapter implements TelephonyAdapter {
  readonly mode = "freeswitch" as const;
  private readonly events = new EventEmitter();
  private readonly jobs = new Map<string, string>();
  private readonly earlyJobs = new Map<string, EslEvent>();
  private readonly seenEvents = new Set<string>();
  private readonly streams = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly healthProbe: FreeSwitchHealthProbe;

  constructor(
    readonly client = new EslClient(config.freeswitch),
    readonly configured = isProductionGatewayConfigured(),
    private readonly media = config.mediaGateway,
    private readonly mediaTimeoutMs = 3000
  ) {
    this.unsubscribe = client.onEvent((event) => this.receive(event));
    this.healthProbe = new FreeSwitchHealthProbe(client, configured);
  }

  health(): Promise<TelephonyHealth> { return this.healthProbe.read(); }


  onEvent(listener: (event: TelephonyEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  onConnection(listener: (connected: boolean) => void): () => void { return this.client.onConnection(listener); }

  async listChannels(): Promise<ProviderChannel[]> {
    const frame = await this.client.command("api show channels as json");
    const value = JSON.parse(frame.body) as { rows?: { uuid?: string }[]; row_count?: number };
    if ((!Array.isArray(value.rows) && value.row_count !== 0) || (value.rows?.length ?? 0) > 1000) throw new Error("Invalid FreeSWITCH channel inventory.");
    const channels: ProviderChannel[] = [];
    for (const row of value.rows ?? []) {
      this.assertUuid(row.uuid ?? "");
      try {
        const identity = await this.client.command(`api uuid_getvar ${row.uuid} origination_caller_id_name`);
        channels.push({ providerCallId: row.uuid!, callerName: identity.body.trim() });
      } catch (error) {
        if (!(error instanceof EslCommandError) || !/No such channel|invalid uuid/i.test(error.reply)) throw error;
      }
    }
    return channels;
  }

  async originate(input: Pick<TestCallInput, "destination" | "callerId">, providerCallId = randomUUID(), guard?: CommandGuard): Promise<TelephonyCall> {
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
    const frame = await this.client.command(`bgapi originate {${variables}}sofia/gateway/singtel/${input.destination} &park()`, guard);
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
    // The stream dies with the channel, so a refused stop must never stand between us and the kill.
    try { await this.stopStreaming(providerCallId); }
    catch (error) { logger.warn({ providerCallId, err: error }, "Audio stream stop was not confirmed; terminating the channel anyway"); }
    try { await this.client.command(`api uuid_kill ${providerCallId} NORMAL_CLEARING`); }
    catch (error) {
      // A remote hangup can win the race with this idempotent termination request.
      if (!(error instanceof EslCommandError) || !/No such channel|invalid uuid/i.test(error.reply)) throw error;
    }
  }

  async playClip(providerCallId: string, clip: Clip, playbackId = randomUUID()): Promise<void> {
    this.assertUuid(providerCallId);
    this.assertUuid(playbackId);
    if (!clip.telephonyAssetUrl) throw new Error(`Live playback requires an uploaded file for ${clip.name}.`);
    const filename = clip.telephonyAssetUrl.split("/").at(-1);
    if (!filename || !/^[a-f0-9-]+\.wav$/i.test(filename)) throw new Error("Clip media path is invalid.");
    if (!/^\/[a-zA-Z0-9/_-]+$/.test(config.freeswitch.mediaDirectory)) throw new Error("FreeSWITCH media directory is invalid.");
    await this.client.command(`api uuid_setvar ${providerCallId} mktr_playback_id ${playbackId}`);
    await this.client.command(`api uuid_broadcast ${providerCallId} ${config.freeswitch.mediaDirectory}/${filename} aleg`);
  }

  async startAnsweringMachineDetection(providerCallId: string): Promise<void> {
    this.assertUuid(providerCallId);
    await this.client.command(`api avmd ${providerCallId} start`);
  }

  async startRecording(providerCallId: string, callId: string): Promise<void> {
    this.assertUuid(providerCallId); this.assertUuid(callId);
    await this.client.command(`api uuid_record ${providerCallId} start /var/lib/freeswitch/recordings/sessions/${callId}.wav`);
  }

  /** One stream per call: started on answer so no listen window ever pays a provider handshake. */
  async startStreaming(providerCallId: string, callId: string): Promise<void> {
    [providerCallId, callId].forEach((id) => this.assertUuid(id));
    const url = this.mediaWorkerUrl(`/audio/${callId}`);
    await this.client.command(`api uuid_setvar ${providerCallId} STREAM_EXTRA_HEADERS ${JSON.stringify({ Authorization: `Bearer ${this.media.webhookToken}` })}`);
    // mono is the read (callee) leg; 8k is signed little-endian PCM on the supported Linux hosts.
    await this.client.command(`api uuid_audio_stream ${providerCallId} start ${url.href} mono 8k`);
    this.streams.add(providerCallId);
  }

  private async stopStreaming(providerCallId: string): Promise<void> {
    if (!this.streams.delete(providerCallId)) return;
    try { await this.client.command(`api uuid_audio_stream ${providerCallId} stop`); }
    catch (error) {
      // The channel can clear first; the stream then ends with it.
      if (!(error instanceof EslCommandError) || !/No such channel|invalid uuid/i.test(error.reply)) throw error;
    }
  }

  async startListening(callId: string, windowId: string, endpointingMs: number): Promise<void> {
    [callId, windowId].forEach((id) => this.assertUuid(id));
    if (!Number.isSafeInteger(endpointingMs)) throw new Error("Listen endpointing must be a whole number of milliseconds.");
    const url = this.mediaWorkerUrl(`/calls/${callId}/window/${windowId}`, "http");
    url.search = new URLSearchParams({ endpointingMs: String(endpointingMs) }).toString();
    // A window the worker never learns about is a deaf turn, so this failure fails the call.
    await this.mediaWorkerRequest("POST", url);
  }

  async stopListening(callId: string, windowId: string): Promise<void> {
    [callId, windowId].forEach((id) => this.assertUuid(id));
    const url = this.mediaWorkerUrl(`/calls/${callId}/window/${windowId}`, "http");
    // Closing is an optimisation: it stops the worker submitting a late reply the API would
    // refuse anyway. Losing it must not fail a call that has already been answered.
    try { await this.mediaWorkerRequest("DELETE", url); }
    catch (error) { logger.warn({ callId, windowId, err: error }, "Media worker did not confirm the listen window closed"); }
  }

  private mediaWorkerUrl(pathname: string, scheme: "ws" | "http" = "ws"): URL {
    if (this.media.webhookToken.length < 16 || !/^[A-Za-z0-9_-]+$/.test(this.media.webhookToken)) {
      throw new Error("Media gateway token must have at least 16 URL-safe characters.");
    }
    const url = new URL(this.media.workerUrl);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^[a-zA-Z0-9.:/-]+$/.test(url.href)) {
      throw new Error("Media worker URL must be a plain ws or wss service URL.");
    }
    // The worker serves its control routes and its audio upgrades on one listener.
    if (scheme === "http") url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = pathname;
    return url;
  }

  private async mediaWorkerRequest(method: "POST" | "DELETE", url: URL): Promise<void> {
    const response = await fetch(url, {
      method, headers: { Authorization: `Bearer ${this.media.webhookToken}` }, signal: AbortSignal.timeout(this.mediaTimeoutMs)
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Media worker ${method} ${url.pathname} returned HTTP ${response.status}.`);
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
    if (event.name === "CHANNEL_HANGUP_COMPLETE") {
      this.streams.delete(providerCallId);
      this.emit({ type: "hangup", providerCallId, cause: event.headers["hangup-cause"] ?? "NORMAL_CLEARING" });
    }
    if (event.name === "CUSTOM" && event.headers["event-subclass"] === "avmd::beep" && event.headers["beep-status"]?.toUpperCase() === "DETECTED") this.emit({ type: "voicemail", providerCallId });
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
