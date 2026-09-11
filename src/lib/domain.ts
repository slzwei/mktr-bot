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
    noSpeechTimeoutMs?: number;
    endpointingMs?: number;
    maxAttempts?: number;
  };
};

/** Silence after the caller stops before the speech provider finalizes a listen node's reply.
 *  The ceiling matches Deepgram's 1000 ms UtteranceEnd fallback, which must not run ahead of the endpoint. */
export const LISTEN_ENDPOINTING = { defaultMs: 300, minMs: 100, maxMs: 1000 } as const;

/** Once the caller is heard saying words, silence is no longer the right thing to time, so the
 *  listen node's no-speech timeout is replaced by this one-shot wait for the finished transcript.
 *  One shot, so a noisy line cannot hold a window open indefinitely. */
export const LISTEN_SPEAKING_GRACE_MS = 12_000;

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
  telephonyAssetUrl?: string;
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

/** A call still running. Everything else is terminal, so the media worker refuses audio for it. */
export const ACTIVE_CALL_STATUSES: ReadonlySet<CallStatus> = new Set<CallStatus>([
  "queued",
  "dialing",
  "ringing",
  "answered",
  "playing",
  "listening",
  "classifying"
]);

export type CallEventType =
  | "inbound_callback"
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

export type CallOutcome = "completed" | "interested" | "not_interested" | "callback" | "unknown" | "busy" | "no_answer" | "failed" | "voicemail" | "stopped" | "inbound_callback";

export type CallSession = {
  id: string;
  providerCallId: string;
  destination: string;
  callerId: CallerId;
  flowId: string;
  flowVersion: number;
  campaignId?: string;
  contactId?: string;
  status: CallStatus;
  currentNodeId?: string;
  createdAt: string;
  endedAt?: string;
  endReason?: string;
  classifierResult?: ClassifierResult;
  listenWindowId?: string;
  lastListenWindowId?: string;
  lastUtteranceId?: string;
  retryAttempts?: Record<string, number>;
  outcome?: CallOutcome;
  recordingFile?: string;
  recordingExpiresAt?: string;
  direction?: "outbound" | "inbound_callback";
  terminationIntent?: { status: "ended" | "failed"; reason: string };
  dialAuthorization?: { basis: "consent" | "dnc"; recordId: string; checkedAt: string };
  events: CallEvent[];
};


export type OutcomeDelivery = {
  id: string;
  callId: string;
  campaignId: string;
  url: string;
  payload: string;
  attempts: number;
  status: "pending" | "delivered" | "failed";
  nextAttemptAt: string;
  createdAt: string;
  deliveredAt?: string;
  lastError?: string;
};

export type OutcomeDeliverySummary = Pick<OutcomeDelivery, "id" | "callId" | "status" | "attempts" | "nextAttemptAt" | "createdAt" | "deliveredAt" | "lastError">;

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

export type OperatorSettings = {
  telephony: {
    mode: TelephonyMode;
    maxConcurrentCalls: number;
    originateTimeoutSeconds: number;
    maxCallSeconds: number;
  };
  classifier: { mode: ClassifierMode; model: string | null };
};

export type TestCallInput = {
  destination: string;
  callerId: CallerId;
  flowId: string;
  flowVersion?: number;
  campaignId?: string;
  contactId?: string;
  scenario?: "interested" | "not_interested" | "callback" | "uncertain";
};

export type DncRegistryEvidence = {
  statusCode: "S000";
  // PDPC's own metadata, null when the Registry omits it. Evidence only — no gate reads
  // these; the binding expiry is the clearance's own checkedAt + 21 days.
  createdTime: string | null;
  validUntil: string | null;
  noVoiceCall: boolean;
  noTextMessage: boolean;
  noFax: boolean;
};

export type DncCheckResult = {
  checked: number;
  cleared: number;
  registered: number;
  skippedAlreadyCovered: number;
  skippedNotSingapore: number;
  failed: number;
  submitted: number;
  failure?: { statusCode: string; httpStatus?: number; message: string; billingUncertain?: boolean };
};

export type ContactImportPreview = {
  imported: number;
  duplicates: number;
  needsCheck: number;
  alreadyCovered: number;
  notSingapore: number;
  credits: number;
  dncEnabled: boolean;
};

export type ContactPermission = {
  phone: string;
  dialable: boolean;
  basis: "consent" | "dnc" | null;
  clearanceExpiresAt: string | null;
  skipReason?: string;
  /** When the evidence behind this permission was obtained: the Registry response
   *  receipt time for a DNC clearance, or the consent time for recorded consent. */
  checkedAt: string | null;
  /** All three PDPC registers from the same paid lookup. ONLY `noVoiceCall` governs
   *  dialling — text or fax registration never blocks a voice call. Null when the
   *  permission came from consent or from a manually entered result with no snapshot. */
  registers: { noVoiceCall: boolean; noTextMessage: boolean; noFax: boolean } | null;
  /** PDPC transaction id for a Registry clearance, or the recorded consent reference. */
  reference: string | null;
};

/** One side of a call, derived from the event timeline — never stored. */
export type TranscriptTurn = {
  at: string;
  role: "agent" | "caller";
  text: string;
  nodeId?: string;
  latencyMs?: number;
};

/** Row projection for the call-history list: no event array, so the list stays light. */
export type CallSummary = {
  id: string;
  destination: string;
  callerId: CallerId;
  contactId?: string;
  contactName?: string;
  campaignId?: string;
  campaignName?: string;
  flowId: string;
  flowVersion: number;
  status: CallStatus;
  outcome?: CallOutcome;
  direction?: "outbound" | "inbound_callback";
  createdAt: string;
  endedAt?: string;
  durationSeconds: number | null;
  endReason?: string;
  hasRecording: boolean;
  transcriptTurns: number;
  dialBasis: "consent" | "dnc" | null;
};

export type CallListPage = { calls: CallSummary[]; nextCursor: string | null; total: number };

export type PermissionSummary = { contacts: ContactPermission[]; dncEnabled: boolean };
export type ContactImportResult = { imported: number; duplicates: number; contacts: Contact[]; dnc?: DncCheckResult };

export type Contact = {
  id: string;
  name: string;
  phone: string;
  createdAt: string;
  updatedAt: string;
};

export type CallingHours = {
  days: number[];
  start: string;
  end: string;
  timeZone: "Asia/Singapore";
};

export type Campaign = {
  id: string;
  name: string;
  flowId: string;
  flowVersion: number;
  callerId: CallerId;
  status: "draft" | "running" | "paused" | "stopped" | "completed";
  callingHours: CallingHours;
  maxAttempts: number;
  retryDelaySeconds: number;
  dialIntervalMs: number;
  lastDialAt?: string;
  lastError?: string;
  outcomeWebhookUrl?: string;
  outcomeWebhookEnabledAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CampaignContact = {
  id: string;
  campaignId: string;
  contactId: string;
  ordinal: number;
  status: "pending" | "dialing" | "completed" | "skipped";
  attempts: number;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  lastCallId?: string;
  outcome?: string;
  skipReason?: string;
  lastError?: string;
};

export type CampaignDetail = Campaign & {
  withinCallingHours: boolean;
  progress: { total: number; pending: number; dialing: number; completed: number; skipped: number };
  contacts: (CampaignContact & { contact: Contact })[];
};

export type CampaignInput = Pick<Campaign, "name" | "flowId" | "callerId"> & {
  flowVersion?: number;
  contactIds: string[];
  callingHours?: CallingHours;
  maxAttempts?: number;
  retryDelaySeconds?: number;
  dialIntervalMs?: number;
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
