import { Archive, ArchiveRestore, Braces, Check, ChevronDown, CircleAlert, FolderPlus, LoaderCircle, MoreHorizontal, Pencil, Pin, PinOff, Tag, Tags, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { internalSessionLink } from "../permalinks";
import type { SessionGroup, SessionInfo, SessionStatusView } from "../types";
import { NameDialog } from "./NameDialog";

type Changed = (removedFromActiveId?: string) => void;

function GroupAssignmentDialog({ workspaceId, session, groups, onClose, onChanged }: { workspaceId: string; session: SessionInfo; groups: SessionGroup[]; onClose: () => void; onChanged: Changed }) {
  const [selected, setSelected] = useState(session.groups);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setSaving(true); setError("");
    try { await api.updateSession(workspaceId, session.id, { groups: selected }); onChanged(); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Cannot update groups"); setSaving(false); }
  }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="session-groups-title">
    <div className="dialog-header no-close"><div className="dialog-icon"><Tags size={18} /></div><div><h2 id="session-groups-title">Session groups</h2><p>A session can appear in more than one group.</p></div></div>
    <div className="group-check-list">{groups.map((group) => { const checked = selected.includes(group.id); return <button type="button" className={checked ? "selected" : ""} onClick={() => setSelected((current) => checked ? current.filter((id) => id !== group.id) : [...current, group.id])} key={group.id}><span>{checked && <Check size={13} />}</span><Tag size={14} /><strong>{group.name}</strong></button>; })}{groups.length === 0 && <div className="empty-group-list">Create a group from the session list first.</div>}</div>
    {error && <div className="dialog-error">{error}</div>}
    <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving || groups.length === 0} onClick={() => void save()}>Save groups</button></div>
  </div></div>;
}

function SessionState({ status }: { status?: SessionStatusView }) {
  if (status?.state === "running") return <span className="session-state running" role="status" aria-label="Session is running" title="Running"><LoaderCircle size={13} /></span>;
  if (status?.state === "error") return <span className="session-state error" role="status" aria-label="Session has an error" title={status.errorMessage || "Session error"}><CircleAlert size={13} /></span>;
  if (status?.unread) return <span className="session-state unread" role="status" aria-label="Session has new output" title="New output"><i /></span>;
  return null;
}

function SessionRow({ workspaceId, session, status, groups, active, onSelect, onChanged }: { workspaceId: string; session: SessionInfo; status?: SessionStatusView; groups: SessionGroup[]; active: boolean; onSelect: () => void; onChanged: Changed }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);

  async function update(patch: { pinned?: boolean; archived?: boolean }) {
    setBusy(true);
    try { await api.updateSession(workspaceId, session.id, patch); setMenuOpen(false); onChanged(patch.archived === true ? session.id : undefined); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try { await api.deleteSession(workspaceId, session.id); setDeleteOpen(false); onChanged(session.id); }
    finally { setBusy(false); }
  }

  const title = session.name || session.firstMessage || "New session";
  return <>
    <div className={`session-list-item ${active ? "active" : ""}`}>
      <button className="session-open" onClick={onSelect}><span className="sidebar-item-copy"><strong>{title}</strong><small>{session.pinned && <Pin size={9} />} {new Date(session.modified).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></span><SessionState status={status} /></button>
      <div className="session-menu-root" ref={menuRef}><button className="row-menu-trigger" title={`Actions for ${title}`} aria-label={`Actions for ${title}`} aria-expanded={menuOpen} onClick={() => setMenuOpen((current) => !current)}><MoreHorizontal size={15} /></button>
        {menuOpen && <div className="row-actions-menu session-actions-menu">
          <button onClick={() => { setMenuOpen(false); setRenameOpen(true); }}><Pencil size={14} />Rename</button>
          <button onClick={() => void navigator.clipboard.writeText(internalSessionLink(workspaceId, session.id)).then(() => { setLinkCopied(true); window.setTimeout(() => setLinkCopied(false), 1200); })}><Braces size={14} />{linkCopied ? "Link copied" : "Copy session link"}</button>
          <button onClick={() => { setMenuOpen(false); setGroupsOpen(true); }}><Tags size={14} />Manage groups</button>
          {!session.archived && <button disabled={busy} onClick={() => void update({ pinned: !session.pinned })}>{session.pinned ? <PinOff size={14} /> : <Pin size={14} />}{session.pinned ? "Unpin" : "Pin"}</button>}
          <button disabled={busy} onClick={() => void update({ archived: !session.archived, ...(session.archived ? {} : { pinned: false }) })}>{session.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}{session.archived ? "Restore" : "Archive"}</button>
          <button className="danger" disabled={busy} onClick={() => { setMenuOpen(false); setDeleteOpen(true); }}><Trash2 size={14} />Delete</button>
        </div>}
      </div>
    </div>
    {renameOpen && <NameDialog title="Rename session" description="Set a title that is easy to find in the session list." label="Session title" initialValue={title} submitLabel="Rename session" icon={<Pencil size={18} />} onClose={() => setRenameOpen(false)} onSubmit={async (name) => { await api.updateSession(workspaceId, session.id, { name }); onChanged(); setRenameOpen(false); }} />}
    {groupsOpen && <GroupAssignmentDialog workspaceId={workspaceId} session={session} groups={groups} onClose={() => setGroupsOpen(false)} onChanged={onChanged} />}
    {deleteOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteOpen(false); }}><div className="dialog-card session-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-session-title">
      <div className="dialog-header no-close"><div className="dialog-icon danger"><Trash2 size={18} /></div><div><h2 id="delete-session-title">Delete session?</h2><p>This removes the conversation file from the workspace.</p></div></div>
      <div className="delete-session-name">{title}</div>
      <div className="dialog-actions"><button className="secondary-button" onClick={() => setDeleteOpen(false)}>Cancel</button><button className="danger-button" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />Delete session</button></div>
    </div></div>}
  </>;
}

function GroupSection({ group, sessions, statuses, workspaceId, activeSessionId, groups, onSelect, onChanged, onGroupsChanged }: { group: SessionGroup; sessions: SessionInfo[]; statuses: Record<string, SessionStatusView>; workspaceId: string; activeSessionId: string; groups: SessionGroup[]; onSelect: (id: string) => void; onChanged: Changed; onGroupsChanged: () => void }) {
  const [open, setOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);
  return <div className="session-group-section">
    <div className="session-group-heading"><button className={open ? "open" : ""} onClick={() => setOpen((current) => !current)}><ChevronDown size={13} /><Tag size={12} /><span>{group.name}</span><small>{sessions.length}</small></button>{group.id && <div className="group-menu-root" ref={rootRef}><button className="row-menu-trigger" title={`Actions for ${group.name}`} onClick={() => setMenuOpen((current) => !current)}><MoreHorizontal size={14} /></button>{menuOpen && <div className="row-actions-menu"><button onClick={() => { setMenuOpen(false); setRenameOpen(true); }}><Pencil size={14} />Rename group</button><button className="danger" onClick={async () => { await api.deleteSessionGroup(workspaceId, group.id); setMenuOpen(false); onGroupsChanged(); onChanged(); }}><Trash2 size={14} />Delete group</button></div>}</div>}</div>
    {open && <div className="session-items grouped">{sessions.map((session) => <SessionRow workspaceId={workspaceId} session={session} status={statuses[session.id]} groups={groups} active={session.id === activeSessionId} onSelect={() => onSelect(session.id)} onChanged={onChanged} key={`${group.id}-${session.id}`} />)}{sessions.length === 0 && <div className="empty-session-group">No sessions</div>}</div>}
    {renameOpen && <NameDialog title="Rename group" description="Sessions assigned to this group stay in the group." label="Group name" initialValue={group.name} submitLabel="Rename group" icon={<Tag size={18} />} onClose={() => setRenameOpen(false)} onSubmit={async (name) => { await api.renameSessionGroup(workspaceId, group.id, name); onGroupsChanged(); setRenameOpen(false); }} />}
  </div>;
}

export function SessionList({ workspaceId, sessions, statuses, activeSessionId, showArchived, onSelect, onChanged }: { workspaceId: string; sessions: SessionInfo[]; statuses: Record<string, SessionStatusView>; activeSessionId: string; showArchived: boolean; onSelect: (sessionId: string) => void; onChanged: Changed }) {
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const active = sessions.filter((session) => !session.archived);
  const archived = sessions.filter((session) => session.archived);
  const ungrouped = active.filter((session) => session.groups.length === 0);
  const loadGroups = () => { void api.sessionGroups(workspaceId).then((result) => setGroups(result.groups)); };
  useEffect(loadGroups, [workspaceId]);

  return <div className="session-list">
    <div className="session-group-toolbar"><button onClick={() => setCreateGroupOpen(true)}><FolderPlus size={13} />New group</button></div>
    {groups.length === 0 ? <div className="session-items">{active.map((session) => <SessionRow workspaceId={workspaceId} session={session} status={statuses[session.id]} groups={groups} active={session.id === activeSessionId} onSelect={() => onSelect(session.id)} onChanged={onChanged} key={session.id} />)}</div> : <div className="session-group-list">{groups.map((group) => <GroupSection group={group} sessions={active.filter((session) => session.groups.includes(group.id))} statuses={statuses} workspaceId={workspaceId} activeSessionId={activeSessionId} groups={groups} onSelect={onSelect} onChanged={onChanged} onGroupsChanged={loadGroups} key={group.id} />)}<GroupSection group={{ id: "", name: "Ungrouped" }} sessions={ungrouped} statuses={statuses} workspaceId={workspaceId} activeSessionId={activeSessionId} groups={groups} onSelect={onSelect} onChanged={onChanged} onGroupsChanged={loadGroups} /></div>}
    {showArchived && <div className="archived-sessions"><div className="archived-sessions-label"><span>Archived</span><small>{archived.length}</small></div><div className="session-items archived">{archived.map((session) => <SessionRow workspaceId={workspaceId} session={session} status={statuses[session.id]} groups={groups} active={session.id === activeSessionId} onSelect={() => onSelect(session.id)} onChanged={onChanged} key={session.id} />)}{archived.length === 0 && <div className="empty-session-group">No archived sessions</div>}</div></div>}
    {createGroupOpen && <NameDialog title="Create session group" description="Use groups to organize related sessions. A session can belong to several groups." label="Group name" submitLabel="Create group" icon={<FolderPlus size={18} />} onClose={() => setCreateGroupOpen(false)} onSubmit={async (name) => { await api.createSessionGroup(workspaceId, name); loadGroups(); setCreateGroupOpen(false); }} />}
  </div>;
}
