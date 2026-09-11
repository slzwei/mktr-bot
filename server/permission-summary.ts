import type { ContactPermission } from "../src/lib/domain.js";
import { ConsentPolicy, DialConsentError, DNC_VALIDITY_MS, type DialPermissionStore } from "./compliance.js";

/** Read the same policy as the dial gate; no alternative authorization logic. */
export function permissionSummary(store: DialPermissionStore, phones: string[], date = new Date()): ContactPermission[] {
  const policy = new ConsentPolicy(store, () => date);
  return phones.map((phone) => {
    const checkedAt = Date.parse(store.getDncClearance(phone)?.checkedAt ?? "");
    const clearanceExpiresAt = Number.isFinite(checkedAt) ? new Date(checkedAt + DNC_VALIDITY_MS).toISOString() : null;
    try { return { phone, dialable: true, basis: policy.authorize(phone).basis, clearanceExpiresAt }; }
    catch (error) {
      if (!(error instanceof DialConsentError)) throw error;
      return { phone, dialable: false, basis: null, clearanceExpiresAt, skipReason: error.skipReason };
    }
  });
}
