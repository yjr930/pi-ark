import { join } from "node:path";
import { ModelRuntime, SettingsManager, resolveModelScopeWithDiagnostics, type ScopedModel } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { loadConfig, piArkAgentDir } from "./config.js";
import type { AuthFlowInteraction } from "./auth-flows.js";

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

export function createGlobalSettingsManager(cwd: string): SettingsManager {
  return SettingsManager.create(cwd, piArkAgentDir, { projectTrusted: false });
}

export class SettingsService {
  private constructor(private readonly manager: SettingsManager, private readonly models: ModelRuntime) {}

  static async create(cwd: string): Promise<SettingsService> {
    const agentDir = piArkAgentDir;
    const manager = createGlobalSettingsManager(cwd);
    const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: true });
    return new SettingsService(manager, models);
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
        return { id: provider.id, name: provider.name, configured: auth.configured, authSource: auth.source, authLabel: auth.label, canDisconnect: auth.source === "stored", supportsSubscription: Boolean(subscription), subscriptionName: subscription?.name, subscriptionLoginLabel: subscription?.loginLabel, usingSubscription: this.models.isUsingSubscription(provider.id) };
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

  async getSessionModels() {
    const scope = await this.getModelScope();
    return scope.enabled.map((model) => ({ provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model) }));
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
