import { useCallback, useEffect, useRef, useState } from "react";
import { CircleStop, GitBranch, Pause, PhoneCall, Play, RadioTower, X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { latestCallSnapshot } from "../lib/call-snapshot";
import { formatDuration, type CallSession, type FlowDefinition, type TrunkStatus } from "../lib/domain";
import { isCallInProgress, singaporeDateTime, singaporeTime, statusLabels } from "../lib/operator-display";
import { useCallStream } from "../lib/use-call-stream";
import { CallEventTimeline } from "./CallEventTimeline";
import { EmptyState, LoadError, OutcomeChip } from "./OperatorUI";

type Props = {
  calls: CallSession[];
  flows: FlowDefinition[];
  trunk: TrunkStatus;
  refreshFailed: boolean;
  onUpdated: (call: CallSession) => void;
  onCampaigns: () => void;
  onFlows: () => void;
};
type Names = { contacts: Map<string, string>; campaigns: Map<string, string> };

export function LiveCallsView({ calls, flows, trunk, refreshFailed, onUpdated, onCampaigns, onFlows }: Props) {
  // Keep the positions of observed calls for this visit. Only explicit dismissal
  // removes a finished card; a call outside the roster must release its stream.
  const [watched, setWatched] = useState(() => calls.filter((call) => isCallInProgress(call.status)).reverse());
  const [paused, setPaused] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [now, setNow] = useState(Date.now);
  const [names, setNames] = useState<Names>({ contacts: new Map(), campaigns: new Map() });
  const [nameError, setNameError] = useState("");
  const [nameRevision, setNameRevision] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const running = watched.filter((call) => isCallInProgress(call.status)).length;
  const finished = watched.length - running;
  const identityKey = JSON.stringify([...new Set(watched.flatMap((call) => [call.contactId, call.campaignId].filter(Boolean)))].sort());

  useEffect(() => {
    setWatched((current) => {
      const roster = new Map(calls.map((call) => [call.id, call]));
      const known = new Set(current.map((call) => call.id));
      return [
        ...current.filter((call) => !isCallInProgress(call.status) || roster.has(call.id)).map((call) => roster.has(call.id) ? latestCallSnapshot(call, roster.get(call.id)!) : call),
        ...calls.filter((call) => !known.has(call.id) && isCallInProgress(call.status)).reverse()
      ];
    });
  }, [calls]);

  const update = useCallback((call: CallSession) => {
    setWatched((current) => current.map((item) => item.id === call.id ? latestCallSnapshot(item, call) : item));
    onUpdated(call);
  }, [onUpdated]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setPaused(preference.matches);
    preference.addEventListener("change", changed);
    return () => preference.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    if (paused || running === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [paused, running]);

  useEffect(() => {
    if (identityKey === "[]") return;
    let disposed = false;
    setNameError("");
    // Bootstrap has no names. Refresh these existing lookups only when the set
    // of identities changes (or on explicit retry), never on a polling timer.
    void Promise.all([api.contacts(), api.campaigns()]).then(([contacts, campaigns]) => {
      if (!disposed) setNames({ contacts: new Map(contacts.map((contact) => [contact.id, contact.name])), campaigns: new Map(campaigns.map((campaign) => [campaign.id, campaign.name])) });
    }).catch((error) => {
      if (!disposed) setNameError(error instanceof Error ? error.message : "Contact and campaign names could not be retrieved.");
    });
    return () => { disposed = true; };
  }, [identityKey, nameRevision]);

  const full = trunk.activeCalls >= trunk.maxConcurrentCalls;
  const dismiss = (id?: string) => {
    setWatched((current) => current.filter((call) => isCallInProgress(call.status) || id !== undefined && call.id !== id));
    heading.current?.focus();
  };

  return <div className="operator-view live-calls-view">
    <header className="operator-page-header"><div><h1 ref={heading} tabIndex={-1}>Live calls</h1><p>Every call in progress, from first ring to final outcome.</p></div>
      <div className="live-calls-actions"><button className="secondary-button" onClick={() => setPaused((value) => !value)}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? "Resume timers & logs" : "Pause timers & logs"}</button><button className="secondary-button" onClick={onCampaigns}><PhoneCall size={15} /> Campaigns</button></div>
    </header>

    <section className={`live-capacity${full ? " live-capacity--full" : ""}`} aria-label="Trunk capacity">
      <div className="live-capacity-count"><RadioTower size={22} aria-hidden="true" /><div><strong>{trunk.activeCalls}<span> / {trunk.maxConcurrentCalls}</span></strong><span>calls in flight</span></div></div>
      <div className="live-capacity-message"><strong>{full ? "Trunk full" : trunk.activeCalls === 0 ? "Ready for the next call" : `${trunk.maxConcurrentCalls - trunk.activeCalls} ${trunk.maxConcurrentCalls - trunk.activeCalls === 1 ? "slot" : "slots"} available`}</strong><p>{full ? "Campaigns wait for a free slot before dialing the next contact." : "Campaigns share this capacity with individual calls."}</p></div>
      <div className="live-capacity-slots" aria-hidden="true">{Array.from({ length: trunk.maxConcurrentCalls }, (_, index) => <span key={index} className={index < trunk.activeCalls ? "is-occupied" : ""} />)}</div>
    </section>
    {refreshFailed && <p className="live-roster-warning" role="status">Call roster connection interrupted. Capacity may be out of date; retrying automatically.</p>}
    {nameError && <LoadError title="Could not load contact and campaign names" error={nameError} onRetry={() => setNameRevision((value) => value + 1)} />}
    <div className="live-calls-caption"><span>{paused ? "Timers and logs paused. Status and End controls stay live." : "Timelines show newest events first · Singapore time"}</span>{finished > 0 && <button className="text-button" onClick={() => dismiss()}>Dismiss {finished} finished {finished === 1 ? "call" : "calls"}</button>}</div>
    {watched.length === 0 ? <section className="operator-surface"><EmptyState title={trunk.activeCalls > 0 ? "No running calls in the recent roster" : "No calls running"} action={<div className="live-empty-actions"><button className="primary-button" onClick={onCampaigns}><PhoneCall size={15} /> Open campaigns</button><button className="secondary-button" onClick={onFlows}><GitBranch size={15} /> Go to flows</button></div>}>{trunk.activeCalls > 0 ? "Capacity includes calls outside the 25 most recent sessions. Review campaign activity for those calls." : "Start a campaign or test a published flow. Calls appear here automatically, including calls started by another operator."}</EmptyState></section> : <>
      <div className="live-call-grid">{watched.map((call) => <LiveCallCard key={call.id} call={call} flows={flows} names={names} now={now} paused={paused} onUpdated={update} onDismiss={() => dismiss(call.id)} />)}</div>
      <p className="operator-page-note">Finished calls stay here until dismissed or you leave this view. Their full records remain in Call history.</p>
    </>}
    {trunk.activeCalls > running && watched.length > 0 && <p className="live-roster-warning">Showing {running} running calls from the recent roster; capacity includes {trunk.activeCalls} calls in total.</p>}
  </div>;
}

function LiveCallCard({ call, flows, names, now, paused, onUpdated, onDismiss }: {
  call: CallSession; flows: FlowDefinition[]; names: Names; now: number; paused: boolean; onUpdated: (call: CallSession) => void; onDismiss: () => void;
}) {
  const live = isCallInProgress(call.status);
  const streamState = useCallStream(call.id, live, onUpdated);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [displayed, setDisplayed] = useState(call);
  // Pausing affects only motion. Final outcomes always replace the frozen log.
  if (displayed !== call && (!paused || !live)) setDisplayed(call);
  const name = call.contactId ? names.contacts.get(call.contactId) : undefined;
  const flow = flows.find((item) => item.id === call.flowId);
  const node = flow?.version === call.flowVersion && flow.status === "published" ? flow.nodes.find((item) => item.id === call.currentNodeId) : undefined;
  const elapsed = Math.max(0, Math.floor(((call.endedAt ? Date.parse(call.endedAt) : now) - Date.parse(call.createdAt)) / 1000));
  const callerTurns = displayed.events.filter((event) => event.type === "transcript_final" && event.detail?.trim());
  const latestSpeech = callerTurns.at(-1);
  const recording = call.recordingFile ? live ? "Recording" : call.recordingExpiresAt && Date.parse(call.recordingExpiresAt) <= now ? "Recording expired" : "Recording available" : "Not recording";
  const end = async () => {
    setStopping(true); setError("");
    try { onUpdated(await api.stopCall(call.id)); }
    catch (caught) { setError(caught instanceof ApiError ? caught.message : "Could not end this call. Try again."); }
    finally { setStopping(false); }
  };

  return <article className={`live-call-card${live ? "" : " live-call-card--finished"}${call.status === "failed" ? " live-call-card--failed" : ""}`} aria-label={`Call to ${name || call.destination}`} data-testid="live-call-card" data-call-id={call.id}>
    <header className="live-call-identity"><div><span className="eyebrow">{call.direction === "inbound_callback" ? "Inbound callback" : call.campaignId ? "Campaign call" : "Individual call"}</span><h2>{name || call.destination}</h2><span className="live-call-number">{name && <>{call.destination} · </>}Caller ID {call.callerId}</span></div></header>
    <div className="live-call-state"><div className="live-call-status"><span className={`status-orb status-orb--${call.status}`} aria-hidden="true" /><strong>{statusLabels[call.status]}</strong></div><span className="live-call-duration" aria-live="off" title={`Started ${singaporeDateTime(call.createdAt)} Singapore time`}>{formatDuration(elapsed)}<small>{live ? paused ? "elapsed · paused" : "elapsed" : "duration"}</small></span></div>
    <dl className="live-call-facts">
      <div><dt>Flow</dt><dd>{flow?.name || `Unavailable flow (${call.flowId})`} <span className="live-flow-version">v{call.flowVersion}</span></dd></div>
      <div><dt>{live ? "Current node" : "Last node"}</dt><dd>{node?.data.label || (call.currentNodeId ? `Node ${call.currentNodeId} · label unavailable for v${call.flowVersion}` : live ? "Waiting to enter flow" : "No node recorded")}</dd></div>
      {call.campaignId && <div><dt>Campaign</dt><dd>{names.campaigns.get(call.campaignId) || `Campaign ${call.campaignId}`}</dd></div>}
    </dl>
    <div className="live-call-connection"><span className={live && streamState !== "connected" ? "live-stream-warning" : ""}>{!live ? "Session finished" : streamState === "connected" ? "Live connection" : streamState === "connecting" ? "Connecting to call updates…" : "Reconnecting to call updates…"}</span><span className={recording === "Recording" ? "live-recording" : ""}>{recording === "Recording" && <i aria-hidden="true" />}{recording}</span></div>
    {!live && <div className="live-call-outcome"><OutcomeChip status={call.status} outcome={call.outcome} /><p>{call.endReason || "No end reason recorded"}</p></div>}
    <CallEventTimeline events={displayed.events} live={live} scrollable />
    <section className="live-call-speech" aria-label="Latest caller speech"><div><strong>Latest caller speech</strong>{latestSpeech && <time dateTime={latestSpeech.timestamp}>{singaporeTime(latestSpeech.timestamp)} SGT</time>}</div><p>{latestSpeech?.detail || "No caller speech captured yet."}</p>{callerTurns.length > 1 && <details><summary>Earlier caller speech ({callerTurns.length - 1})</summary>{callerTurns.slice(0, -1).map((event) => <p key={event.id}><time dateTime={event.timestamp}>{singaporeTime(event.timestamp)} SGT</time> {event.detail}</p>)}</details>}</section>
    {error && <p className="form-error" role="alert">{error}</p>}
    <footer className="live-call-footer"><span>Call {call.id.slice(0, 8)}</span>{live ? <button className="stop-button" onClick={end} disabled={stopping}><CircleStop size={15} />{stopping ? "Ending…" : "End call"}</button> : <button className="secondary-button" onClick={onDismiss}><X size={14} /> Dismiss</button>}</footer>
  </article>;
}
