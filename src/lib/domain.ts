export const RESERVED_CALLER_ID = "+6562773210";

export const CALLER_IDS = [
  "+6562773211",
  "+6562773212",
  "+6562773213",
  "+6562773214",
  "+6562773215",
  "+6562773216",
  "+6562773217",
  "+6562773218",
  "+6562773219"
] as const;

export type CallerId = (typeof CALLER_IDS)[number];

export type FlowNodeKind =
  | "start"
  | "playClip"
  | "listen"
  | "classify"
  | "condition"
  | "retry"
  | "end";

export type FlowNode = {
  id: string;
  type: FlowNodeKind;
  position: { x: number; y: number };
  data: {
    label: string;
    clipId?: string;
    prompt?: string;
    threshold?: number;
    description?: string;
  };
};

export type BranchCondition = {
  intent?: string;
  sentiment?: "positive" | "neutral" | "negative" | "uncertain";
  confidenceBelow?: number;
  fallback?: boolean;
};

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  condition?: BranchCondition;
};

export type FlowDefinition = {
  id: string;
  name: string;
  version: number;
  status: "draft" | "published";
  startNodeId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  updatedAt: string;
};

export type Clip = {
  id: string;
  name: string;
  durationSeconds: number;
  format: "wav" | "mp3";
  status: "ready" | "processing" | "archived";
  assetUrl?: string;
  previewUrl?: string;
  originalFilename?: string;
  usedBy: number;
  updatedAt: string;
  color: "teal" | "orange" | "blue" | "rose";
};

export type ClassifierResult = {
  intent: string;
  sentiment: "positive" | "neutral" | "negative" | "uncertain";
  confidence: number;
  transcript: string;
  provider?: "rules" | "openai";
};

export type CallStatus =
  | "queued"
  | "dialing"
  | "ringing"
  | "answered"
  | "playing"
  | "listening"
  | "classifying"
  | "ended"
  | "failed";

export type CallEventType =
  | "queued"
  | "dialing"
  | "ringing"
  | "answered"
  | "clip_playing"
  | "listening"
  | "transcript_final"
  | "classified"
  | "branch_selected"
  | "ended"
  | "error";

export type CallEvent = {
  id: string;
  type: CallEventType;
  timestamp: string;
  title: string;
  detail?: string;
  nodeId?: string;
  latencyMs?: number;
};

export type CallSession = {
  id: string;
  providerCallId: string;
  destination: string;
  callerId: CallerId;
  flowId: string;
  flowVersion: number;
  status: CallStatus;
  currentNodeId?: string;
  createdAt: string;
  endedAt?: string;
  endReason?: string;
  classifierResult?: ClassifierResult;
  listenWindowId?: string;
  lastListenWindowId?: string;
  lastUtteranceId?: string;
  events: CallEvent[];
};

export type TelephonyMode = "simulated" | "freeswitch";
export type ClassifierMode = "rules" | "openai";

export type TrunkStatus = {
  mode: TelephonyMode;
  available: boolean;
  configured: boolean;
  trunkUsername: string;
  endpoint: string;
  signalingPort: number;
  codecs: string[];
  media: string;
  maxConcurrentCalls: number;
  activeCalls: number;
  classifierMode: ClassifierMode;
  callerIds: readonly CallerId[];
  reservedCallerId: string;
};

export type BootstrapData = {
  flows: FlowDefinition[];
  clips: Clip[];
  calls: CallSession[];
  trunk: TrunkStatus;
};

export type TestCallInput = {
  destination: string;
  callerId: CallerId;
  flowId: string;
  scenario?: "interested" | "not_interested" | "callback" | "uncertain";
};

export const SCENARIOS: Record<
  NonNullable<TestCallInput["scenario"]>,
  ClassifierResult
> = {
  interested: {
    intent: "interested",
    sentiment: "positive",
    confidence: 0.94,
    transcript: "Yes, I would like to hear more about that."
  },
  not_interested: {
    intent: "not_interested",
    sentiment: "negative",
    confidence: 0.92,
    transcript: "No thanks, I am not interested."
  },
  callback: {
    intent: "callback",
    sentiment: "neutral",
    confidence: 0.87,
    transcript: "Could you call me back tomorrow afternoon?"
  },
  uncertain: {
    intent: "unknown",
    sentiment: "uncertain",
    confidence: 0.42,
    transcript: "Sorry, can you say that again?"
  }
};

export function isCallerId(value: string): value is CallerId {
  return (CALLER_IDS as readonly string[]).includes(value);
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function formatPhoneNumber(value: string): string {
  if (/^\+656277\d{4}$/.test(value)) {
    return `${value.slice(0, 3)} ${value.slice(3, 7)} ${value.slice(7)}`;
  }
  return value;
}
