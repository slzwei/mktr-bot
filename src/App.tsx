import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AudioLines,
  Bot,
  ChevronDown,
  CircleHelp,
  FileClock,
  GitBranch,
  LoaderCircle,
  Menu,
  MonitorDot,
  PhoneCall,
  Play,
  Plus,
  RadioTower,
  Save,
  Settings,
  ShieldCheck,
  Trash2,
  Upload
} from "lucide-react";
import { LiveCallsView } from "./components/LiveCallsView";
import { LoadError } from "./components/OperatorUI";
import { latestCallSnapshot } from "./lib/call-snapshot";
import { CallConsole } from "./components/CallConsole";
import { ClipLibrary } from "./components/ClipLibrary";
import { FlowCanvas } from "./components/FlowCanvas";
import { TrunkPanel } from "./components/TrunkPanel";
import { SessionGate } from "./components/SignIn";
import { CampaignsPanel } from "./components/CampaignsPanel";
import { PermissionsPanel } from "./components/PermissionsPanel";
import { CallHistoryPanel } from "./components/CallHistoryPanel";
import { EventLogsView, HelpView, SettingsView } from "./components/SystemViews";
import { api, ApiError, type Operator } from "./lib/api";
import type { BootstrapData, CallSession, CallSummary, Clip, FlowDefinition } from "./lib/domain";
import { isCallInProgress } from "./lib/operator-display";

type View = "live" | "flows" | "clips" | "calls" | "permissions" | "trunk" | "campaigns" | "events" | "settings" | "help";

const navigation: { id: View; label: string; icon: typeof GitBranch }[] = [
  { id: "flows", label: "Flows", icon: GitBranch },
  { id: "clips", label: "Audio clips", icon: AudioLines },
  { id: "live", label: "Live calls", icon: MonitorDot },
  { id: "calls", label: "Call history", icon: FileClock },
  { id: "campaigns", label: "Campaigns", icon: PhoneCall },
  { id: "permissions", label: "Contact permissions", icon: ShieldCheck },
  { id: "trunk", label: "SIP trunk", icon: RadioTower }
];

function Workspace({ operator, signOut }: { operator: Operator; signOut: () => Promise<void> }) {
  const [data, setData] = useState<BootstrapData>();
  const [view, setView] = useState<View>("flows");
  const [activeFlowId, setActiveFlowId] = useState("");
  const [workingFlow, setWorkingFlow] = useState<FlowDefinition>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [callOpen, setCallOpen] = useState(false);
  const [activeCall, setActiveCall] = useState<CallSession>();
  const [historyCall, setHistoryCall] = useState<CallSummary>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string }>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [loadError, setLoadError] = useState("");
  const loaded = Boolean(data);

  const refreshOperations = useCallback(async () => {
    const bootstrap = await api.bootstrap();
    // Refresh operational state without replacing unsaved editor/clip changes.
    setData((current) => {
      if (!current) return current;
      const previous = new Map(current.calls.map((call) => [call.id, call]));
      const calls = bootstrap.calls.map((call) => latestCallSnapshot(previous.get(call.id), call));
      const newerCompletions = bootstrap.calls.filter((call, index) => isCallInProgress(call.status) && !isCallInProgress(calls[index].status)).length;
      return { ...current, calls, trunk: { ...bootstrap.trunk, activeCalls: Math.max(0, bootstrap.trunk.activeCalls - newerCompletions) } };
    });
    setActiveCall((current) => current ? latestCallSnapshot(current, bootstrap.calls.find((call) => call.id === current.id) ?? current) : current);
    setRefreshFailed(false);
  }, []);

  const loadWorkspace = useCallback(() => {
    setLoadError("");
    return api.bootstrap()
      .then((bootstrap) => {
        setData(bootstrap);
        const first = bootstrap.flows[0];
        if (first) {
          setActiveFlowId(first.id);
          setWorkingFlow(first);
        }
      })
      .catch((error) => setLoadError(error instanceof Error ? error.message : "Could not load the application."));
  }, []);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);

  useEffect(() => {
    if (!loaded) return;
    let stopped = false;
    let pending = false;
    const refresh = async () => {
      if (stopped || pending) return;
      pending = true;
      try { await refreshOperations(); }
      catch { if (!stopped) setRefreshFailed(true); }
      finally { pending = false; }
    };
    const timer = setInterval(() => { void refresh(); }, 2000);
    const focused = () => { void refresh(); };
    window.addEventListener("focus", focused);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener("focus", focused); };
  }, [refreshOperations, loaded]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  const selectFlow = (id: string) => {
    const flow = data?.flows.find((candidate) => candidate.id === id);
    if (!flow) return;
    setActiveFlowId(id);
    setWorkingFlow(structuredClone(flow));
    setSelectedNodeId(undefined);
  };

  const updateFlowInData = useCallback((flow: FlowDefinition) => {
    setData((current) => current ? { ...current, flows: current.flows.map((item) => item.id === flow.id ? flow : item) } : current);
    setWorkingFlow(flow);
  }, []);

  const save = async () => {
    if (!workingFlow) return;
    setSaving(true);
    try {
      const saved = await api.saveFlow(workingFlow);
      updateFlowInData(saved);
      setNotice({ kind: "success", text: "Draft saved." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof ApiError ? error.message : "Could not save the flow." });
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!workingFlow) return;
    setSaving(true);
    try {
      const saved = await api.saveFlow(workingFlow);
      const result = await api.publishFlow(saved.id);
      updateFlowInData(result.flow);
      setNotice({ kind: "success", text: `Published version ${result.flow.version}.` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof ApiError ? error.message : "Flow validation failed." });
    } finally {
      setSaving(false);
    }
  };

  const createFlow = async () => {
    setSaving(true);
    try {
      const flow = await api.createFlow(`Untitled flow ${(data?.flows.length ?? 0) + 1}`);
      setData((current) => current ? { ...current, flows: [...current.flows, flow] } : current);
      setActiveFlowId(flow.id);
      setWorkingFlow(flow);
      setSelectedNodeId(undefined);
      setView("flows");
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not create a flow." });
    } finally { setSaving(false); }
  };

  const deleteFlow = async () => {
    if (!workingFlow) return;
    setSaving(true);
    try {
      await api.deleteFlow(workingFlow.id);
      const remaining = data?.flows.filter((flow) => flow.id !== workingFlow.id) ?? [];
      setData((current) => current ? { ...current, flows: remaining } : current);
      setActiveFlowId(remaining[0]?.id ?? "");
      setWorkingFlow(remaining[0] ? structuredClone(remaining[0]) : undefined);
      setSelectedNodeId(undefined);
      setNotice({ kind: "success", text: "Flow removed. Published history is retained." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not delete the flow." });
    } finally { setSaving(false); }
  };

  const onLiveCallUpdate = useCallback((call: CallSession) => {
    setActiveCall((current) => current?.id === call.id ? latestCallSnapshot(current, call) : current);
    setData((current) => {
      if (!current) return current;
      const previous = current.calls.find((candidate) => candidate.id === call.id);
      const snapshot = latestCallSnapshot(previous, call);
      const calls = previous ? current.calls.map((candidate) => candidate.id === call.id ? snapshot : candidate) : [snapshot, ...current.calls];
      const difference = Number(isCallInProgress(snapshot.status)) - Number(Boolean(previous && isCallInProgress(previous.status)));
      return { ...current, calls, trunk: { ...current.trunk, activeCalls: Math.max(0, current.trunk.activeCalls + difference) } };
    });
  }, []);

  const onCallUpdate = useCallback((call: CallSession) => {
    setActiveCall((current) => latestCallSnapshot(current, call));
    onLiveCallUpdate(call);
  }, [onLiveCallUpdate]);

  const onClipCreated = (clip: Clip) => {
    setData((current) => current ? { ...current, clips: [clip, ...current.clips] } : current);
    setNotice({ kind: "success", text: "Audio clip added." });
  };

  const onClipRemoved = (id: string, archived?: Clip) => {
    setData((current) => current ? { ...current, clips: archived ? current.clips.map((clip) => clip.id === id ? archived : clip) : current.clips.filter((clip) => clip.id !== id) } : current);
    setNotice({ kind: "success", text: archived ? "Clip archived. Published history can still play its audio." : "Clip deleted." });
  };

  const calls = useMemo(() => data?.calls ?? [], [data?.calls]);
  const openTestCall = () => {
    setHistoryCall(undefined);
    setActiveCall((current) => current && isCallInProgress(current.status) ? current : undefined);
    setCallOpen(true);
  };

  if (!data) {
    if (loadError) return <main className="loading-screen"><LoadError title="Could not load voice control" error={loadError} onRetry={() => { void loadWorkspace(); }} /></main>;
    return <main className="loading-screen" role="status"><span className="brand-mark"><Bot size={22} /></span><LoaderCircle className="spin" size={22} /><strong>Loading voice control</strong></main>;
  }

  return (
    <div className={`app-shell ${callOpen ? "has-call-console" : ""} ${callOpen && (historyCall || activeCall && !isCallInProgress(activeCall.status)) ? "has-call-detail" : ""}`}>
      <header className="topbar">
        <div className="topbar__brand">
          <button className="mobile-menu" onClick={() => setSidebarOpen((open) => !open)} aria-label="Toggle navigation"><Menu size={19} /></button>
          <span className="brand-mark"><Bot size={20} /></span>
          <span>MKTR</span>
          <small>Voice Control</small>
        </div>
        <div className="topbar__status">
          <span className={`status-pill status-pill--${data.trunk.mode}`}><i /> {data.trunk.mode === "simulated" ? "Simulator" : "Singtel live"}</span>
          <button className="icon-button" title="Help" aria-label="Help" onClick={() => { setView("help"); setSidebarOpen(false); }}><CircleHelp size={18} /></button>
          <button className="account-button" aria-label="Sign out" title={`Sign out ${operator.email}`} onClick={signOut}><span>{operator.email.slice(0, 2).toUpperCase()}</span><ChevronDown size={14} /></button>
        </div>
      </header>

      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <nav>
          <span className="nav-label">Workspace</span>
          {navigation.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "is-active" : ""} onClick={() => { setView(item.id); setSidebarOpen(false); if (item.id === "live") setCallOpen(false); }}><Icon size={17} /> {item.label}</button>;
          })}
          <span className="nav-label nav-label--lower">System</span>
          <button className={view === "events" ? "is-active" : ""} onClick={() => { setView("events"); setSidebarOpen(false); }}><Activity size={17} /> Event logs</button>
          <button className={view === "settings" ? "is-active" : ""} onClick={() => { setView("settings"); setSidebarOpen(false); }}><Settings size={17} /> Settings</button>
        </nav>
        <div className="sidebar__trunk">
          <div><RadioTower size={16} /><span><strong>Singtel SIP</strong><small>{data.trunk.trunkUsername}</small></span></div>
          <div className="capacity-meter"><i style={{ width: `${(data.trunk.activeCalls / data.trunk.maxConcurrentCalls) * 100}%` }} /></div>
          <small>{data.trunk.activeCalls} of {data.trunk.maxConcurrentCalls} calls active</small>
          {refreshFailed && <small role="status">Refreshing connection…</small>}
        </div>
      </aside>

      <main className="main-view">
        {view === "flows" && workingFlow && (
          <>
            <div className="workspace-toolbar">
              <div className="flow-switcher">
                <span className="eyebrow">Call flow</span>
                <div>
                  <select aria-label="Current flow" value={activeFlowId} onChange={(event) => selectFlow(event.target.value)}>
                    {data.flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}
                  </select>
                  <span className={`version-tag version-tag--${workingFlow.status}`}>{workingFlow.status === "published" ? `Published v${workingFlow.version}` : "Draft"}</span>
                  <button className="icon-button icon-button--danger" onClick={deleteFlow} disabled={saving} aria-label="Delete flow" title="Delete flow; retain published history"><Trash2 size={15} /></button>
                </div>
              </div>
              <div className="toolbar-actions">
                <button className="secondary-button" onClick={createFlow} disabled={saving}><Plus size={15} /> New flow</button>
                <button className="secondary-button" onClick={save} disabled={saving}>{saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />} Save</button>
                <button className="secondary-button" onClick={publish} disabled={saving}><Upload size={15} /> Publish</button>
                <button className="primary-button" onClick={openTestCall}><Play size={15} fill="currentColor" /> Test call</button>
              </div>
            </div>
            <FlowCanvas key={workingFlow.id} flow={workingFlow} clips={data.clips} selectedNodeId={selectedNodeId} onSelectedNodeChange={setSelectedNodeId} onChange={(flow) => setWorkingFlow({ ...flow, status: "draft" })} />
          </>
        )}

        {view === "flows" && !workingFlow && <div className="empty-history empty-flows"><GitBranch size={28} /><strong>No flows yet</strong><span>Create a flow to start with a simple Start → End path.</span><button className="primary-button" onClick={createFlow} disabled={saving}><Plus size={15} /> New flow</button></div>}

        {view === "live" && <LiveCallsView calls={calls} flows={data.flows} trunk={data.trunk} refreshFailed={refreshFailed} onUpdated={onLiveCallUpdate} onCampaigns={() => setView("campaigns")} onFlows={() => setView("flows")} />}
        {view === "clips" && <ClipLibrary clips={data.clips} onCreated={onClipCreated} onRemoved={onClipRemoved} />}
        {view === "trunk" && <TrunkPanel trunk={data.trunk} />}
        {view === "campaigns" && <CampaignsPanel flows={data.flows} canManageWebhooks={operator.role === "admin"} />}
        {view === "permissions" && <PermissionsPanel onManage={() => setView("campaigns")} />}
        {view === "events" && <EventLogsView calls={calls} />}
        {view === "settings" && <SettingsView />}
        {view === "help" && <HelpView />}
        {view === "calls" && <CallHistoryPanel onSelect={(call) => { setHistoryCall(call); setActiveCall(undefined); setCallOpen(true); }} onNewCall={openTestCall} />}
      </main>

      <CallConsole open={callOpen} flows={data.flows} trunk={data.trunk} activeCall={activeCall} historyCall={historyCall} onClose={() => setCallOpen(false)} onStarted={onCallUpdate} onUpdated={onCallUpdate} />
      {notice && <div className={`toast toast--${notice.kind}`}><ShieldCheck size={16} /> {notice.text}</div>}
    </div>
  );
}

export default function App() {
  return <SessionGate>{(operator, signOut) => <Workspace operator={operator} signOut={signOut} />}</SessionGate>;
}
