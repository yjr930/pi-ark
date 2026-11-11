import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Copy, Maximize2, Plus, RefreshCw, TerminalSquare, ClipboardPaste, X } from "lucide-react";
import { api } from "../api";
import { readTerminalAppearance, subscribeTerminalAppearance } from "../terminal-preferences";
import { TerminalClient, type TerminalClientState } from "../terminal-client";
import type { TerminalInfo, Workspace } from "../types";

type Appearance = ReturnType<typeof readTerminalAppearance>;
type Notice = { message: string; error: boolean };
const connectionLabels = { connecting: "Connecting…", connected: "Connected", reconnecting: "Reconnecting…", disconnected: "Disconnected", exited: "Exited", closed: "Closed" };

function TerminalPane({ workspaceId, info, active, closing, appearance, onClient, onInfo, onState, onClosed, onNotice }: {
  workspaceId: string;
  info: TerminalInfo;
  active: boolean;
  closing: boolean;
  appearance: Appearance;
  onClient: (id: string, client: TerminalClient | null) => void;
  onInfo: (info: TerminalInfo) => void;
  onState: (id: string, state: TerminalClientState) => void;
  onClosed: (id: string) => void;
  onNotice: (message: string, error: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<TerminalClient | null>(null);
  const latest = useRef({ info, appearance, onClient, onInfo, onState, onClosed, onNotice });
  latest.current = { info, appearance, onClient, onInfo, onState, onClosed, onNotice };

  useEffect(() => {
    if (!hostRef.current) return;
    const client = new TerminalClient(hostRef.current, workspaceId, latest.current.info, latest.current.appearance, {
      onInfo: (updated) => latest.current.onInfo(updated),
      onState: (state) => latest.current.onState(info.id, state),
      onClosed: () => latest.current.onClosed(info.id),
      onNotice: (message, error) => latest.current.onNotice(message, error),
    });
    clientRef.current = client;
    latest.current.onClient(info.id, client);
    return () => { latest.current.onClient(info.id, null); clientRef.current = null; client.dispose(); };
  }, [workspaceId, info.id]);
  useEffect(() => { clientRef.current?.setActive(active); }, [active]);
  useEffect(() => { clientRef.current?.setClosing(closing); }, [closing]);
  useEffect(() => { clientRef.current?.setAppearance(appearance); }, [appearance]);

  return <div className="terminal-panel" id={`terminal-panel-${workspaceId}-${info.id}`} role="tabpanel" aria-labelledby={`terminal-tab-${workspaceId}-${info.id}`} hidden={!active} data-terminal-id={info.id}>
    <div className="terminal-host" ref={hostRef} />
  </div>;
}

export function Terminal({ workspace, active }: { workspace: Workspace; active: boolean }) {
  const selectionKey = `pi-ark-terminal-active:${window.location.pathname}:${workspace.id}`;
  const [tabs, setTabs] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState(() => { try { return localStorage.getItem(selectionKey) || ""; } catch { return ""; } });
  const [states, setStates] = useState<Record<string, TerminalClientState>>({});
  const [appearance, setAppearance] = useState(readTerminalAppearance);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const clients = useRef(new Map<string, TerminalClient>());
  const mounted = useRef(false);
  const initialized = useRef(false);
  const creatingRef = useRef(false);
  const closingRef = useRef(new Set<string>());
  const listRequest = useRef<Promise<void> | null>(null);
  const mutationRevision = useRef(0);
  const selectedId = tabs.some((tab) => tab.id === activeId) ? activeId : tabs[0]?.id || "";
  const selected = tabs.find((tab) => tab.id === selectedId);
  const selectedState = states[selectedId];

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => subscribeTerminalAppearance(setAppearance), []);
  useEffect(() => {
    if (active && selectedId) document.getElementById(`terminal-tab-${workspace.id}-${selectedId}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, selectedId, workspace.id]);
  useEffect(() => {
    if (!initialized.current || loading) return;
    if (selectedId !== activeId) setActiveId(selectedId);
    try { if (selectedId) localStorage.setItem(selectionKey, selectedId); else localStorage.removeItem(selectionKey); } catch { /* Keep the current selection in memory when browser storage is unavailable. */ }
  }, [activeId, selectedId, selectionKey, loading]);

  const showNotice = useCallback((message: string, error: boolean) => { if (mounted.current) setNotice({ message, error }); }, []);
  const removeTab = useCallback((id: string) => {
    if (!mounted.current) return;
    mutationRevision.current++;
    setTabs((current) => current.filter((tab) => tab.id !== id));
    setStates((current) => { const next = { ...current }; delete next[id]; return next; });
  }, []);
  const onInfo = useCallback((info: TerminalInfo) => { if (mounted.current) setTabs((current) => current.map((tab) => tab.id === info.id ? info : tab)); }, []);
  const onState = useCallback((id: string, state: TerminalClientState) => { if (mounted.current) setStates((current) => ({ ...current, [id]: state })); }, []);
  const onClient = useCallback((id: string, client: TerminalClient | null) => { if (client) clients.current.set(id, client); else clients.current.delete(id); }, []);

  const createTab = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    initialized.current = true;
    mutationRevision.current++;
    setCreating(true); setNotice(null);
    try {
      const dimensions = clients.current.values().next().value?.terminal;
      const info = await api.createTerminal(workspace.id, dimensions ? { cols: dimensions.cols, rows: dimensions.rows } : {});
      if (!mounted.current) return;
      setTabs((current) => current.some((tab) => tab.id === info.id) ? current : [...current, info]);
      setActiveId(info.id);
    } catch (reason) {
      showNotice(`Cannot create terminal: ${reason instanceof Error ? reason.message : "Request failed"}`, true);
    } finally {
      creatingRef.current = false;
      mutationRevision.current++;
      if (mounted.current) { setCreating(false); setLoading(false); }
    }
  }, [workspace.id, showNotice]);

  const syncTabs = useCallback(() => {
    if (listRequest.current) return listRequest.current;
    const revision = mutationRevision.current;
    const request = (async () => {
      try {
        const result = await api.terminals(workspace.id);
        if (!mounted.current || revision !== mutationRevision.current) return;
        const firstLoad = !initialized.current;
        initialized.current = true;
        const ids = new Set(result.terminals.map((tab) => tab.id));
        setTabs((current) => [...result.terminals, ...current.filter((tab) => closingRef.current.has(tab.id) && !ids.has(tab.id))]);
        setStates((current) => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id) || closingRef.current.has(id))));
        if (firstLoad && result.terminals.length === 0) await createTab();
      } catch (reason) {
        showNotice(`Cannot load terminal tabs: ${reason instanceof Error ? reason.message : "Request failed"}`, true);
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
    listRequest.current = request;
    void request.finally(() => { if (listRequest.current === request) listRequest.current = null; });
    return request;
  }, [workspace.id, createTab, showNotice]);

  useEffect(() => {
    if (!active) return;
    void syncTabs();
    const refresh = () => { if (document.visibilityState === "visible") void syncTabs(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 10000);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); window.clearInterval(timer); };
  }, [active, syncTabs]);

  async function closeTab(id: string) {
    if (closingRef.current.has(id)) return;
    closingRef.current.add(id);
    mutationRevision.current++;
    setClosing(new Set(closingRef.current));
    setNotice(null);
    const client = clients.current.get(id);
    client?.setClosing(true);
    try {
      await api.closeTerminal(workspace.id, id);
      removeTab(id);
    } catch (reason) {
      client?.setClosing(false);
      showNotice(`Cannot close terminal: ${reason instanceof Error ? reason.message : "Request failed"}`, true);
    } finally {
      mutationRevision.current++;
      closingRef.current.delete(id);
      if (mounted.current) setClosing(new Set(closingRef.current));
    }
  }

  function selectTab(id: string) {
    setActiveId(id);
    setNotice(null);
  }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabs[next].id);
    document.getElementById(`terminal-tab-${workspace.id}-${tabs[next].id}`)?.focus();
  }

  const retryVisible = selectedState && ["disconnected", "reconnecting"].includes(selectedState.connection);
  return <section className="terminal-page" data-testid="terminal-page" data-workspace-id={workspace.id}>
    <header className="page-header terminal-header">
      <div className="terminal-heading"><h2><TerminalSquare size={18} />Terminal</h2><p title={workspace.path}>{workspace.path}</p></div>
      <div className="terminal-toolbar" role="toolbar" aria-label="Terminal actions">
        <button type="button" aria-label="Copy terminal selection" title="Copy selection (Ctrl+Shift+C / ⌘C)" disabled={!selectedState?.hasSelection} onClick={() => void clients.current.get(selectedId)?.copy()}><Copy size={15} /><span>Copy</span></button>
        <button type="button" aria-label="Paste into terminal" title="Paste from clipboard" disabled={selectedState?.connection !== "connected" || closing.has(selectedId)} onClick={() => void clients.current.get(selectedId)?.paste()}><ClipboardPaste size={15} /><span>Paste</span></button>
        <button type="button" aria-label="Fit terminal" title="Fit terminal" disabled={!selected} onClick={() => clients.current.get(selectedId)?.fit()}><Maximize2 size={15} /><span>Fit</span></button>
      </div>
    </header>
    <div className="terminal-tabs-bar">
      <div className="terminal-tabs" role="tablist" aria-label="Terminal tabs" aria-orientation="horizontal">
        {tabs.map((tab, index) => <div className={`terminal-tab-item ${tab.id === selectedId ? "active" : ""}`} key={tab.id} role="presentation" data-terminal-id={tab.id}>
          <button className="terminal-tab" type="button" role="tab" id={`terminal-tab-${workspace.id}-${tab.id}`} aria-controls={`terminal-panel-${workspace.id}-${tab.id}`} aria-selected={tab.id === selectedId} tabIndex={tab.id === selectedId ? 0 : -1} onClick={() => selectTab(tab.id)} onKeyDown={(event) => navigateTabs(event, index)} title={tab.title}>
            <span className="terminal-tab-title">{tab.title}</span><span className={`terminal-tab-state ${tab.status}`}>{closing.has(tab.id) ? "Closing…" : tab.status === "exited" ? `Exited${tab.exitCode === undefined ? "" : ` (${tab.exitCode})`}` : "Running"}</span>
          </button>
          <button className="terminal-tab-close" type="button" aria-label={`Close terminal ${tab.title}`} title={`Close terminal ${tab.title}`} tabIndex={tab.id === selectedId ? 0 : -1} disabled={closing.has(tab.id)} onClick={() => void closeTab(tab.id)}><X size={13} /></button>
        </div>)}
      </div>
      <button className="terminal-add" type="button" aria-label="New terminal tab" title="New terminal tab" disabled={loading || creating} onClick={() => void createTab()}><Plus size={16} /></button>
    </div>
    {selected && <div className={`terminal-connection ${selectedState?.connection || "connecting"}`} data-testid="terminal-connection">
      <span role="status"><i />{closing.has(selectedId) ? "Closing terminal…" : selected.status === "exited" ? `Exited${selected.exitCode === undefined ? "" : ` (${selected.exitCode})`}` : connectionLabels[selectedState?.connection || "connecting"]}</span>
      {selectedState?.message && <span className="terminal-connection-message">{selectedState.message}</span>}
      {retryVisible && <button type="button" aria-label="Reconnect terminal" onClick={() => clients.current.get(selectedId)?.retry()}><RefreshCw size={12} />Retry</button>}
    </div>}
    {notice && <div className={`terminal-notice ${notice.error ? "error" : "success"}`} role={notice.error ? "alert" : "status"}><span>{notice.message}</span><button type="button" aria-label="Dismiss terminal message" onClick={() => setNotice(null)}><X size={13} /></button></div>}
    <div className="terminal-panels">
      {tabs.map((tab) => <TerminalPane key={tab.id} workspaceId={workspace.id} info={tab} active={active && tab.id === selectedId} closing={closing.has(tab.id)} appearance={appearance} onClient={onClient} onInfo={onInfo} onState={onState} onClosed={removeTab} onNotice={showNotice} />)}
      {tabs.length === 0 && <div className="terminal-empty" data-testid="terminal-empty"><TerminalSquare size={28} /><h3>{loading || creating ? "Opening terminal…" : "No terminal tabs"}</h3><p>{loading || creating ? "Restoring this workspace’s terminals." : "Create a terminal to run commands in this workspace."}</p>{!loading && !creating && <div><button className="primary-button" type="button" onClick={() => void createTab()}><Plus size={15} />New terminal</button><button className="secondary-button" type="button" onClick={() => void syncTabs()}><RefreshCw size={14} />Refresh tabs</button></div>}</div>}
    </div>
  </section>;
}
