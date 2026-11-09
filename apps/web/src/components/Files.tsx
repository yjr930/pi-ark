import DOMPurify from "dompurify";
import { marked } from "marked";
import { ChevronRight, File, FileCode2, Folder, FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { FileContent, FileEntry, Workspace } from "../types";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Files({ workspace }: { workspace: Workspace }) {
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true); setError(""); setFile(null);
    api.files(workspace.id, directory).then((result) => setEntries(result.entries)).catch((reason) => setError(reason.message)).finally(() => setLoading(false));
  }, [workspace.id, directory]);

  async function open(entry: FileEntry) {
    if (entry.type === "directory") { setDirectory(entry.path); return; }
    setLoading(true); setError("");
    try { setFile(await api.file(workspace.id, entry.path)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Cannot open file"); } finally { setLoading(false); }
  }

  const crumbs = directory ? directory.split("/") : [];
  const html = useMemo(() => {
    if (!file?.markdown) return "";
    const sanitized = DOMPurify.sanitize(marked.parse(file.content, { async: false }) as string);
    const document = new DOMParser().parseFromString(sanitized, "text/html");
    const baseDirectory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    for (const image of document.querySelectorAll("img")) {
      const source = image.getAttribute("src");
      if (source && !/^(?:[a-z]+:|\/|#)/i.test(source)) {
        const imagePath = [...baseDirectory.split("/"), ...source.split("/")].filter(Boolean).reduce<string[]>((parts, part) => part === ".." ? parts.slice(0, -1) : part === "." ? parts : [...parts, part], []).join("/");
        image.src = `/api/workspaces/${encodeURIComponent(workspace.id)}/image?path=${encodeURIComponent(imagePath)}`;
      }
      image.loading = "lazy";
    }
    return document.body.innerHTML;
  }, [file, workspace.id]);

  return <section className="files-page">
    <header className="page-header"><div><h2>Files</h2><p>{workspace.path}</p></div></header>
    <div className="file-workspace">
      <aside className="file-browser">
        <div className="breadcrumbs"><button onClick={() => setDirectory("")}><FolderOpen size={15} />{workspace.name}</button>{crumbs.map((crumb, index) => <span key={`${crumb}-${index}`}><ChevronRight size={13} /><button onClick={() => setDirectory(crumbs.slice(0, index + 1).join("/"))}>{crumb}</button></span>)}</div>
        <div className="file-list">
          {loading && !file && <div className="loading"><LoaderCircle size={18} />Loading</div>}
          {entries.map((entry) => <button className="file-row" key={entry.path} onClick={() => void open(entry)}>
            {entry.type === "directory" ? <Folder size={17} /> : /\.(ts|tsx|js|jsx|json|css|html|md)$/i.test(entry.name) ? <FileCode2 size={17} /> : <File size={17} />}
            <span>{entry.name}</span>{entry.type === "file" && <small>{formatSize(entry.size)}</small>}
          </button>)}
        </div>
      </aside>
      <main className="file-viewer">
        {error ? <div className="viewer-placeholder error-text">{error}</div> : file ? <>
          <div className="viewer-title"><div><FileCode2 size={16} /><span>{file.path}</span></div><small>{formatSize(file.size)}</small></div>
          {file.markdown ? <article className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="code-view"><code>{file.content}</code></pre>}
        </> : <div className="viewer-placeholder"><FileCode2 size={30} /><h3>Select a file</h3><p>Markdown files open in reading view.</p></div>}
      </main>
    </div>
  </section>;
}
