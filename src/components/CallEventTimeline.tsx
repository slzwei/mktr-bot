import { CircleStop, Clock3, Phone, RadioTower, Route, Sparkles, Volume2 } from "lucide-react";
import type { CallEvent } from "../lib/domain";
import { singaporeDateTime, singaporeTime } from "../lib/operator-display";

const eventIcon = (type: CallEvent["type"]) => {
  if (type === "clip_playing") return Volume2;
  if (type === "classified") return Sparkles;
  if (type === "branch_selected") return Route;
  if (type === "dialing" || type === "ringing" || type === "answered") return Phone;
  if (type === "listening" || type === "transcript_final") return RadioTower;
  if (type === "ended") return CircleStop;
  return Clock3;
};

export function CallEventTimeline({ events, live, scrollable = false }: { events: CallEvent[]; live: boolean; scrollable?: boolean }) {
  return <div className="event-log call-event-timeline" aria-live="off">
    <div className="event-log__title"><span>{live ? "Live event timeline" : "Event timeline"}</span><small>{events.length} events · SGT</small></div>
    <div className={scrollable ? "call-event-scroll" : undefined} role={scrollable ? "region" : undefined} aria-label={scrollable ? "Technical events, newest first" : undefined} tabIndex={scrollable ? 0 : undefined}>
      {events.slice().reverse().map((event) => {
        const Icon = eventIcon(event.type);
        return <div className="event-row" key={event.id}>
          <span className={`event-row__icon event-row__icon--${event.type}`}><Icon size={14} aria-hidden="true" /></span>
          <div><strong>{event.title}</strong>{event.detail && <small>{event.detail}</small>}</div>
          <div className="event-row__timing"><time dateTime={event.timestamp} title={`${singaporeDateTime(event.timestamp)} Singapore time`}>{singaporeTime(event.timestamp)}</time>{event.latencyMs !== undefined && <small>{event.latencyMs} ms</small>}</div>
        </div>;
      })}
      {events.length === 0 && <p className="secondary-text">No technical events recorded.</p>}
    </div>
  </div>;
}
