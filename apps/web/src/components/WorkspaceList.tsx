import { CircleMinus, Folder, MoreHorizontal, Pencil } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Workspace } from "../types";

function WorkspaceRow({ workspace, active, onSelect, onRenamed, onClosed }: { workspace: Workspace; active: boolean; onSelect: () => void; onRenamed: (workspace: Workspace) => void; onClosed: (workspace: Workspace) => void }) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(workspace.name);
  const [closeOpen, setCloseOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  function cancelRename() { setDraft(workspace.name); setEditing(false); setError(""); }
  async function rename(event: FormEvent) {
    event.preventDefault();
    const name = draft.trim();
    if (!name) return;
    setSaving(true); setError("");
    try { onRenamed(await api.renameWorkspace(workspace.id, name)); setEditing(false); setActionsOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Cannot rename workspace"); }
    finally { setSaving(false); }
  }
  async function close() {
    setSaving(true); setError("");
    try { await api.closeWorkspace(workspace.id); onClosed(workspace); setCloseOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Cannot close workspace"); setSaving(false); }
  }

  return <div className="workspace-list-entry">
    {editing ? <form className="workspace-inline-rename" onSubmit={(event) => void rename(event)}><input ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") cancelRename(); }} aria-label="Workspace name" /><div><button type="submit" disabled={saving || !draft.trim()}>Save</button><button type="button" onClick={cancelRename}>Cancel</button></div>{error && <small>{error}</small>}</form> : <>
      <div className={`workspace-list-item ${active ? "active" : ""}`}><button className="workspace-open" onClick={onSelect}><Folder size={15} /><span className="sidebar-item-copy"><strong>{workspace.name}</strong><small>{workspace.path}</small></span></button><button className="row-menu-trigger" title={`Workspace actions for ${workspace.name}`} aria-label={`Workspace actions for ${workspace.name}`} aria-expanded={actionsOpen} onClick={() => setActionsOpen((current) => !current)}><MoreHorizontal size={15} /></button></div>
      {actionsOpen && <div className="workspace-inline-actions"><button onClick={() => { setDraft(workspace.name); setEditing(true); }}><Pencil size={13} />Rename</button><button className="danger" onClick={() => setCloseOpen(true)}><CircleMinus size={13} />Close</button></div>}
    </>}
    {closeOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCloseOpen(false); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="close-workspace-title"><div className="dialog-header no-close"><div className="dialog-icon"><CircleMinus size={18} /></div><div><h2 id="close-workspace-title">Close workspace?</h2><p>Pi-Ark will remove it from this sidebar. The directory, project files, settings, and sessions stay on the server.</p></div></div><div className="workspace-close-summary"><strong>{workspace.name}</strong><code>{workspace.path}</code></div>{error && <div className="dialog-error">{error}</div>}<div className="dialog-actions"><button className="secondary-button" onClick={() => setCloseOpen(false)}>Cancel</button><button className="danger-button" disabled={saving} onClick={() => void close()}>Close workspace</button></div></div></div>}
  </div>;
}

export function WorkspaceList({ workspaces, activeId, onSelect, onRenamed, onClosed }: { workspaces: Workspace[]; activeId: string; onSelect: (id: string) => void; onRenamed: (workspace: Workspace) => void; onClosed: (workspace: Workspace) => void }) {
  return <div className="workspace-list">{workspaces.map((workspace) => <WorkspaceRow workspace={workspace} active={workspace.id === activeId} onSelect={() => onSelect(workspace.id)} onRenamed={onRenamed} onClosed={onClosed} key={workspace.id} />)}{workspaces.length === 0 && <div className="workspace-list-empty">No open workspaces</div>}</div>;
}
