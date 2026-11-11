import { Check, CircleAlert, Eye, EyeOff, Folder, Globe2, LoaderCircle, Lock, PackageOpen, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { SkillScope, SkillSelection, SkillView, SkillsResponse, Workspace } from "../types";
import { Select } from "./Select";

type Notice = { kind: "success" | "error"; text: string };

const scopeLabels: Record<SkillScope, string> = { builtin: "Built-in", global: "Global", workspace: "Workspace" };

function preferredWorkspaceId(workspaces: Workspace[]): string {
  const fromUrl = new URLSearchParams(window.location.search).get("workspace");
  return workspaces.find((workspace) => workspace.id === fromUrl)?.id || workspaces[0]?.id || "";
}

function disabledNames(skills: SkillView[]): string[] {
  return skills.filter((skill) => !skill.enabled && !(skill.scope === "builtin" && skill.name === "browser")).map((skill) => skill.name);
}

function statusLabel(skill: SkillView): string {
  if (!skill.enabled) return "Disabled";
  return skill.explicitOnly ? "Explicit only" : "Enabled";
}

export function SkillsSettings({ active }: { active: boolean }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [playwrightEnabled, setPlaywrightEnabled] = useState<boolean | null>(null);
  const started = useRef(false);
  const workspaceDisabled = useRef<Record<string, string[]>>({});
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveRevision = useRef(0);
  const workspaceRef = useRef("");
  const urlWorkspaceRef = useRef("");

  useEffect(() => { workspaceRef.current = workspaceId; }, [workspaceId]);

  useEffect(() => {
    if (!active) return;
    if (!started.current) {
      started.current = true;
      void initialize();
      return;
    }
    if (workspaceId) void loadMcpDependency(workspaceId);
  }, [active]);

  useEffect(() => {
    if (!active || !started.current || workspaces.length === 0) return;
    const currentUrlWorkspace = new URLSearchParams(window.location.search).get("workspace") || "";
    if (currentUrlWorkspace === urlWorkspaceRef.current) return;
    const target = workspaces.find((workspace) => workspace.id === currentUrlWorkspace);
    if (!target) return;
    if (target.id === workspaceId) { urlWorkspaceRef.current = currentUrlWorkspace; return; }
    if (loading || saving) return;
    urlWorkspaceRef.current = currentUrlWorkspace;
    workspaceRef.current = target.id;
    setWorkspaceId(target.id);
    void loadWorkspace(target.id);
  }, [active]);

  const enabledSkills = useMemo(() => data ? [...data.builtin, ...data.global, ...data.workspace].filter((skill) => skill.enabled) : [], [data]);
  const promptSkills = useMemo(() => enabledSkills.filter((skill) => !skill.explicitOnly), [enabledSkills]);
  const descriptionLength = useMemo(() => promptSkills.reduce((total, skill) => total + skill.description.length, 0), [promptSkills]);
  const estimatedTokens = Math.ceil(descriptionLength / 4);

  function rememberSelection(result: SkillsResponse, targetWorkspace: string) {
    workspaceDisabled.current[targetWorkspace] = disabledNames(result.workspace);
  }

  async function loadMcpDependency(id: string) {
    try {
      const result = await api.mcpServers(id);
      if (workspaceRef.current === id) setPlaywrightEnabled(Boolean(result.servers.find((server) => server.name === "playwright")?.enabled));
    } catch {
      if (workspaceRef.current === id) setPlaywrightEnabled(null);
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
      workspaceRef.current = id;
      if (!id) { setData(null); return; }
      const skills = await api.skills(id);
      setData(skills); rememberSelection(skills, id);
      void loadMcpDependency(id);
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot load skills" });
    } finally {
      setLoading(false);
    }
  }

  async function loadWorkspace(id: string) {
    setLoading(true); setNotice(null); setData(null); setExpandedSkill(null);
    workspaceRef.current = id;
    saveRevision.current += 1;
    try {
      const result = await api.skills(id);
      setData(result); rememberSelection(result, id);
      void loadMcpDependency(id);
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot load skills" });
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    if (!workspaceId) { await initialize(); return; }
    setRefreshing(true); setNotice(null);
    try {
      const result = await api.skills(workspaceId);
      setData(result); rememberSelection(result, workspaceId);
      void loadMcpDependency(workspaceId);
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot refresh skills" });
    } finally {
      setRefreshing(false);
    }
  }

  function persistSelection(next: SkillsResponse, targetWorkspace: string) {
    const revision = ++saveRevision.current;
    const selection: SkillSelection = {
      disabledBuiltin: disabledNames(next.builtin),
      disabledGlobal: disabledNames(next.global),
      disabledWorkspace: { ...workspaceDisabled.current, [targetWorkspace]: disabledNames(next.workspace) },
    };
    setSaving(true); setNotice(null);
    const task = saveQueue.current.catch(() => undefined).then(async () => {
      const saved = await api.saveSkillSelection(selection);
      if (revision !== saveRevision.current || workspaceRef.current !== targetWorkspace) return;
      setData(saved); rememberSelection(saved, targetWorkspace);
      setNotice({ kind: "success", text: "Skill selection saved. New Sessions use the updated set." });
    }).catch(async (reason) => {
      if (revision !== saveRevision.current || workspaceRef.current !== targetWorkspace) return;
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save skill selection" });
      const restored = await api.skills(targetWorkspace).catch(() => null);
      if (restored && revision === saveRevision.current && workspaceRef.current === targetWorkspace) {
        setData(restored); rememberSelection(restored, targetWorkspace);
      }
    }).finally(() => {
      if (revision === saveRevision.current) setSaving(false);
    });
    saveQueue.current = task;
  }

  function applySkillToggle(scope: SkillScope, name: string, enabled: boolean) {
    if (!data || !workspaceId || loading || refreshing) return;
    const next: SkillsResponse = { ...data, builtin: data.builtin, global: data.global, workspace: data.workspace };
    next[scope] = data[scope].map((skill) => skill.name === name ? { ...skill, enabled } : skill);
    setData(next);
    void persistSelection(next, workspaceId);
  }

  function toggleSkill(scope: SkillScope, name: string, enabled: boolean) {
    applySkillToggle(scope, name, enabled);
  }

  function selectWorkspace(id: string) {
    if (id === workspaceId || loading || refreshing) return;
    setWorkspaceId(id);
    void loadWorkspace(id);
  }

  function renderSkillRows(skills: SkillView[], scope: SkillScope, emptyText: string) {
    if (skills.length === 0) return <div className="agent-resource-empty">{emptyText}</div>;
    return <div className="agent-resource-list">{skills.map((skill) => {
      const key = `${scope}:${skill.name}`;
      const open = expandedSkill === key;
      const isBrowser = scope === "builtin" && skill.name === "browser";
      const status = isBrowser ? (playwrightEnabled === null ? "Loading" : playwrightEnabled ? "Enabled" : "Disabled") : statusLabel(skill);
      const statusClass = isBrowser ? (playwrightEnabled ? "enabled" : "disabled") : !skill.enabled ? "disabled" : skill.explicitOnly ? "explicit" : "enabled";
      return <div className="agent-resource-row" key={key}>
        {isBrowser ? <span className="agent-resource-lock" title="Controlled by the playwright MCP server"><Lock size={13} /></span> : <input className="agent-resource-checkbox" type="checkbox" checked={skill.enabled} disabled={loading || refreshing} onChange={(event) => toggleSkill(scope, skill.name, event.target.checked)} aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`} />}
        <div className="agent-resource-copy">
          <div className="agent-resource-title">
            <strong>{skill.name}</strong>
            <span className={`agent-resource-badge ${skill.source === "built-in" ? "builtin" : "managed"}`}>{skill.source === "built-in" ? "Built-in" : "Managed"}</span>
            <span className={`agent-resource-status ${statusClass}`}>{status}</span>
          </div>
          <p>{skill.description || "No description."}</p>
          {isBrowser && playwrightEnabled === false && <p className="agent-resource-hint">Enable playwright in MCP to use this skill.</p>}
          <code className="agent-resource-path" title={skill.location}>{skill.location}</code>
        </div>
        <button type="button" className="secondary-button agent-resource-view" aria-expanded={open} aria-label={`${open ? "Hide" : "View"} ${skill.name}`} onClick={() => setExpandedSkill(open ? null : key)}>{open ? <EyeOff size={13} /> : <Eye size={13} />}{open ? "Hide" : "View"}</button>
        {open && <div className="agent-resource-details">
          <dl>
            <div><dt>Source</dt><dd>{skill.source === "built-in" ? "Built-in" : "Managed"}</dd></div>
            <div><dt>Scope</dt><dd>{scopeLabels[skill.scope]}</dd></div>
            <div><dt>Mode</dt><dd>{skill.explicitOnly ? "Explicit invocation only" : "Model list and explicit invocation"}</dd></div>
            <div><dt>Location</dt><dd><code>{skill.location}</code></dd></div>
          </dl>
          <p>Open <code>SKILL.md</code> at this location in Terminal to read the skill body.</p>
        </div>}
      </div>;
    })}</div>;
  }

  return <>
    {notice && <div role="status" className={`settings-notice ${notice.kind}`}>{notice.kind === "success" ? <Check size={15} /> : <CircleAlert size={15} />}{notice.text}</div>}
    <div className="agent-resource-overview">
      <div className="agent-resource-summary">
        {data ? <>
          <span><strong>{enabledSkills.length}</strong> skills enabled</span>
          <span>Model-visible descriptions <strong>{descriptionLength.toLocaleString()}</strong> characters</span>
          <span>Estimated context <strong>~{estimatedTokens.toLocaleString()}</strong> tokens</span>
          {saving && <span className="agent-resource-saving"><LoaderCircle size={12} className="agent-resource-spin" />Saving selection</span>}
        </> : <span>{loading ? "Loading skills" : workspaces.length > 0 ? "Skills unavailable" : "No workspace selected"}</span>}
      </div>
      <button type="button" className="secondary-button" disabled={loading || refreshing || saving} onClick={() => void refresh()}>{refreshing || loading ? <LoaderCircle size={13} className="agent-resource-spin" /> : <RefreshCw size={13} />}Refresh</button>
    </div>
    {loading && !data ? <section className="settings-section"><div className="settings-inline-loading"><LoaderCircle size={16} className="agent-resource-spin" />Loading skills</div></section> : data ? <>
      <section className="settings-section">
        <div className="settings-section-title"><PackageOpen size={17} /><div><h3>Built-in skills</h3><p>Skills shipped with Pi-Ark. They update with each release.</p></div></div>
        {renderSkillRows(data.builtin, "builtin", "No built-in skills found.")}
      </section>
      <section className="settings-section">
        <div className="settings-section-title"><Globe2 size={17} /><div><h3>Global skills</h3><p>Skills available in every workspace.</p></div></div>
        {renderSkillRows(data.global, "global", "No global skills found.")}
      </section>
      <section className="settings-section">
        <div className="settings-section-title"><Folder size={17} /><div><h3>Workspace skills</h3><p>Skills available only in the selected workspace.</p></div></div>
        {workspaces.length > 0 ? <>
          <label className="settings-field agent-resource-workspace-field"><span>Workspace</span><Select ariaLabel="Workspace for skills" value={workspaceId} disabled={saving || loading || refreshing} onChange={selectWorkspace} options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name, description: workspace.path }))} /></label>
          {renderSkillRows(data.workspace, "workspace", "No workspace skills found.")}
        </> : <div className="agent-resource-empty">Open a workspace to manage workspace skills.</div>}
      </section>
      {data.diagnostics.length > 0 && <section className="settings-section">
        <div className="settings-section-title"><CircleAlert size={17} /><div><h3>Diagnostics</h3><p>Problems found while scanning skill directories.</p></div></div>
        <ul className="agent-resource-diagnostics">{data.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.path}:${index}`}><code>{diagnostic.path}</code><span>{diagnostic.message}</span></li>)}</ul>
      </section>}
    </> : <section className="settings-section"><div className="agent-resource-empty">{workspaces.length > 0 ? "The skill list is unavailable. Use Refresh to try again." : "Open a workspace to load Agent skills."}</div></section>}
  </>;
}
