import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  CallEvent,
  CallEventType,
  CallSession,
  CallStatus,
  ClassifierResult,
  Clip,
  FlowDefinition,
  FlowEdge,
  FlowNode,
  TestCallInput
} from "../src/lib/domain.js";
import { SCENARIOS } from "../src/lib/domain.js";
import { createTranscriptClassifier, type TranscriptClassifier } from "./classifier.js";
import { config } from "./config.js";
import type { Store } from "./store.js";
import { assertAllowedCallerId, type TelephonyAdapter, type TelephonyEvent } from "./telephony.js";

const activeStatuses = new Set<CallStatus>([
  "queued",
  "dialing",
  "ringing",
  "answered",
  "playing",
  "listening",
  "classifying"
]);

type PlaybackDelay = (clip: Clip, mode: TelephonyAdapter["mode"]) => number;
export type TranscriptReceipt = { windowId: string; utteranceId: string; sttLatencyMs?: number };
export class ListenWindowClosedError extends Error { readonly status = 409; }

const defaultPlaybackDelay: PlaybackDelay = (clip, mode) => {
  if (mode === "simulated") {
    return Math.max(350, Math.min(1_200, clip.durationSeconds * 90));
  }
  return Math.max(250, clip.durationSeconds * 1_000);
};

/**
 * Runs the published graph associated with each call. Clip playback moves to
 * the next canvas node, while listen nodes pause until the media gateway sends
 * a final transcript.
 */
export class CallOrchestrator {
  private readonly updates = new EventEmitter();
  private readonly schedules = new Map<string, NodeJS.Timeout[]>();
  private readonly flowSnapshots = new Map<string, FlowDefinition>();
  private readonly simulationReplies = new Map<string, string[]>();
  private readonly traversalHops = new Map<string, number>();
  private pendingStarts = 0;
  private readonly playbacks = new Map<string, { id: string; target: string }>();
  private readonly terminations = new Map<string, Promise<CallSession>>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly listenTimers = new Map<string, NodeJS.Timeout>();
  private readonly unsubscribeAdapter?: () => void;
  private readonly unsubscribeConnection?: () => void;
  private stopping = false;
  private initialized = false;
  private reconciling = false;
  private reconciliation?: Promise<void>;

  constructor(
    private readonly store: Store,
    private readonly adapter: TelephonyAdapter,
    private readonly classifier: TranscriptClassifier = createTranscriptClassifier(),
    private readonly playbackDelay: PlaybackDelay = defaultPlaybackDelay,
    private readonly deadlines = { originateTimeoutMs: config.originateTimeoutSeconds * 1000, maxCallMs: config.maxCallSeconds * 1000 }
  ) {
    for (const session of store.listCalls().filter((call) => activeStatuses.has(call.status))) {
      const graph = store.getFlowVersion(session.flowId, session.flowVersion);
      if (!graph) throw new Error(`Active call ${session.id} has no immutable flow version.`);
      this.flowSnapshots.set(session.id, graph);
    }
    this.unsubscribeAdapter = adapter.onEvent?.((event) => {
      void this.handleTelephonyEvent(event).catch((error: unknown) => {
        console.error("Telephony event handling failed", { providerCallId: event.providerCallId, error });
      });
    });
    this.unsubscribeConnection = adapter.onConnection?.((connected) => {
      if (!this.initialized || this.stopping) return;
      this.reconciling = true;
      if (connected) void this.reconcile("ESL_RECONNECTED").catch((error: unknown) => console.error("ESL reconciliation failed; dialing disabled", { error }));
    });
  }

  async initialize(): Promise<void> {
    await this.reconcile("SERVICE_RESTART");
    this.initialized = true;
  }

  private reconcile(reason: string): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    this.reconciling = true;
    const operation = (async () => {
      const channels = this.adapter.mode === "freeswitch" ? await this.adapter.listChannels?.() : [];
      if (this.adapter.mode === "freeswitch" && !channels) throw new Error("Live adapter cannot reconcile channels.");
      const active = this.store.listCalls().filter((call) => activeStatuses.has(call.status));
      const known = new Set(active.map((call) => call.providerCallId));
      for (const channel of channels ?? []) {
        if (channel.callerName === "MKTR" && !known.has(channel.providerCallId)) await this.adapter.hangup(channel.providerCallId);
      }
      const remote = new Set((channels ?? []).map((channel) => channel.providerCallId));
      for (const call of active) {
        if (remote.has(call.providerCallId)) await this.finish(call, "failed", reason);
        else await this.complete(call, "failed", reason);
      }
      this.reconciling = false;
    })();
    this.reconciliation = operation;
    void operation.then(() => { this.reconciliation = undefined; }, () => { this.reconciliation = undefined; });
    return operation;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const results = await Promise.allSettled(this.store.listCalls().filter((call) => activeStatuses.has(call.status)).map((call) => this.finish(call, "ended", "SERVICE_SHUTDOWN")));
    this.unsubscribeAdapter?.(); this.unsubscribeConnection?.();
    await this.adapter.close?.();
    await this.store.flush();
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Some provider hangups were not confirmed during shutdown.");
  }

  activeCallCount(): number {
    return this.store.listCalls().filter((call) => activeStatuses.has(call.status)).length;
  }

  async start(input: TestCallInput): Promise<CallSession> {
    if (this.stopping || this.reconciling) throw new Error("Call service is reconciling or shutting down.");
    assertAllowedCallerId(input.callerId);
    if (!/^\+[1-9]\d{7,14}$/.test(input.destination)) {
      throw new Error("Destination must use E.164 format, for example +6591234567.");
    }
    if (this.activeCallCount() + this.pendingStarts >= Math.min(5, config.maxConcurrentCalls)) {
      throw new Error("The Singtel trunk is at its " + config.maxConcurrentCalls + "-call limit.");
    }
    this.pendingStarts += 1;
    let reserved = true;
    let session: CallSession | undefined;

    try {
      const flow = this.store.getFlow(input.flowId);
      if (!flow) throw new Error("Selected flow no longer exists.");
      if (flow.status !== "published") throw new Error("Publish the flow before starting a call.");

      session = {
        id: randomUUID(),
        providerCallId: randomUUID(),
        destination: input.destination,
        callerId: input.callerId,
        flowId: flow.id,
        flowVersion: flow.version,
        status: "queued",
        createdAt: new Date().toISOString(),
        events: []
      };
      this.flowSnapshots.set(session.id, structuredClone(flow));
      this.record(session, "queued", "Call queued", flow.name + " v" + flow.version);
      const persisted = this.persist(session);
      this.pendingStarts -= 1;
      reserved = false;
      await persisted;
      this.after(session.id, this.deadlines.originateTimeoutMs, async (current) => {
        if (["queued", "dialing", "ringing"].includes(current.status)) await this.finish(current, "failed", "NO_ANSWER");
      });
      // Persist the UUID before sending originate: answer/job events may precede its reply.
      const provider = await this.adapter.originate(input, session.providerCallId);
      const current = this.store.getCall(session.id) ?? session;
      if (current.providerCallId !== provider.providerCallId) {
        current.providerCallId = provider.providerCallId;
        await this.persist(current);
      }
      if (this.adapter.mode === "simulated" && activeStatuses.has(current.status) && !this.stopping) {
        this.runSimulation(session.id, input.scenario ?? "interested");
      }
      return this.store.getCall(session.id) ?? session;
    } catch (error) {
      if (session) await this.finish(session, "failed", error instanceof Error ? error.message : "Originate failed.");
      throw error;
    } finally {
      if (reserved) this.pendingStarts -= 1;
    }
  }

  async stop(id: string, reason = "Stopped by operator"): Promise<CallSession> {
    const session = this.store.getCall(id);
    if (!session) throw new Error("Call not found.");
    if (!activeStatuses.has(session.status)) return session;
    return this.finish(session, "ended", reason);
  }

  get(id: string): CallSession | undefined {
    return this.store.getCall(id);
  }

  markAnswered(id: string): Promise<CallSession> {
    return this.enqueue(id, () => this.answer(id));
  }

  private async answer(id: string): Promise<CallSession> {
    const session = this.store.getCall(id);
    if (!session) throw new Error("Call not found.");
    if (!activeStatuses.has(session.status)) return session;
    if (this.stopping || this.reconciling || this.terminations.has(id)) return session;
    if (["answered", "playing", "listening", "classifying"].includes(session.status)) {
      return session;
    }
    const flow = this.flowForSession(session);
    if (!flow) throw new Error("Call flow no longer exists.");

    try {
      this.traversalHops.set(session.id, 0);
      await this.transition(session, "answered", "answered", "Call answered");
      this.after(session.id, this.deadlines.maxCallMs, async (current) => { await this.finish(current, "ended", "ALLOTTED_TIMEOUT"); });
      await this.advance(session, flow, flow.startNodeId);
      return this.store.getCall(id) ?? session;
    } catch (error) {
      await this.finish(session, "failed", error instanceof Error ? error.message : "Call automation failed.");
      throw error;
    }
  }

  submitTranscript(id: string, transcript: string, receipt?: TranscriptReceipt): Promise<CallSession> {
    return this.enqueue(id, () => this.classifyTranscript(id, transcript, receipt));
  }

  async mediaError(id: string, windowId: string): Promise<CallSession> {
    const session = this.store.getCall(id);
    if (!session) throw new Error("Call not found.");
    if (session.status !== "listening" || session.listenWindowId !== windowId) return session;
    return this.finish(session, "failed", "Speech transcription unavailable.");
  }

  private async classifyTranscript(id: string, transcript: string, receipt?: TranscriptReceipt): Promise<CallSession> {
    const session = this.store.getCall(id);
    if (!session) throw new Error("Call not found.");
    if (receipt && session.lastUtteranceId === receipt.utteranceId && session.lastListenWindowId === receipt.windowId) return session;
    if (session.status !== "listening" || this.terminations.has(id) || (receipt && session.listenWindowId !== receipt.windowId)) {
      throw new ListenWindowClosedError("The call is not waiting in this listen window.");
    }
    const flow = this.flowForSession(session);
    if (!flow) throw new Error("Call flow no longer exists.");
    const listeningNode = this.nodeFor(flow, session.currentNodeId);
    if (!listeningNode || listeningNode.type !== "listen") {
      throw new Error("The call is not currently positioned at a listen node.");
    }

    try {
      this.record(session, "transcript_final", "Transcript final", transcript, listeningNode.id, receipt?.sttLatencyMs);
      session.lastListenWindowId = session.listenWindowId;
      this.clearListenTimer(session.id);
      session.lastUtteranceId = receipt?.utteranceId;
      session.listenWindowId = undefined;
      session.status = "classifying";
      await this.persist(session);
      await this.adapter.stopListening?.(session.providerCallId);

      const startedAt = performance.now();
      const result = await this.classifier.classify(transcript);
      const latest = this.store.getCall(id);
      if (!latest || !activeStatuses.has(latest.status) || this.terminations.has(id)) return latest ?? session;
      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
      session.classifierResult = result;
      await this.transition(
        session,
        "classifying",
        "classified",
        "Classified: " + result.intent,
        result.sentiment + " sentiment / " + (result.confidence * 100).toFixed(0) + "% confidence / " + (result.provider ?? this.classifier.mode),
        listeningNode.id,
        latencyMs
      );

      const route = this.pickRoute(flow, result, listeningNode.id);
      if (!route) throw new Error("No route matched the classified response.");
      const nextNode = this.nodeFor(flow, route.target);
      if (!nextNode) throw new Error("The selected route points to a missing node.");
      if (nextNode.type !== "classify" && nextNode.type !== "condition") {
        this.recordBranch(session, route, listeningNode.id);
        await this.persist(session);
      }

      this.traversalHops.set(session.id, 0);
      await this.advance(session, flow, route.target, result);
      return this.store.getCall(id) ?? session;
    } catch (error) {
      await this.finish(session, "failed", error instanceof Error ? error.message : "Call automation failed.");
      throw error;
    }
  }

  subscribe(id: string, listener: (session: CallSession) => void): () => void {
    const eventName = "call:" + id;
    this.updates.on(eventName, listener);
    return () => this.updates.off(eventName, listener);
  }

  private runSimulation(
    callId: string,
    scenario: NonNullable<TestCallInput["scenario"]>
  ) {
    this.simulationReplies.set(callId, [SCENARIOS[scenario].transcript]);
    this.after(callId, 100, async (session) => {
      if (session.status === "queued") await this.transition(session, "dialing", "dialing", "Dialing destination", session.destination);
    });
    this.after(callId, 800, async (session) => {
      if (["queued", "dialing"].includes(session.status)) await this.transition(session, "ringing", "ringing", "Phone is ringing", "Caller ID " + session.callerId);
    });
    this.after(callId, 1_650, async (session) => {
      await this.markAnswered(session.id);
    });
  }

  private async advance(
    session: CallSession,
    flow: FlowDefinition,
    nodeId: string,
    result = session.classifierResult,
    visited = new Set<string>()
  ): Promise<void> {
    if (!activeStatuses.has(session.status) || !activeStatuses.has(this.store.getCall(session.id)?.status ?? "ended") || this.terminations.has(session.id) || this.stopping || this.reconciling) return;
    this.incrementTraversal(session);
    if (visited.has(nodeId)) {
      throw new Error("The flow has a loop with no listen or clip boundary.");
    }
    visited.add(nodeId);

    const node = this.nodeFor(flow, nodeId);
    if (!node) throw new Error("The flow references a missing node.");
    session.currentNodeId = node.id;

    if (node.type === "start") {
      const route = this.pickLinearRoute(flow, node.id);
      if (!route) throw new Error("The start node has no route.");
      await this.advance(session, flow, route.target, result, visited);
      return;
    }

    if (node.type === "playClip" || node.type === "retry") {
      if (node.type === "retry") {
        const maxAttempts = node.data.maxAttempts ?? 1;
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("Retry maxAttempts must be from 1 to 10.");
        const attempts = session.retryAttempts ??= {};
        if ((attempts[node.id] ?? 0) >= maxAttempts) {
          const fallback = this.outgoing(flow, node.id).find((edge) => edge.condition?.fallback);
          if (fallback) await this.advance(session, flow, fallback.target, result, visited);
          else await this.finish(session, "ended", "Retry limit reached");
          return;
        }
        attempts[node.id] = (attempts[node.id] ?? 0) + 1;
        await this.persist(session);
      }
      const route = this.pickLinearRoute(flow, node.id);
      if (!route) throw new Error("The clip node has no route.");
      const playbackId = randomUUID();
      this.playbacks.set(session.id, { id: playbackId, target: route.target });
      const clip = await this.playNode(session, node, playbackId);
      if (this.adapter.mode === "simulated") {
        this.after(session.id, this.playbackDelay(clip, "simulated"), async () => {
          await this.enqueue(session.id, () => this.playbackStopped(session.id, playbackId));
        });
      }
      return;
    }

    if (node.type === "listen") {
      await this.enterListening(session, node);
      return;
    }

    if (node.type === "classify" || node.type === "condition") {
      if (!result) throw new Error(node.data.label + " needs a callee transcript before it can route.");
      const route = this.pickRoute(flow, result, node.id, node.data.threshold);
      if (!route) throw new Error("No route matched the classified response.");
      this.recordBranch(session, route, node.id);
      await this.persist(session);
      await this.advance(session, flow, route.target, result, visited);
      return;
    }

    if (node.type === "end") {
      await this.persist(session);
      await this.finish(session, "ended", "Flow completed");
      return;
    }

    throw new Error("Unsupported flow node.");
  }

  private async enterListening(session: CallSession, node: FlowNode) {
    session.listenWindowId = randomUUID();
    await this.transition(
      session,
      "listening",
      "listening",
      "Listening for reply",
      this.adapter.mode === "simulated" ? "Simulator response window" : "Waiting for media gateway transcript",
      node.id
    );
    await this.adapter.startListening?.(session.providerCallId, session.id, session.listenWindowId);
    if (!activeStatuses.has(this.store.getCall(session.id)?.status ?? "ended") || this.terminations.has(session.id)) return;
    const windowId = session.listenWindowId;
    const timeout = node.data.noSpeechTimeoutMs ?? 6000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("Listen timeout must be from 1 to 60000 milliseconds.");
    this.clearListenTimer(session.id);
    const timer = setTimeout(() => {
      void this.enqueue(session.id, () => this.noSpeech(session.id, windowId)).catch((error: unknown) => {
        console.error("No-speech routing failed", { callId: session.id, error });
      });
    }, timeout);
    timer.unref();
    this.listenTimers.set(session.id, timer);
    const transcript = this.simulationReplies.get(session.id)?.shift();
    if (!transcript) return;
    if (this.simulationReplies.get(session.id)?.length === 0) {
      this.simulationReplies.delete(session.id);
    }
    this.after(session.id, 700, async (current) => {
      if (current.status === "listening") {
        await this.submitTranscript(current.id, transcript);
      }
    });
  }

  private async playNode(session: CallSession, node: FlowNode, playbackId: string): Promise<Clip> {
    if (!node.data.clipId) throw new Error(node.data.label + " has no audio clip.");
    const clip = this.store.getClip(node.data.clipId);
    if (!clip || clip.status !== "ready") throw new Error(node.data.label + " needs a ready audio clip.");
    await this.transition(session, "playing", "clip_playing", "Playing " + node.data.label, "Pre-recorded clip", node.id);
    await this.adapter.playClip(session.providerCallId, clip, playbackId);
    return clip;
  }

  private async noSpeech(id: string, windowId: string): Promise<void> {
    const session = this.store.getCall(id);
    if (!session || session.status !== "listening" || session.listenWindowId !== windowId || this.terminations.has(id)) return;
    this.clearListenTimer(id);
    session.listenWindowId = undefined;
    session.status = "classifying";
    await this.persist(session);
    try {
      await this.adapter.stopListening?.(session.providerCallId);
      const flow = this.flowForSession(session);
      const route = flow && this.outgoing(flow, session.currentNodeId!).find((edge) => edge.condition?.fallback);
      if (!flow || !route) throw new Error("No-speech timeout has no fallback route.");
      const result: ClassifierResult = { intent: "unknown", sentiment: "uncertain", confidence: 0, transcript: "", provider: "rules" };
      session.classifierResult = result;
      this.record(session, "branch_selected", "No speech: fallback selected", route.label ?? "Fallback", session.currentNodeId);
      await this.persist(session);
      await this.advance(session, flow, route.target, result);
    } catch (error) {
      await this.finish(session, "failed", error instanceof Error ? error.message : "No-speech routing failed.");
    }
  }

  private clearListenTimer(id: string) {
    clearTimeout(this.listenTimers.get(id));
    this.listenTimers.delete(id);
  }

  private pickLinearRoute(flow: FlowDefinition, sourceId: string): FlowEdge | undefined {
    const outgoing = this.outgoing(flow, sourceId);
    return (
      outgoing.find((edge) => !edge.condition || this.isUnconditional(edge.condition)) ??
      outgoing.find((edge) => edge.condition?.fallback) ??
      outgoing[0]
    );
  }

  private pickRoute(
    flow: FlowDefinition,
    result: ClassifierResult,
    sourceId: string,
    threshold?: number
  ): FlowEdge | undefined {
    const outgoing = this.outgoing(flow, sourceId);
    const matches = outgoing
      .filter((edge) => this.matches(edge.condition, result))
      .sort((left, right) => this.conditionSpecificity(right.condition) - this.conditionSpecificity(left.condition));

    if (threshold !== undefined && result.confidence < threshold) {
      const lowConfidenceRoute = matches.find((edge) => edge.condition?.confidenceBelow !== undefined)
        ?? outgoing.find((edge) => edge.condition?.fallback && edge.condition.confidenceBelow !== undefined)
        ?? outgoing.find((edge) => edge.condition?.fallback);
      if (lowConfidenceRoute) return lowConfidenceRoute;
    }

    return (
      matches.find((edge) => !edge.condition?.fallback) ??
      matches[0] ??
      outgoing.find((edge) => edge.condition?.fallback) ??
      outgoing.find((edge) => !edge.condition || this.isUnconditional(edge.condition))
    );
  }

  private outgoing(flow: FlowDefinition, sourceId: string): FlowEdge[] {
    return flow.edges.filter((edge) => edge.source === sourceId);
  }

  private matches(condition: FlowEdge["condition"], result: ClassifierResult): boolean {
    if (!condition || this.isUnconditional(condition)) return false;
    return (
      (condition.intent === undefined || condition.intent === result.intent) &&
      (condition.sentiment === undefined || condition.sentiment === result.sentiment) &&
      (condition.confidenceBelow === undefined || result.confidence < condition.confidenceBelow)
    );
  }

  private isUnconditional(condition: NonNullable<FlowEdge["condition"]>): boolean {
    return (
      condition.intent === undefined &&
      condition.sentiment === undefined &&
      condition.confidenceBelow === undefined &&
      !condition.fallback
    );
  }

  private conditionSpecificity(condition: FlowEdge["condition"]): number {
    if (!condition) return 0;
    return Number(condition.intent !== undefined) +
      Number(condition.sentiment !== undefined) +
      Number(condition.confidenceBelow !== undefined);
  }

  private recordBranch(session: CallSession, route: FlowEdge, sourceNodeId: string) {
    this.record(
      session,
      "branch_selected",
      "Branch selected: " + (route.label ?? "Fallback"),
      this.describeCondition(route.condition),
      sourceNodeId,
      1
    );
  }

  private describeCondition(condition: FlowEdge["condition"]) {
    if (!condition || this.isUnconditional(condition)) return "Default route";
    const parts = [
      condition.intent,
      condition.sentiment,
      condition.confidenceBelow === undefined ? undefined : "Confidence below " + Math.round(condition.confidenceBelow * 100) + "%",
      condition.fallback && !condition.intent && !condition.sentiment && condition.confidenceBelow === undefined ? "Fallback" : undefined
    ].filter(Boolean);
    return parts.join(" / ");
  }

  private nodeFor(flow: FlowDefinition, id: string | undefined): FlowNode | undefined {
    return flow.nodes.find((node) => node.id === id);
  }

  private flowForSession(session: CallSession): FlowDefinition | undefined {
    return this.flowSnapshots.get(session.id) ?? this.store.getFlowVersion(session.flowId, session.flowVersion);
  }

  private incrementTraversal(session: CallSession) {
    const next = (this.traversalHops.get(session.id) ?? 0) + 1;
    if (next > 64) throw new Error("The flow exceeded its 64-node traversal limit.");
    this.traversalHops.set(session.id, next);
  }

  private after(callId: string, delayMs: number, action: (session: CallSession) => void | Promise<void>) {
    const timer = setTimeout(() => {
      void this.runScheduledAction(callId, action);
    }, delayMs);
    timer.unref();
    const timers = this.schedules.get(callId) ?? [];
    timers.push(timer);
    this.schedules.set(callId, timers);
  }

  private async runScheduledAction(callId: string, action: (session: CallSession) => void | Promise<void>) {
    const session = this.store.getCall(callId);
    if (!session || !activeStatuses.has(session.status)) return;
    try {
      await action(session);
    } catch (error) {
      const current = this.store.getCall(callId);
      if (current && activeStatuses.has(current.status)) {
        try { await this.finish(current, "failed", error instanceof Error ? error.message : "Call automation failed."); }
        catch (hangupError) { console.error("Scheduled call termination failed", { callId, error: hangupError }); }
      }
    }
  }

  private async transition(
    session: CallSession,
    status: CallStatus,
    eventType: CallEventType,
    title: string,
    detail?: string,
    nodeId?: string,
    latencyMs?: number
  ) {
    session.status = status;
    this.record(session, eventType, title, detail, nodeId, latencyMs);
    await this.persist(session);
  }

  private async complete(session: CallSession, status: "ended" | "failed", reason: string): Promise<CallSession> {
    this.cancelSchedule(session.id);
    session.status = status;
    session.endedAt = new Date().toISOString();
    session.listenWindowId = undefined;
    session.endReason = reason;
    this.record(session, status === "failed" ? "error" : "ended", status === "failed" ? "Call failed" : "Call ended", reason);
    await this.persist(session);
    this.cleanupRuntimeState(session.id);
    return session;
  }

  private finish(session: CallSession, status: "ended" | "failed", reason: string): Promise<CallSession> {
    const current = this.store.getCall(session.id) ?? session;
    if (!activeStatuses.has(current.status)) return Promise.resolve(current);
    const existing = this.terminations.get(session.id);
    if (existing) return existing;
    this.cancelSchedule(session.id);
    const operation = (async () => {
      try {
        await this.adapter.hangup(current.providerCallId);
        const latest = this.store.getCall(current.id) ?? current;
        if (!activeStatuses.has(latest.status)) return latest;
        return await this.complete(latest, status, reason);
      } catch (error) {
        const latest = this.store.getCall(current.id) ?? current;
        if (!activeStatuses.has(latest.status)) return latest;
        this.record(latest, "error", "Hangup not confirmed", "Trunk slot retained; retry termination after ESL recovers.");
        await this.persist(latest);
        throw error;
      }
    })();
    this.terminations.set(session.id, operation);
    void operation.then(() => this.terminations.delete(session.id), () => this.terminations.delete(session.id));
    return operation;
  }

  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.operations.get(id) ?? Promise.resolve()).then(action, action);
    this.operations.set(id, next);
    void next.then(() => { if (this.operations.get(id) === next) this.operations.delete(id); },
      () => { if (this.operations.get(id) === next) this.operations.delete(id); });
    return next;
  }

  private async playbackStopped(id: string, playbackId?: string): Promise<void> {
    const session = this.store.getCall(id);
    const playback = this.playbacks.get(id);
    if (!session || session.status !== "playing" || !playback || playback.id !== playbackId || this.terminations.has(id)) return;
    this.playbacks.delete(id);
    const flow = this.flowForSession(session);
    if (!flow) throw new Error("Call flow no longer exists.");
    try { await this.advance(session, flow, playback.target); }
    catch (error) { await this.finish(session, "failed", error instanceof Error ? error.message : "Playback routing failed."); }
  }

  private async handleTelephonyEvent(event: TelephonyEvent): Promise<void> {
    const session = this.store.listCalls().find((call) => call.providerCallId === event.providerCallId);
    if (!session || !activeStatuses.has(session.status)) return;
    if (event.type === "hangup") {
      await this.complete(session, "ended", event.cause ?? "NORMAL_CLEARING");
      return;
    }
    if (this.stopping || this.reconciling) return;
    await this.enqueue(session.id, async () => {
      const current = this.store.getCall(session.id);
      if (!current || !activeStatuses.has(current.status) || this.terminations.has(current.id)) return;
      if (event.type === "answered") await this.answer(current.id);
      else if (event.type === "playbackStopped") await this.playbackStopped(current.id, event.playbackId);
      else if (event.type === "originateFailed") await this.complete(current, "failed", event.cause ?? "ORIGINATE_FAILED");
      else if (event.type === "dialing" && current.status === "queued") await this.transition(current, "dialing", "dialing", "Dialing destination");
      else if (event.type === "ringing" && ["queued", "dialing"].includes(current.status)) await this.transition(current, "ringing", "ringing", "Phone is ringing");
    });
  }

  private cancelSchedule(callId: string) {
    this.clearListenTimer(callId);
    (this.schedules.get(callId) ?? []).forEach((timer) => clearTimeout(timer));
    this.schedules.delete(callId);
  }

  private cleanupRuntimeState(callId: string) {
    this.playbacks.delete(callId);
    this.flowSnapshots.delete(callId);
    this.simulationReplies.delete(callId);
    this.traversalHops.delete(callId);
  }

  private record(
    session: CallSession,
    type: CallEventType,
    title: string,
    detail?: string,
    nodeId?: string,
    latencyMs?: number
  ) {
    const event: CallEvent = {
      id: randomUUID(),
      type,
      title,
      detail,
      nodeId,
      latencyMs,
      timestamp: new Date().toISOString()
    };
    session.events.push(event);
  }

  private async persist(session: CallSession) {
    this.store.saveCall(session);
    await this.store.flush();
    this.publish(this.store.getCall(session.id) ?? session);
  }

  private publish(session: CallSession) {
    this.updates.emit("call:" + session.id, structuredClone(session));
  }
}
