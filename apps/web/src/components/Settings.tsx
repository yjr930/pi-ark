import { BookOpen, Check, CircleAlert, Cpu, Download, Eye, FileText, HardDrive, KeyRound, LoaderCircle, LogOut, MessageSquareText, PackageOpen, Palette, PanelLeft, Plug, Plus, Puzzle, RefreshCw, RotateCcw, Save, Search, ShieldAlert, SlidersHorizontal, Sparkles, Star, TerminalSquare, Trash2, Type, Unplug } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { clearSessionCache, flushSessionCache, formatCacheSize, getSessionCacheSummary } from "../session-cache";
import { themes } from "../theme";
import { FONT_LEVELS, FONT_SCALE_STEP, MAX_FONT_SCALE, MIN_FONT_SCALE, levelPixels } from "../typography";
import type { AppearanceSettings } from "../appearance";
import type { GlobalSettings, ModelPreferences, ProviderPluginsResponse, ReleaseInfo, SubscriptionAuthFlow, GlobalPreferences, Workspace } from "../types";
import { Select } from "./Select";
import { McpSettings } from "./McpSettings";
import { MemorySettings, type MemorySettingsHandle } from "./MemorySettings";
import { ExtensionsSettings } from "./ExtensionsSettings";
import { SkillsSettings } from "./SkillsSettings";
import { SubscriptionLogin } from "./SubscriptionLogin";
import { TerminalSettings } from "./TerminalSettings";
import type { TerminalSettingsHandle } from "./TerminalSettings";

const categories = [
  { id: "appearance", label: "Appearance", description: "Theme, text size, and conversation display, saved in this browser.", icon: Palette },
  { id: "models", label: "Models & providers", description: "Credentials, available models, and defaults for new Sessions.", icon: Cpu },
  { id: "agent", label: "Agent behavior", description: "Shared instructions and conversation defaults.", icon: SlidersHorizontal },
  { id: "memory", label: "Memory", description: "Changes save automatically and take effect on the next turn in the main Session.", icon: BookOpen },
  { id: "skills", label: "Skills", description: "Agent skills available globally and in each workspace.", icon: Sparkles },
  { id: "mcp", label: "MCP", description: "Agent tool servers, connection state, and browser runtime.", icon: Plug },
  { id: "extensions", label: "Extensions", description: "User-installed extensions and the tools they register.", icon: Puzzle },
  { id: "files", label: "Files", description: "File browsing and preview preferences.", icon: Eye },
  { id: "terminal", label: "Terminal", description: "Server shell profiles and browser font preferences.", icon: TerminalSquare },
  { id: "maintenance", label: "Maintenance", description: "Version, installation, service management, and browser cache.", icon: PackageOpen },
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

type SettingsProps = {
  active: boolean;
  appearance: AppearanceSettings;
  onAppearanceChange: (next: AppearanceSettings) => void;
  memoryCategory: boolean;
  onMemoryCategoryChange: (selected: boolean) => void;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceId: string;
};

export function Settings({ active, appearance, onAppearanceChange, memoryCategory, onMemoryCategoryChange, workspaces, workspacesLoading, workspaceId }: SettingsProps) {
  const [otherCategory, setOtherCategory] = useState<Exclude<SettingsCategory, "memory">>("appearance");
  const category = memoryCategory ? "memory" : otherCategory;
  const [global, setGlobal] = useState<GlobalSettings | null>(null);
  const currentCategory = categories.find((item) => item.id === category)!;
  const [providerId, setProviderId] = useState("");
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [providerPlugins, setProviderPlugins] = useState<ProviderPluginsResponse | null>(null);
  const [providerPluginId, setProviderPluginId] = useState("");
  const [providerName, setProviderName] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerBusy, setProviderBusy] = useState(false);
  const [deleteProviderOpen, setDeleteProviderOpen] = useState(false);
  const [modelPreferences, setModelPreferences] = useState<ModelPreferences | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [modelProviderFilter, setModelProviderFilter] = useState("");
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
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
  const [terminalBusy, setTerminalBusy] = useState(false);
  const terminalSettingsRef = useRef<TerminalSettingsHandle>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const memorySettingsRef = useRef<MemorySettingsHandle>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [cacheSummary, setCacheSummary] = useState(() => getSessionCacheSummary());
  const [cacheClearOpen, setCacheClearOpen] = useState(false);
  const [cacheClearing, setCacheClearing] = useState(false);
  const globalSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const modelSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const preferencesSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const releaseRequested = useRef(false);
  const globalSaveRevision = useRef(0);
  const modelSaveRevision = useRef(0);
  const filesSaveRevision = useRef(0);
  const approvalsSaveRevision = useRef(0);
  const contentRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef<Partial<Record<SettingsCategory, number>>>({});

  useLayoutEffect(() => { if (active && contentRef.current) contentRef.current.scrollTop = scrollPositions.current[category] || 0; }, [active, category, loading]);
  useLayoutEffect(() => {
    const tabs = tabsRef.current;
    const selected = tabs?.querySelector<HTMLButtonElement>('[aria-current="page"]');
    if (!active || !tabs || !selected) return;
    const reveal = () => {
      if (tabs.scrollWidth <= tabs.clientWidth) return;
      const row = tabs.getBoundingClientRect();
      const button = selected.getBoundingClientRect();
      if (button.left < row.left + 8) tabs.scrollLeft += button.left - row.left - 8;
      else if (button.right > row.right - 8) tabs.scrollLeft += button.right - row.right + 8;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(tabs);
    observer.observe(selected);
    return () => observer.disconnect();
  }, [active, category]);

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

  useEffect(() => {
    if (!active) { setApiKey(""); setDisconnectOpen(false); setReleaseUpdateOpen(false); setReleaseRollbackOpen(false); setCacheClearOpen(false); }
    if (active && category === "maintenance") {
      setCacheSummary(getSessionCacheSummary());
      void flushSessionCache().then(() => setCacheSummary(getSessionCacheSummary()));
      if (!releaseRequested.current) {
        releaseRequested.current = true;
        setReleaseChecking(true);
        void api.releaseInfo().then(setRelease).catch((reason) => setNotice({ kind: "error", text: reason.message })).finally(() => setReleaseChecking(false));
      }
    }
  }, [active, category]);

  useEffect(() => {
    if (!active || category !== "maintenance") return;
    const timer = window.setInterval(() => setCacheSummary(getSessionCacheSummary()), 2000);
    return () => window.clearInterval(timer);
  }, [active, category]);

  async function refreshSettings() {
    if (category === "memory") { await memorySettingsRef.current?.refresh(); return; }
    if (category === "terminal") { setNotice(null); await terminalSettingsRef.current?.refresh(); return; }
    setSaving(true); setNotice(null);
    try {
      const [result, models] = await Promise.all([api.globalSettings(), api.modelPreferences()]);
      setGlobal(result); setModelPreferences(models); setPromptDraft(result.agent.systemPrompt.append);
      if (category === "maintenance") setRelease(await api.releaseInfo());
    } catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot refresh settings" }); }
    finally { setSaving(false); }
  }

  const selectedProvider = useMemo(() => global?.providers.find((provider) => provider.id === providerId), [global, providerId]);
  const selectedDefaultModel = useMemo(() => modelPreferences?.models.find((model) => model.provider === modelPreferences.defaultProvider && model.id === modelPreferences.defaultModel), [modelPreferences]);
  const modelProviderOptions = useMemo(() => {
    const providers = new Map<string, string>();
    for (const provider of global?.providers || []) if (provider.configured) providers.set(provider.id, provider.name);
    for (const model of modelPreferences?.models || []) providers.set(model.provider, model.providerName);
    return [...providers.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
  }, [global, modelPreferences]);
  const activeModelProvider = useMemo(() => {
    if (modelProviderOptions.some((option) => option.value === modelProviderFilter)) return modelProviderFilter;
    return (modelProviderOptions.find((option) => option.value === providerId) || modelProviderOptions.find((option) => option.value === modelPreferences?.defaultProvider) || modelProviderOptions[0])?.value || "";
  }, [modelProviderFilter, modelProviderOptions, providerId, modelPreferences?.defaultProvider]);
  const groupedModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    const visible = (modelPreferences?.models || []).filter((model) => model.provider === activeModelProvider && (!query || `${model.providerName} ${model.provider} ${model.name} ${model.id}`.toLowerCase().includes(query)));
    const groups = new Map<string, typeof visible>();
    for (const model of visible) groups.set(model.providerName, [...(groups.get(model.providerName) || []), model]);
    return [...groups.entries()];
  }, [modelPreferences, modelSearch, activeModelProvider]);

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

  async function selectProvider(provider: string) {
    if (!global) return;
    if (subscriptionFlow?.status === "pending") await api.cancelSubscriptionLogin(subscriptionFlow.id).catch(() => undefined);
    const providerOption = global.providers.find((item) => item.id === provider);
    setProviderId(provider); setSubscriptionFlow(null); setSubscriptionMode(Boolean(providerOption?.usingSubscription)); setApiKey(""); setNotice(null);
  }

  function providerSelectOption(provider: GlobalSettings["providers"][number]) {
    const auth = provider.configured ? provider.authLabel || provider.authSource || "Configured" : "Authentication required";
    return { value: provider.id, label: provider.name, status: provider.configured ? "Configured" : undefined, description: provider.custom ? `${provider.pluginName || provider.plugin || "Provider plugin"} · ${auth}` : auth };
  }

  async function openAddProvider() {
    setAddProviderOpen(true); setProviderPlugins(null); setProviderPluginId(""); setProviderName(""); setProviderApiKey(""); setNotice(null);
    try {
      const result = await api.providerPlugins();
      setProviderPlugins(result);
      setProviderPluginId(result.plugins[0]?.id || "");
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot load provider plugins" });
    }
  }

  function closeAddProvider() {
    if (providerBusy) return;
    setAddProviderOpen(false); setProviderName(""); setProviderApiKey(""); setProviderPluginId("");
  }

  async function createCustomProvider() {
    const name = providerName.trim();
    if (!providerPluginId || !name) return;
    setProviderBusy(true); setNotice(null);
    try {
      const result = await api.createProviderInstance({ pluginId: providerPluginId, name, apiKey: providerApiKey.trim() });
      setGlobal(result.global);
      setModelPreferences(result.preferences);
      setProviderId(result.providerId);
      setAddProviderOpen(false);
      setProviderName(""); setProviderApiKey(""); setProviderPluginId("");
      setNotice({ kind: "success", text: providerApiKey.trim() ? "Custom provider added. Click Refresh models to load its models." : "Custom provider added. Save an API key, then click Refresh models to load its models." });
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot add custom provider" });
    } finally { setProviderBusy(false); }
  }

  async function reloadProviderPlugins() {
    setProviderBusy(true); setNotice(null);
    try {
      const result = await api.reloadProviderPlugins();
      setProviderPlugins(result.plugins);
      setGlobal(result.global);
      setModelPreferences(result.preferences);
      if (!result.global.providers.some((provider) => provider.id === providerId)) setProviderId(result.global.providers.some((provider) => provider.id === result.global.provider) ? result.global.provider : result.global.providers[0]?.id || "");
      setNotice({ kind: result.plugins.errors.length ? "error" : "success", text: result.plugins.errors.length ? `Provider plugins reloaded with ${result.plugins.errors.length} warnings.` : "Provider plugins reloaded." });
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot reload provider plugins" });
    } finally { setProviderBusy(false); }
  }

  async function deleteCustomProvider() {
    if (!selectedProvider?.custom) return;
    const provider = selectedProvider;
    setProviderBusy(true); setNotice(null);
    try {
      const result = await api.deleteProviderInstance(provider.id);
      setGlobal(result.global);
      setModelPreferences(result.preferences);
      setProviderId(result.global.providers.some((provider) => provider.id === result.global.provider) ? result.global.provider : result.global.providers[0]?.id || "");
      setDeleteProviderOpen(false);
      setNotice({ kind: "success", text: `Custom provider ${provider.name} deleted.` });
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot delete custom provider" });
    } finally { setProviderBusy(false); }
  }

  async function refreshModelCatalog() {
    setModelsRefreshing(true); setNotice(null);
    try {
      const result = await api.refreshModels();
      setModelPreferences(result.preferences);
      const refreshed = await api.globalSettings().catch(() => null);
      if (refreshed) setGlobal(refreshed);
      if (result.errors.length) setNotice({ kind: "error", text: `Model catalog refreshed with errors: ${result.errors.map((error) => error.provider).join(", ")}` });
      else setNotice({ kind: "success", text: result.added.length ? `Model catalog refreshed. ${result.added.length} new models available.` : "Model catalog refreshed. No new models." });
    } catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot refresh model catalog" }); }
    finally { setModelsRefreshing(false); }
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

  function persistApprovalSettings(approvals: GlobalPreferences["approvals"], success: string): Promise<void> {
    const revision = ++approvalsSaveRevision.current;
    setGlobal((current) => current ? { ...current, approvals } : current); setSaving(true); setNotice(null);
    const task = preferencesSaveQueue.current.catch(() => undefined).then(async () => {
      const saved = await api.saveApprovalSettings(approvals);
      if (revision === approvalsSaveRevision.current) { setGlobal((current) => current ? { ...current, approvals: saved } : current); setNotice({ kind: "success", text: success }); }
    }).catch(async (reason) => {
      if (revision === approvalsSaveRevision.current) {
        setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save approval setting" });
        const restored = await api.globalSettings().catch(() => null);
        if (restored && revision === approvalsSaveRevision.current) setGlobal((current) => current ? { ...current, approvals: restored.approvals } : current);
      }
    }).finally(() => { if (revision === approvalsSaveRevision.current) setSaving(false); });
    preferencesSaveQueue.current = task;
    return task;
  }

  function updateAppearance(patch: Partial<AppearanceSettings>) {
    onAppearanceChange({ ...appearance, ...patch });
  }

  function selectTheme(theme: AppearanceSettings["theme"]) {
    updateAppearance({ theme });
  }

  function updateFileSettings(files: GlobalPreferences["files"], success: string) {
    if (global) void persistFileSettings(files, success);
  }

  async function clearBrowserCache() {
    setCacheClearing(true);
    try {
      await clearSessionCache();
      setCacheSummary(getSessionCacheSummary());
      setCacheClearOpen(false);
      setNotice({ kind: "success", text: "Browser cache cleared." });
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot clear browser cache" });
    } finally { setCacheClearing(false); }
  }

  function selectCategory(next: SettingsCategory) {
    if (next !== "memory") setOtherCategory(next);
    if ((next === "memory") !== memoryCategory) onMemoryCategoryChange(next === "memory");
    setNotice(null);
  }

  const loadingCategory = loading && (category === "agent" || category === "appearance" || category === "models" || category === "files" || category === "maintenance" || category === "account");

  return <section className="settings-page">
    <header className="page-header"><div><h2>Settings</h2><p>Shared preferences for all workspaces, plus Agent resources and browser appearance</p></div>{category !== "skills" && category !== "mcp" && category !== "extensions" && <button type="button" className="icon-button settings-refresh" title="Refresh settings" aria-label="Refresh settings" disabled={category === "memory" ? memoryBusy : loadingCategory || saving || (category === "terminal" && terminalBusy)} onClick={() => void refreshSettings()}><RefreshCw size={15} /></button>}</header>
    <div className="settings-layout">
      <nav className="settings-tabs" aria-label="Settings categories" ref={tabsRef}>
        <span className="settings-nav-label">Preferences</span>
        {categories.map((item) => <button type="button" key={item.id} className={category === item.id ? "active" : ""} aria-current={category === item.id ? "page" : undefined} onClick={() => selectCategory(item.id)}><item.icon size={16} /><span>{item.label}</span></button>)}
      </nav>
      <main className="settings-content" ref={contentRef} onScroll={(event) => { if (active) scrollPositions.current[category] = event.currentTarget.scrollTop; }}>
        <div className="settings-content-heading"><span>{category === "memory" ? "Global and Workspace settings" : category === "terminal" ? "Server and browser settings" : category === "appearance" || category === "account" ? "Browser settings" : category === "skills" || category === "mcp" || category === "extensions" ? "Agent resources" : "Global settings"}</span><h2>{currentCategory.label}</h2><p>{currentCategory.description}</p></div>
        {loadingCategory && <div className="settings-inline-loading" role="status"><LoaderCircle size={16} aria-hidden="true" />Loading settings…</div>}
        {notice && category !== "memory" && <div role="status" className={`settings-notice ${notice.kind}`}>{notice.kind === "success" ? <Check size={15} /> : <CircleAlert size={15} />}{notice.text}</div>}
        <div className="settings-category" hidden={category !== "memory"}>
          <MemorySettings ref={memorySettingsRef} active={active && category === "memory"} workspaces={workspaces} workspacesLoading={workspacesLoading} workspaceId={workspaceId} onBusyChange={setMemoryBusy} />
        </div>
        <div className="settings-category" hidden={category !== "terminal"}>
          <TerminalSettings ref={terminalSettingsRef} active={active && category === "terminal"} onBusyChange={setTerminalBusy} />
        </div>
        <div className="settings-category" hidden={category !== "skills"}>
          <SkillsSettings active={active && category === "skills"} />
        </div>
        <div className="settings-category" hidden={category !== "mcp"}>
          <McpSettings active={active && category === "mcp"} />
        </div>
        <div className="settings-category" hidden={category !== "extensions"}>
          <ExtensionsSettings active={active && category === "extensions"} />
        </div>
        {global && <>
          <div className="settings-category" hidden={category !== "appearance"}>
          <section className="settings-section">
            <div className="settings-section-title"><Palette size={17} /><div><h3>Theme</h3><p>Color palette for the whole interface in this browser.</p></div></div>
            <div className="theme-options" aria-label="Theme">{themes.map((theme) => <button type="button" aria-pressed={appearance.theme === theme.id} title={theme.description} className={appearance.theme === theme.id ? "selected" : ""} onClick={() => selectTheme(theme.id)} key={theme.id}><span className="theme-preview">{theme.colors.map((color) => <i style={{ background: color }} key={color} />)}</span><strong>{theme.name}</strong><Check size={13} className={appearance.theme === theme.id ? "" : "theme-check-hidden"} /></button>)}</div>
          </section>
          <section className="settings-section">
            <div className="settings-section-title"><Type size={17} /><div><h3>Text size</h3><p>Scales every interface font in this browser. Conversation text, Settings, and the sidebar scale together.</p></div></div>
            <div className="text-size-bar">
              <input type="range" aria-label="Text scale" min={MIN_FONT_SCALE * 100} max={MAX_FONT_SCALE * 100} step={FONT_SCALE_STEP * 100} value={Math.round(appearance.fontScale * 100)} onChange={(event) => updateAppearance({ fontScale: Number(event.target.value) / 100 })} />
              <output className="text-size-value">{Math.round(appearance.fontScale * 100)}%</output>
              <button type="button" className="secondary-button" disabled={appearance.fontScale === 1} onClick={() => updateAppearance({ fontScale: 1 })}><RotateCcw size={13} />Reset</button>
            </div>
            <div className="text-size-levels">{FONT_LEVELS.map((level) => <div className="text-size-level" key={level.id}><span className="text-size-sample" style={{ fontSize: `var(--fs-${level.id})` }}>Aa</span><strong>{level.label}</strong><span>{level.role}</span><small>{levelPixels(level, appearance.fontScale)} px</small></div>)}</div>
          </section>
          <section className="settings-section">
            <div className="settings-section-title"><PanelLeft size={17} /><div><h3>Sidebar</h3><p>What the workspace list shows in this browser.</p></div></div>
            <div className="settings-rows"><div className="settings-row"><div><strong>Working session count</strong><span>Show a circled number on each workspace row with the Sessions running in that workspace.</span></div><Toggle label="Working session count" checked={appearance.showWorkingCount} onChange={(checked) => updateAppearance({ showWorkingCount: checked })} /></div></div>
          </section>
          <section className="settings-section">
            <div className="settings-section-title"><MessageSquareText size={17} /><div><h3>Conversation</h3><p>How conversations and Markdown files render in this browser.</p></div></div>
            <div className="settings-rows"><div className="settings-row"><div><strong>Hide reasoning</strong><span>Hide reasoning content in every conversation while preserving it in Session history.</span></div><Toggle checked={appearance.hideReasoning} onChange={(checked) => updateAppearance({ hideReasoning: checked })} /></div><div className="settings-row"><div><strong>Keep line breaks</strong><span>Show each new line in conversations and Markdown files on a new line. Turn off to join lines within a paragraph.</span></div><Toggle label="Keep line breaks" checked={appearance.markdownLineBreaks} onChange={(checked) => updateAppearance({ markdownLineBreaks: checked })} /></div></div>
          </section>
          </div>
          <div className="settings-category" hidden={category !== "models"}>
          <section className="settings-section">
            <div className="settings-section-title"><Cpu size={17} /><div><h3>Provider and model</h3><p>Manage Provider credentials, choose the models shown in model menus, and set the default for new sessions.</p></div></div>
            <div className="settings-grid">
              <label className="settings-field"><span>Manage Provider</span><Select ariaLabel="Provider" searchable searchPlaceholder="Search providers" value={providerId} onChange={(value) => void selectProvider(value)} options={global.providers.map(providerSelectOption)} /></label>
              <label className="settings-field"><span>Default thinking level</span><Select ariaLabel="Default model thinking level" value={modelPreferences?.thinkingLevel || "off"} disabled={!selectedDefaultModel} onChange={(value) => { if (modelPreferences) void persistModelPreferences({ ...modelPreferences, thinkingLevel: value as GlobalSettings["thinkingLevel"] }, "Thinking default saved."); }} options={(selectedDefaultModel?.thinkingLevels || ["off"]).map((level) => ({ value: level, label: level }))} /></label>
            </div>
            <div className="provider-status-row"><div className="provider-status"><i className={selectedProvider?.configured ? "configured" : ""} /><span>{selectedProvider?.configured ? `Authenticated${selectedProvider.authLabel ? ` · ${selectedProvider.authLabel}` : selectedProvider.authSource ? ` · ${selectedProvider.authSource}` : ""}` : "Authentication required"}</span></div><div className="provider-status-actions">{selectedProvider?.custom && <span className="provider-plugin-label">{selectedProvider.pluginName || selectedProvider.plugin}</span>}{selectedProvider?.canDisconnect && <button type="button" className="secondary-button provider-disconnect" disabled={saving} onClick={() => setDisconnectOpen(true)}><Unplug size={13} />Disconnect</button>}{selectedProvider?.custom && <button type="button" className="secondary-button provider-delete" disabled={saving || providerBusy} onClick={() => setDeleteProviderOpen(true)}><Trash2 size={13} />Delete provider</button>}</div></div>
            <div className="provider-custom-actions"><button type="button" className="secondary-button" disabled={saving || providerBusy} onClick={() => void openAddProvider()}><Plus size={13} />Add custom provider</button><button type="button" className="secondary-button" disabled={saving || providerBusy} onClick={() => void reloadProviderPlugins()}>{providerBusy ? <LoaderCircle size={13} className="model-refresh-spin" /> : <RefreshCw size={13} />}Reload provider plugins</button></div>
            {selectedProvider?.supportsSubscription && <div className="subscription-mode"><div><strong>Use subscription account</strong><span>{selectedProvider.subscriptionName}</span></div><Toggle checked={subscriptionMode} onChange={(checked) => void toggleSubscription(checked)} /></div>}
            {selectedProvider?.supportsSubscription && subscriptionMode && <SubscriptionLogin provider={selectedProvider} flow={subscriptionFlow} busy={subscriptionBusy} onStart={() => void startSubscriptionLogin()} onAnswer={answerSubscriptionLogin} onCancel={() => void cancelSubscriptionLogin()} />}
            {!subscriptionMode && <div className="settings-confirm-field"><label className="settings-field settings-api-key"><span>API key</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && apiKey.trim()) void saveApiKey(); }} placeholder={selectedProvider?.configured ? "Leave empty to keep the current credential" : "Enter an API key"} /><small>Write-only. Saved by pi in its global credential store and never returned to the browser.</small></label>{(apiKey || !selectedProvider?.configured) && <div className="inline-setting-actions"><button type="button" className="secondary-button" disabled={saving} onClick={cancelApiKeyEdit}>Cancel</button><button type="button" className="primary-button" disabled={saving || !apiKey.trim()} onClick={() => void saveApiKey()}>{saving ? <LoaderCircle size={14} /> : <Save size={14} />}Save API key</button></div>}</div>}
            <div className="model-preferences">
              <div className="model-preferences-heading"><div className="model-preferences-title"><strong>Models shown in Pi-Ark</strong><span>Checked models appear in new and existing Session model menus. The starred model is the default for new Sessions.</span></div><div className="model-provider-filter"><Select ariaLabel="Filter models by Provider" value={activeModelProvider} onChange={setModelProviderFilter} options={modelProviderOptions} disabled={modelProviderOptions.length === 0} placeholder={global.providers.some((provider) => provider.configured) ? "Refresh to load models" : "No connected provider"} /></div><button type="button" className="secondary-button model-refresh" disabled={loading || saving || modelsRefreshing} onClick={() => void refreshModelCatalog()}>{modelsRefreshing ? <LoaderCircle size={13} className="model-refresh-spin" /> : <RefreshCw size={13} />}{modelsRefreshing ? "Refreshing" : "Refresh models"}</button><label><Search size={13} /><input aria-label="Search models" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="Search models" /></label></div>
              <div className="model-preferences-list">{groupedModels.map(([providerName, providerModels]) => <div className="model-provider-group" key={providerName}><div className="model-provider-heading"><strong>{providerName}</strong><span>{providerModels.filter((model) => model.enabled).length} selected</span></div>{providerModels.map((model) => { const isDefault = model.provider === modelPreferences?.defaultProvider && model.id === modelPreferences.defaultModel; return <div className={`model-preference-row ${model.enabled ? "enabled" : ""}`} key={`${model.provider}/${model.id}`}><button type="button" className="model-visibility" role="checkbox" aria-checked={model.enabled} aria-label={`${model.enabled ? "Hide" : "Show"} ${model.name || model.id} in model menus`} disabled={saving || modelsRefreshing} onClick={() => toggleModel(model.provider, model.id)} /><div><strong>{model.name || model.id}</strong><small>{model.provider}/{model.id} · {model.contextWindow.toLocaleString()} context{model.reasoning ? " · reasoning" : ""}</small></div><button type="button" className={`model-default ${isDefault ? "selected" : ""}`} aria-label={isDefault ? `${model.name || model.id} is the default model` : `Use ${model.name || model.id} as default`} aria-pressed={isDefault} disabled={saving || modelsRefreshing} onClick={() => selectDefaultModel(model.provider, model.id)}><Star size={14} fill={isDefault ? "currentColor" : "none"} /></button></div>; })}</div>)}{groupedModels.length === 0 && <div className="model-preferences-empty">{modelPreferences?.models.length ? "No models match this search." : global.providers.some((provider) => provider.configured) ? "Click Refresh models to load models." : "Connect a Provider to choose models."}</div>}</div>
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
          <section className="settings-section">
            <div className="settings-section-title"><HardDrive size={17} /><div><h3>Browser cache</h3><p>Recent conversations and composer state stored in this browser for faster reopening.</p></div></div>
            <div className="settings-rows"><div className="settings-row settings-cache-row"><div><strong>Cached data</strong><span>{cacheSummary.entries === 0 ? "No cached data in this browser." : `Cached conversations, Session lists, and composer states occupy ${formatCacheSize(cacheSummary.bytes)} in this browser.`}{!cacheSummary.persistent && " This browser is keeping the cache for the current page only."}</span></div><button type="button" className="secondary-button" disabled={cacheClearing || cacheSummary.entries === 0} onClick={() => setCacheClearOpen(true)}><Trash2 size={13} />Clear browser cache</button></div></div>
          </section>
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
          <section className="settings-section">
            <div className="settings-section-title"><ShieldAlert size={17} /><div><h3>Command approval</h3><p>Pause Agent commands that delete files until you approve them.</p></div></div>
            <div className="settings-rows"><div className="settings-row"><div><strong>Delete commands</strong><span>Bash commands that delete files wait for your approval. Applies to subagent Sessions and takes effect on the next tool call.</span></div><Toggle checked={global.approvals.deleteCommands} onChange={(checked) => void persistApprovalSettings({ ...global.approvals, deleteCommands: checked }, "Delete command approval saved.")} /></div></div>
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
    {addProviderOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !providerBusy) closeAddProvider(); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="add-provider-title"><div className="dialog-header no-close"><div className="dialog-icon"><Plus size={18} /></div><div><h2 id="add-provider-title">Add custom provider</h2><p>Choose an installed provider plugin, name the channel, and save its API key.</p></div></div><div className="dialog-provider-form"><label className="dialog-field"><span>Provider type</span><Select ariaLabel="Provider type" value={providerPluginId} onChange={setProviderPluginId} options={(providerPlugins?.plugins || []).map((plugin) => ({ value: plugin.id, label: plugin.name, description: plugin.description || plugin.baseUrl }))} disabled={providerBusy || !providerPlugins?.plugins.length} placeholder={providerPlugins ? "No provider plugins" : "Loading plugins…"} /></label><label className="dialog-field"><span>Provider name</span><input value={providerName} maxLength={80} onChange={(event) => setProviderName(event.target.value)} placeholder="e.g. RightCode Claude" disabled={providerBusy} /></label><label className="dialog-field"><span>API key</span><input type="password" autoComplete="off" value={providerApiKey} onChange={(event) => setProviderApiKey(event.target.value)} placeholder="Enter API key" disabled={providerBusy} /></label>{providerPlugins && providerPlugins.plugins.length === 0 && <div className="dialog-error">No provider plugins are installed. Ask the Agent to add a plugin in <code>{providerPlugins.directory}</code>.</div>}{providerPlugins && providerPlugins.errors.length > 0 && <div className="dialog-error">{providerPlugins.errors[0].message}</div>}</div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={providerBusy} onClick={closeAddProvider}>Cancel</button><button type="button" className="primary-button" disabled={providerBusy || !providerPluginId || !providerName.trim()} onClick={() => void createCustomProvider()}>{providerBusy ? <LoaderCircle size={14} /> : <Plus size={14} />}Add provider</button></div></div></div>}
    {deleteProviderOpen && selectedProvider?.custom && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !providerBusy) setDeleteProviderOpen(false); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-provider-title"><div className="dialog-header no-close"><div className="dialog-icon danger"><Trash2 size={18} /></div><div><h2 id="delete-provider-title">Delete {selectedProvider.name}?</h2><p>Pi-Ark removes this custom provider, its saved API key, and its model selections. The provider plugin stays installed.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={providerBusy} onClick={() => setDeleteProviderOpen(false)}>Cancel</button><button type="button" className="danger-button" disabled={providerBusy} onClick={() => void deleteCustomProvider()}>{providerBusy ? <LoaderCircle size={14} /> : <Trash2 size={14} />}Delete provider</button></div></div></div>}
    {disconnectOpen && selectedProvider && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setDisconnectOpen(false); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="disconnect-provider-title"><div className="dialog-header no-close"><div className="dialog-icon danger"><Unplug size={18} /></div><div><h2 id="disconnect-provider-title">Disconnect {selectedProvider.name}?</h2><p>Pi-Ark will remove this Provider's saved credential. Sessions that need this Provider will require authentication again.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => setDisconnectOpen(false)}>Cancel</button><button type="button" className="danger-button" disabled={saving} onClick={() => void disconnectProvider()}>{saving ? <LoaderCircle size={14} /> : <Unplug size={14} />}Disconnect Provider</button></div></div></div>}
    {releaseUpdateOpen && release && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !releaseUpdating) setReleaseUpdateOpen(false); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="release-update-title"><div className="dialog-header no-close"><div className="dialog-icon"><Download size={18} /></div><div><h2 id="release-update-title">Update Pi-Ark?</h2><p>Pi-Ark will install release {release.latestVersion}, switch the current release atomically, preserve this data directory, and restart the service.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={releaseUpdating} onClick={() => setReleaseUpdateOpen(false)}>Cancel</button><button type="button" className="primary-button" disabled={releaseUpdating} onClick={() => void updateRelease()}>{releaseUpdating ? <LoaderCircle size={14} /> : <Download size={14} />}Update Pi-Ark</button></div></div></div>}
    {releaseRollbackOpen && release && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !releaseUpdating) setReleaseRollbackOpen(false); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="release-rollback-title"><div className="dialog-header no-close"><div className="dialog-icon"><RotateCcw size={18} /></div><div><h2 id="release-rollback-title">Roll back Pi-Ark?</h2><p>Pi-Ark will switch from {release.version} to {release.previousVersion}, preserve this data directory, and restart the service.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={releaseUpdating} onClick={() => setReleaseRollbackOpen(false)}>Cancel</button><button type="button" className="primary-button" disabled={releaseUpdating} onClick={() => void rollbackRelease()}>{releaseUpdating ? <LoaderCircle size={14} /> : <RotateCcw size={14} />}Roll back</button></div></div></div>}
    {cacheClearOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !cacheClearing) setCacheClearOpen(false); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="cache-clear-title"><div className="dialog-header no-close"><div className="dialog-icon"><HardDrive size={18} /></div><div><h2 id="cache-clear-title">Clear browser cache?</h2><p>Pi-Ark will remove cached conversations, unsent drafts, and attachments from this browser. Session history stored on the server stays unchanged.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={cacheClearing} onClick={() => setCacheClearOpen(false)}>Cancel</button><button type="button" className="danger-button" disabled={cacheClearing} onClick={() => void clearBrowserCache()}>{cacheClearing ? <LoaderCircle size={14} /> : <Trash2 size={14} />}Clear cache</button></div></div></div>}
  </section>;
}
