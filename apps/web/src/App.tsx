import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Archive, Box, ChevronDown, ChevronLeft, ChevronRight, Files as FilesIcon, FolderPlus, Settings as Gear, Link2, LoaderCircle, Menu, MessageSquare, Plus, TerminalSquare } from "lucide-react";
import { api } from "./api";
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import { MarkdownLineBreaksContext } from "./components/Markdown";
import { NameDialog } from "./components/NameDialog";
import { SessionList } from "./components/SessionList";
import { WorkspaceList } from "./components/WorkspaceList";
import { appLocation, parseInternalSessionLink, readPermalink, sessionLocation, sessionPermalink, workspaceLocation, type AppPage, type InternalSessionTarget } from "./permalinks";
import { cacheSessionUiState, deleteCachedSessionSnapshot, getCachedSessionUiState, sessionCacheKey } from "./session-cache";
import { resolveActiveSessionId } from "./session-selection";
import { acknowledgeSessionStatus, mergeSessionStatuses, type SessionStatusMap } from "./session-status";
import { applyTheme } from "./theme";
import type { SessionInfo, UiSettings, Workspace } from "./types";

const Files = lazy(() => import("./components/Files").then((module) => ({ default: module.Files })));
const Notebook = lazy(() => import("./components/Notebook").then((module) => ({ default: module.Notebook })));
const Terminal = lazy(() => import("./components/Terminal").then((module) => ({ default: module.Terminal })));
const Settings = lazy(() => import("./components/Settings").then((module) => ({ default: module.Settings })));
type Page = AppPage;

export default function App() {
  const initialPermalink = useRef(readPermalink());
  const pendingInternalTarget = useRef<InternalSessionTarget | undefined>(undefined);
  const lastSessionByWorkspace = useRef<Record<string, string>>({});
  const pendingNewSessionByWorkspace = useRef<Record<string, string>>({});
  const openSessionIdsRef = useRef<Record<string, string[]>>({});
  const selectionRevision = useRef(0);
  const currentWorkspaceId = useRef("");
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [uiSettings, setUiSettings] = useState<UiSettings>({ theme: "ark-dark", hideReasoning: false, markdownLineBreaks: true });
  const [workspaceId, setWorkspaceId] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsWorkspaceId, setSessionsWorkspaceId] = useState("");
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [statusesByWorkspace, setStatusesByWorkspace] = useState<Record<string, SessionStatusMap>>({});
  const [openSessionIds, setOpenSessionIds] = useState<Record<string, string[]>>({});
  const sessionStatuses = statusesByWorkspace[workspaceId] || {};
  const [sessionId, setSessionId] = useState("");
  const [targetMessageId, setTargetMessageId] = useState(initialPermalink.current.messageId);
  const [leafEntryId, setLeafEntryId] = useState(initialPermalink.current.leafEntryId);
  const [page, setPage] = useState<Page>(initialPermalink.current.page);
  const [settingsVisited, setSettingsVisited] = useState(initialPermalink.current.page === "settings");
  const [terminalWorkspaces, setTerminalWorkspaces] = useState<string[]>([]);
  const [sidebar, setSidebar] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("pi-ark-sidebar-collapsed") === "true");
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(460, Math.max(220, Number(localStorage.getItem("pi-ark-sidebar-width")) || 280)));
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [workspacesExpanded, setWorkspacesExpanded] = useState(() => localStorage.getItem("pi-ark-workspaces-expanded") !== "false");
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [sessionLinkOpen, setSessionLinkOpen] = useState(false);
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [error, setError] = useState("");

  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    try {
      const [workspaceResult, ui] = await Promise.all([api.workspaces(), api.uiSettings()]);
      applyTheme(ui.theme); setUiSettings(ui);
      setWorkspaces(workspaceResult.workspaces);
      setWorkspaceId((current) => workspaceResult.workspaces.some((item) => item.id === current) ? current : workspaceResult.workspaces.find((item) => item.id === initialPermalink.current.workspaceId)?.id || workspaceResult.workspaces[0]?.id || "");
    } finally { setWorkspacesLoading(false); }
  }, []);

  useEffect(() => { api.session().then(() => { setAuth("in"); return loadWorkspaces(); }).catch(() => setAuth("out")); }, [loadWorkspaces]);
  useEffect(() => {
    if (auth !== "in") return;
    if (!workspaceId) { setSessions([]); setSessionsWorkspaceId(""); setSessionId(""); setSessionsLoading(false); return; }
    let active = true;
    const requestRevision = selectionRevision.current;
    setSessionId(""); setError(""); setSessionsLoading(true);
    api.sessions(workspaceId).then((result) => {
      if (!active) return;
      setSessions(result.sessions); setSessionsWorkspaceId(workspaceId); setSessionsLoading(false);
      if (selectionRevision.current !== requestRevision) { pendingInternalTarget.current = undefined; initialPermalink.current = { page: "agent" }; return; }
      const pendingTarget = pendingInternalTarget.current?.workspaceId === workspaceId ? pendingInternalTarget.current : undefined;
      const initialTarget = initialPermalink.current;
      const linkedSessionId = pendingTarget?.sessionId || (initialTarget.workspaceId === workspaceId ? initialTarget.sessionId : undefined);
      const rememberedSessionId = lastSessionByWorkspace.current[workspaceId];
      const selectedId = result.sessions.find((session) => session.id === linkedSessionId)?.id || result.sessions.find((session) => session.id === rememberedSessionId)?.id || result.sessions.find((session) => !session.archived && !session.subagentOrigin)?.id || "";
      setSessionId(selectedId);
      if (pendingTarget && selectedId === pendingTarget.sessionId) {
        setTargetMessageId(pendingTarget.messageId); setLeafEntryId(pendingTarget.leafEntryId); setPage("agent"); window.history.replaceState(null, "", sessionPermalink(workspaceId, selectedId, pendingTarget.messageId, pendingTarget.leafEntryId));
      } else {
        if (!linkedSessionId || selectedId !== linkedSessionId) { setTargetMessageId(undefined); setLeafEntryId(undefined); }
        if ((!initialTarget.messageId && !initialTarget.leafEntryId) || selectedId !== linkedSessionId) window.history.replaceState(null, "", appLocation(initialTarget.page, workspaceId, selectedId));
      }
      pendingInternalTarget.current = undefined; initialPermalink.current = { page: "agent" };
    }).catch((reason) => {
      if (!active) return;
      setSessionsLoading(false); setError(reason.message);
      if (selectionRevision.current !== requestRevision) return;
      setSessions([]); setSessionsWorkspaceId(workspaceId); setSessionId("");
    });
    return () => { active = false; };
  }, [workspaceId, auth]);

  useEffect(() => { currentWorkspaceId.current = workspaceId; }, [workspaceId]);

  useEffect(() => {
    if (page !== "agent" || !workspaceId || !sessionId || sessionsWorkspaceId !== workspaceId) return;
    if (!sessions.some((session) => session.id === sessionId)) return;
    lastSessionByWorkspace.current[workspaceId] = sessionId;
  }, [page, sessionId, sessions, sessionsWorkspaceId, workspaceId]);

  useEffect(() => {
    if (sessionsWorkspaceId !== workspaceId) return;
    const pending = pendingNewSessionByWorkspace.current[workspaceId];
    if (pending && sessions.some((session) => session.id === pending)) delete pendingNewSessionByWorkspace.current[workspaceId];
  }, [sessions, sessionsWorkspaceId, workspaceId]);

  useEffect(() => {
    if (auth !== "in" || !workspaceId) return;
    let current = true;
    const refresh = () => { void api.sessionStatuses(workspaceId).then((result) => {
      if (!current) return;
      setStatusesByWorkspace((workspaces) => ({ ...workspaces, [workspaceId]: mergeSessionStatuses(workspaces[workspaceId] || {}, result.statuses, page === "agent" && document.visibilityState === "visible" ? sessionId : undefined) }));
      const openIds = result.statuses.map((status) => status.id);
      openSessionIdsRef.current = { ...openSessionIdsRef.current, [workspaceId]: openIds };
      setOpenSessionIds((ids) => ({ ...ids, [workspaceId]: openIds }));
    }).catch(() => undefined); };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { current = false; window.clearInterval(timer); };
  }, [auth, page, sessionId, workspaceId]);

  useEffect(() => {
    if (page === "agent" && sessionId && document.visibilityState === "visible") setStatusesByWorkspace((workspaces) => ({ ...workspaces, [workspaceId]: acknowledgeSessionStatus(workspaces[workspaceId] || {}, sessionId) }));
  }, [page, sessionId, workspaceId]);

  useEffect(() => {
    if (page === "terminal" && workspaceId) setTerminalWorkspaces((current) => current.includes(workspaceId) ? current : [...current, workspaceId]);
  }, [page, workspaceId]);

  const workspace = workspaces.find((item) => item.id === workspaceId);
  const sessionListReady = sessionsWorkspaceId === workspaceId;
  const workspaceSessions = sessionListReady ? sessions : [];
  const loadingSessions = sessionsLoading || !sessionListReady;
  const selectedSession = workspaceSessions.find((item) => item.id === sessionId) || (sessionListReady && workspace && sessionId ? { id: sessionId, cwd: workspace.path, created: new Date().toISOString(), modified: new Date().toISOString(), messageCount: 0, firstMessage: "", pinned: false, archived: false, groups: [] } : undefined);
  const refreshSessions = useCallback((removedFromActiveId?: string) => {
    if (!workspaceId) return;
    void api.sessions(workspaceId).then((result) => {
      if (currentWorkspaceId.current !== workspaceId) return;
      if (removedFromActiveId && !result.sessions.some((session) => session.id === removedFromActiveId)) {
        deleteCachedSessionSnapshot(sessionCacheKey(workspaceId, removedFromActiveId));
        if (pendingNewSessionByWorkspace.current[workspaceId] === removedFromActiveId) delete pendingNewSessionByWorkspace.current[workspaceId];
      }
      setSessions(result.sessions); setSessionsWorkspaceId(workspaceId);
      setSessionId((current) => {
        const next = resolveActiveSessionId({ currentSessionId: current, sessions: result.sessions, removedFromActiveId, liveSessionIds: openSessionIdsRef.current[workspaceId] || [], pendingSessionId: pendingNewSessionByWorkspace.current[workspaceId] });
        if (next !== current) window.history.replaceState(null, "", appLocation(page, workspaceId, next));
        return next;
      });
    }).catch((reason) => setError(reason.message));
  }, [page, workspaceId]);

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      localStorage.setItem("pi-ark-sidebar-collapsed", String(!current));
      return !current;
    });
  }

  function toggleWorkspaces() {
    setWorkspacesExpanded((current) => {
      localStorage.setItem("pi-ark-workspaces-expanded", String(!current));
      return !current;
    });
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (sidebarCollapsed || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    setSidebarResizing(true);
    const move = (moveEvent: PointerEvent) => setSidebarWidth(Math.min(460, Math.max(220, startWidth + moveEvent.clientX - startX)));
    const finish = (upEvent: PointerEvent) => {
      const width = Math.min(460, Math.max(220, startWidth + upEvent.clientX - startX));
      setSidebarWidth(width); localStorage.setItem("pi-ark-sidebar-width", String(width)); setSidebarResizing(false);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish);
  }

  async function createSession() {
    if (!workspace) return;
    const pendingId = pendingNewSessionByWorkspace.current[workspace.id];
    if (pendingId && (pendingId === sessionId || openSessionIds[workspace.id]?.includes(pendingId))) {
      selectionRevision.current += 1;
      setTargetMessageId(undefined); setLeafEntryId(undefined); setSessionId(pendingId); setPage("agent"); setSidebar(false); window.history.replaceState(null, "", sessionLocation(workspace.id, pendingId));
      return;
    }
    const previousDraft = pendingId ? getCachedSessionUiState(sessionCacheKey(workspace.id, pendingId))?.draft : undefined;
    try {
      const created = await api.createSession(workspace.id);
      pendingNewSessionByWorkspace.current[workspace.id] = created.id;
      selectionRevision.current += 1;
      if (currentWorkspaceId.current !== workspace.id) return;
      if (previousDraft?.trim()) cacheSessionUiState(sessionCacheKey(workspace.id, created.id), { draft: previousDraft, attachments: [], disclosures: {} });
      setSessionId(created.id); setTargetMessageId(undefined); setLeafEntryId(undefined); setPage("agent"); setSidebar(false); window.history.replaceState(null, "", sessionLocation(workspace.id, created.id));
      refreshSessions();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Cannot create session"); }
  }

  async function openCreatedSession(createdSessionId: string) {
    if (!workspaceId) return;
    selectionRevision.current += 1;
    setSessions(await api.sessions(workspaceId).then((result) => result.sessions)); setSessionsWorkspaceId(workspaceId);
    setSessionId(createdSessionId); setTargetMessageId(undefined); setLeafEntryId(undefined); setPage("agent"); setSidebar(false); window.history.replaceState(null, "", sessionLocation(workspaceId, createdSessionId));
  }

  function selectWorkspace(id: string) {
    setWorkspaceId(id); setTargetMessageId(undefined); setLeafEntryId(undefined); setCreateGroupOpen(false); setPage("agent"); window.history.replaceState(null, "", workspaceLocation(id));
  }

  function selectPage(nextPage: Page) {
    if (nextPage === "settings") setSettingsVisited(true);
    setPage(nextPage); setSidebar(false); window.history.replaceState(null, "", nextPage === "agent" && workspaceId && sessionId ? sessionPermalink(workspaceId, sessionId, targetMessageId, leafEntryId) : appLocation(nextPage, workspaceId, sessionId));
  }

  function selectSession(id: string) {
    selectionRevision.current += 1;
    setStatusesByWorkspace((workspaces) => ({ ...workspaces, [workspaceId]: acknowledgeSessionStatus(workspaces[workspaceId] || {}, id) }));
    setSessionId(id); setTargetMessageId(undefined); setLeafEntryId(undefined); setPage("agent"); setSidebar(false); window.history.replaceState(null, "", sessionLocation(workspaceId, id));
  }

  function openNotebook() {
    setPage("notebook"); setSidebar(false); window.history.replaceState(null, "", appLocation("notebook", workspaceId, sessionId));
  }

  async function openInternalSessionLink(value: string) {
    const target = parseInternalSessionLink(value);
    if (!target) throw new Error("Enter a valid Pi-Ark session link");
    if (!workspaces.some((item) => item.id === target.workspaceId)) throw new Error("The linked workspace is not open");
    const result = await api.sessions(target.workspaceId);
    if (!result.sessions.some((item) => item.id === target.sessionId)) throw new Error("The linked session does not exist");
    setSessionLinkOpen(false); setShowArchivedSessions(false); setSidebar(false);
    selectionRevision.current += 1;
    if (target.workspaceId === workspaceId) {
      setSessions(result.sessions); setSessionsWorkspaceId(target.workspaceId); setSessionId(target.sessionId); setTargetMessageId(target.messageId); setLeafEntryId(target.leafEntryId); setPage("agent"); window.history.replaceState(null, "", sessionPermalink(target.workspaceId, target.sessionId, target.messageId, target.leafEntryId));
    } else {
      pendingInternalTarget.current = target; setWorkspaceId(target.workspaceId);
    }
  }

  function workspaceAdded(added: Workspace) {
    selectionRevision.current += 1;
    setWorkspaces((current) => [...current, added]);
    setWorkspaceId(added.id); setTargetMessageId(undefined); setLeafEntryId(undefined); setPage("agent"); setAddWorkspaceOpen(false); setSidebar(false); window.history.replaceState(null, "", workspaceLocation(added.id));
  }

  function workspaceRenamed(updated: Workspace) {
    setWorkspaces((current) => current.map((item) => item.id === updated.id ? updated : item));
  }

  function workspaceClosed(closed: Workspace) {
    setTerminalWorkspaces((current) => current.filter((id) => id !== closed.id));
    setWorkspaces((current) => {
      const remaining = current.filter((item) => item.id !== closed.id);
      setWorkspaceId((selected) => {
        const next = selected === closed.id ? remaining[0]?.id || "" : selected;
        if (next !== selected) window.history.replaceState(null, "", appLocation("agent", next));
        return next;
      });
      return remaining;
    });
  }

  if (auth === "loading") return <div className="app-loading"><Box size={28} /><span>Pi-Ark</span></div>;
  if (auth === "out") return <Login onLogin={() => { setAuth("in"); void loadWorkspaces(); }} />;

  return <MarkdownLineBreaksContext.Provider value={uiSettings.markdownLineBreaks}><div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${sidebarResizing ? "sidebar-resizing" : ""}`} onClickCapture={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[data-pi-ark-link]");
    if (!link?.dataset.piArkLink) return;
    event.preventDefault();
    void openInternalSessionLink(link.dataset.piArkLink).catch((reason) => setError(reason.message));
  }} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    {sidebar && <button className="sidebar-scrim" aria-label="Close sidebar" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? "sidebar-open" : ""} ${sidebarCollapsed ? "collapsed" : ""}`}>
      <div className="sidebar-brand"><div><Box size={18} /><strong>Pi-Ark</strong></div></div>
      <section className={`sidebar-section workspace-section ${workspacesExpanded ? "expanded" : "collapsed"}`}>
        <div className="sidebar-section-header"><button className="sidebar-section-toggle" type="button" aria-expanded={workspacesExpanded} onClick={toggleWorkspaces}><ChevronDown size={13} /><span>Workspaces</span></button><button className="icon-button" title="Add workspace" onClick={() => setAddWorkspaceOpen(true)}><Plus size={15} /></button></div>
        {workspacesExpanded && <WorkspaceList workspaces={workspaces} activeId={workspaceId} onSelect={selectWorkspace} onRenamed={workspaceRenamed} onClosed={workspaceClosed} />}
      </section>
      <nav className="sidebar-navigation sidebar-list">
        <button className={page === "agent" ? "active" : ""} onClick={() => selectPage("agent")}><MessageSquare size={16} /><span>Agent</span></button>
        <button className={page === "files" ? "active" : ""} onClick={() => selectPage("files")}><FilesIcon size={16} /><span>Files</span></button>
        <button className={page === "terminal" ? "active" : ""} onClick={() => selectPage("terminal")}><TerminalSquare size={16} /><span>Terminal</span></button>
        <button className={page === "settings" ? "active" : ""} onClick={() => selectPage("settings")}><Gear size={16} /><span>Settings</span></button>
      </nav>
      <section className="sidebar-section sessions-section">
        <div className="sidebar-section-header"><span>Sessions</span><div className="sidebar-header-actions"><button className={`icon-button ${showArchivedSessions ? "active" : ""}`} title={showArchivedSessions ? "Hide archived sessions" : "Show archived sessions"} aria-label={showArchivedSessions ? "Hide archived sessions" : "Show archived sessions"} aria-pressed={showArchivedSessions} onClick={() => setShowArchivedSessions((current) => !current)}><Archive size={14} /></button><button className="icon-button" title="Open Pi-Ark session link" aria-label="Open Pi-Ark session link" onClick={() => setSessionLinkOpen(true)}><Link2 size={14} /></button><button className="icon-button" title="New session group" aria-label="New session group" onClick={() => setCreateGroupOpen(true)}><FolderPlus size={14} /></button><button className="icon-button" title="New session" aria-label="New session" onClick={() => void createSession()}><Plus size={15} /></button></div></div>
        {workspace && <SessionList workspaceId={workspace.id} sessions={workspaceSessions} statuses={sessionStatuses} activeSessionId={sessionId} showArchived={showArchivedSessions} notebookActive={page === "notebook"} createGroupOpen={createGroupOpen} onSelect={selectSession} onOpenNotebook={openNotebook} onCreateGroupClose={() => setCreateGroupOpen(false)} onChanged={refreshSessions} />}
      </section>
    </aside>
    <div className="sidebar-resizer desktop-only" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" onPointerDown={beginSidebarResize}><button title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} onPointerDown={(event) => event.stopPropagation()} onClick={toggleSidebar}>{sidebarCollapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}</button></div>
    <div className="mobile-bar"><button onClick={() => setSidebar(true)}><Menu size={20} /></button><div><Box size={17} /><strong>{workspace?.name || "Pi-Ark"}</strong></div><button onClick={() => void createSession()}><Plus size={20} /></button></div>
    <main className="content-area">
      {error && <div className="global-error">{error}</div>}
      {!workspace && page !== "settings" && (workspacesLoading ? <div className="page-loading"><LoaderCircle size={20} />Loading workspaces</div> : <div className="no-session"><Box size={30} /><h2>No open workspace</h2><p>Add an existing server directory to start working.</p><button className="primary-button" onClick={() => setAddWorkspaceOpen(true)}><Plus size={16} />Add workspace</button></div>)}
      {workspace && page === "agent" && (selectedSession ? <Chat key={`${workspace.id}:${selectedSession.id}:${targetMessageId || "latest"}:${leafEntryId || "active"}`} workspace={workspace} session={selectedSession} sessions={workspaceSessions} sessionStatuses={sessionStatuses} targetMessageId={targetMessageId} leafEntryId={leafEntryId} hideReasoning={uiSettings.hideReasoning} onSessionChanged={refreshSessions} onSessionForked={(createdSessionId) => void openCreatedSession(createdSessionId)} /> : loadingSessions ? <div className="page-loading"><LoaderCircle size={20} />Loading sessions</div> : <div className="no-session"><MessageSquare size={30} /><h2>Start a new session</h2><p>Each session stays inside {workspace.name}.</p><button className="primary-button" onClick={() => void createSession()}><Plus size={16} />New session</button></div>)}
      <Suspense fallback={<div className="page-loading"><LoaderCircle size={20} />Loading page</div>}>
        {workspace && page === "notebook" && <Notebook key={workspace.id} workspace={workspace} />}
        {workspace && page === "files" && <Files workspace={workspace} />}
      </Suspense>
      {workspaces.filter((item) => terminalWorkspaces.includes(item.id) || (page === "terminal" && workspaceId === item.id)).map((item) => <div className="terminal-page-host" key={item.id} hidden={page !== "terminal" || workspaceId !== item.id} data-terminal-workspace={item.id}><Suspense fallback={<div className="page-loading"><LoaderCircle size={20} />Loading terminal</div>}><Terminal workspace={item} active={page === "terminal" && workspaceId === item.id} /></Suspense></div>)}
      {(settingsVisited || page === "settings") && <div className="settings-page-host" hidden={page !== "settings"}><Suspense fallback={<div className="page-loading"><LoaderCircle size={20} />Loading settings</div>}><Settings active={page === "settings"} uiSettings={uiSettings} onUiSettingsChanged={(next) => { setUiSettings(next); applyTheme(next.theme); }} /></Suspense></div>}
    </main>
    {addWorkspaceOpen && <AddWorkspaceDialog onClose={() => setAddWorkspaceOpen(false)} onAdded={workspaceAdded} />}
    {sessionLinkOpen && <NameDialog title="Open session link" description="Paste a Pi-Ark internal session or message link." label="Pi-Ark session link" submitLabel="Open session" icon={<Link2 size={18} />} onClose={() => setSessionLinkOpen(false)} onSubmit={openInternalSessionLink} />}
  </div></MarkdownLineBreaksContext.Provider>;
}
