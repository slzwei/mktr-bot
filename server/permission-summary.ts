import type { ContactPermission, DncRegistryEvidence } from "../src/lib/domain.js";
import { ConsentPolicy, DialConsentError, DNC_VALIDITY_MS, type DialPermissionStore } from "./compliance.js";

/**
 * One PDPC lookup bills once and returns all three registers, so withholding the text
 * and fax verdicts throws away data already paid for. Only `noVoiceCall` governs
 * dialling — `ConsentPolicy` is still the single authority on that, and this function
 * reads it rather than re-deriving permission.
 */
function registersFrom(clearance: unknown): ContactPermission["registers"] {
  const evidence = (clearance as { evidence?: Partial<DncRegistryEvidence> } | undefined)?.evidence;
  if (!evidence || typeof evidence.noVoiceCall !== "boolean") return null;
  return {
    noVoiceCall: evidence.noVoiceCall,
    noTextMessage: evidence.noTextMessage === true,
    noFax: evidence.noFax === true,
  };
}

/** Read the same policy as the dial gate; no alternative authorization logic. */
export function permissionSummary(store: DialPermissionStore, phones: string[], date = new Date()): ContactPermission[] {
  const policy = new ConsentPolicy(store, () => date);
  return phones.map((phone) => {
    const clearance = store.getDncClearance(phone);
    const consent = store.getConsent(phone);
    const checkedAtMs = Date.parse(clearance?.checkedAt ?? "");
    const clearanceExpiresAt = Number.isFinite(checkedAtMs) ? new Date(checkedAtMs + DNC_VALIDITY_MS).toISOString() : null;
    const registers = registersFrom(clearance);

    try {
      const basis = policy.authorize(phone).basis;
      // The evidence shown is the evidence the gate actually relied on.
      return {
        phone,
        dialable: true,
        basis,
        clearanceExpiresAt,
        checkedAt: basis === "consent" ? consent?.consentedAt ?? null : clearance?.checkedAt ?? null,
        registers: basis === "consent" ? null : registers,
        reference: basis === "consent" ? consent?.source ?? null : clearance?.reference ?? null,
      };
    } catch (error) {
      if (!(error instanceof DialConsentError)) throw error;
      // Blocked contacts still show their registers: a number on the No Voice Call
      // Register was paid for like any other, and the operator needs to see why.
      return {
        phone,
        dialable: false,
        basis: null,
        clearanceExpiresAt,
        skipReason: error.skipReason,
        checkedAt: clearance?.checkedAt ?? null,
        registers,
        reference: clearance?.reference ?? null,
      };
    }
  });
}
