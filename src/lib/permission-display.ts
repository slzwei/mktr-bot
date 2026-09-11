import type { ContactPermission, DncCheckResult } from "./domain";

export const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function permissionDisplay(permission?: ContactPermission) {
  if (!permission) return { tone: "unknown", label: "Permission unavailable", detail: "Permission status could not be loaded." };
  if (!permission.dialable) return {
    tone: "blocked",
    label: permission.skipReason === "Number is listed on the No Voice Call Register." ? "On the No Voice Call Register" : "No permission",
    detail: permission.skipReason
  };
  // An absent Registry snapshot is not a clean verdict. Keep manual evidence visible
  // without advertising permission that this screen cannot verify.
  if (permission.basis !== "consent" && (!permission.registers || permission.basis !== "dnc")) return {
    tone: "unknown", label: "Permission unverified", detail: "No Registry verdict or recorded consent. Review the evidence before calling."
  };
  if (permission.basis !== "consent" && permission.registers?.noVoiceCall) return {
    tone: "blocked", label: "On the No Voice Call Register", detail: "Number is listed on the No Voice Call Register."
  };
  if (permission.basis === "dnc" && (!permission.clearanceExpiresAt || !Number.isFinite(Date.parse(permission.clearanceExpiresAt)) || Date.parse(permission.clearanceExpiresAt) <= Date.now())) return {
    tone: "blocked", label: "No permission", detail: "Registry clearance has expired or has no recorded expiry."
  };
  if (permission.basis === "dnc" && permission.clearanceExpiresAt && Date.parse(permission.clearanceExpiresAt) - Date.now() <= 3 * 24 * 60 * 60 * 1000) {
    return { tone: "expiring", label: `Dialable · clearance expiring ${new Date(permission.clearanceExpiresAt).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })} Singapore time`, detail: "DNC clearance expires within three days." };
  }
  return { tone: "clear", label: "Dialable", detail: permission.basis === "consent" ? "Recorded voice marketing consent" : "Current Registry clearance" };
}

export function registryOutcome(result: DncCheckResult): string {
  let text = `${countLabel(result.checked, "number")} checked; ${result.cleared} clear; ${result.registered} on the No Voice Call Register; ${result.skippedAlreadyCovered} already covered; ${countLabel(result.skippedNotSingapore, "non-Singapore number")} skipped.`;
  if (result.failure) {
    text += ` ${countLabel(result.failed, "number")} not checked. ${result.failure.message} (${result.failure.statusCode}${result.failure.httpStatus ? `; HTTP ${result.failure.httpStatus}` : ""}).`;
    if (result.failure.billingUncertain) text += ` ${result.submitted} numbers were submitted in this run; the failed batch may have spent credits. Review with the operator before retrying.`;
  }
  return text;
}
