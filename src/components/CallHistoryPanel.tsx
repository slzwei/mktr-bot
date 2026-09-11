import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Download, MessageSquareText, PhoneCall, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { formatDuration, type CallListPage, type CallSummary, type Contact } from "../lib/domain";
import { isCallInProgress, outcomeLabels, statusLabels } from "../lib/operator-display";
import { DateCell, EmptyState, LoadError, OutcomeChip, Pager, SearchField, SkeletonRows } from "./OperatorUI";

const PAGE_SIZE = 25;
const initialFilters = { search: "", campaignId: "", contactId: "", status: "", outcome: "" };

export function CallHistoryPanel({ onSelect, onNewCall }: { onSelect: (call: CallSummary) => void; onNewCall: () => void }) {
  const [filters, setFilters] = useState(initialFilters);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [result, setResult] = useState<{ key: string; query: string; page: CallListPage }>();
  const [failure, setFailure] = useState<{ key: string; error: string }>();
  const [revision, setRevision] = useState(0);
  const [choices, setChoices] = useState<{ contacts: Contact[]; campaigns: { id: string; name: string }[] }>();
  const [choiceError, setChoiceError] = useState("");
  const [choiceRevision, setChoiceRevision] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const query = { ...filters, search: filters.search.trim(), cursor: cursors.at(-1), limit: PAGE_SIZE };
  const queryString = JSON.stringify(query);
  const key = `${queryString}:${revision}`;
  // Retain the current page during a background refresh; a different filter or
  // cursor always gets fresh skeletons, never rows from the previous query.
  const page = result?.query === queryString ? result.page : undefined;
  const error = failure?.key === key ? failure.error : "";
  const refreshing = result?.key !== key && !error;
  const loading = !page && !error;
  const update = (name: keyof typeof filters, value: string) => {
    setFilters((current) => ({ ...current, [name]: value })); setCursors([undefined]);
  };
  const clear = () => { setFilters(initialFilters); setCursors([undefined]); };
  const hasFilters = Object.values(filters).some(Boolean);
  useEffect(() => {
    let disposed = false;
    // Debounce typing and discard obsolete responses when filters or pages change.
    const timer = setTimeout(() => {
      void api.callHistory(JSON.parse(queryString) as Parameters<typeof api.callHistory>[0]).then((data) => {
        if (!disposed) setResult({ key, query: queryString, page: data });
      }).catch((caught) => {
        if (!disposed) setFailure({ key, error: caught instanceof Error ? caught.message : "Call history could not be retrieved." });
      });
    }, 250);
    return () => { disposed = true; clearTimeout(timer); };
  }, [queryString, key]);
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }); }, [queryString]);
  useEffect(() => {
    let disposed = false;
    setChoiceError("");
    void Promise.all([api.contacts(), api.campaigns()]).then(([contacts, campaigns]) => {
      if (!disposed) setChoices({ contacts, campaigns });
    }).catch((caught) => { if (!disposed) setChoiceError(caught instanceof Error ? caught.message : "Filter choices could not be loaded."); });
    return () => { disposed = true; };
  }, [choiceRevision]);
  useEffect(() => {
    const refresh = () => setRevision((current) => current + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  useEffect(() => {
    if (refreshing || error || !page?.calls.some((call) => isCallInProgress(call.status))) return;
    const timer = setTimeout(() => setRevision((current) => current + 1), 5000);
    return () => clearTimeout(timer);
  }, [page, refreshing, error]);

  return <div className="operator-view history-view">
    <header className="operator-page-header"><div><h1>Call history</h1><p>Review every call, follow its outcome, and read the conversation.</p></div><button className="primary-button" onClick={onNewCall}><PhoneCall size={16} /> New test call</button></header>
    <section className="operator-surface" aria-label="Call history records">
      <div className="operator-filters history-filters">
        <SearchField label="Search call history" value={filters.search} onChange={(value) => update("search", value)} placeholder="Search contact name or number" />
        <label className="operator-filter">Campaign<select value={filters.campaignId} disabled={!choices} onChange={(event) => update("campaignId", event.target.value)}><option value="">All campaigns</option>{choices?.campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></label>
        <label className="operator-filter">Contact<select value={filters.contactId} disabled={!choices} onChange={(event) => update("contactId", event.target.value)}><option value="">All contacts</option>{choices?.contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name ? `${contact.name} · ` : ""}{contact.phone}</option>)}</select></label>
        <label className="operator-filter">Status<select value={filters.status} onChange={(event) => update("status", event.target.value)}><option value="">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="operator-filter">Outcome<select value={filters.outcome} onChange={(event) => update("outcome", event.target.value)}><option value="">All outcomes</option>{Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button className="secondary-button filter-refresh" aria-label="Refresh call history" title="Refresh call history" disabled={refreshing} onClick={() => setRevision((current) => current + 1)}><RefreshCw size={16} /></button>
      </div>
      {choiceError && <LoadError title="Could not load campaign and contact filters" error={choiceError} onRetry={() => setChoiceRevision((current) => current + 1)} />}
      <div className="operator-table-heading"><h2>{page ? `${page.total.toLocaleString("en-SG")} ${page.total === 1 ? "call" : "calls"}` : "Call records"}{hasFilters && <small>matching filters</small>}</h2><div>{hasFilters && <button className="text-button" onClick={clear}>Clear filters</button>}<span>Newest first · Singapore time</span></div></div>
      {error ? <LoadError title="Could not load call history" error={error} onRetry={() => setRevision((current) => current + 1)} /> : <>
        <div className="operator-table-scroll" ref={scroll} role="region" aria-label="Call history table" tabIndex={0} aria-busy={refreshing}>
          <table className="operator-table history-data-table"><caption className="sr-only">Calls, newest first. Open a call to read its transcript and technical events.</caption>
            <colgroup><col className="history-col-contact" /><col className="history-col-context" /><col className="history-col-start" /><col className="history-col-duration" /><col className="history-col-outcome" /><col className="history-col-content" /></colgroup>
            <thead><tr><th scope="col">Contact</th><th scope="col">Campaign / flow</th><th scope="col">Started<small>Singapore time</small></th><th scope="col">Duration</th><th scope="col">Outcome</th><th scope="col">Conversation</th></tr></thead>
            {loading ? <SkeletonRows columns={6} /> : <tbody>{page?.calls.map((call) => <tr className="history-row" key={call.id} data-testid="call-history-row" onClick={(event) => { if (!(event.target as HTMLElement).closest("a, button")) onSelect(call); }}>
              <td><button className="history-open" onClick={() => onSelect(call)} aria-label={`Open call to ${call.contactName || call.destination}`}><strong className="cell-truncate" title={call.contactName || call.destination}>{call.contactName || call.destination}</strong><ArrowUpRight size={14} aria-hidden="true" /></button><span className="cell-secondary numeric" title={call.destination}>{call.contactName ? call.destination : "Unnamed contact"}</span></td>
              <td><span className="cell-truncate" title={call.campaignName || (call.direction === "inbound_callback" ? "Inbound callback" : "Individual call")}>{call.campaignName || (call.direction === "inbound_callback" ? "Inbound callback" : "Individual call")}</span><span className="cell-secondary cell-truncate numeric" title={`Caller ID ${call.callerId} · Flow v${call.flowVersion}`}>{call.callerId} · v{call.flowVersion}</span></td>
              <td><DateCell value={call.createdAt} /></td>
              <td className="numeric">{isCallInProgress(call.status) ? <span className="secondary-text">In progress</span> : call.durationSeconds === null ? <span className="secondary-text">Not recorded</span> : <span title={`${call.durationSeconds} seconds`}>{formatDuration(call.durationSeconds)}</span>}</td>
              <td><OutcomeChip status={call.status} outcome={call.outcome} /><span className="cell-secondary cell-truncate" title={call.endReason}>{isCallInProgress(call.status) ? statusLabels[call.status] : call.endReason || "Call ended"}</span></td>
              <td><span className={`conversation-indicator ${call.transcriptTurns ? "" : "secondary-text"}`}><MessageSquareText size={14} aria-hidden="true" />{call.transcriptTurns ? `${call.transcriptTurns} turns` : isCallInProgress(call.status) ? "Awaiting conversation" : "No conversation"}</span>{call.hasRecording ? <a className="recording-link" href={`/api/calls/${encodeURIComponent(call.id)}/recording`} download aria-label={`Download recording for ${call.contactName || call.destination}`}><Download size={13} aria-hidden="true" /> Recording</a> : <span className="cell-secondary">{isCallInProgress(call.status) ? "No recording yet" : "No recording"}</span>}</td>
            </tr>)}</tbody>}
          </table>
        </div>
        {page?.calls.length === 0 && <EmptyState title={hasFilters ? "No matching calls" : cursors.length > 1 ? "You’ve reached the end" : "No calls yet"} action={<button className="secondary-button" onClick={hasFilters ? clear : cursors.length > 1 ? () => setCursors([undefined]) : onNewCall}>{hasFilters ? "Clear filters" : cursors.length > 1 ? "Back to latest calls" : "New test call"}</button>}>{hasFilters ? "Try a different name, number or combination of filters." : cursors.length > 1 ? "There are no more calls on this page. Return to the latest calls to refresh the list." : "Campaign and individual calls will appear here with their outcomes, recordings and conversations. Run a simulator call from a published flow to get started."}</EmptyState>}
        <Pager label={page ? `${page.calls.length ? (cursors.length - 1) * PAGE_SIZE + 1 : 0}–${page.calls.length ? (cursors.length - 1) * PAGE_SIZE + page.calls.length : 0} of ${page.total.toLocaleString("en-SG")} calls${refreshing ? " · Updating…" : ""}` : "Loading calls…"} page={cursors.length} disabled={refreshing} previous={cursors.length > 1 ? () => setCursors((current) => current.slice(0, -1)) : undefined} next={page?.nextCursor ? () => setCursors((current) => [...current, page.nextCursor!]) : undefined} />
      </>}
    </section>
    <p className="operator-page-note">Open any call to review its conversation and the permission used at dial time.</p>
  </div>;
}
