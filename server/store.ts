import { randomUUID } from "node:crypto";
import type { CallSession, Clip, FlowDefinition, FlowNode } from "../src/lib/domain.js";

const now = () => new Date().toISOString();

const clips: Clip[] = [
  {
    id: "clip-welcome",
    name: "Opening greeting",
    durationSeconds: 7,
    previewUrl: "/demo-clips/welcome.wav",
    format: "wav",
    status: "ready",
    usedBy: 1,
    updatedAt: now(),
    color: "teal"
  },
  {
    id: "clip-interest",
    name: "Interested response",
    durationSeconds: 7,
    previewUrl: "/demo-clips/interest.wav",
    format: "wav",
    status: "ready",
    usedBy: 1,
    updatedAt: now(),
    color: "blue"
  },
  {
    id: "clip-decline",
    name: "Not interested response",
    durationSeconds: 5,
    previewUrl: "/demo-clips/decline.wav",
    format: "wav",
    status: "ready",
    usedBy: 1,
    updatedAt: now(),
    color: "rose"
  },
  {
    id: "clip-callback",
    name: "Callback confirmation",
    durationSeconds: 6,
    previewUrl: "/demo-clips/callback.wav",
    format: "wav",
    status: "ready",
    usedBy: 1,
    updatedAt: now(),
    color: "orange"
  },
  {
    id: "clip-clarify",
    name: "Clarification prompt",
    durationSeconds: 4,
    previewUrl: "/demo-clips/clarify.wav",
    format: "wav",
    status: "ready",
    usedBy: 1,
    updatedAt: now(),
    color: "orange"
  }
];

const flowNodes: FlowNode[] = [
  {
    id: "start",
    type: "start",
    position: { x: 0, y: 260 },
    data: { label: "Start call", description: "Call answered" }
  },
  {
    id: "opening",
    type: "playClip",
    position: { x: 220, y: 260 },
    data: { label: "Opening greeting", clipId: "clip-welcome", description: "7 sec WAV" }
  },
  {
    id: "listen",
    type: "listen",
    position: { x: 455, y: 260 },
    data: { label: "Listen for reply", description: "Endpoint after 750 ms" }
  },
  {
    id: "classify",
    type: "classify",
    position: { x: 700, y: 260 },
    data: { label: "Classify response", threshold: 0.7, description: "Intent + sentiment" }
  },
  {
    id: "interested",
    type: "playClip",
    position: { x: 970, y: 50 },
    data: { label: "Interested response", clipId: "clip-interest", description: "Positive / interested" }
  },
  {
    id: "callback",
    type: "playClip",
    position: { x: 970, y: 210 },
    data: { label: "Callback confirmation", clipId: "clip-callback", description: "Callback requested" }
  },
  {
    id: "decline",
    type: "playClip",
    position: { x: 970, y: 370 },
    data: { label: "Not interested", clipId: "clip-decline", description: "Negative response" }
  },
  {
    id: "retry",
    type: "retry",
    position: { x: 970, y: 530 },
    data: { label: "Clarify once", clipId: "clip-clarify", maxAttempts: 1, description: "Low confidence fallback" }
  },
  {
    id: "end-interest",
    type: "end",
    position: { x: 1245, y: 50 },
    data: { label: "End call" }
  },
  {
    id: "end-callback",
    type: "end",
    position: { x: 1245, y: 210 },
    data: { label: "End call" }
  },
  {
    id: "end-decline",
    type: "end",
    position: { x: 1245, y: 370 },
    data: { label: "End call" }
  },
  {
    id: "end-uncertain",
    type: "end",
    position: { x: 1245, y: 530 },
    data: { label: "End: uncertain" }
  }
];

const initialFlow: FlowDefinition = {
  id: "flow-prospect-intake",
  name: "Prospect qualification",
  version: 3,
  status: "published",
  startNodeId: "start",
  nodes: flowNodes,
  edges: [
    { id: "e-start-opening", source: "start", target: "opening" },
    { id: "e-opening-listen", source: "opening", target: "listen" },
    { id: "e-listen-classify", source: "listen", target: "classify", condition: { fallback: true } },
    {
      id: "e-classify-interested",
      source: "classify",
      target: "interested",
      label: "Interested",
      condition: { intent: "interested", sentiment: "positive" }
    },
    {
      id: "e-classify-callback",
      source: "classify",
      target: "callback",
      label: "Callback",
      condition: { intent: "callback" }
    },
    {
      id: "e-classify-decline",
      source: "classify",
      target: "decline",
      label: "Not interested",
      condition: { intent: "not_interested", sentiment: "negative" }
    },
    {
      id: "e-classify-retry",
      source: "classify",
      target: "retry",
      label: "Low confidence",
      condition: { confidenceBelow: 0.7, fallback: true }
    },
    { id: "e-interested-end", source: "interested", target: "end-interest" },
    { id: "e-callback-end", source: "callback", target: "end-callback" },
    { id: "e-decline-end", source: "decline", target: "end-decline" },
    { id: "e-retry-end", source: "retry", target: "end-uncertain" }
  ],
  updatedAt: now()
};

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryStore {
  private readonly flows = new Map<string, FlowDefinition>([[initialFlow.id, initialFlow]]);
  private readonly clips = new Map<string, Clip>(clips.map((clip) => [clip.id, clip]));
  private readonly calls = new Map<string, CallSession>();

  listFlows(): FlowDefinition[] {
    return Array.from(this.flows.values()).map(clone);
  }

  getFlow(id: string): FlowDefinition | undefined {
    const flow = this.flows.get(id);
    return flow ? clone(flow) : undefined;
  }

  saveFlow(flow: FlowDefinition): FlowDefinition {
    const saved = { ...clone(flow), updatedAt: now() };
    this.flows.set(saved.id, saved);
    this.refreshClipUsage();
    return clone(saved);
  }

  createDraft(name: string): FlowDefinition {
    const source = this.getFlow(initialFlow.id) ?? clone(initialFlow);
    const draft: FlowDefinition = {
      ...source,
      id: randomUUID(),
      name,
      // A draft has no published revision yet. The first publish creates v1.
      version: 0,
      status: "draft",
      nodes: source.nodes.map((node) => ({ ...node, position: { ...node.position } })),
      edges: source.edges.map((edge) => ({ ...edge, condition: edge.condition ? { ...edge.condition } : undefined })),
      updatedAt: now()
    };
    this.flows.set(draft.id, draft);
    this.refreshClipUsage();
    return clone(draft);
  }

  listClips(): Clip[] {
    return Array.from(this.clips.values()).map(clone);
  }

  getClip(id: string): Clip | undefined {
    const clip = this.clips.get(id);
    return clip ? clone(clip) : undefined;
  }

  createClip(
    name: string,
    durationSeconds: number,
    asset?: Pick<Clip, "assetUrl" | "originalFilename" | "format">
  ): Clip {
    const colors: Clip["color"][] = ["teal", "orange", "blue", "rose"];
    const clip: Clip = {
      id: randomUUID(),
      name,
      durationSeconds,
      format: asset?.format ?? "wav",
      status: "ready",
      assetUrl: asset?.assetUrl,
      originalFilename: asset?.originalFilename,
      usedBy: 0,
      updatedAt: now(),
      color: colors[this.clips.size % colors.length]
    };
    this.clips.set(clip.id, clip);
    return clone(clip);
  }

  saveCall(session: CallSession): CallSession {
    this.calls.set(session.id, clone(session));
    return clone(session);
  }

  getCall(id: string): CallSession | undefined {
    const call = this.calls.get(id);
    return call ? clone(call) : undefined;
  }

  listCalls(): CallSession[] {
    return Array.from(this.calls.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  private refreshClipUsage() {
    const usage = new Map<string, number>();
    this.flows.forEach((flow) => {
      flow.nodes.forEach((node) => {
        if (node.data.clipId) usage.set(node.data.clipId, (usage.get(node.data.clipId) ?? 0) + 1);
      });
    });
    this.clips.forEach((clip) => {
      clip.usedBy = usage.get(clip.id) ?? 0;
    });
  }
}
