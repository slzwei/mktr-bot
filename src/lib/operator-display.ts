import type { CallOutcome, CallStatus } from "./domain";

export const singaporeDateTime = (value: string) => new Date(value).toLocaleString("en-SG", { timeZone: "Asia/Singapore" });
export const singaporeDate = (value: string) => new Date(value).toLocaleDateString("en-SG", { timeZone: "Asia/Singapore", day: "2-digit", month: "short", year: "numeric" });
export const singaporeTime = (value: string) => new Date(value).toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const isCallInProgress = (status: CallStatus) => status !== "ended" && status !== "failed";
export const basisLabel = (basis: "consent" | "dnc" | null | undefined) => basis === "consent" ? "Recorded consent" : basis === "dnc" ? "DNC clearance" : "Not recorded";

export const outcomeLabels: Record<CallOutcome, string> = {
  completed: "Completed", interested: "Interested", not_interested: "Not interested", callback: "Callback requested",
  unknown: "Unresolved", busy: "Busy", no_answer: "No answer", failed: "Failed", voicemail: "Voicemail",
  stopped: "Stopped", inbound_callback: "Inbound callback"
};
export const statusLabels: Record<CallStatus, string> = {
  queued: "Queued", dialing: "Dialing", ringing: "Ringing", answered: "Answered", playing: "Playing",
  listening: "Listening", classifying: "Classifying", ended: "Ended", failed: "Failed"
};
