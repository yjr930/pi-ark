import { Archive, ArchiveRestore, BookOpen, Download, LoaderCircle, Pencil, Pin, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import type { MemoryDraft, MemoryEntry, MemoryEntryPatch, MemoryProposal, MemorySettings, MemorySnapshot, MemoryStatus, MemoryType, Workspace } from "../types";
import { cleanMemoryDraft, draftFromMemoryEntry, emptyMemoryDraft, memoryError, MemoryDraftFields, MemorySourceLink, memoryStatuses, memoryTypes } from "./MemoryDraftFields";
import { MemoryProposalReview } from "./MemoryProposalReview";

type EntryEditorState = { kind: "create"; notebookText?: string } | { kind: "edit"; entry: MemoryEntry };
type Editor = EntryEditorState | { kind: "delete"; entry: MemoryEntry };
type ErrorScope = "page" | "editor" | "proposal";

function EntryEditor({ editor, enabled, busy, failure, onSave, onClose, onReload }: {
  editor: EntryEditorState;
  enabled: boolean; busy: boolean; failure?: ReturnType<typeof memoryError>;
  onSave: (draft: MemoryDraft, patch: Pick<MemoryEntryPatch, "status" | "reverify" | "changeReason">) => void;
  onClose: () => void; onReload: () => void;
}) {
  const entry = editor.kind === "edit" ? editor.entry : undefined;
  const fromNotebook = editor.kind === "create" && editor.notebookText !== undefined;
  const [draft, setDraft] = useState(() => entry ? draftFromMemoryEntry(entry) : emptyMemoryDraft(editor.kind === "create" ? editor.notebookText : undefined));
  const [status, setStatus] = useState(entry?.status ?? "active");
  const [reverify, setReverify] = useState(false);
  const [reason, setReason] = useState("");
  const canSave = !busy && (enabled || !!entry) && !failure?.conflict;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSave) onSave({ ...draft, reviewAfter: entry && draft.reviewAfter === entry.reviewAfter ? undefined : draft.reviewAfter }, { status: status === entry?.status ? undefined : status, reverify: reverify || undefined, changeReason: reason.trim() || undefined });
  }
  return <form className="memory-panel memory-editor memory-form" onSubmit={submit}>
    <h3>{entry ? "Edit memory" : fromNotebook ? "Save selection to Memory" : "New memory entry"}</h3>
    {fromNotebook && <p>The draft contains the text you selected in Notebook. Review it and save when ready.</p>}
    {!enabled && !entry && <p>Enable Memory for this Workspace to save the draft.</p>}
    <fieldset disabled={busy}>
      <MemoryDraftFields draft={draft} onChange={setDraft} showSourceUrl={!fromNotebook} source={entry?.source} />
      {entry && <>
        <label className="dialog-field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as MemoryStatus)}>{Object.entries(memoryStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="dialog-field"><span>Reason for this change (optional)</span><input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <label className="memory-check"><input type="checkbox" checked={reverify} onChange={(event) => setReverify(event.target.checked)} /><span>Mark as verified today</span></label>
      </>}
    </fieldset>
    {failure && <div className="memory-message memory-warning" role="alert"><span>{failure.text}</span>{failure.conflict && entry && <button type="button" className="secondary-button" disabled={busy} onClick={onReload}>Discard edits and load latest</button>}</div>}
    <div className="memory-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={!canSave}>{entry ? "Save changes" : "Save to Memory"}</button></div>
  </form>;
}

function EntryCard({ entry, busy, sourceAvailable, onEdit, onDelete, onCheck, onChangeStatus, onOpenNotebook }: {
  entry: MemoryEntry; busy: boolean; sourceAvailable?: boolean;
  onEdit: () => void; onDelete: () => void; onCheck: () => void;
  onChangeStatus: (status: MemoryStatus) => void; onOpenNotebook: () => void;
}) {
  return <article className="memory-panel memory-entry">
    <div className="memory-panel-heading"><h4>{entry.pinned && <Pin size={14} aria-label="Pinned" />}{entry.title}</h4><span className={`memory-badge status-${entry.status}`}>{memoryStatuses[entry.status]}</span></div>
    <p>{entry.summary}</p>
    <div className="memory-meta"><span>{memoryTypes[entry.type]}</span>{entry.tags.map((tag) => <span className="memory-badge" key={tag}>{tag}</span>)}</div>
    <details className="memory-body" onToggle={(event) => { if (event.currentTarget.open && !busy && sourceAvailable === undefined && entry.source.kind === "message") onCheck(); }}>
      <summary>View body and details</summary>
      <pre>{entry.body}</pre>
      <div className="memory-meta">
        <span>Updated <time dateTime={entry.updatedAt}>{entry.updatedAt.slice(0, 10)}</time></span>
        {entry.verifiedAt && <span>Verified <time dateTime={entry.verifiedAt}>{entry.verifiedAt.slice(0, 10)}</time></span>}
        {entry.changeReason && <span>Last change: {entry.changeReason}</span>}
      </div>
    </details>
    <div className="memory-source"><MemorySourceLink source={entry.source} unavailable={sourceAvailable === false} onOpenNotebook={onOpenNotebook} />{entry.source.kind === "message" && <button type="button" disabled={busy} onClick={onCheck}>Check source</button>}{entry.reviewAfter && <span>Review after <time dateTime={entry.reviewAfter}>{entry.reviewAfter.slice(0, 10)}</time></span>}</div>
    <div className="memory-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={onEdit}><Pencil size={14} />Edit</button>
      {entry.status === "archived" ? <button type="button" className="secondary-button" disabled={busy} onClick={() => onChangeStatus("active")}><ArchiveRestore size={14} />Restore</button> : <button type="button" className="secondary-button" disabled={busy} onClick={() => onChangeStatus("archived")}><Archive size={14} />Archive</button>}
      <button type="button" className="secondary-button" disabled={busy} onClick={onDelete}><Trash2 size={14} />Delete</button>
    </div>
  </article>;
}

export function Memory({ workspace, proposalId, notebookText, onReview, onOpenNotebook }: {
  workspace: Workspace; proposalId?: string; notebookText?: string;
  onReview: (proposalId?: string) => void; onOpenNotebook: () => void;
}) {
  const workspaceId = workspace.id;
  const [snapshot, setSnapshot] = useState<MemorySnapshot>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<({ scope: ErrorScope } & ReturnType<typeof memoryError>)>();
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Editor | undefined>(() => notebookText !== undefined ? { kind: "create", notebookText } : undefined);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MemoryType | "">("");
  const [status, setStatus] = useState<MemoryStatus | "">("");
  const [sourceChecks, setSourceChecks] = useState<Record<string, boolean | undefined>>({});
  const running = useRef(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const editorVisible = Boolean(editor || proposalId);

  useEffect(() => {
    const controller = new AbortController();
    void api.memory(workspaceId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setSnapshot(result);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError({ scope: "page", ...memoryError(reason, "Refresh Memory to load current data.") });
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [workspaceId]);

  useLayoutEffect(() => { if (editorVisible && !loading && snapshot?.enabled) editorRef.current?.scrollIntoView({ block: "start" }); }, [editorVisible, loading, proposalId, snapshot?.enabled]);

  async function run(task: () => Promise<void>, scope: ErrorScope = "page") {
    if (loading || running.current) return;
    running.current = true;
    setBusy(true); setError(undefined); setNotice("");
    try { await task(); }
    catch (reason) {
      setError({ scope, ...memoryError(reason, scope === "proposal" ? "Reload the suggestion and review the latest source and entries before confirming again." : "Load the latest Memory data before trying again.") });
    } finally { running.current = false; setBusy(false); }
  }

  async function reloadSnapshot() {
    const result = await api.memory(workspaceId);
    setSnapshot(result);
    setSourceChecks({});
    return result;
  }

  function updateSettings(settings: MemorySettings) {
    void run(async () => {
      const result = await api.saveMemorySettings(workspaceId, settings);
      setSnapshot(result);
      setNotice(result.autoIndex === settings.autoIndex ? "Memory settings saved." : "Enable Memory for this Workspace before changing the short index setting.");
    });
  }

  function updateEntry(entry: MemoryEntry) {
    setSnapshot((current) => current && { ...current, entries: [entry, ...current.entries.filter((item) => item.id !== entry.id)] });
    setSourceChecks((current) => ({ ...current, [entry.id]: undefined }));
  }

  function saveEntry(draft: MemoryDraft, patch: Pick<MemoryEntryPatch, "status" | "reverify" | "changeReason">) {
    if (!editor || editor.kind === "delete") return;
    void run(async () => {
      const clean = cleanMemoryDraft(draft);
      const entry = editor.kind === "edit" ? await api.updateMemoryEntry(workspaceId, editor.entry.id, { ...clean, ...patch, revision: editor.entry.revision }) : await api.createMemoryEntry(workspaceId, clean);
      updateEntry(entry);
      setEditor(undefined);
      setNotice("Memory entry saved.");
    }, "editor");
  }

  function deleteEntry(entry: MemoryEntry) {
    void run(async () => {
      await api.deleteMemoryEntry(workspaceId, entry.id, entry.revision);
      setSnapshot((current) => current && { ...current, entries: current.entries.filter((item) => item.id !== entry.id) });
      setEditor(undefined);
      setNotice("Memory entry deleted.");
    }, "editor");
  }

  function checkSource(entry: MemoryEntry) {
    void run(async () => {
      const result = await api.checkMemorySource(workspaceId, entry.id);
      updateEntry(result.entry);
      setSourceChecks((current) => ({ ...current, [entry.id]: result.sourceAvailable }));
      if (!result.sourceAvailable) setNotice("A Memory source is unavailable. Review the entry or add a replacement source.");
    });
  }

  async function onProposalChanged(proposal: MemoryProposal) {
    setSnapshot((current) => current && { ...current, proposals: [proposal, ...current.proposals.filter((item) => item.id !== proposal.id)] });
    if (proposal.status === "confirmed") {
      try { await reloadSnapshot(); }
      catch { setError({ scope: "page", text: "The suggestion was saved. Refresh Memory to see the updated entries.", conflict: false }); }
    }
  }

  function beginEdit(next?: Editor) { setEditor(next); setError(undefined); setNotice(""); }
  function showProposal(id?: string) { beginEdit(); onReview(id); }

  const pending = snapshot?.proposals.filter((item) => item.status === "pending") ?? [];
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const entries = (snapshot?.entries ?? []).filter((entry) => {
    if ((type && entry.type !== type) || (status && entry.status !== status)) return false;
    const text = [entry.title, entry.summary, entry.body, ...entry.tags].join("\n").toLowerCase();
    return terms.every((term) => text.includes(term));
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const editorError = error?.scope === "editor" ? error : undefined;

  return <section className="memory-page">
    <header className="page-header memory-header"><div><h2><BookOpen size={18} />Memory</h2><p title={workspace.path}>{workspace.name}</p></div><div className="memory-actions">
      <button type="button" className="secondary-button" disabled={loading || busy} onClick={() => void run(async () => { await reloadSnapshot(); })}><RefreshCw size={15} />Refresh</button>
      {snapshot && <a className="secondary-button" href={api.memoryExportUrl(workspaceId)} download><Download size={15} />Export Markdown</a>}
    </div></header>
    <div className="memory-scroll">
      <div className="memory-content">
        {loading && <p className="memory-message" role="status"><LoaderCircle size={16} className="memory-spinner" />Loading Memory…</p>}
        {error?.scope === "page" && <div className="memory-message memory-warning" role="alert">{error.text}</div>}
        {notice && <p className="memory-message" role="status">{notice}</p>}
        {snapshot && <section className="memory-panel memory-settings">
          <h3>Workspace settings</h3>
          <label className="memory-check"><input type="checkbox" checked={snapshot.enabled} disabled={busy} onChange={(event) => updateSettings({ enabled: event.target.checked, autoIndex: snapshot.autoIndex })} /><span>Enable Memory<small>Share confirmed entries across Sessions in this Workspace.</small></span></label>
          <label className="memory-check"><input type="checkbox" checked={snapshot.autoIndex} disabled={busy} onChange={(event) => updateSettings({ enabled: snapshot.enabled, autoIndex: event.target.checked })} /><span>Include short index<small>When Memory is enabled, include an index of selected entries in model requests.</small></span></label>
        </section>}
        <div ref={editorRef}>
          {proposalId ? <MemoryProposalReview key={proposalId} workspaceId={workspaceId} proposalId={proposalId} enabled={Boolean(snapshot?.enabled)} entries={snapshot?.entries ?? []} busy={busy || loading} run={(task) => { void run(task, "proposal"); }} onChanged={onProposalChanged} onRefreshEntries={() => { void run(async () => { await reloadSnapshot(); }); }} onClose={() => showProposal()} onOpenNotebook={onOpenNotebook} failure={error?.scope === "proposal" ? error : undefined} /> : editor && editor.kind !== "delete" && <EntryEditor key={editor.kind === "edit" ? `${editor.entry.id}:${editor.entry.revision}` : "create"} editor={editor} enabled={Boolean(snapshot?.enabled)} busy={busy || loading} failure={editorError} onSave={saveEntry} onClose={() => beginEdit()} onReload={() => {
            if (editor.kind !== "edit") return;
            void run(async () => {
              const latest = (await reloadSnapshot()).entries.find((entry) => entry.id === editor.entry.id);
              setEditor(latest ? { kind: "edit", entry: latest } : undefined);
              if (!latest) setNotice("This entry was deleted in another view.");
            }, "editor");
          }} />}
        </div>
        {snapshot && !proposalId && <>
          <section className="memory-panel memory-suggestions"><h3>Pending suggestions <small>{pending.length > 0 ? `(${pending.length})` : ""}</small></h3>
            {pending.length === 0 ? <p>No suggestions waiting for review.</p> : pending.map((item) => <div className="memory-suggestion" key={item.id}><div><strong>{item.draft.title}</strong><p>{item.draft.summary}</p></div><button type="button" className="secondary-button" disabled={busy} onClick={() => showProposal(item.id)}>Review memory</button></div>)}
          </section>
          <section className="memory-entries" aria-busy={busy}>
            <div className="memory-panel-heading"><h3>Entries</h3><button type="button" className="primary-button" disabled={!snapshot.enabled || busy || Boolean(editor)} onClick={() => beginEdit({ kind: "create" })}><Plus size={15} />New entry</button></div>
            {!snapshot.enabled && <p>Enable Memory to create entries or confirm suggestions.</p>}
            <div className="memory-filters">
              <label className="dialog-field"><span>Search entries</span><input type="search" value={query} placeholder="Search Memory…" onChange={(event) => setQuery(event.target.value)} /></label>
              <label className="dialog-field"><span>Type</span><select value={type} onChange={(event) => setType(event.target.value as MemoryType | "")}><option value="">All types</option>{Object.entries(memoryTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="dialog-field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as MemoryStatus | "")}><option value="">All statuses</option>{Object.entries(memoryStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            </div>
            {entries.length === 0 && <p>{snapshot.entries.length ? "No entries match these filters." : "No Memory entries yet."}</p>}
            {entries.map((entry) => <EntryCard key={entry.id} entry={entry} busy={busy || Boolean(editor)} sourceAvailable={sourceChecks[entry.id]} onEdit={() => beginEdit({ kind: "edit", entry })} onDelete={() => beginEdit({ kind: "delete", entry })} onCheck={() => checkSource(entry)} onChangeStatus={(nextStatus) => void run(async () => {
              const updated = await api.updateMemoryEntry(workspaceId, entry.id, { ...draftFromMemoryEntry(entry), revision: entry.revision, status: nextStatus });
              updateEntry(updated);
              setNotice(updated.status === "archived" ? "Memory entry archived." : updated.status === "review" ? "Memory entry restored and needs review." : "Memory entry restored.");
            })} onOpenNotebook={onOpenNotebook} />)}
          </section>
        </>}
      </div>
    </div>
    {editor?.kind === "delete" && <div className="dialog-backdrop" role="presentation"><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-memory-heading">
      <div className="dialog-header no-close"><div className="dialog-icon danger"><Trash2 size={18} /></div><div><h2 id="delete-memory-heading">Delete memory entry?</h2><p>This permanently removes the entry from this Workspace.</p></div></div>
      <div className="delete-session-name">{editor.entry.title}</div>
      {editorError && <div className="dialog-error" role="alert">{editorError.text}</div>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => { beginEdit(); if (editorError?.conflict) void run(async () => { await reloadSnapshot(); }); }}>Cancel</button><button type="button" className="danger-button" disabled={busy || editorError?.conflict} onClick={() => deleteEntry(editor.entry)}><Trash2 size={15} />Delete entry</button></div>
    </div></div>}
  </section>;
}
