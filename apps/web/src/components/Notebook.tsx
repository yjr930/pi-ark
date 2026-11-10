import { NotebookPen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Workspace } from "../types";

type SaveStatus = "loading" | "saving" | "saved" | "error";

export function Notebook({ workspace }: { workspace: Workspace }) {
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<SaveStatus>("loading");
  const contentRef = useRef("");
  const savedRef = useRef("");
  const loadedRef = useRef(false);
  const mountedRef = useRef(true);
  const timerRef = useRef<number | undefined>(undefined);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  function queueSave(value: string) {
    const request = saveChainRef.current.then(() => api.saveNotebook(workspace.id, value)).then(() => undefined);
    saveChainRef.current = request.catch(() => undefined);
    void request.then(() => {
      savedRef.current = value;
      if (mountedRef.current) setStatus(contentRef.current === value ? "saved" : "saving");
    }).catch(() => { if (mountedRef.current) setStatus("error"); });
  }

  function scheduleSave(value: string) {
    contentRef.current = value;
    setContent(value);
    setStatus("saving");
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { timerRef.current = undefined; queueSave(value); }, 300);
  }

  function flushSave() {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = undefined; }
    if (loadedRef.current && contentRef.current !== savedRef.current) queueSave(contentRef.current);
  }

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    setStatus("loading");
    void api.notebook(workspace.id).then((result) => {
      if (!active) return;
      contentRef.current = result.content;
      savedRef.current = result.content;
      loadedRef.current = true;
      setContent(result.content);
      setStatus("saved");
    }).catch(() => { if (active) { loadedRef.current = true; setStatus("error"); } });
    return () => {
      active = false;
      mountedRef.current = false;
      flushSave();
    };
  }, [workspace.id]);

  const statusText = status === "loading" ? "Loading notes" : status === "saving" ? "Saving" : status === "error" ? "Save failed" : "Saved";
  return <section className="notebook-page">
    <header className="page-header notebook-header"><div><h2><NotebookPen size={18} />Notebook</h2><p>{workspace.path}</p></div><span className={`notebook-status ${status}`} role="status" aria-live="polite">{statusText}</span></header>
    <div className="notebook-editor"><textarea aria-label="Workspace notebook" value={content} disabled={status === "loading"} placeholder="Write temporary notes here..." spellCheck onChange={(event) => scheduleSave(event.target.value)} onBlur={flushSave} /></div>
  </section>;
}
