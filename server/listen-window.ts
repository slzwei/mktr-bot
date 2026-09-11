import { ACTIVE_CALL_STATUSES, LISTEN_ENDPOINTING, type CallSession, type CallStatus, type FlowDefinition, type FlowNode } from "../src/lib/domain.js";

/** Reply to GET /api/media/calls/:id/window: what the worker needs before it accepts a call's audio. */
export type ListenWindow = { status: CallStatus; listenWindowId?: string; endpointingMs?: number };

/** Why a listen node's endpointing cannot be used, or undefined when it is unset or within range. */
export function endpointingIssue(node: FlowNode): string | undefined {
  const value = node.data.endpointingMs;
  if (value === undefined || (Number.isSafeInteger(value) && value >= LISTEN_ENDPOINTING.minMs && value <= LISTEN_ENDPOINTING.maxMs)) return undefined;
  return `${node.data.label} needs endpointing from ${LISTEN_ENDPOINTING.minMs} to ${LISTEN_ENDPOINTING.maxMs} milliseconds.`;
}

/** The silence a listen node waits for before its reply is final; the shared default when the node leaves it unset. */
export function listenEndpointingMs(node: FlowNode): number {
  const issue = endpointingIssue(node);
  if (issue) throw new Error(issue);
  return node.data.endpointingMs ?? LISTEN_ENDPOINTING.defaultMs;
}

/** Whether the graph ever listens. A flow that only announces needs no speech stream at all. */
export function flowListens(flow: FlowDefinition | undefined): boolean {
  return Boolean(flow?.nodes.some((node) => node.type === "listen"));
}

/**
 * The endpointing of the first listen node reachable from the start, or undefined when the
 * graph never listens. This is the value the worker opens its speech stream with before any
 * window exists, so the first reply costs no provider handshake. It is only a warm-up: an
 * unusable node value is skipped here and reported when that node's own window opens.
 */
function firstListenEndpointingMs(flow: FlowDefinition | undefined): number | undefined {
  if (!flow) return undefined;
  const queue = [flow.startNodeId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = flow.nodes.find((candidate) => candidate.id === id);
    if (!node) continue;
    if (node.type === "listen") return endpointingIssue(node) ? undefined : node.data.endpointingMs ?? LISTEN_ENDPOINTING.defaultMs;
    for (const edge of flow.edges) if (edge.source === id) queue.push(edge.target);
  }
  return undefined;
}

/** Published versions are immutable, so the stored version is the graph the orchestrator is running. */
export function listenWindow(call: CallSession, flow: FlowDefinition | undefined): ListenWindow {
  if (call.status !== "listening") {
    // One speech stream serves the whole call, so a call between windows still needs an
    // endpointing: the worker opens the provider during playback rather than after it.
    const warmup = ACTIVE_CALL_STATUSES.has(call.status) ? firstListenEndpointingMs(flow) : undefined;
    return { status: call.status, listenWindowId: call.listenWindowId, ...(warmup === undefined ? {} : { endpointingMs: warmup }) };
  }
  const node = flow?.nodes.find((candidate) => candidate.id === call.currentNodeId);
  if (!node || node.type !== "listen") throw new Error(`Call ${call.id} is listening outside a listen node of flow ${call.flowId} v${call.flowVersion}.`);
  return { status: call.status, listenWindowId: call.listenWindowId, endpointingMs: listenEndpointingMs(node) };
}
