import { Check, CircleAlert, Cpu, Download, Eye, FileText, KeyRound, LoaderCircle, LogOut, MessageSquareText, PackageOpen, Palette, RefreshCw, RotateCcw, Save, Search, SlidersHorizontal, Star, Unplug } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { applyTheme, themes } from "../theme";
import type { GlobalSettings, ModelPreferences, ReleaseInfo, SubscriptionAuthFlow, ThemeId, UiSettings, GlobalPreferences } from "../types";
import { Select } from "./Select";
import { SubscriptionLogin } from "./SubscriptionLogin";

const categories = [
  { id: "interface", label: "Interface", description: "Appearance and conversation visibility.", icon: Palette },
  { id: "models", label: "Models & providers", description: "Credentials, available models, and defaults for new Sessions.", icon: Cpu },
  { id: "agent", label: "Agent behavior", description: "Shared instructions and conversation defaults.", icon: SlidersHorizontal },
  { id: "files", label: "Files", description: "File browsing and preview preferences.", icon: Eye },
  { id: "maintenance", label: "Maintenance", description: "Version, installation, and service management.", icon: PackageOpen },
  { id: "account", label: "Account", description: "Your current browser session.", icon: LogOut },
] as const;
type SettingsCategory = (typeof categories)[number]["id"];
const thinkingOrder: GlobalSettings["thinkingLevel"][] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const queueOptions = [{ value: "one-at-a-time", label: "One at a time", description: "Process each queued message separately" }, { value: "all", label: "All queued", description: "Deliver all queued messages together" }];

function closestThinkingLevel(levels: GlobalSettings["thinkingLevel"][], requested: GlobalSettings["thinkingLevel"]): GlobalSettings["thinkingLevel"] {
  if (levels.includes(requested)) return requested;
  const requestedIndex = thinkingOrder.indexOf(requested);
  return thinkingOrder.slice(requestedIndex).find((level) => levels.includes(level)) || [...thinkingOrder.slice(0, requestedIndex)].reverse().find((level) => levels.includes(level)) || levels[0] || "off";
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} className={`settings-toggle ${checked ? "enabled" : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}

export function Settings({ active, uiSettings, onUiSettingsChanged }: { active: boolean; uiSettings: UiSettings; onUiSettingsChanged: (settings: UiSettings) => void }) {
  const [category, setCategory] = useState<SettingsCategory>("interface");
  const [global, setGlobal] = useState<GlobalSettings | null>(null);
  const currentCategory = categories.find((item) => item.id === category)!;
  const [providerId, setProviderId] = useState("");
  const [modelPreferences, setModelPreferences] = useState<ModelPreferences | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [releaseChecking, setReleaseChecking] = useState(false);
  const [releaseUpdating, setReleaseUpdating] = useState(false);
  const [releaseUpdateOpen, setReleaseUpdateOpen] = useState(false);
  const [releaseRollbackOpen, setReleaseRollbackOpen] = useState(false);
  const [globalSystemPrompt, setGlobalSystemPrompt] = useState({ content: "", systemPromptPath: "", appendSystemPromptPath: "" });
  const [promptRefreshing, setPromptRefreshing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [subscriptionMode, setSubscriptionMode] = useState(false);
  const [subscriptionFlow, setSubscriptionFlow] = useState<SubscriptionAuthFlow | null>(null);
  const [subscriptionBusy, setSubscriptionBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const globalSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const uiSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const modelSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const preferencesSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const releaseRequested = useRef(false);
  const globalSaveRevision = useRef(0);
  const uiSaveRevision = useRef(0);
  const modelSaveRevision = useRef(0);
  const filesSaveRevision = useRef(0);
  const contentRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef<Partial<Record<SettingsCategory, number>>>({});

  useLayoutEffect(() => { if (active && contentRef.current) contentRef.current.scrollTop = scrollPositions.current[category] || 0; }, [active, category, loading]);

  useEffect(() => {
    let current = true;
    void api.globalSettings().then((result) => {
      if (!current) return;
      setGlobal(result); setProviderId(result.provider); setPromptDraft(result.agent.systemPrompt.append);
      setSubscriptionMode(Boolean(result.providers.find((provider) => provider.id === result.provider)?.usingSubscription));
    }).catch((reason) => { if (current) setNotice({ kind: "error", text: reason.message }); }).finally(() => { if (current) setLoading(false); });
    void api.modelPreferences().then((result) => { if (current) setModelPreferences(result); }).catch((reason) => { if (current) setNotice({ kind: "error", text: reason.message }); });
    return () => { current = false; };
  }, []);

  useEffect(() => { setGlobal((current) => current ? { ...current, ...uiSettings } : current); }, [uiSettings.theme, uiSettings.hideReasoning, uiSettings.markdownLineBreaks]);

  useEffect(() => {
    if (!active) { setApiKey(""); setDisconnectOpen(false); setReleaseUpdateOpen(false); setReleaseRollbackOpen(false); }
    if (active && category === "maintenance" && !releaseRequested.current) {
      releaseRequested.current = true;
      setReleaseChecking(true);
      void api.releaseInfo().then(setRelease).catch((reason) => setNotice({ kind: "error", text: reason.message })).finally(() => setReleaseChecking(false));
    }
  }, [active, category]);

  async function refreshSettings() {
    setSaving(true); setNotice(null);
    try {
      const [result, models] = await Promise.all([api.globalSettings(), api.modelPreferences()]);
      setGlobal(result); setModelPreferences(models); setPromptDraft(result.agent.systemPrompt.append); onUiSettingsChanged({ theme: result.theme, hideReasoning: result.hideReasoning, markdownLineBreaks: result.markdownLineBreaks });
      if (category === "maintenance") setRelease(await api.releaseInfo());
    } catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot refresh settings" }); }
    finally { setSaving(false); }
  }

  const selectedProvider = useMemo(() => global?.providers.find((provider) => provider.id === providerId), [global, providerId]);
  const selectedDefaultModel = useMemo(() => modelPreferences?.models.find((model) => model.provider === modelPreferences.defaultProvider && model.id === modelPreferences.defaultModel), [modelPreferences]);
  const groupedModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    const visible = (modelPreferences?.models || []).filter((model) => !query || `${model.providerName} ${model.provider} ${model.name} ${model.id}`.toLowerCase().includes(query));
    const groups = new Map<string, typeof visible>();
    for (const model of visible) groups.set(model.providerName, [...(groups.get(model.providerName) || []), model]);
    return [...groups.entries()];
  }, [modelPreferences, modelSearch]);

  useEffect(() => {
    if (!active || !subscriptionFlow || subscriptionFlow.status !== "pending") return;
    const timer = window.setTimeout(() => {
      void api.subscriptionLogin(subscriptionFlow.id).then((next) => { setSubscriptionFlow(next); if (next.status === "success") void subscriptionCompleted(); }).catch((reason) => setNotice({ kind: "error", text: reason.message }));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [active, subscriptionFlow]);

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

  function persistUiSettings(next: GlobalSettings, success: string): Promise<void> {
    const revision = ++uiSaveRevision.current;
    setGlobal(next); applyTheme(next.theme); onUiSettingsChanged({ theme: next.theme, hideReasoning: next.hideReasoning, markdownLineBreaks: next.markdownLineBreaks }); setSaving(true); setNotice(null);
    const task = uiSaveQueue.current.catch(() => undefined).then(async () => {
      const saved = await api.saveUiSettings({ theme: next.theme, hideReasoning: next.hideReasoning, markdownLineBreaks: next.markdownLineBreaks });
      if (revision === uiSaveRevision.current) { setGlobal((current) => current ? { ...current, ...saved } : current); onUiSettingsChanged(saved); setNotice({ kind: "success", text: success }); }
    }).catch(async (reason) => {
      if (revision === uiSaveRevision.current) {
        setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save interface setting" });
        const restored = await api.uiSettings().catch(() => null);
        if (restored) { setGlobal((current) => current ? { ...current, ...restored } : current); applyTheme(restored.theme); onUiSettingsChanged(restored); }
      }
    }).finally(() => { if (revision === uiSaveRevision.current) setSaving(false); });
    uiSaveQueue.current = task;
    return task;
  }

  async function selectProvider(provider: string) {
    if (!global) return;
    if (subscriptionFlow?.status === "pending") await api.cancelSubscriptionLogin(subscriptionFlow.id).catch(() => undefined);
    const providerOption = global.providers.find((item) => item.id === provider);
    setProviderId(provider); setSubscriptionFlow(null); setSubscriptionMode(Boolean(providerOption?.usingSubscription)); setApiKey(""); setNotice(null);
  }

  async function refreshProviderAndModels(success: string) {
    const [refreshed, preferences] = await Promise.all([api.globalSettings(), api.modelPreferences()]);
    setGlobal(refreshed); setModelPreferences(preferences); setSubscriptionBusy(false); setNotice({ kind: "success", text: success });
  }

  async function subscriptionCompleted() {
    await refreshProviderAndModels("Subscription connected.");
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

  function persistModelPreferences(next: ModelPreferences, success: string): Promise<void> {
    const revision = ++modelSaveRevision.current;
    setModelPreferences(next); setSaving(true); setNotice(null);
    const task = modelSaveQueue.current.catch(() => undefined).then(async () => {
      const saved = await api.saveModelPreferences({ enabledModels: next.models.filter((model) => model.enabled).map((model) => `${model.provider}/${model.id}`), defaultProvider: next.defaultProvider, defaultModel: next.defaultModel, thinkingLevel: next.thinkingLevel });
      if (revision === modelSaveRevision.current) {
        setModelPreferences(saved);
        setGlobal((current) => current ? { ...current, provider: saved.defaultProvider, model: saved.defaultModel, thinkingLevel: saved.thinkingLevel } : current);
        setNotice({ kind: "success", text: success });
      }
    }).catch(async (reason) => {
      if (revision === modelSaveRevision.current) {
        setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save model preferences" });
        const restored = await api.modelPreferences().catch(() => null);
        if (restored) setModelPreferences(restored);
      }
    }).finally(() => { if (revision === modelSaveRevision.current) setSaving(false); });
    modelSaveQueue.current = task;
    return task;
  }

  function toggleModel(provider: string, modelId: string) {
    if (!modelPreferences) return;
    const reference = `${provider}/${modelId}`;
    const selected = modelPreferences.models.find((model) => `${model.provider}/${model.id}` === reference);
    if (!selected) return;
    const enabled = !selected.enabled;
    const models = modelPreferences.models.map((model) => `${model.provider}/${model.id}` === reference ? { ...model, enabled } : model);
    const remaining = models.filter((model) => model.enabled);
    if (remaining.length === 0) { setNotice({ kind: "error", text: "Select at least one model." }); return; }
    const wasDefault = provider === modelPreferences.defaultProvider && modelId === modelPreferences.defaultModel;
    const replacement = wasDefault && !enabled ? remaining[0] : undefined;
    const next = { ...modelPreferences, models, ...(replacement ? { defaultProvider: replacement.provider, defaultModel: replacement.id, thinkingLevel: closestThinkingLevel(replacement.thinkingLevels, modelPreferences.thinkingLevel) } : {}) };
    void persistModelPreferences(next, "Model visibility saved.");
  }

  function selectDefaultModel(provider: string, modelId: string) {
    if (!modelPreferences) return;
    const selected = modelPreferences.models.find((model) => model.provider === provider && model.id === modelId);
    if (!selected) return;
    const next = { ...modelPreferences, models: modelPreferences.models.map((model) => model === selected ? { ...model, enabled: true } : model), defaultProvider: provider, defaultModel: modelId, thinkingLevel: closestThinkingLevel(selected.thinkingLevels, modelPreferences.thinkingLevel) };
    void persistModelPreferences(next, "Default model saved.");
  }

  async function saveApiKey() {
    if (!apiKey.trim() || !providerId) return;
    setSaving(true); setNotice(null);
    try { await api.saveProviderApiKey(providerId, apiKey.trim()); setApiKey(""); await refreshProviderAndModels("API key saved."); }
    catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save API key" }); }
    finally { setSaving(false); }
  }

  function cancelApiKeyEdit() {
    setApiKey(""); setNotice(null);
  }

  async function disconnectProvider() {
    if (!providerId) return;
    setSaving(true); setNotice(null);
    try {
      if (subscriptionFlow?.status === "pending") await api.cancelSubscriptionLogin(subscriptionFlow.id).catch(() => undefined);
      await api.disconnectProvider(providerId); setDisconnectOpen(false); setSubscriptionFlow(null); setSubscriptionMode(false); await refreshProviderAndModels("Provider disconnected.");
    } catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot disconnect provider" }); }
    finally { setSaving(false); }
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
    try { setGlobalSystemPrompt(await api.globalSystemPrompt()); }
    catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot refresh global system prompt" }); }
    finally { setPromptRefreshing(false); }
  }

  async function savePrompt() {
    if (!global) return;
    const append = promptDraft;
    setSaving(true); setNotice(null);
    const task = preferencesSaveQueue.current.catch(() => undefined).then(() => api.saveGlobalSystemPrompt({ append }));
    preferencesSaveQueue.current = task.then(() => undefined, () => undefined);
    try {
      const saved = await task;
      setGlobal((current) => current ? { ...current, agent: { ...current.agent, systemPrompt: saved.agent.systemPrompt } } : current);
      setGlobalSystemPrompt((current) => ({ ...current, content: "" }));
      setNotice({ kind: "success", text: "Global system prompt saved. Newly opened sessions will use this content." });
    } catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save system prompt" }); }
    finally { setSaving(false); }
  }

  function persistFileSettings(files: GlobalPreferences["files"], success: string): Promise<void> {
    const revision = ++filesSaveRevision.current;
    setGlobal((current) => current ? { ...current, files } : current); setSaving(true); setNotice(null);
    const task = preferencesSaveQueue.current.catch(() => undefined).then(async () => {
      const saved = await api.saveGlobalPreferences({ files });
      if (revision === filesSaveRevision.current) { setGlobal((current) => current ? { ...current, files: saved.files } : current); setNotice({ kind: "success", text: success }); }
    }).catch(async (reason) => {
      if (revision === filesSaveRevision.current) {
        setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save file setting" });
        const restored = await api.globalPreferences().catch(() => null);
        if (restored && revision === filesSaveRevision.current) setGlobal((current) => current ? { ...current, files: restored.files } : current);
      }
    }).finally(() => { if (revision === filesSaveRevision.current) setSaving(false); });
    preferencesSaveQueue.current = task;
    return task;
  }

  function selectTheme(theme: ThemeId) {
    if (!global) return;
    void persistUiSettings({ ...global, theme }, "Theme saved.");
  }

  function updateFileSettings(files: GlobalPreferences["files"], success: string) {
    if (global) void persistFileSettings(files, success);
  }

  if (loading) return <section className="settings-page"><div className="page-loading"><LoaderCircle size={20} />Loading settings</div></section>;

  return <section className="settings-page">
    <header className="page-header"><div><h2>Settings</h2><p>Shared preferences for all workspaces</p></div><button type="button" className="icon-button settings-refresh" title="Refresh settings" aria-label="Refresh settings" disabled={saving} onClick={() => void refreshSettings()}><RefreshCw size={15} /></button></header>
    <div className="settings-layout">
      <nav className="settings-tabs" aria-label="Settings categories">
        <span className="settings-nav-label">Preferences</span>
        {categories.map((item) => <button type="button" key={item.id} className={category === item.id ? "active" : ""} aria-current={category === item.id ? "page" : undefined} onClick={() => { setCategory(item.id); setNotice(null); }}><item.icon size={16} /><span>{item.label}</span></button>)}
      </nav>
      <main className="settings-content" ref={contentRef} onScroll={(event) => { if (active) scrollPositions.current[category] = event.currentTarget.scrollTop; }}>
        <div className="settings-content-heading"><span>Global settings</span><h2>{currentCategory.label}</h2><p>{currentCategory.description}</p></div>
        {notice && <div role="status" className={`settings-notice ${notice.kind}`}>{notice.kind === "success" ? <Check size={15} /> : <CircleAlert size={15} />}{notice.text}</div>}
        {global && <>
          <div className="settings-category" hidden={category !== "interface"}>
          <section className="settings-section">
            <div className="settings-section-title"><Palette size={17} /><div><h3>Appearance</h3><p>Theme and conversation visibility shared by every workspace and device using this service.</p></div></div>
            <div className="theme-options" aria-label="Theme">{themes.map((theme) => <button type="button" aria-pressed={global.theme === theme.id} title={theme.description} className={global.theme === theme.id ? "selected" : ""} onClick={() => selectTheme(theme.id)} key={theme.id}><span className="theme-preview">{theme.colors.map((color) => <i style={{ background: color }} key={color} />)}</span><strong>{theme.name}</strong><Check size={13} className={global.theme === theme.id ? "" : "theme-check-hidden"} /></button>)}</div>
            <div className="settings-rows"><div className="settings-row"><div><strong>Hide reasoning</strong><span>Hide reasoning content in every conversation while preserving it in Session history.</span></div><Toggle checked={global.hideReasoning} onChange={(checked) => void persistUiSettings({ ...global, hideReasoning: checked }, "Reasoning visibility saved.")} /></div><div className="settings-row"><div><strong>Keep line breaks</strong><span>Show each new line in conversations and Markdown files on a new line. Turn off to join lines within a paragraph.</span></div><Toggle label="Keep line breaks" checked={global.markdownLineBreaks} onChange={(checked) => void persistUiSettings({ ...global, markdownLineBreaks: checked }, "Line break preference saved.")} /></div></div>
          </section>
          </div>
          <div className="settings-category" hidden={category !== "models"}>
          <section className="settings-section">
            <div className="settings-section-title"><Cpu size={17} /><div><h3>Provider and model</h3><p>Manage Provider credentials, choose the models shown in model menus, and set the default for new sessions.</p></div></div>
            <div className="settings-grid">
              <label className="settings-field"><span>Manage Provider</span><Select ariaLabel="Provider" value={providerId} onChange={(value) => void selectProvider(value)} options={global.providers.map((provider) => ({ value: provider.id, label: provider.name, status: provider.configured ? "Configured" : undefined, description: provider.configured ? provider.authLabel || provider.authSource : "Authentication required" }))} /></label>
              <label className="settings-field"><span>Default thinking level</span><Select ariaLabel="Default model thinking level" value={modelPreferences?.thinkingLevel || "off"} disabled={!selectedDefaultModel} onChange={(value) => { if (modelPreferences) void persistModelPreferences({ ...modelPreferences, thinkingLevel: value as GlobalSettings["thinkingLevel"] }, "Thinking default saved."); }} options={(selectedDefaultModel?.thinkingLevels || ["off"]).map((level) => ({ value: level, label: level }))} /></label>
            </div>
            <div className="provider-status-row"><div className="provider-status"><i className={selectedProvider?.configured ? "configured" : ""} /><span>{selectedProvider?.configured ? `Authenticated${selectedProvider.authLabel ? ` · ${selectedProvider.authLabel}` : selectedProvider.authSource ? ` · ${selectedProvider.authSource}` : ""}` : "Authentication required"}</span></div>{selectedProvider?.canDisconnect && <button type="button" className="secondary-button provider-disconnect" disabled={saving} onClick={() => setDisconnectOpen(true)}><Unplug size={13} />Disconnect</button>}</div>
            {selectedProvider?.supportsSubscription && <div className="subscription-mode"><div><strong>Use subscription account</strong><span>{selectedProvider.subscriptionName}</span></div><Toggle checked={subscriptionMode} onChange={(checked) => void toggleSubscription(checked)} /></div>}
            {selectedProvider?.supportsSubscription && subscriptionMode && <SubscriptionLogin provider={selectedProvider} flow={subscriptionFlow} busy={subscriptionBusy} onStart={() => void startSubscriptionLogin()} onAnswer={answerSubscriptionLogin} onCancel={() => void cancelSubscriptionLogin()} />}
            {!subscriptionMode && <div className="settings-confirm-field"><label className="settings-field settings-api-key"><span><KeyRound size={14} />API key</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && apiKey.trim()) void saveApiKey(); }} placeholder={selectedProvider?.configured ? "Leave empty to keep the current credential" : "Enter an API key"} /><small>Write-only. Saved by pi in its global credential store and never returned to the browser.</small></label>{(apiKey || !selectedProvider?.configured) && <div className="inline-setting-actions"><button type="button" className="secondary-button" disabled={saving} onClick={cancelApiKeyEdit}>Cancel</button><button type="button" className="primary-button" disabled={saving || !apiKey.trim()} onClick={() => void saveApiKey()}>{saving ? <LoaderCircle size={14} /> : <Save size={14} />}Save API key</button></div>}</div>}
            <div className="model-preferences">
              <div className="model-preferences-heading"><div><strong>Models shown in Pi-Ark</strong><span>Checked models appear in new and existing Session model menus. The starred model is the default for new Sessions.</span></div><label><Search size={13} /><input aria-label="Search models" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="Search models" /></label></div>
              <div className="model-preferences-list">{groupedModels.map(([providerName, providerModels]) => <div className="model-provider-group" key={providerName}><div className="model-provider-heading"><strong>{providerName}</strong><span>{providerModels.filter((model) => model.enabled).length} selected</span></div>{providerModels.map((model) => { const isDefault = model.provider === modelPreferences?.defaultProvider && model.id === modelPreferences.defaultModel; return <div className={`model-preference-row ${model.enabled ? "enabled" : ""}`} key={`${model.provider}/${model.id}`}><button type="button" className="model-visibility" role="checkbox" aria-checked={model.enabled} aria-label={`${model.enabled ? "Hide" : "Show"} ${model.name || model.id} in model menus`} disabled={saving} onClick={() => toggleModel(model.provider, model.id)} /><div><strong>{model.name || model.id}</strong><small>{model.provider}/{model.id} · {model.contextWindow.toLocaleString()} context{model.reasoning ? " · reasoning" : ""}</small></div><button type="button" className={`model-default ${isDefault ? "selected" : ""}`} aria-label={isDefault ? `${model.name || model.id} is the default model` : `Use ${model.name || model.id} as default`} aria-pressed={isDefault} disabled={saving} onClick={() => selectDefaultModel(model.provider, model.id)}><Star size={14} fill={isDefault ? "currentColor" : "none"} /></button></div>; })}</div>)}{groupedModels.length === 0 && <div className="model-preferences-empty">{modelPreferences?.models.length ? "No models match this search." : "Connect a Provider to choose models."}</div>}</div>
            </div>
          </section>
          </div>
          <div className="settings-category" hidden={category !== "maintenance"}>
          {!release && <div className="settings-inline-loading">{releaseChecking ? <><LoaderCircle size={16} />Loading release information</> : <button type="button" className="secondary-button" onClick={() => void checkReleaseUpdate()}>Load release information</button>}</div>}
          {release && <section className="settings-section pi-core-section">
            <div className="settings-section-title"><PackageOpen size={17} /><div><h3>Pi-Ark release</h3><p>Pi-Ark and its bundled, compatible pi core are updated together.</p></div></div>
            <div className="pi-core-details"><div><span>Pi-Ark version</span><strong>{release.version}</strong></div><div><span>Bundled pi core</span><strong>{release.coreVersion}</strong></div><div><span>Install mode</span><strong>{release.installedRelease ? `Release · ${release.channel}` : "Development checkout"}</strong></div>{release.latestVersion && <div><span>Latest release</span><strong>{release.latestVersion}</strong></div>}{release.previousVersion && <div><span>Previous release</span><strong>{release.previousVersion}</strong></div>}<div className="path"><span>Install path</span><code>{release.installPath}</code></div><div className="path"><span>Data path</span><code>{release.dataDir}</code></div><div className="path"><span>Pi-Ark agent data</span><code>{release.agentDir}</code></div><div className="path"><span>Pi core package</span><code>{release.corePath}</code></div></div>
            <div className="maintenance-commands"><span>Service management commands</span>{Object.entries(release.commands).map(([name, command]) => <div key={name}><strong>{name}</strong><code>{command}</code></div>)}</div>
            <div className="pi-core-actions"><button type="button" className="secondary-button" disabled={releaseChecking || releaseUpdating} onClick={() => void checkReleaseUpdate()}>{releaseChecking ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}Check for updates</button>{release.rollbackAvailable && <button type="button" className="secondary-button" disabled={releaseUpdating} onClick={() => setReleaseRollbackOpen(true)}><RotateCcw size={14} />Roll back</button>}{release.channel === "stable" && release.latestVersion && release.updateAvailable && <button type="button" className="primary-button" disabled={releaseUpdating || !release.installedRelease} onClick={() => setReleaseUpdateOpen(true)}><Download size={14} />Update to {release.latestVersion}</button>}{release.channel === "stable" && release.latestVersion && !release.updateAvailable && <span className="pi-core-current"><Check size={13} />Up to date</span>}{release.channel === "development" && <span className="pi-core-current">Development build</span>}</div>
          </section>}
          </div>
          <div className="settings-category" hidden={category !== "agent"}>
          <section className="settings-section">
            <div className="settings-section-title"><MessageSquareText size={17} /><div><h3>System prompt</h3><p>Additional instructions shared by every workspace. Changes apply to newly opened sessions.</p></div></div>
            <label className="settings-field"><span>Global append content</span><textarea className="settings-textarea" rows={6} value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} placeholder="Add shared instructions for your Agent" /></label>
            <div className="system-prompt-editor-actions"><button type="button" className="secondary-button" disabled={saving || promptDraft === global.agent.systemPrompt.append} onClick={() => { setPromptDraft(global.agent.systemPrompt.append); setNotice(null); }}>Cancel</button><button type="button" className="primary-button" disabled={saving || promptDraft === global.agent.systemPrompt.append} onClick={() => void savePrompt()}>{saving ? <LoaderCircle size={14} /> : <Save size={14} />}Save system prompt</button></div>
            <details className="settings-prompt-preview" onToggle={(event) => { if (event.currentTarget.open && !globalSystemPrompt.content && !promptRefreshing) void refreshGlobalPrompt(); }}><summary><FileText size={14} />Preview effective prompt</summary>
              <div className="prompt-file-guide"><div><FileText size={15} /><span><strong>Optional replacement file</strong><code>{globalSystemPrompt.systemPromptPath || "PI_ARK_AGENT_DIR/SYSTEM.md"}</code></span></div><div><FileText size={15} /><span><strong>Optional append file</strong><code>{globalSystemPrompt.appendSystemPromptPath || "PI_ARK_AGENT_DIR/APPEND_SYSTEM.md"}</code></span></div><p>The preview includes pi instructions, tools, context files, and shared append content.</p></div>
              <div className="system-prompt-view"><div className="system-prompt-toolbar"><span className="system-prompt-mode">Effective system prompt</span><button type="button" className="secondary-button system-prompt-edit" disabled={promptRefreshing} onClick={() => void refreshGlobalPrompt()}>{promptRefreshing ? <LoaderCircle size={13} /> : <RefreshCw size={13} />}Refresh</button></div><pre>{promptRefreshing ? "Loading effective prompt…" : globalSystemPrompt.content || "Refresh to load the effective prompt."}</pre></div>
            </details>
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
          </div>
          <div className="settings-category" hidden={category !== "account"}>
          <section className="settings-section account-section">
            <div className="settings-section-title"><LogOut size={17} /><div><h3>Account</h3><p>End the current Pi-Ark browser session.</p></div></div>
            <button className="secondary-button account-signout" onClick={async () => { await api.logout(); window.location.reload(); }}><LogOut size={15} />Sign out</button>
          </section>
          </div>
          <div className="settings-category" hidden={category !== "files"}>
          <section className="settings-section">
            <div className="settings-section-title"><Eye size={17} /><div><h3>File browser</h3><p>Shared browsing preferences for all workspaces.</p></div></div>
            <div className="settings-rows"><div className="settings-row"><div><strong>Show hidden files</strong><span>Include dotfiles such as .gitignore. Pi-Ark internal state remains private.</span></div><Toggle checked={global.files.showHiddenFiles} onChange={(checked) => updateFileSettings({ ...global.files, showHiddenFiles: checked }, "Hidden file preference saved.")} /></div></div>
            <label className="settings-field settings-preview-size"><span>Maximum preview size</span><input type="number" min={1} max={100} step={1} value={global.files.maxPreviewSizeMb} onChange={(event) => setGlobal({ ...global, files: { ...global.files, maxPreviewSizeMb: Number(event.target.value) } })} onBlur={() => updateFileSettings(global.files, "Preview size saved.")} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><small>Files up to this size can open in Files. Larger files remain available for download. Range: 1–100 MB.</small></label>
          </section>
          </div>
        </>}
      </main>
    </div>
    {disconnectOpen && selectedProvider && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setDisconnectOpen(false); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="disconnect-provider-title"><div className="dialog-header no-close"><div className="dialog-icon danger"><Unplug size={18} /></div><div><h2 id="disconnect-provider-title">Disconnect {selectedProvider.name}?</h2><p>Pi-Ark will remove this Provider's saved credential. Sessions that need this Provider will require authentication again.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => setDisconnectOpen(false)}>Cancel</button><button type="button" className="danger-button" disabled={saving} onClick={() => void disconnectProvider()}>{saving ? <LoaderCircle size={14} /> : <Unplug size={14} />}Disconnect Provider</button></div></div></div>}
    {releaseUpdateOpen && release && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !releaseUpdating) setReleaseUpdateOpen(false); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="release-update-title"><div className="dialog-header no-close"><div className="dialog-icon"><Download size={18} /></div><div><h2 id="release-update-title">Update Pi-Ark?</h2><p>Pi-Ark will install release {release.latestVersion}, switch the current release atomically, preserve this data directory, and restart the service.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={releaseUpdating} onClick={() => setReleaseUpdateOpen(false)}>Cancel</button><button type="button" className="primary-button" disabled={releaseUpdating} onClick={() => void updateRelease()}>{releaseUpdating ? <LoaderCircle size={14} /> : <Download size={14} />}Update Pi-Ark</button></div></div></div>}
    {releaseRollbackOpen && release && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !releaseUpdating) setReleaseRollbackOpen(false); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="release-rollback-title"><div className="dialog-header no-close"><div className="dialog-icon"><RotateCcw size={18} /></div><div><h2 id="release-rollback-title">Roll back Pi-Ark?</h2><p>Pi-Ark will switch from {release.version} to {release.previousVersion}, preserve this data directory, and restart the service.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={releaseUpdating} onClick={() => setReleaseRollbackOpen(false)}>Cancel</button><button type="button" className="primary-button" disabled={releaseUpdating} onClick={() => void rollbackRelease()}>{releaseUpdating ? <LoaderCircle size={14} /> : <RotateCcw size={14} />}Roll back</button></div></div></div>}
  </section>;
}
