import { AlertCircle, ChevronLeft, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import type { CallOutcome, CallStatus } from "../lib/domain";
import { isCallInProgress, outcomeLabels, singaporeDate, singaporeDateTime, singaporeTime } from "../lib/operator-display";

export function SearchField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="operator-search"><span className="sr-only">{label}</span><Search size={16} aria-hidden="true" />
    <input type="search" maxLength={120} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    {value && <button type="button" aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onChange("")}><X size={16} /></button>}
  </label>;
}

export function DateCell({ value, empty = "Not recorded" }: { value?: string | null; empty?: string }) {
  return value ? <time className="date-cell" dateTime={value} title={`${singaporeDateTime(value)} Singapore time`}><span>{singaporeDate(value)}</span><small>{singaporeTime(value)}</small></time> : <span className="secondary-text">{empty}</span>;
}

export function OutcomeChip({ status, outcome }: { status: CallStatus; outcome?: CallOutcome }) {
  const live = isCallInProgress(status);
  const tone = live ? "info" : outcome === "failed" || status === "failed" ? "blocked" : outcome === "interested" || outcome === "completed" ? "clear" : outcome === "callback" ? "expiring" : "neutral";
  return <span className={`semantic-chip semantic-chip--${tone}`}>{live ? "In progress" : outcome ? outcomeLabels[outcome] : status === "failed" ? "Failed" : "Ended · no outcome"}</span>;
}

export function LoadError({ title, error, onRetry }: { title: string; error: string; onRetry: () => void }) {
  return <div className="operator-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><div><strong>{title}</strong><p>{error} Try again to reload the latest records.</p></div><button className="secondary-button" onClick={onRetry}><RefreshCw size={14} /> Try again</button></div>;
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="operator-empty"><h2>{title}</h2><p>{children}</p>{action}</div>;
}

export function SkeletonRows({ columns, rows = 7 }: { columns: number; rows?: number }) {
  return <tbody aria-hidden="true">{Array.from({ length: rows }, (_, index) => <tr className="skeleton-row" key={index}>{Array.from({ length: columns }, (_, column) => <td key={column}><span className="skeleton-line" /><span className="skeleton-line skeleton-line--short" /></td>)}</tr>)}</tbody>;
}

export function Pager({ label, page, previous, next, disabled = false }: { label: string; page: number; previous?: () => void; next?: () => void; disabled?: boolean }) {
  return <footer className="operator-pager"><span role="status" aria-live="polite">{label}</span><nav aria-label="Pagination"><span>Page {page}</span><button className="secondary-button" aria-label="Previous page" disabled={disabled || !previous} onClick={previous}><ChevronLeft size={16} /> Previous</button><button className="secondary-button" aria-label="Next page" disabled={disabled || !next} onClick={next}>Next <ChevronRight size={16} /></button></nav></footer>;
}
