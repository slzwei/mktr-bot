import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Pause, Play, Plus, Square, Users } from "lucide-react";
import { api } from "../lib/api";
import { CALLER_IDS, type CallingHours, type CampaignDetail, type Contact, type ContactImportPreview, type ContactPermission, type FlowDefinition } from "../lib/domain";
import { countLabel, permissionDisplay, registryOutcome } from "../lib/permission-display";
import { ConsentPanel } from "./ConsentPanel";
import "./campaigns.css";
import { CampaignOutcomes } from "./CampaignOutcomes";

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const message = (error: unknown) => error instanceof Error ? error.message : "Could not update the campaign.";

export function CampaignsPanel({ flows, canManageWebhooks = false }: { flows: FlowDefinition[]; canManageWebhooks?: boolean }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignDetail[]>([]);
  const [selected, setSelected] = useState("");
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<{ csv: string; result: ContactImportPreview } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [permissions, setPermissions] = useState<Record<string, ContactPermission>>({});
  const [dncEnabled, setDncEnabled] = useState(false);
  const inputVersion = useRef(0);
  const importRunning = useRef(false);
  const [name, setName] = useState("");
  const [flowId, setFlowId] = useState(flows.find((flow) => flow.status === "published")?.id ?? "");
  const [callerId, setCallerId] = useState<(typeof CALLER_IDS)[number]>(CALLER_IDS[0]);
  const [hours, setHours] = useState<CallingHours>({ days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "20:00", timeZone: "Asia/Singapore" });
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [retryDelay, setRetryDelay] = useState(60);
  const [dialInterval, setDialInterval] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = campaigns.find((campaign) => campaign.id === selected);
  const refresh = useCallback(async () => {
    try {
      const [list, summary] = await Promise.all([api.campaigns(), api.permissionSummary()]);
      setCampaigns(list);
      setPermissions(Object.fromEntries(summary.contacts.map((entry) => [entry.phone, entry])));
      setDncEnabled(summary.dncEnabled);
      setSelected((current) => current || list[0]?.id || "");
    } catch (failure) { setPermissions({}); throw failure; }
  }, []);
  useEffect(() => {
    let disposed = false;
    void api.contacts().then((list) => { if (!disposed) { setContacts(list); setContactIds(list.map((contact) => contact.id)); } }).catch((failure) => { if (!disposed) setError(message(failure)); });
    void refresh().catch((failure) => { if (!disposed) setError(message(failure)); });
    const timer = setInterval(() => { void refresh().catch((failure) => { if (!disposed) setError(message(failure)); }); }, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    setPreview(null);
    if (!csv.trim()) { setPreviewBusy(false); return; }
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      void api.previewContacts(csv).then((result) => {
        if (!disposed) { setPreview({ csv, result }); setError(""); }
      }).catch((failure) => { if (!disposed) setError(message(failure)); })
        .finally(() => { if (!disposed) setPreviewBusy(false); });
    }, 300);
    return () => { disposed = true; clearTimeout(timer); };
  }, [csv]);

  const changeCsv = (value: string) => {
    inputVersion.current++;
    setPreview(null); setError(""); setNotice("");
    if (new TextEncoder().encode(value).byteLength > 1_000_000) { setCsv(""); setError("CSV is limited to 1 MB."); return; }
    setCsv(value);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };
  const importCsv = () => {
    if (!preview || preview.csv !== csv || importRunning.current) return;
    const confirmed = preview.result;
    importRunning.current = true;
    void run(async () => {
      const result = await api.importContacts(csv, confirmed.dncEnabled ? confirmed.credits : undefined);
      setPreview(null); setCsv("");
      setNotice(`Imported ${countLabel(result.imported, "contact")}; ${countLabel(result.duplicates, "duplicate")} ignored.${result.dnc ? ` ${registryOutcome(result.dnc)}${result.dnc.failure ? " Contacts imported successfully. Numbers not checked cannot be dialled until a successful check or valid recorded consent permits them." : ""}` : " Registry checking is disabled; no credits spent. Permission still requires recorded evidence."}`);
      const list = await api.contacts();
      setContacts(list); setContactIds((current) => [...new Set([...current, ...result.contacts.map((contact) => contact.id)])]);
      await refresh();
    }).finally(() => { importRunning.current = false; });
  };
  const create = () => run(async () => {
    const campaign = await api.createCampaign({ name, flowId, callerId, contactIds, callingHours: hours, maxAttempts, retryDelaySeconds: retryDelay, dialIntervalMs: dialInterval });
    await refresh(); setSelected(campaign.id); setName(""); setNotice("Campaign created. Review the pinned flow and calling hours before starting.");
  });
  const control = (action: "start" | "pause" | "stop") => active && run(async () => { await api.controlCampaign(active.id, action); await refresh(); });
  const activePermissions = active?.contacts.map((entry) => permissions[entry.contact.phone]);
  const verifiedDialable = (entry?: ContactPermission) => ["clear", "expiring"].includes(permissionDisplay(entry).tone);
  const blockedReasons = new Map<string, number>();
  activePermissions?.filter((entry) => !verifiedDialable(entry)).forEach((entry) => {
    const reason = entry?.skipReason ?? permissionDisplay(entry).detail ?? "Permission status unavailable.";
    blockedReasons.set(reason, (blockedReasons.get(reason) ?? 0) + 1);
  });
  return <div className="campaigns-view">
    <section className="library-header"><div><span className="eyebrow"><Users size={14} /> Campaigns</span><h1>Contacts and campaigns</h1><p>Import contacts, choose a published flow, and follow each contact’s progress.</p></div></section>
    {error && <div className="campaign-message campaign-message--error" role="alert">{error}</div>}
    {notice && <div className="campaign-message" role="status">{notice}</div>}
    <div className="campaign-setup">
      <section className="campaign-card">
        <h2>Import contacts</h2><p>CSV headers: phone and optional name. Local Singapore numbers are normalized to +65. Existing numbers are kept once.</p>
        <label>CSV file<input type="file" disabled={busy} accept=".csv,text/csv" onChange={(event) => {
          const file = event.target.files?.[0];
          changeCsv("");
          const version = inputVersion.current;
          if (file) {
            if (file.size > 1_000_000) { setError("CSV is limited to 1 MB."); return; }
            void file.text().then((value) => { if (version === inputVersion.current) changeCsv(value); }).catch((failure) => { if (version === inputVersion.current) setError(message(failure)); });
          }
        }} /></label>
        <label>CSV contacts<textarea rows={5} value={csv} disabled={busy} onChange={(event) => changeCsv(event.target.value)} placeholder={'name,phone\nAlex,91234567'} /></label>
        {previewBusy && <p>Preparing free preview…</p>}
        {preview && preview.csv === csv && <div className="import-preview" data-testid="import-preview">
          <p>{countLabel(preview.result.imported, "contact")} will be imported; {countLabel(preview.result.duplicates, "duplicate")} ignored. {preview.result.alreadyCovered} already covered; {countLabel(preview.result.notSingapore, "non-Singapore number")} requiring recorded consent.</p>
          <p>{preview.result.dncEnabled ? `${countLabel(preview.result.needsCheck, "number")} to check against the Registry. This will spend ${countLabel(preview.result.credits, "credit")}.` : `Registry checking is disabled. This import will spend 0 credits; ${countLabel(preview.result.needsCheck, "Singapore number")} still needing permission evidence.`}</p>
          <p>Nothing is spent until you click the import button.</p>
        </div>}
        <button className="secondary-button" disabled={busy || previewBusy || !preview || preview.csv !== csv} onClick={importCsv}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{preview ? `Import ${countLabel(preview.result.imported, "contact")}${preview.result.dncEnabled ? " and check Registry" : ""} · ${countLabel(preview.result.credits, "credit")}` : "Preview CSV to import"}</button>
      </section>
      <section className="campaign-card">
        <h2>Create campaign</h2>
        <label>Campaign name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
        <div className="campaign-fields"><label>Published flow<select value={flowId} onChange={(event) => setFlowId(event.target.value)}><option value="">Select a published flow</option>{flows.filter((flow) => flow.status === "published").map((flow) => <option key={flow.id} value={flow.id}>{flow.name} · v{flow.version}</option>)}</select></label>
          <label>Campaign caller ID<select value={callerId} onChange={(event) => setCallerId(event.target.value as typeof callerId)}>{CALLER_IDS.map((id) => <option key={id} value={id}>{id}</option>)}</select></label></div>
        <fieldset className="campaign-days"><legend>Calling days · Singapore time</legend>{dayNames.map((day, index) => <label key={day}><input type="checkbox" checked={hours.days.includes(index)} onChange={(event) => setHours({ ...hours, days: event.target.checked ? [...hours.days, index].sort() : hours.days.filter((item) => item !== index) })} />{day}</label>)}</fieldset>
        <div className="campaign-fields"><label>Start time<input value={hours.start} placeholder="09:00" onChange={(event) => setHours({ ...hours, start: event.target.value })} /></label><label>End time<input value={hours.end} placeholder="20:00" onChange={(event) => setHours({ ...hours, end: event.target.value })} /></label></div>
        <details><summary>Retry and pacing settings</summary><div className="campaign-fields"><label>Maximum attempts<input type="number" min={1} max={5} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} /></label><label>Retry delay (seconds)<input type="number" min={1} max={86400} value={retryDelay} onChange={(event) => setRetryDelay(Number(event.target.value))} /></label><label>Minimum dial interval (ms)<input type="number" min={100} max={60000} value={dialInterval} onChange={(event) => setDialInterval(Number(event.target.value))} /></label></div></details>
        <fieldset className="campaign-contacts"><legend>Campaign contacts ({contactIds.length} selected)</legend><label><input type="checkbox" checked={contacts.length > 0 && contactIds.length === contacts.length} onChange={(event) => setContactIds(event.target.checked ? contacts.map((contact) => contact.id) : [])} />Select all contacts</label>{contacts.length === 0 ? <p>Import contacts to create a campaign.</p> : contacts.map((contact) => {
          const state = permissionDisplay(permissions[contact.phone]);
          return <label key={contact.id} className={`contact-permission contact-permission--${state.tone}`} data-testid="contact-permission-row"><input type="checkbox" checked={contactIds.includes(contact.id)} onChange={(event) => setContactIds(event.target.checked ? [...contactIds, contact.id] : contactIds.filter((id) => id !== contact.id))} /><span>{contact.name || contact.phone}<small>{contact.name ? contact.phone : ""}</small><strong className="permission-state">{state.label}</strong><small>{state.detail}</small></span></label>;
        })}</fieldset>
        <button className="primary-button" disabled={busy || !name.trim() || !flowId || !contactIds.length} onClick={create}><Plus size={15} /> Create campaign</button>
      </section>
    </div>
    <ConsentPanel dncEnabled={dncEnabled} onChanged={refresh} />
    <section className="campaign-card campaign-progress">
      <div className="campaign-progress-header"><div><h2>Live progress</h2><label>Campaign<select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Select a campaign</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></label></div>{active && <div className="campaign-controls"><button className="primary-button" disabled={busy || !["draft", "paused"].includes(active.status)} onClick={() => control("start")}><Play size={15} /> Start campaign</button><button className="secondary-button" disabled={busy || active.status !== "running"} onClick={() => control("pause")}><Pause size={15} /> Pause campaign</button><button className="secondary-button" disabled={busy || ["stopped", "completed"].includes(active.status)} onClick={() => control("stop")}><Square size={15} /> Stop campaign</button></div>}</div>
      {!active ? <p>No campaign selected.</p> : <>
        <p><strong data-testid="campaign-status">{active.status}</strong> · Published flow v{active.flowVersion} · Caller ID {active.callerId}</p>
        <p data-testid="campaign-compliance">Permission now: {active.contacts.length} total contacts; {activePermissions?.filter(verifiedDialable).length ?? 0} dialable; {activePermissions?.filter((entry) => !verifiedDialable(entry)).length ?? 0} blocked.{blockedReasons.size > 0 && ` ${[...blockedReasons].map(([reason, count]) => `${count}: ${reason}`).join(" ")}`}</p>
        <p>{active.callingHours.days.map((day) => dayNames[day]).join(", ")} {active.callingHours.start}–{active.callingHours.end} Singapore time · Up to {active.maxAttempts} attempts · Busy and no-answer retry after {active.retryDelaySeconds}s.</p>
        {active.status === "running" && !active.withinCallingHours && <p role="status">Waiting for the next permitted calling window.</p>}
        {active.status === "paused" && <p>Paused. Calls already in progress continue to completion.</p>}
        {active.lastError && <p role="alert">{active.lastError}</p>}
        <div className="campaign-counts" data-testid="campaign-progress"><span>{active.progress.total} total</span><span>{active.progress.pending} pending</span><span>{active.progress.dialing} active</span><span>{active.progress.completed} completed</span><span>{active.progress.skipped} skipped</span></div>
        <div className="campaign-table-scroll"><table><thead><tr><th>Contact</th><th>Phone</th><th>Status</th><th>Attempts</th><th>Outcome</th><th>Next attempt / detail</th></tr></thead><tbody>{active.contacts.map((entry) => <tr key={entry.id} data-testid="campaign-contact-row"><td>{entry.contact.name || "—"}</td><td>{entry.contact.phone}</td><td>{entry.status}</td><td>{entry.attempts}</td><td>{entry.outcome ?? "—"}</td><td>{entry.skipReason ?? entry.lastError ?? (entry.nextAttemptAt ? new Date(entry.nextAttemptAt).toLocaleString("en-SG", { timeZone: "Asia/Singapore" }) : "—")}</td></tr>)}</tbody></table></div>
        <CampaignOutcomes key={active.id} campaign={active} canManage={canManageWebhooks} onSaved={refresh} />
      </>}
    </section>
  </div>;
}
