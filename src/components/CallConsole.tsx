import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  CircleStop,
  Clock3,
  LoaderCircle,
  Phone,
  PhoneCall,
  RadioTower,
  Route,
  Sparkles,
  Volume2
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { CallEvent, CallSession, CallerId, FlowDefinition, TrunkStatus } from "../lib/domain";
import { formatPhoneNumber } from "../lib/domain";

type Props = {
  open: boolean;
  flows: FlowDefinition[];
  trunk: TrunkStatus;
  activeCall?: CallSession;
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

const timestamp = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function CallConsole({ open, flows, trunk, activeCall, onClose, onStarted, onUpdated }: Props) {
  const publishedFlows = useMemo(() => flows.filter((flow) => flow.status === "published"), [flows]);
  const [destination, setDestination] = useState("+6591234567");
  const [callerId, setCallerId] = useState<CallerId>(trunk.callerIds[0]);
  const [flowId, setFlowId] = useState("");
  const [scenario, setScenario] = useState<"interested" | "not_interested" | "callback" | "uncertain">("interested");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!flowId && publishedFlows[0]) setFlowId(publishedFlows[0].id);
  }, [flowId, publishedFlows]);

  useEffect(() => {
    if (!activeCall || !active.has(activeCall.status)) return;
    const events = new EventSource(`/api/calls/${activeCall.id}/events`);
    events.onmessage = (event) => onUpdated(JSON.parse(event.data) as CallSession);
    events.onerror = () => events.close();
    return () => events.close();
  }, [activeCall?.id, activeCall?.status, onUpdated]);

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
    if (!activeCall) return;
    setError("");
    try {
      onUpdated(await api.stopCall(activeCall.id));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not end the call.");
    }
  };

  if (!open) return null;
  const isLive = Boolean(activeCall && active.has(activeCall.status));

  return (
    <aside className="call-console" aria-label="Test call console">
      <div className="call-console__header">
        <div>
          <span className="eyebrow"><Bot size={14} /> Test call</span>
          <h2>{isLive ? "Call in progress" : "Run a flow"}</h2>
        </div>
        <button className="icon-button" onClick={onClose} title="Close call console" aria-label="Close call console">×</button>
      </div>

      {!isLive && (
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

      {activeCall && (
        <div className="call-live">
          <div className="call-live__summary">
            <div className={`status-orb status-orb--${activeCall.status}`} />
            <div>
              <strong>{activeCall.status.replace("_", " ")}</strong>
              <span>{activeCall.destination}</span>
            </div>
            {isLive && <button className="stop-button" onClick={stop}><CircleStop size={15} /> End</button>}
          </div>
          <div className="call-route">
            <span>{formatPhoneNumber(activeCall.callerId)}</span>
            <Route size={13} />
            <span>{activeCall.destination}</span>
          </div>
          {activeCall.classifierResult && (
            <div className="classification-result">
              <span>AI decision</span>
              <strong>{activeCall.classifierResult.intent}</strong>
              <small>{activeCall.classifierResult.sentiment} · {Math.round(activeCall.classifierResult.confidence * 100)}% confidence</small>
            </div>
          )}
          <div className="event-log">
            <div className="event-log__title"><span>Live event timeline</span><small>{activeCall.events.length} events</small></div>
            {activeCall.events.slice().reverse().map((event) => {
              const Icon = eventIcon(event.type);
              return (
                <div className="event-row" key={event.id}>
                  <span className={`event-row__icon event-row__icon--${event.type}`}><Icon size={14} /></span>
                  <div><strong>{event.title}</strong>{event.detail && <small>{event.detail}</small>}</div>
                  <time>{event.latencyMs ? `${event.latencyMs}ms` : timestamp(event.timestamp)}</time>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
      <div className="console-footnote">
        {trunk.mode === "simulated" ? "Safe simulator: no SIP INVITE is sent." : "Live FreeSWITCH gateway: SIP originations enabled."}
      </div>
    </aside>
  );
}
