import { join } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ARK_THEMES, loadConfig, piArkAgentDir, saveGlobalArkSettings, type ArkTheme } from "./config.js";
import type { AuthFlowInteraction } from "./auth-flows.js";

export interface GlobalAgentDefaultsInput {
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  compactionEnabled: boolean;
  retryEnabled: boolean;
}

export interface GlobalSettingsInput extends GlobalAgentDefaultsInput {
  theme: ArkTheme;
  provider: string;
  model: string;
  thinkingLevel: ModelThinkingLevel;
  apiKey?: string;
}

export class SettingsService {
  private constructor(private readonly manager: SettingsManager, private readonly models: ModelRuntime) {}

  static async create(cwd: string): Promise<SettingsService> {
    const agentDir = piArkAgentDir;
    const manager = SettingsManager.create(cwd, agentDir);
    const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: true });
    return new SettingsService(manager, models);
  }

  async getGlobal() {
    await this.manager.reload();
    const arkConfig = await loadConfig();
    const configuredProvider = this.manager.getDefaultProvider();
    const configuredModel = this.manager.getDefaultModel();
    const available = this.models.getAvailableSnapshot();
    const fallback = available[0];
    const provider = configuredProvider || fallback?.provider || "";
    const modelId = configuredModel || fallback?.id || "";
    const model = this.models.getModel(provider, modelId);
    const configuredThinking = this.manager.getDefaultThinkingLevel() || "medium";
    return {
      theme: arkConfig.ui.theme,
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
        return { id: provider.id, name: provider.name, configured: auth.configured, authSource: auth.source, authLabel: auth.label, supportsSubscription: Boolean(subscription), subscriptionName: subscription?.name, subscriptionLoginLabel: subscription?.loginLabel, usingSubscription: this.models.isUsingSubscription(provider.id) }; 
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

  getSessionModels() {
    return this.models.getAvailableSnapshot().map((model) => ({ provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model) }));
  }

  resolveModel(providerId: string, modelId: string) {
    const model = this.models.getModel(providerId, modelId);
    if (!model) throw Object.assign(new Error("Unknown or unavailable model"), { statusCode: 400 });
    return model;
  }

  getModelContextWindow(providerId: string, modelId: string): number | undefined {
    return this.models.getModel(providerId, modelId)?.contextWindow;
  }

  async loginSubscription(providerId: string, interaction: AuthFlowInteraction): Promise<void> {
    const provider = this.models.getProvider(providerId);
    if (!provider?.auth.oauth?.isSubscription) throw Object.assign(new Error("Provider does not support subscription login"), { statusCode: 400 });
    await this.models.login(providerId, "oauth", interaction);
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
    if (!ARK_THEMES.includes(input.theme)) throw Object.assign(new Error("Unknown theme"), { statusCode: 400 });
    const provider = this.models.getProvider(input.provider);
    if (!provider) throw Object.assign(new Error("Unknown provider"), { statusCode: 400 });
    const model = this.models.getModel(input.provider, input.model);
    if (!model) throw Object.assign(new Error("Model does not belong to the selected provider"), { statusCode: 400 });
    if (!getSupportedThinkingLevels(model).includes(input.thinkingLevel)) throw Object.assign(new Error("Thinking level is not supported by the selected model"), { statusCode: 400 });
    if (!(["all", "one-at-a-time"] as const).includes(input.steeringMode) || !(["all", "one-at-a-time"] as const).includes(input.followUpMode)) throw Object.assign(new Error("Invalid message queue mode"), { statusCode: 400 });

    const apiKey = input.apiKey?.trim();
    if (apiKey) {
      await this.models.login(input.provider, "api_key", {
        prompt: async (prompt) => {
          if (prompt.type === "text" || prompt.type === "secret") return apiKey;
          if (prompt.type === "select" && prompt.options.length === 1) return prompt.options[0].id;
          throw new Error("This provider requires an interactive pi /login flow");
        },
        notify: () => undefined,
      });
    }
    if (!(await this.models.checkAuth(input.provider))) throw Object.assign(new Error("Configure this provider with an API key or pi /login before selecting it"), { statusCode: 400 });

    this.manager.setDefaultModelAndProvider(input.provider, input.model);
    this.manager.setDefaultThinkingLevel(input.thinkingLevel);
    this.manager.setSteeringMode(input.steeringMode);
    this.manager.setFollowUpMode(input.followUpMode);
    this.manager.setCompactionEnabled(input.compactionEnabled);
    this.manager.setRetryEnabled(input.retryEnabled);
    await this.manager.flush();
    const errors = this.manager.drainErrors();
    if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("; "));
    await saveGlobalArkSettings(input.theme);
    return this.getGlobal();
  }
}
