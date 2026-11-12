import { Check, CircleAlert, LoaderCircle, PackageOpen, Puzzle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { ExtensionView, ExtensionsResponse, Workspace } from "../types";

type Notice = { kind: "success" | "error"; text: string };

const statusLabels: Record<ExtensionView["status"], string> = { loaded: "Loaded", failed: "Failed" };

function preferredWorkspaceId(workspaces: Workspace[]): string {
  const fromUrl = new URLSearchParams(window.location.search).get("workspace");
  return workspaces.find((workspace) => workspace.id === fromUrl)?.id || workspaces[0]?.id || "";
}

export function ExtensionsSettings({ active }: { active: boolean }) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [data, setData] = useState<ExtensionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const started = useRef(false);
  const workspaceRef = useRef("");

  useEffect(() => { workspaceRef.current = workspaceId; }, [workspaceId]);

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    void initialize();
  }, [active]);

  const loadedCount = useMemo(() => data ? data.extensions.filter((extension) => extension.status === "loaded").length : 0, [data]);
  const toolCount = useMemo(() => data ? data.extensions.reduce((total, extension) => total + extension.tools.length, 0) : 0, [data]);

  async function initialize() {
    setLoading(true); setNotice(null);
    try {
      const result = await api.workspaces();
      const id = preferredWorkspaceId(result.workspaces);
      setWorkspaceId(id);
      workspaceRef.current = id;
      if (!id) { setData(null); return; }
      setData(await api.extensions(id));
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot load extensions" });
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    if (!workspaceId) { await initialize(); return; }
    setRefreshing(true); setNotice(null);
    try {
      const result = await api.extensions(workspaceId);
      if (workspaceRef.current !== workspaceId) return;
      setData(result);
      const reloaded = await api.reloadExtensions();
      if (workspaceRef.current !== workspaceId) return;
      setNotice({ kind: "success", text: reloaded.reloaded > 0 ? `Extensions reloaded. ${reloaded.reloaded} idle ${reloaded.reloaded === 1 ? "Session uses" : "Sessions use"} the updated set.` : "Extensions reloaded. New Sessions use the updated set." });
    } catch (reason) {
      if (workspaceRef.current !== workspaceId) return;
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot refresh extensions" });
    } finally {
      setRefreshing(false);
    }
  }

  function renderTool(tool: ExtensionView["tools"][number]) {
    return <span className={`agent-resource-badge ${tool.active ? "managed" : "builtin"}`} key={tool.name} title={tool.active ? "Model can call this tool directly" : "Registered without automatic activation"}>{tool.name}{tool.active ? "" : " · on demand"}</span>;
  }

  function renderExtension(extension: ExtensionView) {
    return <div className="agent-resource-row" key={extension.path}>
      <div className="agent-resource-copy">
        <div className="agent-resource-title">
          <strong>{extension.name}</strong>
          <span className={`agent-resource-status ${extension.status === "loaded" ? "enabled" : "disabled"}`}>{statusLabels[extension.status]}</span>
        </div>
        <p>{extension.tools.length > 0 ? `${extension.tools.length} registered ${extension.tools.length === 1 ? "tool" : "tools"}` : "No tools registered"}{extension.commands.length > 0 ? ` · ${extension.commands.length} ${extension.commands.length === 1 ? "command" : "commands"}` : ""}</p>
        <code className="agent-resource-path" title={extension.path}>{extension.path}</code>
        {(extension.tools.length > 0 || extension.commands.length > 0) && <div className="agent-resource-details">
          <dl>{extension.tools.length > 0 && <div><dt>Tools</dt><dd>{extension.tools.map(renderTool)}</dd></div>}{extension.commands.length > 0 && <div><dt>Commands</dt><dd>{extension.commands.map((command) => <code key={command}>/{command}</code>)}</dd></div>}</dl>
        </div>}
        {extension.diagnostics.length > 0 && <ul className="agent-resource-diagnostics">{extension.diagnostics.map((diagnostic, index) => <li key={index}><span>{diagnostic}</span></li>)}</ul>}
      </div>
    </div>;
  }

  return <>
    {notice && <div role="status" className={`settings-notice ${notice.kind}`}>{notice.kind === "success" ? <Check size={15} /> : <CircleAlert size={15} />}{notice.text}</div>}
    <div className="agent-resource-overview">
      <div className="agent-resource-summary">
        {data ? <>
          <span><strong>{loadedCount}</strong> extensions loaded</span>
          <span><strong>{toolCount}</strong> registered tools</span>
        </> : <span>{loading ? "Loading extensions" : "Extensions unavailable"}</span>}
      </div>
      <button type="button" className="secondary-button" disabled={loading || refreshing} onClick={() => void refresh()}>{refreshing || loading ? <LoaderCircle size={13} className="agent-resource-spin" /> : <RefreshCw size={13} />}Refresh</button>
    </div>
    <section className="settings-section">
      <div className="settings-section-title">
        <Puzzle size={17} />
        <div><h3>Installed extensions</h3><p>Extensions in the user extension directory. Extension tools become available to the Agent in new Sessions.</p></div>
      </div>
      {loading && !data ? <div className="settings-inline-loading"><LoaderCircle size={16} className="agent-resource-spin" />Loading extensions</div> : data ? data.extensions.length > 0 ? <div className="agent-resource-list">{data.extensions.map(renderExtension)}</div> : <div className="agent-resource-empty">No extensions are installed. Add a <code>.ts</code> or <code>.js</code> file to the extension directory to install one.</div> : <div className="agent-resource-empty">Open a workspace to load extensions.</div>}
    </section>
    {data && <section className="settings-section">
      <div className="settings-section-title"><PackageOpen size={17} /><div><h3>Install directory</h3><p>Pi-Ark loads one level of files and folders from this directory. A folder uses <code>index.ts</code> or a <code>package.json</code> with a <code>pi.extensions</code> entry.</p></div></div>
      <div className="agent-resource-row"><div className="agent-resource-copy"><code className="agent-resource-path" title={data.directory}>{data.directory}</code><p>Place a TypeScript file here, then create a new Session. Use Refresh after changing files to reload idle Sessions.</p></div></div>
    </section>}
    {data && data.diagnostics.length > 0 && <section className="settings-section">
      <div className="settings-section-title"><CircleAlert size={17} /><div><h3>Diagnostics</h3><p>Problems reported while loading extensions.</p></div></div>
      <ul className="agent-resource-diagnostics">{data.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.path}:${index}`}><code>{diagnostic.path}</code><span>{diagnostic.message}</span></li>)}</ul>
    </section>}
  </>;
}
