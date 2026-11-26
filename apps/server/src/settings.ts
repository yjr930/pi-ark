import { join } from "node:path";
import { ModelRuntime, SettingsManager, resolveModelScopeWithDiagnostics, type ScopedModel } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { loadConfig, piArkAgentDir } from "./config.js";
import type { AuthFlowInteraction } from "./auth-flows.js";
import { createProviderPluginConfig, loadProviderInstances, loadProviderPlugins, providerInstanceStatePath, providerPluginDir, providerPluginSignature, saveProviderInstances, uniqueProviderInstanceId, type ProviderInstance, type ProviderModelCache, type ProviderPlugin, type ProviderPluginsResponse } from "./provider-plugins.js";

export interface GlobalAgentDefaultsInput {
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  compactionEnabled: boolean;
  retryEnabled: boolean;
}

export interface GlobalSettingsInput extends GlobalAgentDefaultsInput {
  provider: string;
  model: string;
  thinkingLevel: ModelThinkingLevel;
  apiKey?: string;
}

export interface ModelPreferencesInput {
  enabledModels: string[];
  defaultProvider: string;
  defaultModel: string;
  thinkingLevel: ModelThinkingLevel;
}

const MODEL_REFRESH_TIMEOUT_MS = 30_000;

export function createGlobalSettingsManager(cwd: string): SettingsManager {
  return SettingsManager.create(cwd, piArkAgentDir, { projectTrusted: false });
}

export class SettingsService {
  private providerPlugins: ProviderPlugin[] = [];
  private providerInstances: ProviderInstance[] = [];
  private providerPluginDiagnostics: Array<{ path: string; message: string }> = [];
  private providerInstanceIds = new Set<string>();
  private providerModelCaches = new Map<string, ProviderModelCache>();

  private constructor(private readonly manager: SettingsManager, private readonly models: ModelRuntime) {}

  static async create(cwd: string): Promise<SettingsService> {
    const agentDir = piArkAgentDir;
    const manager = createGlobalSettingsManager(cwd);
    const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: true });
    const service = new SettingsService(manager, models);
    await service.reloadProviderPlugins();
    return service;
  }

  async reloadProviderPlugins(): Promise<void> {
    const catalog = await loadProviderPlugins();
    const instanceState = await loadProviderInstances();
    this.providerPlugins = catalog.plugins;
    this.providerInstances = instanceState.state.instances;
    this.providerPluginDiagnostics = [...catalog.errors, ...instanceState.errors];
    const plugins = new Map(this.providerPlugins.map((plugin) => [plugin.id, plugin]));
    for (const providerId of this.providerInstanceIds) this.models.unregisterProvider(providerId);
    this.providerInstanceIds.clear();
    const nextCaches = new Map<string, ProviderModelCache>();
    for (const instance of this.providerInstances) {
      const plugin = plugins.get(instance.plugin);
      if (!plugin) {
        this.providerPluginDiagnostics.push({ path: providerInstanceStatePath, message: `Provider "${instance.name}" uses missing plugin "${instance.plugin}"` });
        continue;
      }
      const signature = providerPluginSignature(plugin, instance);
      const previous = this.providerModelCaches.get(instance.id);
      const cache = previous?.signature === signature ? previous : { signature, models: [] };
      nextCaches.set(instance.id, cache);
      try {
        this.models.registerProvider(instance.id, createProviderPluginConfig(plugin, instance, cache));
        this.providerInstanceIds.add(instance.id);
      } catch (error) {
        this.providerPluginDiagnostics.push({ path: plugin.path, message: error instanceof Error ? error.message : String(error) });
      }
    }
    this.providerModelCaches = nextCaches;
  }

  async getProviderPlugins(): Promise<ProviderPluginsResponse> {
    const catalog = await loadProviderPlugins();
    const instanceState = await loadProviderInstances();
    const plugins = new Set(catalog.plugins.map((plugin) => plugin.id));
    const missing = instanceState.state.instances
      .filter((instance) => !plugins.has(instance.plugin))
      .map((instance) => ({ path: providerInstanceStatePath, message: `Provider "${instance.name}" uses missing plugin "${instance.plugin}"` }));
    return { directory: providerPluginDir, plugins: catalog.plugins, errors: [...catalog.errors, ...instanceState.errors, ...missing, ...this.providerPluginDiagnostics.filter((diagnostic) => !catalog.errors.some((error) => error.path === diagnostic.path && error.message === diagnostic.message) && !instanceState.errors.some((error) => error.path === diagnostic.path && error.message === diagnostic.message) && !missing.some((error) => error.message === diagnostic.message))] };
  }

  async createProviderInstance(input: { pluginId?: unknown; name?: unknown; apiKey?: unknown }) {
    const pluginId = typeof input.pluginId === "string" ? input.pluginId.trim() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!pluginId) throw Object.assign(new Error("A provider plugin is required"), { statusCode: 400 });
    if (!name) throw Object.assign(new Error("Provider name is required"), { statusCode: 400 });
    if (name.length > 80) throw Object.assign(new Error("Provider name must be 80 characters or fewer"), { statusCode: 400 });
    await this.reloadProviderPlugins();
    const plugin = this.providerPlugins.find((candidate) => candidate.id === pluginId);
    if (!plugin) throw Object.assign(new Error("Provider plugin is not installed"), { statusCode: 400 });
    const taken = new Set([...this.models.getProviders().map((provider) => provider.id), ...this.providerInstances.map((instance) => instance.id)]);
    const id = uniqueProviderInstanceId(name, taken);
    const instance: ProviderInstance = { id, name, plugin: plugin.id };
    const signature = providerPluginSignature(plugin, instance);
    const cache: ProviderModelCache = { signature, models: [] };
    this.models.registerProvider(id, createProviderPluginConfig(plugin, instance, cache));
    try {
      if (apiKey) await this.models.login(id, "api_key", {
        prompt: async (prompt) => {
          if (prompt.type === "text" || prompt.type === "secret") return apiKey;
          if (prompt.type === "select" && prompt.options.length === 1) return prompt.options[0].id;
          throw new Error("This provider requires an interactive pi /login flow");
        },
        notify: () => undefined,
      });
      await saveProviderInstances({ version: 1, instances: [...this.providerInstances, instance] });
    } catch (error) {
      this.models.unregisterProvider(id);
      await this.models.logout(id).catch(() => undefined);
      throw error;
    }
    this.providerInstances = [...this.providerInstances, instance];
    this.providerInstanceIds.add(id);
    this.providerModelCaches.set(id, cache);
    return { providerId: id, global: await this.getGlobal(), preferences: await this.getModelPreferences() };
  }

  async deleteProviderInstance(providerId: string) {
    const instance = this.providerInstances.find((candidate) => candidate.id === providerId);
    if (!instance) throw Object.assign(new Error("Provider instance not found"), { statusCode: 404 });
    const preferences = await this.getModelPreferences();
    const selectedReferences = new Set(preferences.models.filter((model) => model.enabled).map((model) => `${model.provider}/${model.id}`));
    await this.models.logout(providerId).catch(() => undefined);
    this.models.unregisterProvider(providerId);
    this.providerInstanceIds.delete(providerId);
    this.providerModelCaches.delete(providerId);
    this.providerInstances = this.providerInstances.filter((candidate) => candidate.id !== providerId);
    await saveProviderInstances({ version: 1, instances: this.providerInstances });
    const remaining = this.models.getAvailableSnapshot();
    const enabled = remaining.filter((model) => selectedReferences.has(`${model.provider}/${model.id}`));
    const selected = enabled.length > 0 ? enabled : remaining.slice(0, 1);
    if (selected.length > 0) {
      const configured = selected.find((model) => model.provider === preferences.defaultProvider && model.id === preferences.defaultModel) || selected[0];
      this.manager.setEnabledModels(selected.length === remaining.length ? undefined : selected.map((model) => `${model.provider}/${model.id}`));
      this.manager.setDefaultModelAndProvider(configured.provider, configured.id);
      this.manager.setDefaultThinkingLevel(clampThinkingLevel(configured, preferences.thinkingLevel));
      await this.manager.flush();
      const errors = this.manager.drainErrors();
      if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("; "));
    }
    return { global: await this.getGlobal(), preferences: await this.getModelPreferences() };
  }

  private async getModelScope(): Promise<{ available: ReturnType<ModelRuntime["getAvailableSnapshot"]>; enabled: ReturnType<ModelRuntime["getAvailableSnapshot"]>; scopedModels: ScopedModel[] }> {
    await this.manager.reload();
    const patterns = this.manager.getEnabledModels();
    if (!patterns?.length) {
      const available = this.models.getAvailableSnapshot();
      return { available, enabled: available, scopedModels: [] };
    }
    const resolved = await resolveModelScopeWithDiagnostics(patterns, this.models, { signal: AbortSignal.timeout(15_000) });
    const available = this.models.getAvailableSnapshot();
    if (resolved.scopedModels.length === 0 || resolved.scopedModels.length === available.length) return { available, enabled: available, scopedModels: [] };
    return { available, enabled: resolved.scopedModels.map(({ model }) => model), scopedModels: resolved.scopedModels };
  }

  async getGlobal() {
    const scope = await this.getModelScope();
    const arkConfig = await loadConfig();
    const configuredProvider = this.manager.getDefaultProvider();
    const configuredModel = this.manager.getDefaultModel();
    const configured = scope.enabled.find((model) => model.provider === configuredProvider && model.id === configuredModel);
    const fallback = configured || scope.enabled[0];
    const provider = fallback?.provider || configuredProvider || "";
    const modelId = fallback?.id || configuredModel || "";
    const model = fallback || this.models.getModel(provider, modelId);
    const configuredThinking = this.manager.getDefaultThinkingLevel() || "medium";
    const instances = new Map(this.providerInstances.map((instance) => [instance.id, instance]));
    const plugins = new Map(this.providerPlugins.map((plugin) => [plugin.id, plugin]));
    return {
      ...arkConfig.preferences,
      provider,
      model: modelId,
      thinkingLevel: model ? clampThinkingLevel(model, configuredThinking) : "off",
      steeringMode: this.manager.getSteeringMode(),
      followUpMode: this.manager.getFollowUpMode(),
      compactionEnabled: this.manager.getCompactionEnabled(),
      retryEnabled: this.manager.getRetryEnabled(),
      providers: this.models.getProviders().map((provider) => {
        const auth = this.models.getProviderAuthStatus(provider.id);
        const subscription = provider.auth.oauth?.isSubscription ? provider.auth.oauth : undefined;
        const instance = instances.get(provider.id);
        const plugin = instance ? plugins.get(instance.plugin) : undefined;
        return { id: provider.id, name: provider.name, configured: auth.configured, authSource: auth.source, authLabel: auth.label, canDisconnect: auth.source === "stored", supportsSubscription: Boolean(subscription), subscriptionName: subscription?.name, subscriptionLoginLabel: subscription?.loginLabel, usingSubscription: this.models.isUsingSubscription(provider.id), custom: Boolean(instance), plugin: instance?.plugin, pluginName: plugin?.name, pluginAvailable: Boolean(instance && plugin) };
      }).sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name)),
    };
  }

  getModels(providerId: string) {
    if (!this.models.getProvider(providerId)) throw Object.assign(new Error("Unknown provider"), { statusCode: 400 });
    return this.models.getModels(providerId).map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      input: model.input,
      thinkingLevels: getSupportedThinkingLevels(model),
    }));
  }

  async getModelPreferences() {
    const scope = await this.getModelScope();
    const enabledReferences = new Set(scope.enabled.map((model) => `${model.provider}/${model.id}`));
    const configuredProvider = this.manager.getDefaultProvider();
    const configuredModel = this.manager.getDefaultModel();
    const defaultModel = scope.enabled.find((model) => model.provider === configuredProvider && model.id === configuredModel) || scope.enabled[0];
    const providerNames = new Map(this.models.getProviders().map((provider) => [provider.id, provider.name]));
    return {
      models: scope.available.map((model) => ({ provider: model.provider, providerName: providerNames.get(model.provider) || model.provider, id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model), enabled: enabledReferences.has(`${model.provider}/${model.id}`) })),
      defaultProvider: defaultModel?.provider || "",
      defaultModel: defaultModel?.id || "",
      thinkingLevel: defaultModel ? clampThinkingLevel(defaultModel, this.manager.getDefaultThinkingLevel() || "medium") : "off",
    };
  }

  /** Reloads `models.json` and fetches provider catalogs so new models appear without a service restart. */
  async refreshModels() {
    const previous = new Set(this.models.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
    const allowNetwork = process.env.PI_OFFLINE === undefined;
    const result = await this.models.refresh({ allowNetwork, force: true, signal: AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS) });
    const added = this.models.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`).filter((reference) => !previous.has(reference));
    return {
      preferences: await this.getModelPreferences(),
      added,
      errors: [...result.errors].map(([provider, error]) => ({ provider, message: error instanceof Error ? error.message : String(error) })),
    };
  }

  async getSessionModels() {
    const scope = await this.getModelScope();
    const providerNames = new Map(this.models.getProviders().map((provider) => [provider.id, provider.name]));
    return scope.enabled.map((model) => ({ provider: model.provider, providerName: providerNames.get(model.provider) || model.provider, id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model) }));
  }

  async getSessionModelConfiguration(): Promise<{ model: ReturnType<ModelRuntime["getModel"]>; scopedModels: ScopedModel[] }> {
    const scope = await this.getModelScope();
    const configuredProvider = this.manager.getDefaultProvider();
    const configuredModel = this.manager.getDefaultModel();
    const model = scope.enabled.find((candidate) => candidate.provider === configuredProvider && candidate.id === configuredModel) || scope.enabled[0];
    return { model, scopedModels: scope.scopedModels };
  }

  async resolveModel(providerId: string, modelId: string) {
    const scope = await this.getModelScope();
    const model = scope.enabled.find((candidate) => candidate.provider === providerId && candidate.id === modelId);
    if (!model) throw Object.assign(new Error("Model is not enabled or available"), { statusCode: 400 });
    return model;
  }

  getModelContextWindow(providerId: string, modelId: string): number | undefined {
    return this.models.getModel(providerId, modelId)?.contextWindow;
  }

  async loginSubscription(providerId: string, interaction: AuthFlowInteraction): Promise<void> {
    const provider = this.models.getProvider(providerId);
    if (!provider?.auth.oauth?.isSubscription) throw Object.assign(new Error("Provider does not support subscription login"), { statusCode: 400 });
    await this.models.login(providerId, "oauth", interaction, { getDeviceId: () => this.manager.getOrCreateDeviceId() });
  }

  async loginApiKey(providerId: string, apiKey: string) {
    if (!this.models.getProvider(providerId)) throw Object.assign(new Error("Unknown provider"), { statusCode: 400 });
    const value = apiKey?.trim();
    if (!value) throw Object.assign(new Error("API key is required"), { statusCode: 400 });
    await this.models.login(providerId, "api_key", {
      prompt: async (prompt) => {
        if (prompt.type === "text" || prompt.type === "secret") return value;
        if (prompt.type === "select" && prompt.options.length === 1) return prompt.options[0].id;
        throw new Error("This provider requires an interactive pi /login flow");
      },
      notify: () => undefined,
    });
    return this.getGlobal();
  }

  async disconnectProvider(providerId: string) {
    if (!this.models.getProvider(providerId)) throw Object.assign(new Error("Unknown provider"), { statusCode: 400 });
    if (this.models.getProviderAuthStatus(providerId).source !== "stored") throw Object.assign(new Error("This provider does not use a saved credential"), { statusCode: 400 });
    const preferences = await this.getModelPreferences();
    const selectedReferences = new Set(preferences.models.filter((model) => model.enabled).map((model) => `${model.provider}/${model.id}`));
    await this.models.logout(providerId);
    const remaining = this.models.getAvailableSnapshot();
    const enabled = remaining.filter((model) => selectedReferences.has(`${model.provider}/${model.id}`));
    const selected = enabled.length > 0 ? enabled : remaining.slice(0, 1);
    if (selected.length > 0) {
      const configured = selected.find((model) => model.provider === preferences.defaultProvider && model.id === preferences.defaultModel) || selected[0];
      this.manager.setEnabledModels(selected.length === remaining.length ? undefined : selected.map((model) => `${model.provider}/${model.id}`));
      this.manager.setDefaultModelAndProvider(configured.provider, configured.id);
      this.manager.setDefaultThinkingLevel(clampThinkingLevel(configured, preferences.thinkingLevel));
      await this.manager.flush();
      const errors = this.manager.drainErrors();
      if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("; "));
    }
    return this.getGlobal();
  }

  async saveModelPreferences(input: ModelPreferencesInput) {
    if (!Array.isArray(input.enabledModels) || input.enabledModels.some((reference) => typeof reference !== "string" || !reference.trim())) throw Object.assign(new Error("Invalid enabled model list"), { statusCode: 400 });
    const available = this.models.getAvailableSnapshot();
    const availableByReference = new Map(available.map((model) => [`${model.provider}/${model.id}`, model]));
    const enabledReferences = [...new Set(input.enabledModels)];
    if (enabledReferences.length === 0) throw Object.assign(new Error("Select at least one model"), { statusCode: 400 });
    if (enabledReferences.some((reference) => !availableByReference.has(reference))) throw Object.assign(new Error("Enabled model is not available"), { statusCode: 400 });
    const defaultReference = `${input.defaultProvider}/${input.defaultModel}`;
    const defaultModel = availableByReference.get(defaultReference);
    if (!defaultModel || !enabledReferences.includes(defaultReference)) throw Object.assign(new Error("Default model must be enabled"), { statusCode: 400 });
    if (!getSupportedThinkingLevels(defaultModel).includes(input.thinkingLevel)) throw Object.assign(new Error("Thinking level is not supported by the default model"), { statusCode: 400 });
    this.manager.setEnabledModels(enabledReferences.length === available.length ? undefined : enabledReferences);
    this.manager.setDefaultModelAndProvider(input.defaultProvider, input.defaultModel);
    this.manager.setDefaultThinkingLevel(input.thinkingLevel);
    await this.manager.flush();
    const errors = this.manager.drainErrors();
    if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("; "));
    return this.getModelPreferences();
  }

  async saveAgentDefaults(input: GlobalAgentDefaultsInput) {
    if (!(["all", "one-at-a-time"] as const).includes(input.steeringMode) || !(["all", "one-at-a-time"] as const).includes(input.followUpMode)) throw Object.assign(new Error("Invalid message queue mode"), { statusCode: 400 });
    if (typeof input.compactionEnabled !== "boolean" || typeof input.retryEnabled !== "boolean") throw Object.assign(new Error("Invalid agent default setting"), { statusCode: 400 });
    this.manager.setSteeringMode(input.steeringMode);
    this.manager.setFollowUpMode(input.followUpMode);
    this.manager.setCompactionEnabled(input.compactionEnabled);
    this.manager.setRetryEnabled(input.retryEnabled);
    await this.manager.flush();
    const errors = this.manager.drainErrors();
    if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("; "));
    return input;
  }

  async saveGlobal(input: GlobalSettingsInput) {
    const provider = this.models.getProvider(input.provider);
    if (!provider) throw Object.assign(new Error("Unknown provider"), { statusCode: 400 });
    const apiKey = input.apiKey?.trim();
    if (apiKey) await this.loginApiKey(input.provider, apiKey);
    if (!(await this.models.checkAuth(input.provider))) throw Object.assign(new Error("Configure this provider with an API key or pi /login before selecting it"), { statusCode: 400 });
    const model = this.models.getModel(input.provider, input.model);
    if (!model) throw Object.assign(new Error("Model does not belong to the selected provider"), { statusCode: 400 });
    const patterns = this.manager.getEnabledModels();
    if (patterns?.length) {
      const scope = await this.getModelScope();
      if (!scope.enabled.some((candidate) => candidate.provider === input.provider && candidate.id === input.model)) this.manager.setEnabledModels([...patterns, `${input.provider}/${input.model}`]);
    }
    if (!getSupportedThinkingLevels(model).includes(input.thinkingLevel)) throw Object.assign(new Error("Thinking level is not supported by the selected model"), { statusCode: 400 });
    if (!(["all", "one-at-a-time"] as const).includes(input.steeringMode) || !(["all", "one-at-a-time"] as const).includes(input.followUpMode)) throw Object.assign(new Error("Invalid message queue mode"), { statusCode: 400 });

    this.manager.setDefaultModelAndProvider(input.provider, input.model);
    this.manager.setDefaultThinkingLevel(input.thinkingLevel);
    this.manager.setSteeringMode(input.steeringMode);
    this.manager.setFollowUpMode(input.followUpMode);
    this.manager.setCompactionEnabled(input.compactionEnabled);
    this.manager.setRetryEnabled(input.retryEnabled);
    await this.manager.flush();
    const errors = this.manager.drainErrors();
    if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("; "));
    return this.getGlobal();
  }
}
