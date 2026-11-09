import { ArrowUp, Check, ChevronRight, CircleAlert, Copy, Download, File, FileCode2, Folder, FolderOpen, Image as ImageIcon, LoaderCircle, MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "../api";
import type { FileContent, FileEntry, Workspace } from "../types";
import { Markdown } from "./Markdown";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parentDirectory(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}

function absoluteEntryPath(workspacePath: string, relativePath: string): string {
  if (!relativePath) return workspacePath;
  return `${workspacePath.replace(/[\\/]+$/, "")}/${relativePath}`;
}

interface FileActionMenu { entry: FileEntry; top: number; left: number }

export function Files({ workspace }: { workspace: Workspace }) {
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [browserWidth, setBrowserWidth] = useState(() => Math.max(230, Number(localStorage.getItem("pi-ark-files-browser-width")) || 320));
  const [resizing, setResizing] = useState(false);
  const [actionMenu, setActionMenu] = useState<FileActionMenu | null>(null);
  const [copiedPath, setCopiedPath] = useState<"absolute" | "relative" | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const directoryRequestRevision = useRef(0);
  const fileRequestRevision = useRef(0);

  useEffect(() => {
    ++directoryRequestRevision.current; ++fileRequestRevision.current;
    setDirectory(""); setSelected(null); setFile(null); setActionMenu(null);
  }, [workspace.id]);

  useEffect(() => {
    const revision = ++directoryRequestRevision.current;
    ++fileRequestRevision.current;
    setLoading(true); setError(""); setSelected(null); setFile(null); setActionMenu(null);
    api.files(workspace.id, directory).then((result) => { if (revision === directoryRequestRevision.current) setEntries(result.entries); }).catch((reason) => { if (revision === directoryRequestRevision.current) setError(reason.message); }).finally(() => { if (revision === directoryRequestRevision.current) setLoading(false); });
  }, [workspace.id, directory]);

  useEffect(() => {
    if (!actionMenu) return;
    const close = (event: MouseEvent) => { if (!actionMenuRef.current?.contains(event.target as Node)) setActionMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setActionMenu(null); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [actionMenu]);

  async function open(entry: FileEntry) {
    setActionMenu(null);
    if (entry.type === "directory") { setDirectory(entry.path); return; }
    const revision = ++fileRequestRevision.current;
    setSelected(entry); setFile(null); setLoading(true); setError("");
    try { const preview = await api.file(workspace.id, entry.path); if (revision === fileRequestRevision.current) setFile(preview); }
    catch (reason) { if (revision === fileRequestRevision.current) setError(reason instanceof Error ? reason.message : "Cannot open file"); }
    finally { if (revision === fileRequestRevision.current) setLoading(false); }
  }

  function openActions(event: React.MouseEvent<HTMLButtonElement>, entry: FileEntry) {
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    setCopiedPath(null);
    const menuHeight = entry.type === "directory" ? 76 : 109;
    setActionMenu((current) => current?.entry.path === entry.path ? null : { entry, top: Math.min(bounds.bottom + 4, window.innerHeight - menuHeight - 8), left: Math.max(8, Math.min(bounds.right - 178, window.innerWidth - 186)) });
  }

  async function copyPath(kind: "absolute" | "relative") {
    if (!actionMenu) return;
    const value = kind === "absolute" ? absoluteEntryPath(workspace.path, actionMenu.entry.path) : actionMenu.entry.path;
    await navigator.clipboard.writeText(value);
    setCopiedPath(kind);
    window.setTimeout(() => setCopiedPath((current) => current === kind ? null : current), 1200);
  }

  function saveBrowserWidth(width: number) {
    const maximum = workspaceRef.current ? Math.max(230, workspaceRef.current.getBoundingClientRect().width - 320) : width;
    const limited = Math.min(maximum, Math.max(230, width));
    setBrowserWidth(limited); localStorage.setItem("pi-ark-files-browser-width", String(limited));
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !workspaceRef.current) return;
    event.preventDefault();
    const bounds = workspaceRef.current.getBoundingClientRect();
    const limit = (clientX: number) => Math.min(Math.max(230, bounds.width - 320), Math.max(230, clientX - bounds.left));
    setResizing(true); setActionMenu(null);
    const move = (moveEvent: PointerEvent) => setBrowserWidth(limit(moveEvent.clientX));
    const finish = (upEvent: PointerEvent) => {
      saveBrowserWidth(limit(upEvent.clientX)); setResizing(false);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish);
  }

  const crumbs = directory ? directory.split("/") : [];
  const resolveMarkdownImage = useCallback((source: string) => {
    if (!file || /^(?:[a-z]+:|\/|#)/i.test(source)) return source;
    const baseDirectory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    const imagePath = [...baseDirectory.split("/"), ...source.split("/")].filter(Boolean).reduce<string[]>((parts, part) => part === ".." ? parts.slice(0, -1) : part === "." ? parts : [...parts, part], []).join("/");
    return api.fileImageUrl(workspace.id, imagePath);
  }, [file, workspace.id]);

  return <section className={`files-page ${resizing ? "files-resizing" : ""}`}>
    <header className="page-header"><div><h2>Files</h2><p>{workspace.path}</p></div></header>
    <div className="file-workspace" ref={workspaceRef} style={{ "--file-browser-width": `${browserWidth}px` } as React.CSSProperties}>
      <nav className="breadcrumbs" aria-label="Current directory"><button onClick={() => setDirectory("")}><FolderOpen size={15} />{workspace.name}</button>{crumbs.map((crumb, index) => <span key={`${crumb}-${index}`}><ChevronRight size={13} /><button onClick={() => setDirectory(crumbs.slice(0, index + 1).join("/"))}>{crumb}</button></span>)}</nav>
      <aside className="file-browser">
        <div className="file-list" onScroll={() => setActionMenu(null)}>
          <button className="file-parent-row" disabled={!directory} onClick={() => setDirectory(parentDirectory(directory))}><ArrowUp size={16} /><span>Up one level</span><small>{directory ? parentDirectory(directory) || workspace.name : "Workspace root"}</small></button>
          {loading && !selected && <div className="loading"><LoaderCircle size={18} />Loading</div>}
          {entries.map((entry) => <div className="file-row-shell" key={entry.path} data-entry-type={entry.type} data-entry-path={entry.path}>
            <button className="file-row" onClick={() => void open(entry)}>
              {entry.type === "directory" ? <Folder size={17} /> : /\.(png|jpe?g|gif|webp)$/i.test(entry.name) ? <ImageIcon size={17} /> : /\.(ts|tsx|js|jsx|json|css|html|md)$/i.test(entry.name) ? <FileCode2 size={17} /> : <File size={17} />}
              <span>{entry.name}</span>{entry.type === "file" && <small>{formatSize(entry.size)}</small>}
            </button>
            <button className="file-row-actions" title={`Actions for ${entry.name}`} aria-label={`Actions for ${entry.name}`} aria-expanded={actionMenu?.entry.path === entry.path} onClick={(event) => openActions(event, entry)}><MoreHorizontal size={14} /></button>
          </div>)}
        </div>
      </aside>
      <div className="file-pane-resizer" role="separator" aria-label="Resize file browser" aria-orientation="vertical" aria-valuemin={230} aria-valuenow={Math.round(browserWidth)} tabIndex={0} onPointerDown={beginResize} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); saveBrowserWidth(browserWidth + (event.key === "ArrowLeft" ? -20 : 20)); } }} />
      <main className="file-viewer">
        {selected && <div className="viewer-title"><div>{file?.kind === "image" ? <ImageIcon size={16} /> : <FileCode2 size={16} />}<span>{selected.path}</span></div><div className="viewer-title-actions"><small>{formatSize(selected.size)}</small><a href={api.fileDownloadUrl(workspace.id, selected.path)} download={selected.name} aria-label={`Download ${selected.name}`}><Download size={13} />Download</a></div></div>}
        {loading && selected ? <div className="viewer-placeholder"><LoaderCircle className="spin" size={26} /><h3>Loading preview</h3></div> : error && selected ? <div className="viewer-placeholder error-text"><CircleAlert size={30} /><h3>Preview unavailable</h3><p>{error}</p><a className="viewer-download" href={api.fileDownloadUrl(workspace.id, selected.path)} download={selected.name}><Download size={14} />Download file</a></div> : file?.kind === "image" ? <div className="image-view"><img src={api.fileImageUrl(workspace.id, file.path)} alt={file.name} /></div> : file?.kind === "text" ? file.markdown ? <Markdown source={file.content} resolveImage={resolveMarkdownImage} /> : <pre className="code-view"><code>{file.content}</code></pre> : <div className="viewer-placeholder"><FileCode2 size={30} /><h3>Select a file</h3><p>Text, Markdown, and supported images open in preview.</p></div>}
      </main>
    </div>
    {actionMenu && <div className="file-actions-menu" role="menu" ref={actionMenuRef} style={{ top: actionMenu.top, left: actionMenu.left }}>
      <button role="menuitem" onClick={() => void copyPath("absolute")}>{copiedPath === "absolute" ? <Check size={13} /> : <Copy size={13} />}<span>{copiedPath === "absolute" ? "Path copied" : "Copy path"}</span></button>
      <button role="menuitem" onClick={() => void copyPath("relative")}>{copiedPath === "relative" ? <Check size={13} /> : <Copy size={13} />}<span>{copiedPath === "relative" ? "Relative path copied" : "Copy relative path"}</span></button>
      {actionMenu.entry.type !== "directory" && <a role="menuitem" href={api.fileDownloadUrl(workspace.id, actionMenu.entry.path)} download={actionMenu.entry.name} onClick={() => setActionMenu(null)}><Download size={13} /><span>Download</span></a>}
    </div>}
  </section>;
}
