import type { CallOutcome, CallSession } from "../src/lib/domain.js";

export type { CallOutcome } from "../src/lib/domain.js";
export type OutcomeCall = CallSession & { campaignId?: string; contactId?: string; outcome?: CallOutcome; recordingFile?: string; recordingExpiresAt?: string };

export function outcomeForCall(reason: string, status: "ended" | "failed", intent?: string): CallOutcome {
  const cause = reason.trim().toUpperCase();
  if (["USER_BUSY", "BUSY_EVERYWHERE"].includes(cause)) return "busy";
  if (["NO_ANSWER", "NO_USER_RESPONSE", "RECOVERY_ON_TIMER_EXPIRE", "PROGRESS_TIMEOUT", "ALLOTTED_TIMEOUT_BEFORE_ANSWER"].includes(cause)) return "no_answer";
  if (cause === "AMD_VOICEMAIL") return "voicemail";
  if (cause === "SERVICE_SHUTDOWN" || cause.startsWith("STOPPED BY ") || cause === "CAMPAIGN_STOPPED") return "stopped";
  if (status === "failed" || !["NORMAL_CLEARING", "FLOW COMPLETED", "RETRY LIMIT REACHED", "ALLOTTED_TIMEOUT", "ORIGINATOR_CANCEL"].includes(cause)) return "failed";
  return ["interested", "not_interested", "callback", "unknown"].includes(intent ?? "") ? intent as CallOutcome : "completed";
}

function csvCell(value: unknown): string {
  const raw = value === undefined || value === null ? "" : String(value);
  // Avoid executing user-controlled names/transcripts when a CSV is opened in a spreadsheet.
  const singleLine = raw.replace(/[\r\n]+/g, " ");
  const safe = /^[\s]*[=+@-]/.test(singleLine) ? `'${singleLine}` : singleLine;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function campaignCsv(calls: OutcomeCall[]): string {
  const headers = ["call_id", "campaign_id", "contact_id", "destination", "caller_id", "flow_id", "flow_version", "created_at", "ended_at", "status", "outcome", "hangup_reason"];
  return [headers.map(csvCell).join(","), ...calls.map((call) => [call.id, call.campaignId, call.contactId, call.destination, call.callerId, call.flowId, call.flowVersion, call.createdAt, call.endedAt, call.status, call.outcome ?? (["ended", "failed"].includes(call.status) ? outcomeForCall(call.endReason ?? "UNKNOWN", call.status as "ended" | "failed", call.classifierResult?.intent) : ""), call.endReason].map(csvCell).join(","))].join("\r\n") + "\r\n";
}
