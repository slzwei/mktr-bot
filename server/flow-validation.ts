import type { Clip, FlowDefinition, FlowNode } from "../src/lib/domain.js";

export type FlowValidationResult = {
  valid: boolean;
  errors: string[];
};

const requiresFallback = (node: FlowNode) => node.type === "listen" || node.type === "classify";

export function validateFlow(flow: FlowDefinition, clips: Clip[]): FlowValidationResult {
  const errors: string[] = [];
  const nodeIds = new Set(flow.nodes.map((node) => node.id));
  const clipIds = new Set(clips.filter((clip) => clip.status === "ready").map((clip) => clip.id));
  const start = flow.nodes.find((node) => node.id === flow.startNodeId);

  if (!start || start.type !== "start") errors.push("A flow needs one valid start node.");

  for (const edge of flow.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      errors.push(`Connection ${edge.id} references a missing node.`);
    }
  }

  for (const node of flow.nodes) {
    if (["playClip", "retry"].includes(node.type) && (!node.data.clipId || !clipIds.has(node.data.clipId))) {
      errors.push(`${node.data.label} needs a ready audio clip.`);
    }

    const outgoing = flow.edges.filter((edge) => edge.source === node.id);
    if (node.type !== "end" && outgoing.length === 0) {
      errors.push(`${node.data.label} has no outgoing connection.`);
    }

    if (requiresFallback(node) && !outgoing.some((edge) => edge.condition?.fallback)) {
      errors.push(`${node.data.label} needs a fallback route.`);
    }
  }

  if (start) {
    const reachable = new Set<string>();
    const queue = [start.id];
    while (queue.length) {
      const id = queue.shift();
      if (!id || reachable.has(id)) continue;
      reachable.add(id);
      flow.edges.filter((edge) => edge.source === id).forEach((edge) => queue.push(edge.target));
    }
    flow.nodes
      .filter((node) => !reachable.has(node.id))
      .forEach((node) => errors.push(`${node.data.label} is unreachable.`));
  }

  return { valid: errors.length === 0, errors };
}
