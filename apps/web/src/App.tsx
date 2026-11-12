import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Archive, Box, ChevronDown, ChevronLeft, ChevronRight, Files as FilesIcon, FolderPlus, Settings as Gear, Link2, LoaderCircle, Menu, MessageSquare, Plus, TerminalSquare } from "lucide-react";
import { api } from "./api";
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import { MarkdownLineBreaksContext } from "./components/Markdown";
import { FileLinksContext } from "./file-links";
import { initializeFileLinks } from "./file-link-dom";
import { NameDialog } from "./components/NameDialog";
import { SessionList } from "./components/SessionList";
import { WorkspaceList } from "./components/WorkspaceList";
import { appLocation, fileLocation, parseInternalSessionLink, readPermalink, sessionLocation, sessionPermalink, workspaceLocation, type AppPage, type InternalSessionTarget } from "./permalinks";
import { basePath } from "./base-path";
import { readAgentReturnPosition, withAgentReturnPosition } from "./navigation-history";
import { cacheSessionUiState, deleteCachedSessionSnapshot, getCachedSessionUiState, initializeSessionCache, sessionCacheKey } from "./session-cache";
import { resolveActiveSessionId } from "./session-selection";
import { acknowledgeSessionStatus, countWorkingSessions, mergeSessionStatuses, type SessionStatusMap } from "./session-status";
import { readAppearance, saveAppearance, subscribeAppearance, type AppearanceSettings } from "./appearance";
import type { SessionInfo, Workspace } from "./types";

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
  const [appearance, setAppearance] = useState<AppearanceSettings>(readAppearance);
  const [workspaceId, setWorkspaceId] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsWorkspaceId, setSessionsWorkspaceId] = useState("");
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [statusesByWorkspace, setStatusesByWorkspace] = useState<Record<string, SessionStatusMap>>({});
  const [openSessionIds, setOpenSessionIds] = useState<Record<string, string[]>>({});
  const sessionStatuses = statusesByWorkspace[workspaceId] || {};
  const workingCounts = useMemo(() => Object.fromEntries(workspaces.map((item) => [item.id, countWorkingSessions(statusesByWorkspace[item.id] || {})])), [workspaces, statusesByWorkspace]);
  const [sessionId, setSessionId] = useState("");
  const [targetMessageId, setTargetMessageId] = useState(initialPermalink.current.messageId);
  const [leafEntryId, setLeafEntryId] = useState(initialPermalink.current.leafEntryId);
  const [page, setPage] = useState<Page>(initialPermalink.current.page);
  const [restorePosition, setRestorePosition] = useState(() => readAgentReturnPosition(window.history.state, initialPermalink.current));
  const [historyRevision, setHistoryRevision] = useState(0);
  const [fileTarget, setFileTarget] = useState(() => ({ workspaceId: initialPermalink.current.workspaceId, path: initialPermalink.current.filePath || "", type: initialPermalink.current.fileType || "directory" as "file" | "directory", revision: 0 }));
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
      const workspaceResult = await api.workspaces();
      setWorkspaces(workspaceResult.workspaces);
      setWorkspaceId((current) => workspaceResult.workspaces.some((item) => item.id === current) ? current : workspaceResult.workspaces.find((item) => item.id === initialPermalink.current.workspaceId)?.id || workspaceResult.workspaces[0]?.id || "");
    } finally { setWorkspacesLoading(false); }
  }, []);

  const startSession = useCallback(async () => {
    const session = await api.session();
    await initializeSessionCache(`${basePath || "/"}:${session.username}`);
    await initializeFileLinks();
    setAuth("in");
    await loadWorkspaces();
  }, [loadWorkspaces]);
  useEffect(() => { void startSession().catch(() => setAuth("out")); }, [startSession]);
  useEffect(() => subscribeAppearance(setAppearance), []);
  const changeAppearance = useCallback((next: AppearanceSettings) => { setAppearance(saveAppearance(next)); }, []);
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
        if ((!initialTarget.messageId && !initialTarget.leafEntryId) || selectedId !== linkedSessionId) window.history.replaceState(null, "", initialTarget.page === "files" && initialTarget.filePath !== undefined ? fileLocation(workspaceId, initialTarget.filePath, initialTarget.fileType || "file", selectedId) : appLocation(initialTarget.page, workspaceId, selectedId));
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
    if (auth !== "in") return;
    const restoreHistory = () => {
      const target = readPermalink();
      const targetWorkspace = target.workspaceId || workspaceId;
      if (!workspaces.some((item) => item.id === targetWorkspace)) { setError("The linked workspace is not open"); return; }
      selectionRevision.current += 1;
      pendingInternalTarget.current = undefined;
      setRestorePosition(readAgentReturnPosition(window.history.state, target));
      setHistoryRevision((revision) => revision + 1);
      setPage(target.page); setSidebar(false); setError("");
      setTargetMessageId(target.messageId); setLeafEntryId(target.leafEntryId);
      if (target.page === "settings") setSettingsVisited(true);
      if (target.page === "files") setFileTarget((current) => ({ workspaceId: targetWorkspace, path: target.filePath || "", type: target.fileType || "directory", revision: current.revision + 1 }));
      if (targetWorkspace === workspaceId) {
        setSessionId(target.sessionId || lastSessionByWorkspace.current[targetWorkspace] || "");
        initialPermalink.current = { page: "agent" };
      } else {
        initialPermalink.current = target;
        setWorkspaceId(targetWorkspace);
      }
    };
    window.addEventListener("popstate", restoreHistory);
    return () => window.removeEventListener("popstate", restoreHistory);
  }, [auth, workspaceId, workspaces]);

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
    if (auth !== "in" || workspaces.length === 0) return;
    let current = true;
    const refresh = () => {
      for (const item of workspaces) {
        void api.sessionStatuses(item.id).then((result) => {
          if (!current) return;
          const viewed = item.id === currentWorkspaceId.current && page === "agent" && document.visibilityState === "visible" ? sessionId : undefined;
          setStatusesByWorkspace((statuses) => ({ ...statuses, [item.id]: mergeSessionStatuses(statuses[item.id] || {}, result.statuses, viewed) }));
          if (item.id !== currentWorkspaceId.current) return;
          const openIds = result.statuses.map((status) => status.id);
          openSessionIdsRef.current = { ...openSessionIdsRef.current, [item.id]: openIds };
          setOpenSessionIds((ids) => ({ ...ids, [item.id]: openIds }));
        }).catch(() => undefined);
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { current = false; window.clearInterval(timer); };
  }, [auth, page, sessionId, workspaceId, workspaces]);

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
    setRestorePosition(undefined);
    setWorkspaceId(id); setTargetMessageId(undefined); setLeafEntryId(undefined); setCreateGroupOpen(false); setPage("agent"); window.history.replaceState(null, "", workspaceLocation(id));
  }

  function selectPage(nextPage: Page) {
    setRestorePosition(undefined);
    if (nextPage === "settings") setSettingsVisited(true);
    setPage(nextPage); setSidebar(false); window.history.replaceState(null, "", nextPage === "agent" && workspaceId && sessionId ? sessionPermalink(workspaceId, sessionId, targetMessageId, leafEntryId) : nextPage === "files" && fileTarget.workspaceId === workspaceId ? fileLocation(workspaceId, fileTarget.path, fileTarget.type, sessionId) : appLocation(nextPage, workspaceId, sessionId));
  }

  function openFileTarget(path: string, type: "file" | "directory", targetWorkspaceId = workspaceId) {
    if (!workspaces.some((item) => item.id === targetWorkspaceId)) return;
    const destination = fileLocation(targetWorkspaceId, path, type, targetWorkspaceId === workspaceId ? sessionId : undefined);
    if (page === "agent" && sessionId) {
      const conversation = document.querySelector<HTMLDivElement>(".conversation");
      const position = { workspaceId, sessionId, messageId: targetMessageId, leafEntryId, scrollTop: conversation?.scrollTop || 0, followOutput: conversation ? conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight <= 96 : true };
      window.history.replaceState(withAgentReturnPosition(window.history.state, position), "");
      window.history.pushState(null, "", destination);
    } else window.history.replaceState(window.history.state, "", destination);
    setRestorePosition(undefined);
    setFileTarget((current) => ({ workspaceId: targetWorkspaceId, path, type, revision: current.revision + 1 }));
    setWorkspaceId(targetWorkspaceId); setPage("files"); setSidebar(false);
  }

  function selectSession(id: string) {
    setRestorePosition(undefined);
    selectionRevision.current += 1;
    setStatusesByWorkspace((workspaces) => ({ ...workspaces, [workspaceId]: acknowledgeSessionStatus(workspaces[workspaceId] || {}, id) }));
    setSessionId(id); setTargetMessageId(undefined); setLeafEntryId(undefined); setPage("agent"); setSidebar(false); window.history.replaceState(null, "", sessionLocation(workspaceId, id));
  }

  function openNotebook() {
    setPage("notebook"); setSidebar(false); window.history.replaceState(null, "", appLocation("notebook", workspaceId, sessionId));
  }

  async function openInternalSessionLink(value: string) {
    setRestorePosition(undefined);
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

  function workspaceMoved(next: Workspace[]) {
    setWorkspaces(next);
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
  if (auth === "out") return <Login onLogin={() => { void startSession().catch(() => setAuth("out")); }} />;

  return <MarkdownLineBreaksContext.Provider value={appearance.markdownLineBreaks}><FileLinksContext.Provider value={workspace ? { workspaceId: workspace.id } : undefined}><div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${sidebarResizing ? "sidebar-resizing" : ""}`} onClickCapture={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
    const fileLink = event.target.closest<HTMLAnchorElement>('a[data-pi-ark-file-link="true"]');
    if (fileLink) {
      const url = new URL(fileLink.href, window.location.href);
      const linkedWorkspace = url.searchParams.get("workspace");
      if (url.origin === window.location.origin && url.searchParams.get("page") === "files" && url.searchParams.has("path") && linkedWorkspace) {
        event.preventDefault();
        openFileTarget(url.searchParams.get("path")!, url.searchParams.get("kind") === "directory" ? "directory" : "file", linkedWorkspace);
      }
      return;
    }
    const link = event.target.closest<HTMLAnchorElement>("a[data-pi-ark-link]");
    if (!link?.dataset.piArkLink) return;
    event.preventDefault();
    void openInternalSessionLink(link.dataset.piArkLink).catch((reason) => setError(reason.message));
  }} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    {sidebar && <button className="sidebar-scrim" aria-label="Close sidebar" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? "sidebar-open" : ""} ${sidebarCollapsed ? "collapsed" : ""}`}>
      <div className="sidebar-brand"><div><Box size={22} /><strong>Pi-Ark</strong></div></div>
      <section className={`sidebar-section workspace-section ${workspacesExpanded ? "expanded" : "collapsed"}`}>
        <div className="sidebar-section-header"><button className="sidebar-section-toggle" type="button" aria-expanded={workspacesExpanded} onClick={toggleWorkspaces}><ChevronDown size={13} /><span>Workspaces</span></button><button className="icon-button" title="Add workspace" onClick={() => setAddWorkspaceOpen(true)}><Plus size={15} /></button></div>
        {workspacesExpanded && <WorkspaceList workspaces={workspaces} activeId={workspaceId} workingCounts={workingCounts} showWorkingCount={appearance.showWorkingCount} onSelect={selectWorkspace} onRenamed={workspaceRenamed} onMoved={workspaceMoved} onClosed={workspaceClosed} />}
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
    <div className="mobile-bar"><button onClick={() => setSidebar(true)}><Menu size={20} /></button><div><Box size={20} /><strong>{workspace?.name || "Pi-Ark"}</strong></div><button onClick={() => void createSession()}><Plus size={20} /></button></div>
    <main className="content-area">
      {error && <div className="global-error">{error}</div>}
      {!workspace && page !== "settings" && (workspacesLoading ? <div className="page-loading"><LoaderCircle size={20} />Loading workspaces</div> : <div className="no-session"><Box size={30} /><h2>No open workspace</h2><p>Add an existing server directory to start working.</p><button className="primary-button" onClick={() => setAddWorkspaceOpen(true)}><Plus size={16} />Add workspace</button></div>)}
      {workspace && page === "agent" && (selectedSession ? <Chat key={`${workspace.id}:${selectedSession.id}:${targetMessageId || "latest"}:${leafEntryId || "active"}:${historyRevision}`} restorePosition={restorePosition?.workspaceId === workspace.id && restorePosition.sessionId === selectedSession.id && restorePosition.messageId === targetMessageId && restorePosition.leafEntryId === leafEntryId ? restorePosition : undefined} workspace={workspace} session={selectedSession} sessions={workspaceSessions} sessionStatuses={sessionStatuses} targetMessageId={targetMessageId} leafEntryId={leafEntryId} hideReasoning={appearance.hideReasoning} onSessionChanged={refreshSessions} onSessionForked={(createdSessionId) => void openCreatedSession(createdSessionId)} /> : loadingSessions ? <div className="page-loading"><LoaderCircle size={20} />Loading sessions</div> : <div className="no-session"><MessageSquare size={30} /><h2>Start a new session</h2><p>Each session stays inside {workspace.name}.</p><button className="primary-button" onClick={() => void createSession()}><Plus size={16} />New session</button></div>)}
      <Suspense fallback={<div className="page-loading"><LoaderCircle size={20} />Loading page</div>}>
        {workspace && page === "notebook" && <Notebook key={workspace.id} workspace={workspace} />}
        {workspace && page === "files" && <Files key={workspace.id} workspace={workspace} target={fileTarget.workspaceId === workspaceId ? fileTarget : undefined} onNavigate={openFileTarget} />}
      </Suspense>
      {workspaces.filter((item) => terminalWorkspaces.includes(item.id) || (page === "terminal" && workspaceId === item.id)).map((item) => <div className="terminal-page-host" key={item.id} hidden={page !== "terminal" || workspaceId !== item.id} data-terminal-workspace={item.id}><Suspense fallback={<div className="page-loading"><LoaderCircle size={20} />Loading terminal</div>}><Terminal workspace={item} active={page === "terminal" && workspaceId === item.id} /></Suspense></div>)}
      {(settingsVisited || page === "settings") && <div className="settings-page-host" hidden={page !== "settings"}><Suspense fallback={<div className="page-loading"><LoaderCircle size={20} />Loading settings</div>}><Settings active={page === "settings"} appearance={appearance} onAppearanceChange={changeAppearance} /></Suspense></div>}
    </main>
    {addWorkspaceOpen && <AddWorkspaceDialog onClose={() => setAddWorkspaceOpen(false)} onAdded={workspaceAdded} />}
    {sessionLinkOpen && <NameDialog title="Open session link" description="Paste a Pi-Ark internal session or message link." label="Pi-Ark session link" submitLabel="Open session" icon={<Link2 size={18} />} onClose={() => setSessionLinkOpen(false)} onSubmit={openInternalSessionLink} />}
  </div></FileLinksContext.Provider></MarkdownLineBreaksContext.Provider>;
}
