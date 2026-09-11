import { Bot, Download, UserRound } from "lucide-react";
import type { CallSession, CallSummary, FlowDefinition, TranscriptTurn } from "../lib/domain";
import { formatDuration } from "../lib/domain";
import { basisLabel, singaporeDateTime, singaporeTime } from "../lib/operator-display";
import { EmptyState, OutcomeChip } from "./OperatorUI";

export function CallReview({ call, transcript, summary, flows }: { call: CallSession; transcript: TranscriptTurn[]; summary?: CallSummary; flows: FlowDefinition[] }) {
  const turns = [...transcript].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const duration = call.endedAt ? Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.createdAt)) / 1000)) : null;
  const recording = Boolean(call.recordingFile && call.recordingExpiresAt && Date.parse(call.recordingExpiresAt) > Date.now());
  const flow = flows.find((entry) => entry.id === call.flowId);
  return <div className="call-review">
    <div className="call-review-identity"><div><strong title={summary?.contactName || call.destination}>{summary?.contactName || call.destination}</strong><span className="numeric">{summary?.contactName ? `${call.destination} · ` : ""}{summary?.campaignName || (call.direction === "inbound_callback" ? "Inbound callback" : "Individual call")}</span></div><OutcomeChip status={call.status} outcome={call.outcome} /></div>
    <time className="call-review-date" dateTime={call.createdAt}>{singaporeDateTime(call.createdAt)} · Singapore time</time>
    <dl className="call-review-facts">
      <div><dt>Duration</dt><dd className="numeric">{duration === null || !Number.isFinite(duration) ? "Not recorded" : formatDuration(duration)}</dd></div>
      <div><dt>Flow version</dt><dd title={flow ? `${flow.name} · v${call.flowVersion}` : `${call.flowId} · v${call.flowVersion}`}>{flow?.name || "Archived flow"} · v{call.flowVersion}</dd></div>
      <div><dt>Permission at dial</dt><dd>{basisLabel(call.dialAuthorization?.basis ?? summary?.dialBasis)}</dd></div>
      <div><dt>Caller ID</dt><dd className="numeric">{call.callerId}</dd></div>
      <div className="call-review-end"><dt>End reason</dt><dd>{call.endReason || "No end reason recorded"}</dd></div>
    </dl>
    <div className="call-review-recording">{recording ? <a className="secondary-button" href={`/api/calls/${encodeURIComponent(call.id)}/recording`} download><Download size={15} /> Download recording</a> : <span>No recording available</span>}{recording && call.recordingExpiresAt && <small>Available until {singaporeDateTime(call.recordingExpiresAt)} SGT</small>}</div>
    <section className="conversation" aria-labelledby="conversation-heading"><header><h3 id="conversation-heading">Conversation</h3><span>{turns.length} {turns.length === 1 ? "turn" : "turns"}</span></header>
      {turns.length === 0 ? <EmptyState title="No conversation">No agent or caller turns were captured for this call. This is normal for an unanswered call.</EmptyState> : <ol className="transcript-turns" aria-label="Conversation transcript">{turns.map((turn, index) => {
        const Icon = turn.role === "agent" ? Bot : UserRound;
        return <li key={`${turn.at}-${index}`} className={`transcript-turn transcript-turn--${turn.role}`} data-testid={`transcript-${turn.role}`}><div className="transcript-turn-meta"><strong><Icon size={14} aria-hidden="true" />{turn.role === "agent" ? "Agent" : "Caller"}</strong><time dateTime={turn.at} title={`${singaporeDateTime(turn.at)} Singapore time`}>{singaporeTime(turn.at)}</time>{turn.latencyMs !== undefined && <small title="Processing latency">{turn.latencyMs.toLocaleString("en-SG")} ms</small>}</div><p>{turn.text}</p></li>;
      })}</ol>}
    </section>
  </div>;
}
