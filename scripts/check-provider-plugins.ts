import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";

const catalog = {
  upstreams: [
    { name: "Codex", modality: "chat", supported_protocols: ["responses", "messages", "completions"], default_protocol: "responses", models: [{ name: "gpt-6-sol", is_available: true, tiers: [{ max_context_length: 272000 }], effective_price_config: { input_price: "2", output_price: "10", cache_read_input_price: "0.2", cache_creation_input_price: "2.5" } }] },
    { name: "Claude", modality: "chat", supported_protocols: ["responses", "messages", "completions"], default_protocol: "messages", models: [{ name: "claude-opus-4-8", is_available: true }] },
    { name: "Gemini", modality: "chat", supported_protocols: ["responses", "messages", "completions", "gemini"], default_protocol: "gemini", models: [{ name: "gemini-3.8-flash", is_available: true, tiers: [{ max_context_length: 200 }] }] },
    { name: "Jev", modality: "chat", supported_protocols: ["jev"], default_protocol: "jev", models: [{ name: "jev-1.14.0", is_available: true }] },
  ],
};

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  response.setHeader("content-type", "application/json");
  if (path === "/models/public") {
    response.end(JSON.stringify(catalog));
    return;
  }
  if (path === "/v1/models") {
    if (request.headers.authorization !== "Bearer sk-test") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "invalid API key" }));
      return;
    }
    response.end(JSON.stringify({ data: [{ id: "gpt-6-sol" }, { id: "claude-opus-4-8" }, { id: "gemini-3.8-flash" }] }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});
await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const directory = await mkdtemp(join(resolve(".tmp"), "provider-plugins-check-"));
const agentDir = join(directory, "pi-agent");
const home = join(directory, "home");
await mkdir(agentDir, { recursive: true });
await mkdir(home, { recursive: true });
await writeFile(join(home, "config.json"), JSON.stringify({
  listen: { host: "127.0.0.1", port: 14116 },
  tls: { keyPath: join(home, "tls.key"), certPath: join(home, "tls.crt") },
  auth: { username: "check", passwordHash: "scrypt$fixture$00" },
  workspaces: [],
}) + "\n");
process.env.PI_ARK_HOME = home;
process.env.PI_ARK_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";

try {
  const plugins = await import("../apps/server/src/provider-plugins.ts");
  await plugins.ensureProviderPluginState();
  const defaultCatalog = await plugins.loadProviderPlugins();
  assert.equal(defaultCatalog.errors.length, 0);
  const rightCode = defaultCatalog.plugins.find((plugin) => plugin.id === "rightcode");
  assert.ok(rightCode);
  assert.equal(rightCode.baseUrl, "https://rightapi.io/v1");
  assert.equal(rightCode.models?.metadataFormat, "rightcode-public");
  const template = JSON.parse(await readFile(resolve("skills/provider-plugins/rightcode.json"), "utf8"));
  const generated = JSON.parse(await readFile(join(agentDir, "provider-plugins", "rightcode.json"), "utf8"));
  assert.deepEqual(template, generated);
  const rightCodeModels = plugins.buildProviderModels(rightCode, ["gpt-6-sol", "claude-opus-4-8", "gemini-3.8-flash", "jev-1.14.0"], catalog);
  const rightCodeById = new Map(rightCodeModels.map((model) => [model.id, model]));
  assert.equal(rightCodeById.get("gpt-6-sol")?.api, "openai-responses");
  assert.equal(rightCodeById.get("gpt-6-sol")?.baseUrl, "https://rightapi.io/v1");
  assert.equal(rightCodeById.get("claude-opus-4-8")?.api, "anthropic-messages");
  assert.equal(rightCodeById.get("claude-opus-4-8")?.baseUrl, "https://rightapi.io");
  assert.equal(rightCodeById.get("gemini-3.8-flash")?.api, "google-generative-ai");
  assert.equal(rightCodeById.get("gemini-3.8-flash")?.baseUrl, "https://rightapi.io/v1beta");
  assert.equal(rightCodeById.has("jev-1.14.0"), false);

  const mockPlugin = {
    version: 1,
    name: "Mock Relay",
    description: "Local relay fixture",
    baseUrl: `${origin}/v1`,
    api: "openai-completions",
    models: {
      url: `${origin}/v1/models`,
      format: "openai",
      auth: ["bearer"],
      metadataUrl: `${origin}/models/public`,
      metadataFormat: "rightcode-public",
      fallbackToMetadata: true,
    },
    protocols: [
      { match: "^claude", kind: "messages", api: "anthropic-messages", baseUrl: origin },
      { match: "^(gpt|codex|o[0-9])", kind: "responses", api: "openai-responses", baseUrl: `${origin}/v1` },
      { match: "^gemini", kind: "gemini", api: "google-generative-ai", baseUrl: `${origin}/v1beta` },
    ],
    defaultProtocol: { kind: "completions", api: "openai-completions", baseUrl: `${origin}/v1` },
    modelDefaults: {
      input: ["text"],
      reasoningMatch: "^(claude|gpt|codex|gemini|grok)",
      contextWindow: 128000,
      maxTokens: 16384,
      contextWindowRules: [{ match: "^(gpt|codex)", value: 272000 }, { match: "^(claude|gemini)", value: 200000 }],
      maxTokensRules: [{ match: "^gemini", value: 65536 }, { match: "^(claude|gpt|codex)", value: 32000 }],
    },
  };
  await writeFile(join(agentDir, "provider-plugins", "mock.json"), `${JSON.stringify(mockPlugin, null, 2)}\n`);
  await writeFile(join(agentDir, "provider-plugins", "bad.json"), JSON.stringify({ version: 1, name: "Bad", baseUrl: origin, api: "openai-completions", models: { url: `${origin}/v1/models`, auth: ["bearer"] }, protocols: [{ match: "[", kind: "messages", api: "anthropic-messages", baseUrl: origin }] }) + "\n");

  const { SettingsService } = await import("../apps/server/src/settings.ts");
  const service = await SettingsService.create(directory);
  const pluginList = await service.getProviderPlugins();
  assert.deepEqual(pluginList.plugins.map((plugin) => plugin.id).sort(), ["mock", "rightcode"]);
  assert.equal(pluginList.errors.some((error) => error.path.endsWith("bad.json")), true);

  const created = await service.createProviderInstance({ pluginId: "mock", name: "Mock Relay", apiKey: "sk-test" });
  assert.equal(created.providerId, "mock-relay");
  const custom = created.global.providers.find((provider) => provider.id === created.providerId);
  assert.equal(custom?.custom, true);
  assert.equal(custom?.plugin, "mock");
  assert.equal(custom?.pluginName, "Mock Relay");
  assert.equal(custom?.configured, true);

  const registered: Array<{ id: string; name?: string; refreshModels?: unknown }> = [];
  const factory = plugins.createProviderPluginsExtension();
  await factory({ registerProvider: (id: string, config: { name?: string; refreshModels?: unknown }) => { registered.push({ id, name: config.name, refreshModels: config.refreshModels }); } } as unknown as Parameters<typeof factory>[0]);
  const sessionProvider = registered.find((provider) => provider.id === created.providerId);
  assert.equal(sessionProvider?.name, "Mock Relay");
  assert.equal(typeof sessionProvider?.refreshModels, "function");

  const runtime = (service as unknown as { models: { refresh(options: { allowNetwork: boolean; force: boolean; providers: string[]; signal: AbortSignal }): Promise<{ aborted: boolean; errors: Map<string, Error> }> } }).models;
  const refreshed = await runtime.refresh({ allowNetwork: true, force: true, providers: [created.providerId], signal: AbortSignal.timeout(5000) });
  assert.equal(refreshed.aborted, false);
  assert.deepEqual([...refreshed.errors], []);

  const preferences = await service.getModelPreferences();
  const mockModels = preferences.models.filter((model) => model.provider === created.providerId);
  assert.deepEqual(mockModels.map((model) => model.id).sort(), ["claude-opus-4-8", "gemini-3.8-flash", "gpt-6-sol"]);
  assert.equal(mockModels.find((model) => model.id === "gpt-6-sol")?.providerName, "Mock Relay");

  const resolved = await service.resolveModel(created.providerId, "gpt-6-sol");
  assert.equal(resolved.api, "openai-responses");
  assert.equal(resolved.baseUrl, `${origin}/v1`);
  assert.equal(resolved.reasoning, true);
  assert.equal(resolved.maxTokens, 32000);
  const claude = await service.resolveModel(created.providerId, "claude-opus-4-8");
  assert.equal(claude.api, "anthropic-messages");
  assert.equal(claude.baseUrl, origin);
  const gemini = await service.resolveModel(created.providerId, "gemini-3.8-flash");
  assert.equal(gemini.api, "google-generative-ai");
  assert.equal(gemini.contextWindow, 200000);

  await service.saveModelPreferences({ enabledModels: mockModels.map((model) => `${model.provider}/${model.id}`), defaultProvider: created.providerId, defaultModel: "gpt-6-sol", thinkingLevel: "off" });
  const deleted = await service.deleteProviderInstance(created.providerId);
  assert.equal(deleted.global.providers.some((provider) => provider.id === created.providerId), false);
  assert.notEqual(deleted.preferences.defaultProvider, created.providerId);
  assert.equal((await service.getModelPreferences()).models.some((model) => model.provider === created.providerId), false);
  const instancesAfterDelete = JSON.parse(await readFile(join(agentDir, "provider-instances.json"), "utf8")) as { instances: unknown[] };
  assert.deepEqual(instancesAfterDelete.instances, []);

  const second = await service.createProviderInstance({ pluginId: "mock", name: "Temporary Relay", apiKey: "sk-test" });
  assert.notEqual(second.providerId, created.providerId);
  await rename(join(agentDir, "provider-plugins", "mock.json"), join(agentDir, "provider-plugins", "mock.json.disabled"));
  await service.reloadProviderPlugins();
  assert.equal((await service.getGlobal()).providers.some((provider) => provider.id === second.providerId), false);
  assert.equal((await service.getProviderPlugins()).errors.some((error) => error.message.includes("missing plugin")), true);
  await rename(join(agentDir, "provider-plugins", "mock.json.disabled"), join(agentDir, "provider-plugins", "mock.json"));
  await service.reloadProviderPlugins();
  assert.equal((await service.getGlobal()).providers.some((provider) => provider.id === second.providerId), true);
  await service.deleteProviderInstance(second.providerId);

  await unlink(join(agentDir, "provider-plugins", "rightcode.json"));
  await plugins.ensureProviderPluginState();
  const afterUninstall = await plugins.loadProviderPlugins();
  assert.equal(afterUninstall.plugins.some((plugin) => plugin.id === "rightcode"), false);
  await assert.rejects(() => readFile(join(agentDir, "provider-plugins", "rightcode.json"), "utf8"));

  console.log("Provider plugin checks passed");
} finally {
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
}
