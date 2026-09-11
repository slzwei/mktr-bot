import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  CircleStop,
  Clock3,
  LoaderCircle,
  Phone,
  PhoneCall,
  RadioTower,
  Route,
  Sparkles,
  Volume2,
  X
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { CallEvent, CallSession, CallSummary, CallerId, FlowDefinition, TrunkStatus } from "../lib/domain";
import { formatPhoneNumber } from "../lib/domain";
import { singaporeTime } from "../lib/operator-display";
import { CallReview } from "./CallReview";
import { LoadError } from "./OperatorUI";

type Props = {
  open: boolean;
  flows: FlowDefinition[];
  trunk: TrunkStatus;
  activeCall?: CallSession;
  historyCall?: CallSummary;
  onClose: () => void;
  onStarted: (call: CallSession) => void;
  onUpdated: (call: CallSession) => void;
};

const active = new Set(["queued", "dialing", "ringing", "answered", "playing", "listening", "classifying"]);

const eventIcon = (type: CallEvent["type"]) => {
  if (type === "clip_playing") return Volume2;
  if (type === "classified") return Sparkles;
  if (type === "branch_selected") return Route;
  if (type === "dialing" || type === "ringing" || type === "answered") return Phone;
  if (type === "listening" || type === "transcript_final") return RadioTower;
  if (type === "ended") return CircleStop;
  return Clock3;
};

const timestamp = singaporeTime;

export function CallConsole({ open, flows, trunk, activeCall, historyCall, onClose, onStarted, onUpdated }: Props) {
  const publishedFlows = useMemo(() => flows.filter((flow) => flow.status === "published"), [flows]);
  const [destination, setDestination] = useState("+6591234567");
  const [callerId, setCallerId] = useState<CallerId>(trunk.callerIds[0]);
  const [flowId, setFlowId] = useState("");
  const [scenario, setScenario] = useState<"interested" | "not_interested" | "callback" | "uncertain">("interested");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [streamState, setStreamState] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.call>>>();
  const [detailFailure, setDetailFailure] = useState<{ id: string; error: string }>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRevision, setDetailRevision] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const selectedId = historyCall?.id ?? activeCall?.id;
  const currentCall = activeCall?.id === selectedId ? activeCall : detail?.id === selectedId ? detail : undefined;
  const isActiveCall = Boolean(currentCall ? active.has(currentCall.status) : historyCall && active.has(historyCall.status));
  const reviewing = Boolean(historyCall || currentCall && !isActiveCall);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [open]);

  useEffect(() => {
    if (!open || !selectedId || !reviewing) return;
    let disposed = false;
    setDetailLoading(true); setDetailFailure(undefined);
    void api.call(selectedId).then((call) => {
      if (!disposed) { setDetail(call); onUpdated(call); }
    }).catch((failure) => {
      if (!disposed) setDetailFailure({ id: selectedId, error: failure instanceof Error ? failure.message : "The conversation could not be retrieved." });
    }).finally(() => { if (!disposed) setDetailLoading(false); });
    return () => { disposed = true; };
  }, [selectedId, isActiveCall, open, reviewing, detailRevision, onUpdated]);

  useEffect(() => {
    if (!flowId && publishedFlows[0]) setFlowId(publishedFlows[0].id);
  }, [flowId, publishedFlows]);

  useEffect(() => {
    if (!currentCall || !isActiveCall) return;
    const callId = currentCall.id;
    let disposed = false;
    let resyncing = false;
    let events: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const resync = async () => {
      if (resyncing || disposed) return;
      resyncing = true;
      try {
        const call = await api.getCall(callId);
        if (!disposed) onUpdated(call);
      } catch {
        if (!disposed) setStreamState("reconnecting");
      } finally { resyncing = false; }
    };
    const connect = () => {
      if (disposed) return;
      const stream = new EventSource(`/api/calls/${callId}/events`);
      events = stream;
      stream.onopen = () => { if (!disposed) { setStreamState("connected"); void resync(); } };
      stream.onmessage = (event) => {
        if (disposed) return;
        try { onUpdated(JSON.parse(event.data) as CallSession); }
        catch { setStreamState("reconnecting"); void resync(); }
      };
      stream.onerror = () => {
        if (disposed) return;
        setStreamState("reconnecting");
        void resync();
        // Native EventSource retries dropped sockets. HTTP failures can close it
        // permanently, so recreate only that terminal transport state.
        if (stream.readyState === EventSource.CLOSED) retry = setTimeout(connect, 1000);
      };
    };
    setStreamState("connecting");
    connect();
    return () => { disposed = true; clearTimeout(retry); events?.close(); };
  }, [currentCall?.id, isActiveCall, onUpdated]);

  const start = async () => {
    setError("");
    setStarting(true);
    try {
      const call = await api.startCall({ destination, callerId, flowId, scenario });
      onStarted(call);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not start the call.");
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!currentCall) return;
    setError("");
    try {
      onUpdated(await api.stopCall(currentCall.id));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not end the call.");
    }
  };

  if (!open) return null;
  const isLive = isActiveCall;
  const detailError = detailFailure && detailFailure.id === selectedId ? detailFailure.error : "";
  const loadingReview = reviewing && (detailLoading || detail?.id !== selectedId) && !detailError;
  const eventTimeline = currentCall && <div className="event-log">
    <div className="event-log__title"><span>{isLive ? "Live event timeline" : "Event timeline"}</span><small>{currentCall.events.length} events · SGT</small></div>
    {currentCall.events.slice().reverse().map((event) => {
      const Icon = eventIcon(event.type);
      return <div className="event-row" key={event.id}><span className={`event-row__icon event-row__icon--${event.type}`}><Icon size={14} /></span><div><strong>{event.title}</strong>{event.detail && <small>{event.detail}</small>}</div><time dateTime={event.timestamp}>{event.latencyMs !== undefined ? `${event.latencyMs}ms` : timestamp(event.timestamp)}</time></div>;
    })}
    {currentCall.events.length === 0 && <p className="secondary-text">No technical events recorded.</p>}
  </div>;

  return (
    <aside className={`call-console${reviewing ? " call-console--history" : ""}`} aria-label={reviewing && !isLive ? "Call details" : "Test call console"} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div className="call-console__header">
        <div>
          <span className="eyebrow">{reviewing && !isLive ? "Call record" : "Test call"}</span>
          <h2>{isLive ? "Call in progress" : reviewing ? "Call details" : "Run a flow"}</h2>
        </div>
        <button ref={closeButton} className="icon-button" onClick={onClose} title="Close call console" aria-label="Close call console"><X size={20} /></button>
      </div>

      {!isLive && !reviewing && (
        <div className="call-form">
          <label className="field-label">
            Destination
            <input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="+6591234567" />
          </label>
          <label className="field-label">
            Caller ID
            <select value={callerId} onChange={(event) => setCallerId(event.target.value as CallerId)}>
              {trunk.callerIds.map((id) => <option key={id} value={id}>{formatPhoneNumber(id)}</option>)}
            </select>
          </label>
          <label className="field-label">
            Published flow
            <select value={flowId} onChange={(event) => setFlowId(event.target.value)}>
              {publishedFlows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name} · v{flow.version}</option>)}
            </select>
          </label>
          <label className="field-label">
            Simulated response
            <select value={scenario} onChange={(event) => setScenario(event.target.value as typeof scenario)}>
              <option value="interested">Interested, positive</option>
              <option value="callback">Callback requested</option>
              <option value="not_interested">Not interested, negative</option>
              <option value="uncertain">Unclear response</option>
            </select>
          </label>
          <div className="trunk-capacity">
            <RadioTower size={15} />
            <span>Trunk capacity</span>
            <strong>{trunk.activeCalls}/{trunk.maxConcurrentCalls}</strong>
          </div>
          <button className="primary-button primary-button--call" onClick={start} disabled={starting || !flowId || !trunk.available}>
            {starting ? <LoaderCircle className="spin" size={16} /> : <PhoneCall size={16} />}
            Start test call
          </button>
        </div>
      )}

      {reviewing && detailError && <LoadError title="Could not load this call" error={detailError} onRetry={() => setDetailRevision((value) => value + 1)} />}
      {loadingReview && <div className="call-review-skeleton" role="status" aria-label="Loading call details"><span className="skeleton-line" /><span className="skeleton-line skeleton-line--short" /><div className="skeleton-facts" />{[0, 1, 2].map((index) => <div className="skeleton-turn" key={index}><span className="skeleton-line skeleton-line--short" /><span className="skeleton-line" /><span className="skeleton-line" /></div>)}</div>}
      {reviewing && !isLive && !loadingReview && !detailError && currentCall && detail && detail.id === selectedId && <>
        <CallReview call={currentCall} transcript={detail.transcript} summary={historyCall} flows={flows} />
        <details className="technical-events" key={selectedId}><summary><ChevronDown size={16} /> Technical events <small>{currentCall.events.length} events</small></summary><p>Raw call events for troubleshooting. Newest first, in Singapore time.</p>{eventTimeline}</details>
      </>}

      {currentCall && isLive && (
        <div className="call-live">
          <div className="call-live__summary">
            <div className={`status-orb status-orb--${currentCall.status}`} />
            <div>
              <strong>{currentCall.status.replace("_", " ")}</strong>
              <span>{currentCall.destination}</span>
            </div>
            {isLive && <button className="stop-button" onClick={stop}><CircleStop size={15} /> End</button>}
          </div>
          <div className="call-route">
            <span>{formatPhoneNumber(currentCall.callerId)}</span>
            <Route size={13} />
            <span>{currentCall.destination}</span>
          </div>
          {currentCall.classifierResult && (
            <div className="classification-result">
              <span>AI decision</span>
              <strong>{currentCall.classifierResult.intent}</strong>
              <small>{currentCall.classifierResult.sentiment} · {Math.round(currentCall.classifierResult.confidence * 100)}% confidence</small>
            </div>
          )}
          {eventTimeline}
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
      {isLive && streamState !== "connected" && <p className="console-footnote" role="status">{streamState === "connecting" ? "Connecting to call updates…" : "Reconnecting to call updates…"}</p>}
      {(!reviewing || isLive) && <div className="console-footnote">
        {trunk.mode === "simulated" ? "Safe simulator: no SIP INVITE is sent." : "Live FreeSWITCH gateway: SIP originations enabled."}
      </div>}
    </aside>
  );
}
