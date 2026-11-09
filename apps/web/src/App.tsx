import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Box, ChevronDown, Files as FilesIcon, LoaderCircle, LogOut, Menu, MessageSquare, PanelLeftClose, Plus, TerminalSquare, X } from "lucide-react";
import { api } from "./api";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import type { SessionInfo, Workspace } from "./types";

const Files = lazy(() => import("./components/Files").then((module) => ({ default: module.Files })));
const Terminal = lazy(() => import("./components/Terminal").then((module) => ({ default: module.Terminal })));
type Page = "agent" | "files" | "terminal";

export default function App() {
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [page, setPage] = useState<Page>("agent");
  const [sidebar, setSidebar] = useState(false);
  const [error, setError] = useState("");

  const loadWorkspaces = useCallback(async () => {
    const result = await api.workspaces();
    setWorkspaces(result.workspaces);
    setWorkspaceId((current) => current || result.workspaces[0]?.id || "");
  }, []);

  useEffect(() => { api.session().then(() => { setAuth("in"); return loadWorkspaces(); }).catch(() => setAuth("out")); }, [loadWorkspaces]);
  useEffect(() => {
    if (!workspaceId || auth !== "in") return;
    setSessionId(""); setError("");
    api.sessions(workspaceId).then((result) => { setSessions(result.sessions); setSessionId(result.sessions[0]?.id || ""); }).catch((reason) => setError(reason.message));
  }, [workspaceId, auth]);

  const workspace = workspaces.find((item) => item.id === workspaceId);
  const refreshSessions = useCallback(() => {
    if (!workspaceId) return;
    void api.sessions(workspaceId).then((result) => setSessions(result.sessions)).catch((reason) => setError(reason.message));
  }, [workspaceId]);

  async function createSession() {
    if (!workspace) return;
    try {
      const created = await api.createSession(workspace.id);
      setSessions(await api.sessions(workspace.id).then((result) => result.sessions));
      setSessionId(created.id); setPage("agent"); setSidebar(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Cannot create session"); }
  }

  if (auth === "loading") return <div className="app-loading"><Box size={28} /><span>Pi-Ark</span></div>;
  if (auth === "out") return <Login onLogin={() => { setAuth("in"); void loadWorkspaces(); }} />;

  return <div className="app-shell">
    {sidebar && <button className="sidebar-scrim" aria-label="Close sidebar" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? "sidebar-open" : ""}`}>
      <div className="sidebar-brand"><div><Box size={18} /><strong>Pi-Ark</strong></div><button className="mobile-only" onClick={() => setSidebar(false)}><X size={18} /></button></div>
      <div className="workspace-select"><label>Workspace</label><div><select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{workspaces.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><ChevronDown size={14} /></div>{workspace && <small>{workspace.path}</small>}</div>
      <nav className="main-nav">
        <button className={page === "agent" ? "active" : ""} onClick={() => { setPage("agent"); setSidebar(false); }}><MessageSquare size={16} />Agent</button>
        <button className={page === "files" ? "active" : ""} onClick={() => { setPage("files"); setSidebar(false); }}><FilesIcon size={16} />Files</button>
        <button className={page === "terminal" ? "active" : ""} onClick={() => { setPage("terminal"); setSidebar(false); }}><TerminalSquare size={16} />Terminal</button>
      </nav>
      <div className="threads-header"><span>Threads</span><button title="New thread" onClick={() => void createSession()}><Plus size={15} /></button></div>
      <div className="thread-list">{sessions.map((session) => <button className={session.id === sessionId && page === "agent" ? "active" : ""} key={session.id} onClick={() => { setSessionId(session.id); setPage("agent"); setSidebar(false); }}><span>{session.name || session.firstMessage || "New thread"}</span><small>{new Date(session.modified).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></button>)}</div>
      <div className="sidebar-footer"><button onClick={async () => { await api.logout(); setAuth("out"); }}><LogOut size={15} />Sign out</button><button className="desktop-only" title="Collapse"><PanelLeftClose size={15} /></button></div>
    </aside>
    <div className="mobile-bar"><button onClick={() => setSidebar(true)}><Menu size={20} /></button><div><Box size={17} /><strong>{workspace?.name || "Pi-Ark"}</strong></div><button onClick={() => void createSession()}><Plus size={20} /></button></div>
    <main className="content-area">
      {error && <div className="global-error">{error}</div>}
      {workspace && page === "agent" && (sessionId ? <Chat workspace={workspace} sessionId={sessionId} onSessionSettled={refreshSessions} /> : <div className="no-session"><MessageSquare size={30} /><h2>Start a new thread</h2><p>Each thread stays inside {workspace.name}.</p><button className="primary-button" onClick={() => void createSession()}><Plus size={16} />New thread</button></div>)}
      <Suspense fallback={<div className="page-loading"><LoaderCircle size={20} />Loading page</div>}>
        {workspace && page === "files" && <Files workspace={workspace} />}
        {workspace && page === "terminal" && <Terminal workspace={workspace} />}
      </Suspense>
    </main>
  </div>;
}
