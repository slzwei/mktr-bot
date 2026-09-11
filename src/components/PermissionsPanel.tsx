import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, CircleHelp, Clock3, Phone, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { api } from "../lib/api";
import type { Contact, ContactPermission, PermissionSummary } from "../lib/domain";
import { permissionDisplay } from "../lib/permission-display";
import { singaporeDateTime } from "../lib/operator-display";
import { EmptyState, LoadError, Pager, SearchField, SkeletonRows } from "./OperatorUI";

const PAGE_SIZE = 50;
type Filter = "all" | "dialable" | "blocked" | "expiring" | "unknown";

function VoiceRegister({ registers }: { registers: ContactPermission["registers"] }) {
  const Icon = registers === null ? CircleHelp : registers.noVoiceCall ? ShieldOff : Check;
  return <span data-testid="voice-register" className={`register-verdict register-verdict--${registers === null ? "unknown" : registers.noVoiceCall ? "blocked" : "clear"}`}><Icon size={14} aria-hidden="true" />{registers === null ? "Unknown · no verdict" : registers.noVoiceCall ? "Registered" : "Not registered"}</span>;
}

export function PermissionsPanel({ onManage }: { onManage: () => void }) {
  const [data, setData] = useState<{ contacts: Contact[]; summary: PermissionSummary }>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState("name");
  const [page, setPage] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    setLoading(true); setError("");
    void Promise.all([api.contacts(), api.permissionSummary()]).then(([contacts, summary]) => {
      if (!disposed) setData({ contacts, summary });
    }).catch((failure) => { if (!disposed) setError(failure instanceof Error ? failure.message : "Contact permissions could not be retrieved."); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [revision]);
  // Expiry labels are recomputed while the page remains open, with no paid checks.
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }); }, [page, search, filter, sort]);
  const rows = useMemo(() => {
    const permissions = new Map(data?.summary.contacts.map((entry) => [entry.phone, entry]));
    return (data?.contacts ?? []).map((contact) => {
      const permission = permissions.get(contact.phone);
      return { contact, permission, state: permissionDisplay(permission) };
    });
  }, [data]);
  const dialable = rows.filter(({ state }) => state.tone === "clear" || state.tone === "expiring").length;
  const expiring = rows.filter(({ state }) => state.tone === "expiring").length;
  const filtered = useMemo(() => rows.filter(({ contact, permission, state }) => {
    const needle = search.trim().toLowerCase();
    const match = `${contact.name} ${contact.phone} ${permission?.reference ?? ""}`.toLowerCase().includes(needle);
    return match && (filter === "all" || filter === "dialable" && ["clear", "expiring"].includes(state.tone) || filter === state.tone);
  }).sort((a, b) => {
    if (sort === "checked") return (b.permission?.checkedAt ?? "").localeCompare(a.permission?.checkedAt ?? "");
    if (sort === "expiry") return (a.permission?.clearanceExpiresAt ?? "9999").localeCompare(b.permission?.clearanceExpiresAt ?? "9999");
    return (a.contact.name || a.contact.phone).localeCompare(b.contact.name || b.contact.phone, "en-SG");
  }), [rows, search, filter, sort]);
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  useEffect(() => { setPage((current) => Math.min(current, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1))); }, [filtered.length]);
  const reset = () => { setSearch(""); setFilter("all"); setPage(0); };

  return <div className="operator-view permissions-view">
    <header className="operator-page-header"><div><h1>Contact permissions</h1><p>Understand who you can call, and the evidence behind each decision.</p></div><button className="secondary-button" onClick={onManage}>Manage evidence <ArrowUpRight size={16} /></button></header>
    <div className="permission-overview" aria-label="Permission summary">
      <div><span>Total contacts</span><strong>{loading || error ? "—" : rows.length.toLocaleString("en-SG")}</strong></div>
      <div><span>Dialable</span><strong>{loading || error ? "—" : dialable.toLocaleString("en-SG")}</strong></div>
      <div><span>Blocked or unverified</span><strong>{loading || error ? "—" : (rows.length - dialable).toLocaleString("en-SG")}</strong></div>
      <div><span>Clearance expiring</span><strong>{loading || error ? "—" : expiring.toLocaleString("en-SG")}<small>within 3 days</small></strong></div>
    </div>
    <div className="register-guidance"><Phone size={16} aria-hidden="true" /><p><strong>Voice is the Registry decision.</strong> Text and fax registration do not block voice calls. Unknown means no Registry verdict is available.</p></div>
    <section className="operator-surface" aria-label="Contact permission records">
      <div className="operator-filters">
        <SearchField label="Search contact permissions" value={search} onChange={(value) => { setSearch(value); setPage(0); }} placeholder="Search name, number or reference" />
        <label className="operator-filter">Permission<select value={filter} onChange={(event) => { setFilter(event.target.value as Filter); setPage(0); }}><option value="all">All permissions</option><option value="dialable">Dialable</option><option value="blocked">Blocked</option><option value="expiring">Expiring soon</option><option value="unknown">Unverified</option></select></label>
        <label className="operator-filter">Sort by<select value={sort} onChange={(event) => { setSort(event.target.value); setPage(0); }}><option value="name">Contact name</option><option value="checked">Latest evidence</option><option value="expiry">Earliest expiry</option></select></label>
        <button className="secondary-button filter-refresh" aria-label="Refresh permissions" title="Refresh permissions" disabled={loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} /></button>
      </div>
      {error ? <LoadError title="Could not load contact permissions" error={error} onRetry={() => setRevision((value) => value + 1)} /> : <>
        <div className="operator-table-scroll" ref={scroll} role="region" aria-label="Contact permissions table" tabIndex={0} aria-busy={loading}>
          <table className="operator-table permissions-table"><caption className="sr-only">Voice permission, all three PDPC registers and evidence. All dates are Singapore time.</caption>
            <colgroup><col className="permission-col-contact" /><col className="permission-col-state" /><col className="permission-col-voice" /><col className="permission-col-other" /><col className="permission-col-evidence" /><col className="permission-col-reference" /></colgroup>
            <thead><tr><th scope="col">Contact</th><th scope="col">Voice permission</th><th scope="col">Voice register<small>Call decision</small></th><th scope="col">Text &amp; fax registers<small>Reference only</small></th><th scope="col">Evidence dates<small>Singapore time</small></th><th scope="col">Evidence reference</th></tr></thead>
            {loading ? <SkeletonRows columns={6} /> : <tbody>{visible.map(({ contact, permission, state }) => {
              const Icon = state.tone === "clear" ? ShieldCheck : state.tone === "expiring" ? Clock3 : state.tone === "unknown" ? CircleHelp : ShieldOff;
              const detail = permission?.skipReason || state.detail;
              const registers = permission?.registers ?? null;
              return <tr key={contact.id} data-testid="contact-permission-row" className={`contact-permission--${state.tone}`}>
                <td><strong className="cell-truncate" title={contact.name || "Unnamed contact"}>{contact.name || "Unnamed contact"}</strong><span className="cell-secondary numeric" title={contact.phone}>{contact.phone}</span></td>
                <td><span className={`semantic-chip semantic-chip--${state.tone}`} title={state.label}><Icon size={13} aria-hidden="true" />{state.tone === "expiring" ? "Dialable · expiring" : state.label === "On the No Voice Call Register" ? "Blocked · voice register" : state.label}</span><span className="cell-secondary cell-truncate" title={detail}>{detail}</span>{permission?.basis && state.tone === "unknown" && <span className="cell-secondary">Manual DNC evidence</span>}</td>
                <td><VoiceRegister registers={registers} /></td>
                <td><div className="reference-register" data-testid="text-register"><span>Text</span><span>{registers === null ? "Unknown" : registers.noTextMessage ? "Registered" : "Not registered"}</span></div><div className="reference-register" data-testid="fax-register"><span>Fax</span><span>{registers === null ? "Unknown" : registers.noFax ? "Registered" : "Not registered"}</span></div></td>
                <td className="evidence-dates"><span className="cell-truncate" title={permission?.checkedAt ? `${singaporeDateTime(permission.checkedAt)} Singapore time` : "No evidence date recorded"}><small>Checked</small> {permission?.checkedAt ? <time dateTime={permission.checkedAt}>{singaporeDateTime(permission.checkedAt)}</time> : "Not recorded"}</span><span className="cell-truncate" title={permission?.clearanceExpiresAt ? `${singaporeDateTime(permission.clearanceExpiresAt)} Singapore time` : "No Registry expiry recorded"}><small>Expires</small> {permission?.clearanceExpiresAt ? <time dateTime={permission.clearanceExpiresAt}>{singaporeDateTime(permission.clearanceExpiresAt)}</time> : permission?.basis === "consent" ? "No Registry expiry" : "Not recorded"}</span></td>
                <td><span className={`cell-truncate ${permission?.reference ? "" : "secondary-text"}`} title={permission?.reference ?? "No evidence reference recorded"}>{permission?.reference || "Not recorded"}</span></td>
              </tr>;
            })}</tbody>}
          </table>
        </div>
        {!loading && filtered.length === 0 && <EmptyState title={rows.length ? "No matching contacts" : "No contacts yet"} action={<button className="secondary-button" onClick={rows.length ? reset : onManage}>{rows.length ? "Clear filters" : "Import contacts"}</button>}>{rows.length ? "Try another name, number or reference, or clear the permission filter." : "Import contacts in Campaigns to review their permission, Registry verdicts and evidence here."}</EmptyState>}
        <Pager label={loading ? "Loading contacts…" : `${filtered.length ? page * PAGE_SIZE + 1 : 0}–${Math.min((page + 1) * PAGE_SIZE, filtered.length)} of ${filtered.length.toLocaleString("en-SG")} contacts${search || filter !== "all" ? " matching filters" : ""}`} page={page + 1} disabled={loading} previous={page > 0 ? () => setPage(page - 1) : undefined} next={(page + 1) * PAGE_SIZE < filtered.length ? () => setPage(page + 1) : undefined} />
      </>}
    </section>
    <p className="operator-page-note">Evidence is shown as recorded. {data ? data.summary.dncEnabled ? "Registry checking is available in Campaigns." : "Automatic Registry checking is disabled." : "Registry checking availability has not been loaded."} Recorded consent can independently permit a voice call.</p>
  </div>;
}
