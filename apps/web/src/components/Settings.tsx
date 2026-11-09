import { Check, CircleAlert, Cpu, Download, Eye, FileText, KeyRound, LoaderCircle, LogOut, MessageSquareText, PackageOpen, Palette, RefreshCw, RotateCcw, Save, Settings2, SlidersHorizontal, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { applyTheme, themes } from "../theme";
import type { GlobalSettings, ModelOption, ReleaseInfo, SubscriptionAuthFlow, ThemeId, Workspace, WorkspaceSettings } from "../types";
import { Select } from "./Select";
import { SubscriptionLogin } from "./SubscriptionLogin";

type SettingsTab = "global" | "workspace";
type WorkspaceTool = WorkspaceSettings["agent"]["tools"][number];
const toolOptions: Array<{ id: WorkspaceTool; name: string; description: string }> = [
  { id: "read", name: "Read", description: "Read files from the workspace" },
  { id: "bash", name: "Bash", description: "Run shell commands in the workspace" },
  { id: "edit", name: "Edit", description: "Apply precise changes to existing files" },
  { id: "write", name: "Write", description: "Create or replace files" },
];
const thinkingOrder: GlobalSettings["thinkingLevel"][] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const queueOptions = [{ value: "one-at-a-time", label: "One at a time", description: "Process each queued message separately" }, { value: "all", label: "All queued", description: "Deliver all queued messages together" }];

function closestThinkingLevel(levels: GlobalSettings["thinkingLevel"][], requested: GlobalSettings["thinkingLevel"]): GlobalSettings["thinkingLevel"] {
  if (levels.includes(requested)) return requested;
  const requestedIndex = thinkingOrder.indexOf(requested);
  return thinkingOrder.slice(requestedIndex).find((level) => levels.includes(level)) || [...thinkingOrder.slice(0, requestedIndex)].reverse().find((level) => levels.includes(level)) || levels[0] || "off";
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} className={`settings-toggle ${checked ? "enabled" : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}

export function Settings({ workspace }: { workspace?: Workspace }) {
  const [tab, setTab] = useState<SettingsTab>("global");
  const [global, setGlobal] = useState<GlobalSettings | null>(null);
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [releaseChecking, setReleaseChecking] = useState(false);
  const [releaseUpdating, setReleaseUpdating] = useState(false);
  const [releaseUpdateOpen, setReleaseUpdateOpen] = useState(false);
  const [releaseRollbackOpen, setReleaseRollbackOpen] = useState(false);
  const [globalSystemPrompt, setGlobalSystemPrompt] = useState({ content: "", systemPromptPath: "", appendSystemPromptPath: "" });
  const [promptRefreshing, setPromptRefreshing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [workspacePromptDraft, setWorkspacePromptDraft] = useState("");
  const [subscriptionMode, setSubscriptionMode] = useState(false);
  const [subscriptionFlow, setSubscriptionFlow] = useState<SubscriptionAuthFlow | null>(null);
  const [subscriptionBusy, setSubscriptionBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const globalSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const workspaceSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const globalSaveRevision = useRef(0);
  const workspaceSaveRevision = useRef(0);
  const workspaceIdRef = useRef(workspace?.id);
  workspaceIdRef.current = workspace?.id;

  useEffect(() => {
    let active = true;
    ++workspaceSaveRevision.current;
    setLoading(true); setSaving(false); setNotice(null);
    if (!workspace && tab === "workspace") setTab("global");
    Promise.all([api.globalSettings(), workspace ? api.workspaceSettings(workspace.id) : Promise.resolve(null), api.globalSystemPrompt(workspace?.id), api.releaseInfo()]).then(async ([globalResult, workspaceResult, promptPreview, releaseInfo]) => {
      const nextModels = (await api.providerModels(globalResult.provider)).models;
      if (!active) return;
      setGlobal(globalResult); setWorkspaceSettings(workspaceResult); setWorkspacePromptDraft(workspaceResult?.agent.systemPrompt.append || ""); setGlobalSystemPrompt(promptPreview); setRelease(releaseInfo); applyTheme(globalResult.theme);
      setSubscriptionMode(Boolean(globalResult.providers.find((provider) => provider.id === globalResult.provider)?.usingSubscription));
      setModels(nextModels);
    }).catch((reason) => { if (active) setNotice({ kind: "error", text: reason.message }); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspace?.id]);

  const selectedProvider = useMemo(() => global?.providers.find((provider) => provider.id === global.provider), [global]);
  const selectedModel = useMemo(() => models.find((model) => model.id === global?.model), [global?.model, models]);

  useEffect(() => {
    if (!subscriptionFlow || subscriptionFlow.status !== "pending") return;
    const timer = window.setTimeout(() => {
      void api.subscriptionLogin(subscriptionFlow.id).then((next) => { setSubscriptionFlow(next); if (next.status === "success") void subscriptionCompleted(); }).catch((reason) => setNotice({ kind: "error", text: reason.message }));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [subscriptionFlow]);

  function persistGlobal(next: GlobalSettings, options: { apiKey?: string; success?: string; clearApiKey?: boolean } = {}): Promise<void> {
    const revision = ++globalSaveRevision.current;
    setGlobal(next); setSaving(true); setNotice(null);
    const task = globalSaveQueue.current.catch(() => undefined).then(async () => {
      const saved = await api.saveGlobalSettings({ theme: next.theme, provider: next.provider, model: next.model, thinkingLevel: next.thinkingLevel, steeringMode: next.steeringMode, followUpMode: next.followUpMode, compactionEnabled: next.compactionEnabled, retryEnabled: next.retryEnabled, apiKey: options.apiKey });
      if (revision === globalSaveRevision.current) {
        setGlobal(saved); applyTheme(saved.theme);
        if (options.clearApiKey) setApiKey("");
        setNotice({ kind: "success", text: options.success || "Setting saved." });
      }
    }).catch(async (reason) => {
      if (revision === globalSaveRevision.current) {
        setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save setting" });
        const restored = await api.globalSettings().catch(() => null);
        if (restored) { setGlobal(restored); applyTheme(restored.theme); }
      }
    }).finally(() => { if (revision === globalSaveRevision.current) setSaving(false); });
    globalSaveQueue.current = task;
    return task;
  }

  function persistAgentDefaults(next: GlobalSettings, success: string): Promise<void> {
    const revision = ++globalSaveRevision.current;
    setGlobal(next); setSaving(true); setNotice(null);
    const task = globalSaveQueue.current.catch(() => undefined).then(async () => {
      await api.saveGlobalAgentDefaults({ steeringMode: next.steeringMode, followUpMode: next.followUpMode, compactionEnabled: next.compactionEnabled, retryEnabled: next.retryEnabled });
      if (revision === globalSaveRevision.current) setNotice({ kind: "success", text: success });
    }).catch(async (reason) => {
      if (revision === globalSaveRevision.current) {
        setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save agent default" });
        const restored = await api.globalSettings().catch(() => null);
        if (restored) setGlobal((current) => current ? { ...current, steeringMode: restored.steeringMode, followUpMode: restored.followUpMode, compactionEnabled: restored.compactionEnabled, retryEnabled: restored.retryEnabled } : restored);
      }
    }).finally(() => { if (revision === globalSaveRevision.current) setSaving(false); });
    globalSaveQueue.current = task;
    return task;
  }

  function updateProviderDefault(next: GlobalSettings, success: string) {
    if (selectedProvider?.configured) void persistGlobal(next, { success });
    else setGlobal(next);
  }

  async function selectProvider(provider: string) {
    if (!global) return;
    if (subscriptionFlow?.status === "pending") await api.cancelSubscriptionLogin(subscriptionFlow.id).catch(() => undefined);
    const providerOption = global.providers.find((item) => item.id === provider);
    setSubscriptionFlow(null); setSubscriptionMode(Boolean(providerOption?.usingSubscription)); setApiKey(""); setNotice(null);
    try {
      const nextModels = (await api.providerModels(provider)).models;
      const model = nextModels.find((item) => item.id === global.model) || nextModels[0];
      const next = { ...global, provider, model: model?.id || "", thinkingLevel: closestThinkingLevel(model?.thinkingLevels || ["off"], global.thinkingLevel) };
      setModels(nextModels); setGlobal(next);
      if (providerOption?.configured && model) await persistGlobal(next, { success: "Provider and model saved." });
    } catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot load models" }); }
  }

  async function subscriptionCompleted() {
    if (!global) return;
    const provider = global.provider;
    const refreshed = await api.globalSettings();
    const nextModels = (await api.providerModels(provider)).models;
    const model = nextModels.find((item) => item.id === global.model) || nextModels[0];
    const next = { ...refreshed, provider, model: model?.id || "", thinkingLevel: closestThinkingLevel(model?.thinkingLevels || ["off"], global.thinkingLevel) };
    setSubscriptionMode(true); setSubscriptionBusy(false); setModels(nextModels);
    if (model) await persistGlobal(next, { success: "Subscription connected and provider defaults saved." });
  }

  async function startSubscriptionLogin() {
    if (!selectedProvider) return;
    setSubscriptionBusy(true); setNotice(null);
    try { setSubscriptionFlow(await api.startSubscriptionLogin(selectedProvider.id)); }
    catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot start subscription sign-in" }); }
    finally { setSubscriptionBusy(false); }
  }

  async function answerSubscriptionLogin(promptId: string, value: string) {
    if (!subscriptionFlow) return;
    const next = await api.answerSubscriptionLogin(subscriptionFlow.id, promptId, value);
    setSubscriptionFlow(next);
    if (next.status === "success") await subscriptionCompleted();
  }

  async function cancelSubscriptionLogin() {
    if (!subscriptionFlow) return;
    await api.cancelSubscriptionLogin(subscriptionFlow.id);
    setSubscriptionFlow({ ...subscriptionFlow, status: "cancelled", prompt: undefined });
  }

  async function toggleSubscription(enabled: boolean) {
    setSubscriptionMode(enabled); setApiKey("");
    if (!enabled) { if (subscriptionFlow?.status === "pending") await cancelSubscriptionLogin(); setSubscriptionFlow(null); return; }
    if (!selectedProvider?.usingSubscription) await startSubscriptionLogin();
  }

  function selectDefaultModel(modelId: string) {
    if (!global) return;
    const model = models.find((item) => item.id === modelId);
    const next = { ...global, model: modelId, thinkingLevel: closestThinkingLevel(model?.thinkingLevels || ["off"], global.thinkingLevel) };
    updateProviderDefault(next, "Model default saved.");
  }

  function saveApiKey() {
    if (!global || !apiKey.trim()) return;
    void persistGlobal(global, { apiKey: apiKey.trim(), clearApiKey: true, success: "API key and provider defaults saved." });
  }

  async function cancelApiKeyEdit() {
    setApiKey(""); setNotice(null);
    const restored = await api.globalSettings();
    const restoredModels = (await api.providerModels(restored.provider)).models;
    setGlobal(restored); setModels(restoredModels); setSubscriptionMode(Boolean(restored.providers.find((provider) => provider.id === restored.provider)?.usingSubscription));
  }

  async function checkReleaseUpdate() {
    setReleaseChecking(true); setNotice(null);
    try { setRelease(await api.releaseInfo(true)); }
    catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot check for Pi-Ark updates" }); }
    finally { setReleaseChecking(false); }
  }

  async function updateRelease() {
    setReleaseUpdating(true); setNotice(null);
    try {
      const result = await api.updateRelease();
      setRelease(result); setReleaseUpdateOpen(false);
      setNotice({ kind: "success", text: `Pi-Ark update is ready. The service will restart in ${result.restartDelaySeconds} seconds.` });
    } catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot update Pi-Ark" }); }
    finally { setReleaseUpdating(false); }
  }

  async function rollbackRelease() {
    setReleaseUpdating(true); setNotice(null);
    try {
      const result = await api.rollbackRelease();
      setRelease(result); setReleaseRollbackOpen(false);
      setNotice({ kind: "success", text: `Pi-Ark rollback is ready. The service will restart in ${result.restartDelaySeconds} seconds.` });
    } catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot roll back Pi-Ark" }); }
    finally { setReleaseUpdating(false); }
  }

  async function refreshGlobalPrompt() {
    setPromptRefreshing(true); setNotice(null);
    try { setGlobalSystemPrompt(await api.globalSystemPrompt(workspace?.id)); }
    catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot refresh global system prompt" }); }
    finally { setPromptRefreshing(false); }
  }

  async function saveWorkspacePrompt() {
    if (!workspace || !workspaceSettings) return;
    const workspaceId = workspace.id;
    setSaving(true); setNotice(null);
    const task = workspaceSaveQueue.current.catch(() => undefined).then(() => api.saveWorkspaceSystemPrompt(workspaceId, { append: workspacePromptDraft }));
    workspaceSaveQueue.current = task.then(() => undefined, () => undefined);
    try {
      const saved = await task;
      if (workspaceIdRef.current !== workspaceId) return;
      setWorkspaceSettings((current) => current ? { ...current, agent: { ...current.agent, systemPrompt: saved.agent.systemPrompt } } : saved);
      setWorkspacePromptDraft(saved.agent.systemPrompt.append); setNotice({ kind: "success", text: "Workspace system prompt append saved. Newly opened sessions will use this content." });
    } catch (reason) { if (workspaceIdRef.current === workspaceId) setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save workspace system prompt" }); }
    finally { if (workspaceIdRef.current === workspaceId) setSaving(false); }
  }

  function cancelWorkspacePrompt() {
    setWorkspacePromptDraft(workspaceSettings?.agent.systemPrompt.append || ""); setNotice(null);
  }

  function persistWorkspace(next: WorkspaceSettings, success: string): Promise<void> {
    if (!workspace) return Promise.resolve();
    const workspaceId = workspace.id;
    const revision = ++workspaceSaveRevision.current;
    setWorkspaceSettings(next); setSaving(true); setNotice(null);
    const task = workspaceSaveQueue.current.catch(() => undefined).then(async () => {
      const saved = await api.saveWorkspaceSettings(workspaceId, { agent: { tools: next.agent.tools }, files: next.files });
      if (workspaceIdRef.current === workspaceId && revision === workspaceSaveRevision.current) { setWorkspaceSettings(saved); setNotice({ kind: "success", text: success }); }
    }).catch(async (reason) => {
      if (workspaceIdRef.current === workspaceId && revision === workspaceSaveRevision.current) {
        setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save workspace setting" });
        const restored = await api.workspaceSettings(workspaceId).catch(() => null);
        if (restored && workspaceIdRef.current === workspaceId) setWorkspaceSettings(restored);
      }
    }).finally(() => { if (workspaceIdRef.current === workspaceId && revision === workspaceSaveRevision.current) setSaving(false); });
    workspaceSaveQueue.current = task;
    return task;
  }

  async function selectTheme(theme: ThemeId) {
    if (!global) return;
    const previous = global.theme;
    setGlobal({ ...global, theme }); applyTheme(theme); setNotice(null);
    try { await api.saveUiSettings(theme); setNotice({ kind: "success", text: "Theme saved." }); }
    catch (reason) { setGlobal({ ...global, theme: previous }); applyTheme(previous); setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save theme" }); }
  }

  function toggleTool(tool: WorkspaceTool) {
    if (!workspaceSettings) return;
    const selected = workspaceSettings.agent.tools.includes(tool);
    const tools = selected ? workspaceSettings.agent.tools.filter((item) => item !== tool) : [...workspaceSettings.agent.tools, tool];
    if (tools.length === 0) { setNotice({ kind: "error", text: "Select at least one agent tool" }); return; }
    const next = { ...workspaceSettings, agent: { ...workspaceSettings.agent, tools } };
    void persistWorkspace(next, "Agent tools saved. Newly opened sessions will use this selection.");
  }

  function updateFileSettings(files: WorkspaceSettings["files"], success: string) {
    if (!workspaceSettings) return;
    void persistWorkspace({ ...workspaceSettings, files }, success);
  }

  if (loading) return <section className="settings-page"><div className="page-loading"><LoaderCircle size={20} />Loading settings</div></section>;

  return <section className="settings-page">
    <header className="page-header"><div><h2>Settings</h2><p>{workspace ? `Global defaults and ${workspace.name} preferences` : "Global defaults and account"}</p></div></header>
    <div className="settings-layout">
      <div className="settings-tabs" role="tablist">
        <button className={tab === "global" ? "active" : ""} onClick={() => { setTab("global"); setNotice(null); }}><Settings2 size={16} /><span>Global</span><small>All workspaces</small></button>
        <button className={tab === "workspace" ? "active" : ""} disabled={!workspace} onClick={() => { setTab("workspace"); setNotice(null); }}><SlidersHorizontal size={16} /><span>Workspace</span><small>{workspace?.name || "No workspace"}</small></button>
      </div>
      <main className="settings-content">
        <div className="settings-scope"><span>{tab === "global" ? "Global configuration" : "Workspace configuration"}</span><code>{tab === "global" ? `${release?.agentDir || "PI_ARK_HOME/pi-agent"}/settings.json + PI_ARK_HOME/config.json` : `${workspace?.path || "No workspace"}/.pi-ark/config.json`}</code></div>
        {notice && <div className={`settings-notice ${notice.kind}`}>{notice.kind === "success" ? <Check size={16} /> : <CircleAlert size={16} />}{notice.text}</div>}
        {tab === "global" && global && <>
          <div className="settings-category-title"><span>Interface</span><p>Visual preferences shared by this Pi-Ark service.</p></div>
          <section className="settings-section">
            <div className="settings-section-title"><Palette size={17} /><div><h3>Appearance</h3><p>Theme shared by every workspace and device using this service.</p></div></div>
            {(["dark", "light"] as const).map((group) => <div className="theme-group" key={group}><h4>{group === "dark" ? "Dark" : "Light"}</h4><div className="theme-options">{themes.filter((theme) => theme.group === group).map((theme) => <button type="button" className={global.theme === theme.id ? "selected" : ""} onClick={() => void selectTheme(theme.id)} key={theme.id}><span className="theme-preview">{theme.colors.map((color) => <i style={{ background: color }} key={color} />)}</span><span><strong>{theme.name}</strong><small>{theme.description}</small></span>{global.theme === theme.id && <Check size={14} />}</button>)}</div></div>)}
          </section>
          <div className="settings-category-title"><span>AI runtime</span><p>Provider credentials and defaults for new sessions.</p></div>
          <section className="settings-section">
            <div className="settings-section-title"><Cpu size={17} /><div><h3>Provider and model</h3><p>Default AI connection for new sessions in every workspace.</p></div></div>
            <div className="settings-grid settings-grid-three">
              <label className="settings-field"><span>Provider</span><Select ariaLabel="Provider" value={global.provider} onChange={(value) => void selectProvider(value)} options={global.providers.map((provider) => ({ value: provider.id, label: provider.name, status: provider.configured ? "Configured" : undefined, description: provider.configured ? provider.authLabel || provider.authSource : "Authentication required" }))} /></label>
              <label className="settings-field"><span>Model</span><Select ariaLabel="Model" value={global.model} onChange={selectDefaultModel} options={models.map((model) => ({ value: model.id, label: model.name || model.id, description: `${model.contextWindow.toLocaleString()} context${model.reasoning ? " · reasoning" : ""}` }))} /></label>
              <label className="settings-field"><span>Thinking level</span><Select ariaLabel="Default model thinking level" value={global.thinkingLevel} onChange={(value) => updateProviderDefault({ ...global, thinkingLevel: value as GlobalSettings["thinkingLevel"] }, "Thinking default saved.")} options={(selectedModel?.thinkingLevels || ["off"]).map((level) => ({ value: level, label: level }))} /></label>
            </div>
            <div className="provider-status"><i className={selectedProvider?.configured ? "configured" : ""} /><span>{selectedProvider?.configured ? `Authenticated${selectedProvider.authLabel ? ` · ${selectedProvider.authLabel}` : selectedProvider.authSource ? ` · ${selectedProvider.authSource}` : ""}` : "Authentication required"}</span></div>
            {selectedProvider?.supportsSubscription && <div className="subscription-mode"><div><strong>Use subscription account</strong><span>{selectedProvider.subscriptionName}</span></div><Toggle checked={subscriptionMode} onChange={(checked) => void toggleSubscription(checked)} /></div>}
            {selectedProvider?.supportsSubscription && subscriptionMode && <SubscriptionLogin provider={selectedProvider} flow={subscriptionFlow} busy={subscriptionBusy} onStart={() => void startSubscriptionLogin()} onAnswer={answerSubscriptionLogin} onCancel={() => void cancelSubscriptionLogin()} />}
            {!subscriptionMode && <div className="settings-confirm-field"><label className="settings-field settings-api-key"><span><KeyRound size={14} />API key</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && apiKey.trim()) saveApiKey(); }} placeholder={selectedProvider?.configured ? "Leave empty to keep the current credential" : "Enter an API key"} /><small>Write-only. Saved by pi in its global credential store and never returned to the browser.</small></label>{(apiKey || !selectedProvider?.configured) && <div className="inline-setting-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => void cancelApiKeyEdit()}>Cancel</button><button type="button" className="primary-button" disabled={saving || !apiKey.trim()} onClick={saveApiKey}>{saving ? <LoaderCircle size={14} /> : <Save size={14} />}Save API key</button></div>}</div>}
          </section>
          <div className="settings-category-title"><span>Installation and maintenance</span><p>Release status, paths, updates, rollback, logs, and service commands.</p></div>
          {release && <section className="settings-section pi-core-section">
            <div className="settings-section-title"><PackageOpen size={17} /><div><h3>Pi-Ark release</h3><p>Pi-Ark and its bundled, compatible pi core are updated together.</p></div></div>
            <div className="pi-core-details"><div><span>Pi-Ark version</span><strong>{release.version}</strong></div><div><span>Bundled pi core</span><strong>{release.coreVersion}</strong></div><div><span>Install mode</span><strong>{release.installedRelease ? `Release · ${release.channel}` : "Development checkout"}</strong></div>{release.latestVersion && <div><span>Latest release</span><strong>{release.latestVersion}</strong></div>}{release.previousVersion && <div><span>Previous release</span><strong>{release.previousVersion}</strong></div>}<div className="path"><span>Install path</span><code>{release.installPath}</code></div><div className="path"><span>Data path</span><code>{release.dataDir}</code></div><div className="path"><span>Pi-Ark agent data</span><code>{release.agentDir}</code></div><div className="path"><span>Pi core package</span><code>{release.corePath}</code></div></div>
            <div className="maintenance-commands"><span>Service management commands</span>{Object.entries(release.commands).map(([name, command]) => <div key={name}><strong>{name}</strong><code>{command}</code></div>)}</div>
            <div className="pi-core-actions"><button type="button" className="secondary-button" disabled={releaseChecking || releaseUpdating} onClick={() => void checkReleaseUpdate()}>{releaseChecking ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}Check for updates</button>{release.rollbackAvailable && <button type="button" className="secondary-button" disabled={releaseUpdating} onClick={() => setReleaseRollbackOpen(true)}><RotateCcw size={14} />Roll back</button>}{release.channel === "stable" && release.latestVersion && release.updateAvailable && <button type="button" className="primary-button" disabled={releaseUpdating || !release.installedRelease} onClick={() => setReleaseUpdateOpen(true)}><Download size={14} />Update to {release.latestVersion}</button>}{release.channel === "stable" && release.latestVersion && !release.updateAvailable && <span className="pi-core-current"><Check size={13} />Up to date</span>}{release.channel === "development" && <span className="pi-core-current">Development build</span>}</div>
          </section>}
          <div className="settings-category-title"><span>Agent instructions and behavior</span><p>Effective system prompt and shared conversation defaults.</p></div>
          <section className="settings-section">
            <div className="settings-section-title"><MessageSquareText size={17} /><div><h3>System prompt</h3><p>View the effective prompt generated by Pi-Ark's pi core. Edit the optional files on the server, then refresh this preview.</p></div></div>
            <div className="prompt-file-guide"><div><FileText size={15} /><span><strong>Optional replacement file</strong><code>{globalSystemPrompt.systemPromptPath}</code></span></div><div><FileText size={15} /><span><strong>Optional append file</strong><code>{globalSystemPrompt.appendSystemPromptPath}</code></span></div><p>The preview below is the complete effective prompt generated by pi. It includes built-in instructions, tools, context files, skills, and the current workspace path; it is not the raw content of these optional files.</p></div>
            <div className="system-prompt-view"><div className="system-prompt-toolbar"><span className="system-prompt-mode">Effective system prompt · {workspace?.name || "service workspace"}</span><button type="button" className="secondary-button system-prompt-edit" disabled={promptRefreshing} onClick={() => void refreshGlobalPrompt()}>{promptRefreshing ? <LoaderCircle size={13} /> : <RefreshCw size={13} />}Refresh</button></div><pre>{globalSystemPrompt.content}</pre></div>
          </section>
          <section className="settings-section">
            <div className="settings-section-title"><SlidersHorizontal size={17} /><div><h3>Agent defaults</h3><p>Conversation behavior shared by all workspaces.</p></div></div>
            <div className="settings-grid">
              <label className="settings-field"><span>Steering messages</span><Select ariaLabel="Steering messages" value={global.steeringMode} onChange={(value) => void persistAgentDefaults({ ...global, steeringMode: value as GlobalSettings["steeringMode"] }, "Steering mode saved.")} options={queueOptions} /></label>
              <label className="settings-field"><span>Follow-up messages</span><Select ariaLabel="Follow-up messages" value={global.followUpMode} onChange={(value) => void persistAgentDefaults({ ...global, followUpMode: value as GlobalSettings["followUpMode"] }, "Follow-up mode saved.")} options={queueOptions} /></label>
            </div>
            <div className="settings-rows">
              <div className="settings-row"><div><strong>Automatic compaction</strong><span>Summarize older context when the model context approaches its limit.</span></div><Toggle checked={global.compactionEnabled} onChange={(checked) => void persistAgentDefaults({ ...global, compactionEnabled: checked }, "Automatic compaction setting saved.")} /></div>
              <div className="settings-row"><div><strong>Automatic retry</strong><span>Retry transient provider failures with pi defaults.</span></div><Toggle checked={global.retryEnabled} onChange={(checked) => void persistAgentDefaults({ ...global, retryEnabled: checked }, "Automatic retry setting saved.")} /></div>
            </div>
          </section>
          <div className="settings-category-title"><span>Account and security</span><p>Current browser authentication session.</p></div>
          <section className="settings-section account-section">
            <div className="settings-section-title"><LogOut size={17} /><div><h3>Account</h3><p>End the current Pi-Ark browser session.</p></div></div>
            <button className="secondary-button account-signout" onClick={async () => { await api.logout(); window.location.reload(); }}><LogOut size={15} />Sign out</button>
          </section>
        </>}
        {tab === "workspace" && workspace && workspaceSettings && <>
          <section className="settings-section">
            <div className="settings-section-title"><MessageSquareText size={17} /><div><h3>System prompt append</h3><p>Append Workspace content after pi loads its system prompt files. Save an empty value to clear the Workspace append.</p></div></div>
            <label className="settings-field"><span>Workspace append content</span><textarea className="settings-textarea" rows={10} value={workspacePromptDraft} onChange={(event) => setWorkspacePromptDraft(event.target.value)} placeholder="Optional content appended for this workspace" /></label>
            <div className="system-prompt-editor-actions"><button type="button" className="secondary-button" disabled={saving || workspacePromptDraft === workspaceSettings.agent.systemPrompt.append} onClick={cancelWorkspacePrompt}>Cancel</button><button type="button" className="primary-button" disabled={saving || workspacePromptDraft === workspaceSettings.agent.systemPrompt.append} onClick={() => void saveWorkspacePrompt()}>{saving ? <LoaderCircle size={14} /> : <Save size={14} />}Save system prompt</button></div>
          </section>
          <section className="settings-section">
            <div className="settings-section-title"><Wrench size={17} /><div><h3>Agent tools</h3><p>Tools enabled when Pi-Ark opens a session in {workspace.name}.</p></div></div>
            <div className="tool-options">{toolOptions.map((tool) => <button type="button" className={workspaceSettings.agent.tools.includes(tool.id) ? "selected" : ""} onClick={() => toggleTool(tool.id)} key={tool.id}><span className="tool-check">{workspaceSettings.agent.tools.includes(tool.id) && <Check size={13} />}</span><div><strong>{tool.name}</strong><small>{tool.description}</small></div></button>)}</div>
          </section>
          <section className="settings-section">
            <div className="settings-section-title"><Eye size={17} /><div><h3>File browser</h3><p>Display preferences for the current workspace.</p></div></div>
            <div className="settings-rows"><div className="settings-row"><div><strong>Show hidden files</strong><span>Include dotfiles such as .gitignore. Pi-Ark internal state remains private.</span></div><Toggle checked={workspaceSettings.files.showHiddenFiles} onChange={(checked) => updateFileSettings({ ...workspaceSettings.files, showHiddenFiles: checked }, "Hidden file preference saved.")} /></div></div>
            <label className="settings-field settings-preview-size"><span>Maximum preview size</span><input type="number" min={1} max={100} step={1} value={workspaceSettings.files.maxPreviewSizeMb} onChange={(event) => setWorkspaceSettings({ ...workspaceSettings, files: { ...workspaceSettings.files, maxPreviewSizeMb: Number(event.target.value) } })} onBlur={() => updateFileSettings(workspaceSettings.files, "Preview size saved.")} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><small>Files up to this size can open in Files. Larger files remain available for download. Range: 1–100 MB.</small></label>
          </section>
        </>}
      </main>
    </div>
    {releaseUpdateOpen && release && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !releaseUpdating) setReleaseUpdateOpen(false); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="release-update-title"><div className="dialog-header no-close"><div className="dialog-icon"><Download size={18} /></div><div><h2 id="release-update-title">Update Pi-Ark?</h2><p>Pi-Ark will install release {release.latestVersion}, switch the current release atomically, preserve this data directory, and restart the service.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={releaseUpdating} onClick={() => setReleaseUpdateOpen(false)}>Cancel</button><button type="button" className="primary-button" disabled={releaseUpdating} onClick={() => void updateRelease()}>{releaseUpdating ? <LoaderCircle size={14} /> : <Download size={14} />}Update Pi-Ark</button></div></div></div>}
    {releaseRollbackOpen && release && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !releaseUpdating) setReleaseRollbackOpen(false); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="release-rollback-title"><div className="dialog-header no-close"><div className="dialog-icon"><RotateCcw size={18} /></div><div><h2 id="release-rollback-title">Roll back Pi-Ark?</h2><p>Pi-Ark will switch from {release.version} to {release.previousVersion}, preserve this data directory, and restart the service.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={releaseUpdating} onClick={() => setReleaseRollbackOpen(false)}>Cancel</button><button type="button" className="primary-button" disabled={releaseUpdating} onClick={() => void rollbackRelease()}>{releaseUpdating ? <LoaderCircle size={14} /> : <RotateCcw size={14} />}Roll back</button></div></div></div>}
  </section>;
}
