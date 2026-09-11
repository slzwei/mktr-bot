import { useEffect, useState } from "react";
import { Activity, BookOpen, ExternalLink, Settings } from "lucide-react";
import { api } from "../lib/api";
import type { CallSession, OperatorSettings } from "../lib/domain";

export function EventLogsView({ calls }: { calls: CallSession[] }) {
  const [selectedId, setSelectedId] = useState("");
  const call = calls.find((candidate) => candidate.id === selectedId) ?? calls[0];
  const events = call?.events.slice(-200).reverse() ?? [];
  return (
    <div className="system-view">
      <section className="library-header">
        <div><span className="eyebrow"><Activity size={14} /> Call activity</span><h1>Event logs</h1><p>Recent recorded events for each call, with the newest event first.</p></div>
        {calls.length > 0 && <label className="field-label event-call-selector">Call<select value={call?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>{calls.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.destination} · {new Date(candidate.createdAt).toLocaleString()} · {candidate.id.slice(0, 8)}</option>)}</select></label>}
      </section>
      <section className="system-card" aria-label="Call event log">
        {call ? <>
          <div className="event-summary"><strong>{call.destination}</strong><span>{call.endReason ?? call.status}</span><code>{call.id}</code><small>Showing {events.length} of {call.events.length} events</small></div>
          <ol className="event-log">
            {events.map((event) => <li key={event.id}>
              <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleString()}</time>
              <div><strong>{event.title}</strong>{event.detail && <p>{event.detail}</p>}<small>{event.type}{event.nodeId ? ` · ${event.nodeId}` : ""}{event.latencyMs !== undefined ? ` · ${event.latencyMs} ms` : ""}</small></div>
            </li>)}
          </ol>
          {events.length === 0 && <p className="system-note">This call has no recorded events yet.</p>}
        </> : <div className="empty-history"><Activity size={24} /><strong>No call events yet</strong><span>Call activity appears here after a test session starts.</span></div>}
      </section>
    </div>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<OperatorSettings>();
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    api.settings().then((value) => { if (mounted) setSettings(value); }).catch((caught) => { if (mounted) setError(caught instanceof Error ? caught.message : "Could not load settings."); });
    return () => { mounted = false; };
  }, []);
  return (
    <div className="system-view">
      <section className="library-header"><div><span className="eyebrow"><Settings size={14} /> Deployment</span><h1>Settings</h1><p>Current telephony and classifier configuration. Changes are made by the administrator on the deployment host and require a restart.</p></div><span className="version-tag">Read only</span></section>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!settings && !error && <p className="system-note" role="status">Loading settings…</p>}
      {settings && <div className="settings-grid">
        <section className="system-card"><h2>Telephony</h2><dl className="settings-values">
          <div><dt>Mode</dt><dd>{settings.telephony.mode === "simulated" ? "Simulator" : "FreeSWITCH"}</dd></div>
          <div><dt>Concurrent call limit</dt><dd>{settings.telephony.maxConcurrentCalls}</dd></div>
          <div><dt>Answer timeout</dt><dd>{settings.telephony.originateTimeoutSeconds} seconds</dd></div>
          <div><dt>Maximum answered call</dt><dd>{settings.telephony.maxCallSeconds} seconds</dd></div>
        </dl></section>
        <section className="system-card"><h2>Classifier</h2><dl className="settings-values">
          <div><dt>Mode</dt><dd>{settings.classifier.mode === "rules" ? "Rules" : "OpenAI"}</dd></div>
          <div><dt>Model</dt><dd>{settings.classifier.model ?? "Built-in rules"}</dd></div>
        </dl></section>
      </div>}
    </div>
  );
}

export function HelpView() {
  return (
    <div className="system-view">
      <section className="library-header"><div><span className="eyebrow"><BookOpen size={14} /> Operator guide</span><h1>Help</h1><p>Build a flow, review simulator activity, and follow the deployment checks before a first live call.</p></div></section>
      <section className="system-card help-card"><h2>First live call runbook</h2><p>The runbook covers Shawn's review and approved destination, trunk checks, first-call limits, monitoring, emergency stop, and rollback.</p><a className="primary-button" href="/api/help/runbook" target="_blank" rel="noreferrer">Open first-call runbook <ExternalLink size={15} /></a><small>Opens the current deployment's runbook in a new tab. Sign-in is required.</small></section>
      <section className="system-card help-card"><h2>Editing a flow</h2><p>New flows start with Start and End. Add nodes from the palette, connect their handles, and select a node or route to edit its settings. Save an incomplete draft at any time; publishing checks that its routes and approved audio are usable.</p><p>Retry nodes have a maximum attempt count. Removing a flow preserves published history. Removing a clip archives it when published history still needs its audio.</p></section>
    </div>
  );
}
