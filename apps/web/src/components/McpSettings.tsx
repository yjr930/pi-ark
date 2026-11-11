import { Check, CircleAlert, Globe2, LoaderCircle, Plug, RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { McpBrowserStatus, McpServerState, McpServerView, McpServersResponse, Workspace } from "../types";

type Notice = { kind: "success" | "error"; text: string };

const stateLabels: Record<McpServerState, string> = {
  connected: "Connected",
  disabled: "Disabled",
  failed: "Failed",
  "needs-sign-in": "Needs sign-in",
  starting: "Starting",
};

const stateClasses: Record<McpServerState, string> = {
  connected: "enabled",
  disabled: "disabled",
  failed: "failed",
  "needs-sign-in": "explicit",
  starting: "starting",
};

const browserLabels: Record<McpBrowserStatus["state"], string> = {
  "not-installed": "Not installed",
  installing: "Installing",
  installed: "Installed",
  failed: "Failed",
};

function preferredWorkspaceId(workspaces: Workspace[]): string {
  const fromUrl = new URLSearchParams(window.location.search).get("workspace");
  return workspaces.find((workspace) => workspace.id === fromUrl)?.id || workspaces[0]?.id || "";
}

function logExcerpt(log?: string): string {
  if (!log) return "";
  const trimmed = log.trim();
  return trimmed.length > 1600 ? `…${trimmed.slice(-1600)}` : trimmed;
}

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} className={`settings-toggle ${checked ? "enabled" : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}

export function McpSettings({ active }: { active: boolean }) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [data, setData] = useState<McpServersResponse | null>(null);
  const [browser, setBrowser] = useState<McpBrowserStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const started = useRef(false);
  const mounted = useRef(true);
  const urlWorkspaceRef = useRef("");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    void initialize();
  }, [active]);

  useEffect(() => {
    if (!active || !started.current || workspaces.length === 0) return;
    const currentUrlWorkspace = new URLSearchParams(window.location.search).get("workspace") || "";
    if (currentUrlWorkspace === urlWorkspaceRef.current) return;
    const target = workspaces.find((workspace) => workspace.id === currentUrlWorkspace);
    if (!target) return;
    urlWorkspaceRef.current = currentUrlWorkspace;
    if (target.id === workspaceId || loading || refreshing || busyName) return;
    setWorkspaceId(target.id);
    setData(null);
    void loadData(target.id);
  }, [active]);

  async function loadData(id: string, mode: "initial" | "refresh" = "initial") {
    if (mode === "refresh") setRefreshing(true); else setLoading(true);
    setNotice(null);
    try {
      const [servers, browserStatus] = await Promise.all([api.mcpServers(id), api.mcpBrowser().catch(() => null)]);
      if (!mounted.current) return;
      setData(servers);
      setBrowser(browserStatus);
    } catch (reason) {
      if (mounted.current) setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot load MCP servers" });
    } finally {
      if (mounted.current) { setLoading(false); setRefreshing(false); }
    }
  }

  async function initialize() {
    setLoading(true); setNotice(null);
    try {
      const result = await api.workspaces();
      setWorkspaces(result.workspaces);
      urlWorkspaceRef.current = new URLSearchParams(window.location.search).get("workspace") || "";
      const id = preferredWorkspaceId(result.workspaces);
      setWorkspaceId(id);
      if (!id) return;
      await loadData(id);
    } catch (reason) {
      if (mounted.current) setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot load MCP servers" });
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  async function refresh() {
    if (!workspaceId) { await initialize(); return; }
    await loadData(workspaceId, "refresh");
  }

  async function waitForBrowser(status: McpBrowserStatus): Promise<McpBrowserStatus> {
    let current = status;
    const deadline = Date.now() + 15 * 60 * 1000;
    while (current.state === "installing" && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      if (!mounted.current) return current;
      current = await api.mcpBrowser();
      if (mounted.current) setBrowser(current);
    }
    return current;
  }

  async function ensureBrowser(): Promise<McpBrowserStatus | null> {
    setInstalling(true);
    try {
      let status = browser;
      if (!status || status.state === "not-installed" || status.state === "failed") {
        status = await api.installMcpBrowser();
        if (mounted.current) setBrowser(status);
      }
      status = await waitForBrowser(status);
      return status;
    } catch (reason) {
      if (mounted.current) setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot install the browser runtime" });
      return null;
    } finally {
      if (mounted.current) setInstalling(false);
    }
  }

  async function waitForServerState(name: string, targetWorkspace: string) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      if (!mounted.current || workspaceId !== targetWorkspace) return;
      let latest: McpServersResponse;
      try {
        latest = await api.mcpServers(targetWorkspace);
      } catch (reason) {
        if (mounted.current) setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot refresh MCP server status" });
        return;
      }
      if (!mounted.current || workspaceId !== targetWorkspace) return;
      setData(latest);
      const current = latest.servers.find((item) => item.name === name);
      if (!current || current.state !== "starting") {
        if (current?.state === "connected") setNotice({ kind: "success", text: `${name} connected with ${current.tools.length} tools.` });
        else if (current?.state === "needs-sign-in") setNotice({ kind: "error", text: `${name} needs sign-in. Run pi-ark mcp login ${name}.` });
        else if (current?.state === "failed") setNotice({ kind: "error", text: current.diagnostics.join(" ") || `${name} failed to connect.` });
        return;
      }
      if (mounted.current) setNotice({ kind: "success", text: `${name} is starting. Checking connection…` });
    }
    if (mounted.current) setNotice({ kind: "error", text: `${name} is still starting. Use Refresh to check progress.` });
  }

  async function toggleServer(server: McpServerView, enabled: boolean) {
    if (busyName || refreshing) return;
    const targetWorkspace = workspaceId;
    setBusyName(server.name); setNotice(null);
    try {
      if (server.name === "playwright" && enabled) {
        const status = await ensureBrowser();
        if (!status) return;
        if (status.state !== "installed") {
          setNotice({ kind: "error", text: status.state === "installing" ? "Browser installation is still running. Use Refresh to check progress." : "Browser installation failed. The installer log is shown under playwright." });
          return;
        }
      }
      await api.setMcpServerState(server.name, enabled);
      if (!mounted.current) return;
      if (!enabled) {
        await loadData(targetWorkspace, "refresh");
        if (mounted.current) setNotice({ kind: "success", text: `${server.name} disabled.` });
        return;
      }
      setData((current) => current ? { ...current, servers: current.servers.map((item) => item.name === server.name ? { ...item, enabled, state: "starting" } : item) } : current);
      setNotice({ kind: "success", text: `${server.name} enabled. Checking connection…` });
      await waitForServerState(server.name, targetWorkspace);
    } catch (reason) {
      if (mounted.current) setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save MCP server state" });
    } finally {
      if (mounted.current) setBusyName(null);
    }
  }

  async function toggleAdvanced(server: McpServerView, enabled: boolean) {
    if (busyName || refreshing) return;
    const targetWorkspace = workspaceId;
    setBusyName(server.name); setNotice(null);
    try {
      await api.setMcpAdvanced(server.name, enabled);
      if (!mounted.current) return;
      setData((current) => current ? { ...current, servers: current.servers.map((item) => item.name === server.name ? { ...item, advanced: enabled, state: item.enabled ? "starting" : item.state } : item) } : current);
      setNotice({ kind: "success", text: `${server.name} advanced capabilities ${enabled ? "enabled" : "disabled"}.` });
      if (server.enabled) await waitForServerState(server.name, targetWorkspace);
    } catch (reason) {
      if (mounted.current) setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save advanced capabilities" });
    } finally {
      if (mounted.current) setBusyName(null);
    }
  }

  function renderBrowserRuntime() {
    const log = logExcerpt(browser?.log);
    const browserState = installing ? "installing" : browser?.state || "unavailable";
    return <div className="mcp-browser-panel">
      <div className="mcp-browser-heading">
        <Globe2 size={13} />
        <span>Browser runtime</span>
        <strong className={`mcp-state state-${browserState}`}>{installing ? "Installing" : browser ? browserLabels[browser.state] : "Unavailable"}{!installing && browser?.version ? ` · ${browser.version}` : ""}</strong>
        {installing && <LoaderCircle size={12} className="agent-resource-spin" />}
      </div>
      {browser?.directory && <div className="mcp-browser-path"><span>Target directory</span><code>{browser.directory}</code></div>}
      {browser?.state === "failed" && log && <pre className="mcp-browser-log">{log}</pre>}
      {!installing && browser?.state !== "installed" && <span className="mcp-browser-hint">Enabling playwright installs the Chromium headless shell into this directory.</span>}
    </div>;
  }

  function renderServer(server: McpServerView) {
    const busy = busyName === server.name;
    return <div className="mcp-server-row" key={server.name}>
      <div className="mcp-server-head">
        <div className="mcp-server-identity">
          <div className="agent-resource-title">
            <strong>{server.name}</strong>
            {server.name === "playwright" && <span className="agent-resource-badge recommended">Recommended</span>}
            <span className={`agent-resource-status ${stateClasses[server.state]}`}>{stateLabels[server.state]}</span>
          </div>
        </div>
        {busy ? <LoaderCircle size={16} className="agent-resource-spin" /> : <Toggle checked={server.enabled} disabled={busyName !== null || loading || refreshing} onChange={(checked) => void toggleServer(server, checked)} label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`} />}
      </div>
      <div className="mcp-server-meta">
        <span><em>Source</em><strong>{server.source === "built-in" ? "Built-in" : "User"}</strong></span>
        <span><em>Transport</em><strong>{server.transport || "—"}</strong></span>
        <span><em>Exposure</em><strong>{server.exposure || "—"}</strong></span>
        <span><em>Registered actions</em><strong>{server.tools.length}</strong></span>
      </div>
      {server.state === "needs-sign-in" && <div className="mcp-login-command"><ShieldAlert size={13} /><span>Sign in with</span><code>pi-ark mcp login {server.name}</code></div>}
      {server.diagnostics.length > 0 && <ul className="mcp-server-diagnostics">{server.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}</ul>}
      {server.name === "playwright" && <div className="mcp-advanced-row"><div><strong>Advanced capabilities</strong><span>Storage, network, DevTools, vision and configuration actions.</span></div><Toggle checked={server.advanced !== false} disabled={busyName !== null || loading || refreshing} onChange={(checked) => void toggleAdvanced(server, checked)} label={`${server.advanced !== false ? "Disable" : "Enable"} advanced capabilities`} /></div>}
      {server.name === "playwright" && renderBrowserRuntime()}
    </div>;
  }

  return <>
    {notice && <div role="status" className={`settings-notice ${notice.kind}`}>{notice.kind === "success" ? <Check size={15} /> : <CircleAlert size={15} />}{notice.text}</div>}
    <section className="settings-section">
      <div className="settings-section-title">
        <Plug size={17} />
        <div><h3>MCP servers</h3><p>Servers available to the Agent. Server definitions are managed with the pi-ark mcp command.</p></div>
        <div className="agent-resource-toolbar"><button type="button" className="secondary-button" disabled={loading || refreshing || busyName !== null} onClick={() => void refresh()}>{refreshing || loading ? <LoaderCircle size={13} className="agent-resource-spin" /> : <RefreshCw size={13} />}Refresh</button></div>
      </div>
      {data?.errors.length ? <div className="agent-resource-errors" role="alert"><div className="agent-resource-errors-title"><CircleAlert size={14} /><strong>Configuration errors</strong></div>{data.errors.map((error, index) => <p key={index}>{error}</p>)}</div> : null}
      {loading && !data ? <div className="settings-inline-loading"><LoaderCircle size={16} className="agent-resource-spin" />Loading MCP servers</div> : data ? data.servers.length > 0 ? <div className="mcp-server-list">{data.servers.map(renderServer)}</div> : <div className="agent-resource-empty">No MCP servers are configured. Add one with <code>pi-ark mcp add &lt;name&gt;</code>.</div> : <div className="agent-resource-empty">{workspaceId ? "The MCP server list is unavailable. Use Refresh to try again." : "Open a workspace to load MCP servers."}</div>}
    </section>
  </>;
}
