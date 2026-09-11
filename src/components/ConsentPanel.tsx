import { useState, type FormEvent } from "react";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { api, type VoicePermission } from "../lib/api";
import "./consent.css";

type EvidenceType = "consent" | "dnc" | "opt-out";
const singaporeDate = (value: string) => new Date(value).toLocaleString("en-SG", { timeZone: "Asia/Singapore" });

function evidenceTimestamp(value: string): string {
  // The form explicitly asks for Singapore time; the operator's browser may use another zone.
  const date = new Date(`${value}+08:00`);
  if (!value || !Number.isFinite(date.getTime())) throw new Error("Enter the actual evidence date and time in Singapore time.");
  if (date.getTime() > Date.now()) throw new Error("Evidence date and time cannot be in the future.");
  return date.toISOString();
}

export function ConsentPanel() {
  const [phone, setPhone] = useState("");
  const [kind, setKind] = useState<EvidenceType>("consent");
  const [source, setSource] = useState("");
  const [reference, setReference] = useState("");
  const [timestamp, setTimestamp] = useState("");
  const [dncResult, setDncResult] = useState("");
  const [permission, setPermission] = useState<VoicePermission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const run = async (action: (number: string) => Promise<void>) => {
    setBusy(true); setError(""); setNotice(""); setPermission(null);
    try {
      const number = phone.trim();
      if (!/^\+[1-9]\d{7,14}$/.test(number)) throw new Error("Enter a phone number with its country code, for example +6591234567.");
      await action(number);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update voice call permission.");
    } finally { setBusy(false); }
  };

  const check = () => run(async (number) => { setPermission(await api.voicePermission(number)); });
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(async (number) => {
      if (reference.trim().length < 3) throw new Error("Enter a retrievable evidence reference with at least three characters.");
      if (kind === "dnc") {
        if (!/^\+65\d{8}$/.test(number)) throw new Error("A Singapore DNC result requires a +65 number with eight local digits.");
        if (!dncResult) throw new Error("Select the actual result returned by the DNC Registry.");
        await api.recordDncResult({ phone: number, checkedAt: evidenceTimestamp(timestamp), cleared: dncResult === "clear", source: "Singapore DNC Registry", reference: reference.trim() });
      } else {
        if (source.trim().length < 3) throw new Error("Enter the evidence source with at least three characters.");
        const evidence = `${source.trim()} — ${reference.trim()}`;
        if (kind === "consent") await api.recordVoiceConsent({ phone: number, source: evidence, consentedAt: evidenceTimestamp(timestamp), purpose: "voice_marketing" });
        else await api.recordVoiceOptOut({ phone: number, source: evidence });
      }
      setPermission(await api.voicePermission(number));
      setNotice(kind === "opt-out" ? "Opt-out recorded. This number is blocked from marketing voice calls." : "Evidence saved. Permission has been checked again.");
    });
  };

  return <section className="campaign-card consent-panel" aria-labelledby="consent-heading">
    <h2 id="consent-heading"><ShieldCheck size={18} /> Voice call permission</h2>
    <p>Record the evidence for each number before starting a campaign. Importing a contact does not record permission.</p>
    <form onSubmit={save}>
      <div className="consent-phone-row">
        <label>Permission phone number<input type="tel" autoComplete="tel" required pattern="\+[1-9][0-9]{7,14}" maxLength={16} value={phone} disabled={busy} placeholder="+6591234567" onChange={(event) => { setPhone(event.target.value); setPermission(null); setError(""); setNotice(""); }} /></label>
        <button type="button" className="secondary-button" disabled={busy || !phone.trim()} onClick={() => { void check(); }}>Check permission</button>
      </div>
      <div className="campaign-fields">
        <label>Evidence type<select value={kind} disabled={busy} onChange={(event) => { setKind(event.target.value as EvidenceType); setSource(""); setReference(""); setTimestamp(""); setDncResult(""); setError(""); setNotice(""); }}><option value="consent">Consent to marketing voice calls</option><option value="dnc">DNC Registry result</option><option value="opt-out">Opt-out of marketing voice calls</option></select></label>
        <label>Evidence source{kind === "dnc" ? <input value="Singapore DNC Registry" readOnly /> : <input required minLength={3} maxLength={200} value={source} disabled={busy} placeholder={kind === "consent" ? "Signed voice marketing consent form" : "Customer opt-out request"} onChange={(event) => setSource(event.target.value)} />}</label>
        <label>Evidence reference<input required minLength={3} maxLength={280} value={reference} disabled={busy} placeholder={kind === "dnc" ? "Registry result reference or saved result location" : "Retrievable form, message or request reference"} onChange={(event) => setReference(event.target.value)} /></label>
        {kind !== "opt-out" && <label>{kind === "consent" ? "Consent date and time (Singapore)" : "Registry check date and time (Singapore)"}<input type="datetime-local" required step={60} value={timestamp} disabled={busy} onChange={(event) => setTimestamp(event.target.value)} /></label>}
        {kind === "dnc" && <label>No Voice Call Register result<select required value={dncResult} disabled={busy} onChange={(event) => setDncResult(event.target.value)}><option value="">Select the Registry result</option><option value="clear">Clear — number is not listed</option><option value="listed">Listed — do not call</option></select></label>}
      </div>
      <p className="consent-help">Keep a retrievable reference to the original evidence. {kind === "consent" ? "Enter when consent to voice marketing was actually given, not when you are entering this record." : kind === "dnc" ? "Enter when the Registry check actually ran. DNC clearance is valid for 21 days from that check." : "The opt-out takes effect when saved, with the recording time kept automatically."}</p>
      <button type="submit" className="primary-button" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}{kind === "opt-out" ? "Record opt-out" : kind === "dnc" ? "Save DNC result" : "Save voice consent"}</button>
    </form>
    {error && <p className="campaign-message campaign-message--error" role="alert">{error}</p>}
    {notice && <p className="campaign-message" role="status">{notice}</p>}
    {permission && <div className={`consent-result${permission.allowed ? "" : " consent-result--blocked"}`} role="status">
      <strong>{permission.phone}: {permission.allowed ? "Permitted by recorded evidence" : "Blocked from marketing voice calls"}</strong>
      <p>{permission.allowed ? permission.basis === "consent" ? "Permission basis: recorded voice marketing consent." : "Permission basis: current DNC Registry clearance." : `Skip reason: ${permission.skipReason ?? "No current permission evidence."}`}</p>
      {permission.consent && <p>Consent evidence: {permission.consent.source}<br />{permission.consent.revokedAt ? `Opt-out recorded: ${singaporeDate(permission.consent.revokedAt)}` : `Consent given: ${singaporeDate(permission.consent.consentedAt)}`} Singapore time.</p>}
      {permission.dnc && <p>DNC result: {permission.dnc.cleared ? "clear" : "listed"} · {permission.dnc.reference}<br />Checked: {singaporeDate(permission.dnc.checkedAt)} Singapore time.</p>}
    </div>}
  </section>;
}
