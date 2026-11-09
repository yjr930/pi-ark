import assert from "node:assert/strict";
import { SettingsService } from "../apps/server/src/settings.ts";

function model(provider: string, id: string, reasoning = false) {
  return { provider, id, name: id, api: "openai-responses", baseUrl: "https://example.com", reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 };
}

const available = [model("alpha", "one"), model("alpha", "two", true), model("beta", "three")];
let activeAvailable = available;
let enabledModels: string[] | undefined = ["alpha/two", "beta/three"];
let defaultProvider = "alpha";
let defaultModel = "one";
let defaultThinkingLevel = "high";
let loggedOutProvider: string | undefined;
const manager = {
  reload: async () => undefined,
  getEnabledModels: () => enabledModels,
  setEnabledModels: (next: string[] | undefined) => { enabledModels = next; },
  getDefaultProvider: () => defaultProvider,
  getDefaultModel: () => defaultModel,
  getDefaultThinkingLevel: () => defaultThinkingLevel,
  setDefaultModelAndProvider: (provider: string, modelId: string) => { defaultProvider = provider; defaultModel = modelId; },
  setDefaultThinkingLevel: (level: string) => { defaultThinkingLevel = level; },
  flush: async () => undefined,
  drainErrors: () => [],
};
const models = {
  getAvailable: async () => activeAvailable,
  getAvailableSnapshot: () => activeAvailable,
  getProviders: () => [{ id: "alpha", name: "Alpha", auth: {} }, { id: "beta", name: "Beta", auth: {} }],
  getProvider: (providerId: string) => providerId === "alpha" || providerId === "beta" ? { id: providerId, auth: {} } : undefined,
  getProviderAuthStatus: (providerId: string) => providerId === "alpha" ? { configured: true, source: "stored" } : { configured: true, source: "environment" },
  getModel: (providerId: string, modelId: string) => available.find((candidate) => candidate.provider === providerId && candidate.id === modelId),
  isUsingSubscription: () => false,
  logout: async (providerId: string) => { loggedOutProvider = providerId; activeAvailable = activeAvailable.filter((candidate) => candidate.provider !== providerId); },
};
const settings = Object.assign(Object.create(SettingsService.prototype), { manager, models }) as SettingsService;

const sessionModels = await settings.getSessionModels();
assert.deepEqual(sessionModels.map((candidate) => `${candidate.provider}/${candidate.id}`), ["alpha/two", "beta/three"]);
const preferences = await settings.getModelPreferences();
assert.equal(preferences.defaultProvider, "alpha");
assert.equal(preferences.defaultModel, "two");
assert.equal(preferences.thinkingLevel, "high");
assert.deepEqual(preferences.models.filter((candidate) => candidate.enabled).map((candidate) => `${candidate.provider}/${candidate.id}`), ["alpha/two", "beta/three"]);
await assert.rejects(() => settings.resolveModel("alpha", "one"), /not enabled/);
assert.equal((await settings.resolveModel("beta", "three")).id, "three");

const saved = await settings.saveModelPreferences({ enabledModels: ["alpha/one", "beta/three"], defaultProvider: "beta", defaultModel: "three", thinkingLevel: "off" });
assert.deepEqual(enabledModels, ["alpha/one", "beta/three"]);
assert.equal(defaultProvider, "beta");
assert.equal(defaultModel, "three");
assert.equal(saved.defaultModel, "three");
await assert.rejects(() => settings.saveModelPreferences({ enabledModels: [], defaultProvider: "beta", defaultModel: "three", thinkingLevel: "off" }), /at least one model/);
await assert.rejects(() => settings.saveModelPreferences({ enabledModels: ["alpha/one"], defaultProvider: "beta", defaultModel: "three", thinkingLevel: "off" }), /must be enabled/);

(settings as unknown as { getGlobal: () => Promise<unknown> }).getGlobal = async () => ({ ok: true });
await settings.disconnectProvider("alpha");
assert.equal(loggedOutProvider, "alpha");
assert.equal(defaultProvider, "beta");
assert.equal(defaultModel, "three");
assert.equal(enabledModels, undefined);
await assert.rejects(() => settings.disconnectProvider("beta"), /does not use a saved credential/);
console.log("model preference checks passed");
