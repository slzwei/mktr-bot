import { HttpError } from "./http-error.js";

export type ConsentRecord = {
  id: string; phone: string; source: string; consentedAt: string; recordedAt: string;
  purpose: "voice_marketing"; revokedAt?: string;
};
export type DncClearance = {
  id: string; phone: string; checkedAt: string; recordedAt: string;
  cleared: boolean; source: string; reference: string;
};
export type DialAuthorization = { basis: "consent" | "dnc"; recordId: string; checkedAt: string };
export interface DialPermissionStore {
  getConsent(phone: string): ConsentRecord | undefined;
  getDncClearance(phone: string): DncClearance | undefined;
}
export interface DialPolicy { authorize(phone: string): DialAuthorization; }
export class DialConsentError extends HttpError {
  readonly code = "DIAL_NOT_PERMITTED";
  constructor(readonly skipReason: string) { super(409, skipReason); }
}
// PDPC reduced the validity period to 21 days in February 2021.
export const DNC_VALIDITY_MS = 21 * 24 * 60 * 60 * 1000;
export class ConsentPolicy implements DialPolicy {
  constructor(private readonly store: DialPermissionStore, private readonly now: () => Date = () => new Date()) {}
  authorize(phone: string): DialAuthorization {
    const now = this.now(); const timestamp = now.getTime();
    const consent = this.store.getConsent(phone);
    if (consent?.revokedAt) throw new DialConsentError("Contact opted out of marketing voice calls.");
    if (consent && consent.phone === phone && consent.purpose === "voice_marketing" && consent.source.trim()
      && Number.isFinite(Date.parse(consent.consentedAt)) && Date.parse(consent.consentedAt) <= timestamp) {
      return { basis: "consent", recordId: consent.id, checkedAt: now.toISOString() };
    }
    const dnc = this.store.getDncClearance(phone);
    if (!dnc) throw new DialConsentError("No recorded voice consent or fresh DNC clearance.");
    if (!dnc.cleared) throw new DialConsentError("Number is listed on the No Voice Call Register.");
    const age = timestamp - Date.parse(dnc.checkedAt);
    if (!Number.isFinite(age) || age < 0 || age >= DNC_VALIDITY_MS) throw new DialConsentError("DNC clearance expired; a new Registry check is required after 21 days.");
    if (!/^\+65\d{8}$/.test(phone) || dnc.phone !== phone || !dnc.source.trim() || !dnc.reference.trim()) {
      throw new DialConsentError("A verifiable Singapore voice DNC clearance or recorded consent is required.");
    }
    return { basis: "dnc", recordId: dnc.id, checkedAt: now.toISOString() };
  }
}

export function isVoiceOptOut(transcript: string): boolean {
  const text = transcript.toLowerCase().replace(/[’']/g, "").replace(/[.!?,]/g, " ").replace(/\s+/g, " ").trim();
  return /\b(?:stop calling|dont call me (?:back|again)|do not call me (?:back|again)|remove me|unsubscribe|no (?:more|further) calls)\b/.test(text)
    || /^(?:please )?(?:dont|do not) call me(?: please)?$/.test(text);
}
