import { LISTEN_ENDPOINTING, type CallSession, type CallStatus, type FlowDefinition, type FlowNode } from "../src/lib/domain.js";

/** Reply to GET /api/media/calls/:id/window: what the worker needs before it opens a provider socket. */
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

/** Published versions are immutable, so the stored version is the graph the orchestrator is running. */
export function listenWindow(call: CallSession, flow: FlowDefinition | undefined): ListenWindow {
  if (call.status !== "listening") return { status: call.status, listenWindowId: call.listenWindowId };
  const node = flow?.nodes.find((candidate) => candidate.id === call.currentNodeId);
  if (!node || node.type !== "listen") throw new Error(`Call ${call.id} is listening outside a listen node of flow ${call.flowId} v${call.flowVersion}.`);
  return { status: call.status, listenWindowId: call.listenWindowId, endpointingMs: listenEndpointingMs(node) };
}
