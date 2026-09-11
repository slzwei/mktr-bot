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
import { InMemoryStore } from "./store.js";
import { assertAllowedCallerId, type TelephonyAdapter } from "./telephony.js";

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

  constructor(
    private readonly store: InMemoryStore,
    private readonly adapter: TelephonyAdapter,
    private readonly classifier: TranscriptClassifier = createTranscriptClassifier(),
    private readonly playbackDelay: PlaybackDelay = defaultPlaybackDelay
  ) {}

  activeCallCount(): number {
    return this.store.listCalls().filter((call) => activeStatuses.has(call.status)).length;
  }

  async start(input: TestCallInput): Promise<CallSession> {
    assertAllowedCallerId(input.callerId);
    if (!/^\+[1-9]\d{7,14}$/.test(input.destination)) {
      throw new Error("Destination must use E.164 format, for example +6591234567.");
    }
    if (this.activeCallCount() + this.pendingStarts >= config.maxConcurrentCalls) {
      throw new Error("The Singtel trunk is at its " + config.maxConcurrentCalls + "-call limit.");
    }
    this.pendingStarts += 1;

    try {
      const flow = this.store.getFlow(input.flowId);
      if (!flow) throw new Error("Selected flow no longer exists.");
      if (flow.status !== "published") throw new Error("Publish the flow before starting a call.");

      const provider = await this.adapter.originate(input);
      const session: CallSession = {
        id: randomUUID(),
        providerCallId: provider.providerCallId,
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
      this.store.saveCall(session);
      this.publish(session);
      if (this.adapter.mode === "simulated") {
        this.runSimulation(session.id, input.scenario ?? "interested");
      }
      return session;
    } finally {
      this.pendingStarts -= 1;
    }
  }

  async stop(id: string, reason = "Stopped by operator"): Promise<CallSession> {
    const session = this.store.getCall(id);
    if (!session) throw new Error("Call not found.");
    if (!activeStatuses.has(session.status)) return session;
    this.cancelSchedule(id);
    await this.adapter.hangup(session.providerCallId);
    this.end(session, reason);
    return session;
  }

  get(id: string): CallSession | undefined {
    return this.store.getCall(id);
  }

  async markAnswered(id: string): Promise<CallSession> {
    const session = this.store.getCall(id);
    if (!session) throw new Error("Call not found.");
    if (!activeStatuses.has(session.status)) return session;
    if (["answered", "playing", "listening", "classifying"].includes(session.status)) {
      return session;
    }
    const flow = this.flowForSession(session);
    if (!flow) throw new Error("Call flow no longer exists.");

    try {
      this.traversalHops.set(session.id, 0);
      this.transition(session, "answered", "answered", "Call answered");
      await this.advance(session, flow, flow.startNodeId);
      return this.store.getCall(id) ?? session;
    } catch (error) {
      this.fail(session, error instanceof Error ? error.message : "Call automation failed.");
      throw error;
    }
  }

  async submitTranscript(id: string, transcript: string): Promise<CallSession> {
    const session = this.store.getCall(id);
    if (!session) throw new Error("Call not found.");
    if (session.status !== "listening") throw new Error("The call is not waiting for a callee response.");
    const flow = this.flowForSession(session);
    if (!flow) throw new Error("Call flow no longer exists.");
    const listeningNode = this.nodeFor(flow, session.currentNodeId);
    if (!listeningNode || listeningNode.type !== "listen") {
      throw new Error("The call is not currently positioned at a listen node.");
    }

    try {
      this.record(session, "transcript_final", "Transcript final", transcript, listeningNode.id, 78);
      this.persist(session);

      const startedAt = performance.now();
      const result = await this.classifier.classify(transcript);
      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
      session.classifierResult = result;
      this.transition(
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
        this.persist(session);
      }

      this.traversalHops.set(session.id, 0);
      await this.advance(session, flow, route.target, result);
      return this.store.getCall(id) ?? session;
    } catch (error) {
      this.fail(session, error instanceof Error ? error.message : "Call automation failed.");
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
    this.after(callId, 100, (session) => {
      this.transition(session, "dialing", "dialing", "Dialing destination", session.destination);
    });
    this.after(callId, 800, (session) => {
      this.transition(session, "ringing", "ringing", "Phone is ringing", "Caller ID " + session.callerId);
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
    if (!activeStatuses.has(session.status)) return;
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
      const clip = await this.playNode(session, node);
      const route = this.pickLinearRoute(flow, node.id);
      if (!route) {
        this.end(session, "Flow completed");
        return;
      }
      this.after(session.id, this.playbackDelay(clip, this.adapter.mode), async (current) => {
        const snapshot = this.flowForSession(current);
        if (!snapshot) throw new Error("Call flow no longer exists.");
        await this.advance(current, snapshot, route.target, current.classifierResult);
      });
      return;
    }

    if (node.type === "listen") {
      this.enterListening(session, node);
      return;
    }

    if (node.type === "classify" || node.type === "condition") {
      if (!result) throw new Error(node.data.label + " needs a callee transcript before it can route.");
      const route = this.pickRoute(flow, result, node.id, node.data.threshold);
      if (!route) throw new Error("No route matched the classified response.");
      this.recordBranch(session, route, node.id);
      this.persist(session);
      await this.advance(session, flow, route.target, result, visited);
      return;
    }

    if (node.type === "end") {
      this.end(session, "Flow completed");
      return;
    }

    throw new Error("Unsupported flow node.");
  }

  private enterListening(session: CallSession, node: FlowNode) {
    this.transition(
      session,
      "listening",
      "listening",
      "Listening for reply",
      this.adapter.mode === "simulated" ? "Simulator response window" : "Waiting for media gateway transcript",
      node.id
    );
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

  private async playNode(session: CallSession, node: FlowNode): Promise<Clip> {
    if (!node.data.clipId) throw new Error(node.data.label + " has no audio clip.");
    const clip = this.store.getClip(node.data.clipId);
    if (!clip || clip.status !== "ready") throw new Error(node.data.label + " needs a ready audio clip.");
    this.transition(session, "playing", "clip_playing", "Playing " + node.data.label, "Pre-recorded clip", node.id);
    await this.adapter.playClip(session.providerCallId, clip);
    return clip;
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
    return this.flowSnapshots.get(session.id) ?? this.store.getFlow(session.flowId);
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
        this.fail(current, error instanceof Error ? error.message : "Call automation failed.");
      }
    }
  }

  private transition(
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
    this.persist(session);
  }

  private end(session: CallSession, reason: string) {
    this.cancelSchedule(session.id);
    session.status = "ended";
    session.endedAt = new Date().toISOString();
    session.endReason = reason;
    this.record(session, "ended", "Call ended", reason);
    this.persist(session);
    this.cleanupRuntimeState(session.id);
  }

  private fail(session: CallSession, reason: string) {
    const current = this.store.getCall(session.id);
    if (current && !activeStatuses.has(current.status)) return;
    this.cancelSchedule(session.id);
    session.status = "failed";
    session.endedAt = new Date().toISOString();
    session.endReason = reason;
    this.record(session, "error", "Call failed", reason);
    this.persist(session);
    this.cleanupRuntimeState(session.id);
  }

  private cancelSchedule(callId: string) {
    (this.schedules.get(callId) ?? []).forEach((timer) => clearTimeout(timer));
    this.schedules.delete(callId);
  }

  private cleanupRuntimeState(callId: string) {
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

  private persist(session: CallSession) {
    this.store.saveCall(session);
    this.publish(session);
  }

  private publish(session: CallSession) {
    this.updates.emit("call:" + session.id, structuredClone(session));
  }
}
