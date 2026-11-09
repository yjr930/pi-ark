import { Folder, FolderPlus, LoaderCircle } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import type { Workspace } from "../types";

export function AddWorkspaceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (workspace: Workspace) => void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [directories, setDirectories] = useState<Array<{ name: string; path: string }>>([]);
  const [loadingPaths, setLoadingPaths] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!path.startsWith("/")) { setDirectories([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      setLoadingPaths(true);
      api.directories(path).then((result) => { if (active) setDirectories(result.directories); }).catch(() => { if (active) setDirectories([]); }).finally(() => { if (active) setLoadingPaths(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [path]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try { onAdded(await api.addWorkspace({ name: name.trim() || undefined, path: path.trim() })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Cannot add workspace"); setSaving(false); }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="dialog-card workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="add-workspace-title" onSubmit={submit}>
      <div className="dialog-header no-close"><div className="dialog-icon"><FolderPlus size={18} /></div><div><h2 id="add-workspace-title">Add workspace</h2><p>Choose an existing directory from this server.</p></div></div>
      <label className="dialog-field path-field"><span>Directory path</span><input autoFocus required value={path} onChange={(event) => setPath(event.target.value)} placeholder="/root/workspace/project" autoComplete="off" /></label>
      {(loadingPaths || directories.length > 0) && <div className="directory-suggestions" role="listbox" aria-label="Server directories">{loadingPaths && <div className="directory-loading"><LoaderCircle size={14} />Finding directories</div>}{!loadingPaths && directories.map((directory) => <button type="button" role="option" aria-selected={directory.path === path} onClick={() => setPath(directory.path)} key={directory.path}><Folder size={14} /><span><strong>{directory.name}</strong><small>{directory.path}</small></span>{directory.path === path && <em>Selected</em>}</button>)}</div>}
      <label className="dialog-field"><span>Display name <em>Optional</em></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Derived from the directory name" /></label>
      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving || !path.trim()}>{saving ? <LoaderCircle size={15} /> : <FolderPlus size={15} />}Add workspace</button></div>
    </form>
  </div>;
}
