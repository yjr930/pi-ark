import assert from "node:assert/strict";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { buildRightApiModels, createRightApiExtension, fetchRightApiModels } from "../apps/server/src/rightapi-extension.ts";

const catalog = {
  upstreams: [
    {
      name: "Codex",
      modality: "chat",
      supported_protocols: ["responses", "messages", "completions"],
      default_protocol: "responses",
      models: [
        { name: "gpt-6-sol", is_available: true, tiers: [{ max_context_length: 272000 }], effective_price_config: { input_price: "2", output_price: "10", cache_read_input_price: "0.2", cache_creation_input_price: "2.5" } },
      ],
    },
    {
      name: "Claude",
      modality: "chat",
      supported_protocols: ["responses", "messages", "completions"],
      default_protocol: "messages",
      models: [
        { name: "claude-opus-4-8", is_available: true, effective_price_config: { input_price: "5", output_price: "25", cache_read_input_price: "0.5", cache_creation_input_price: "6.25" } },
      ],
    },
    {
      name: "Gemini",
      modality: "chat",
      supported_protocols: ["responses", "messages", "completions", "gemini"],
      default_protocol: "gemini",
      models: [
        { name: "gemini-3.8-flash", is_available: true, tiers: [{ max_context_length: 200 }], base_price_config: { input_price: "0.1", output_price: "0.4", cache_read_input_price: "0.01", cache_creation_input_price: "0" } },
      ],
    },
    {
      name: "Grok",
      modality: "chat",
      supported_protocols: ["responses", "completions"],
      default_protocol: "responses",
      models: [{ name: "grok-4.7", is_available: true }],
    },
    {
      name: "国模",
      modality: "chat",
      supported_protocols: ["responses", "messages", "completions"],
      default_protocol: "messages",
      models: [{ name: "deepseek-v4-pro", is_available: true }],
    },
    {
      name: "Image",
      modality: "image",
      supported_protocols: ["completions"],
      default_protocol: "completions",
      models: [{ name: "gpt-image-2" }],
    },
    {
      name: "Jev",
      modality: "chat",
      supported_protocols: ["jev"],
      default_protocol: "jev",
      models: [{ name: "jev-1.14.0" }],
    },
  ],
};

const models = buildRightApiModels(["gpt-6-sol", "claude-opus-4-8", "gemini-3.8-flash", "grok-4.7", "deepseek-v4-pro", "unknown-model", "gpt-image-2", "jev-1.14.0"], catalog);
const byId = new Map(models.map((model) => [model.id, model]));

assert.equal(byId.get("gpt-6-sol")?.api, "openai-responses");
assert.equal(byId.get("gpt-6-sol")?.baseUrl, "https://rightapi.io/v1");
assert.equal(byId.get("gpt-6-sol")?.contextWindow, 272000);
assert.deepEqual(byId.get("gpt-6-sol")?.cost, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
assert.equal(byId.get("claude-opus-4-8")?.api, "anthropic-messages");
assert.equal(byId.get("claude-opus-4-8")?.baseUrl, "https://rightapi.io");
assert.equal(byId.get("claude-opus-4-8")?.contextWindow, 200000);
assert.equal(byId.get("gemini-3.8-flash")?.api, "google-generative-ai");
assert.equal(byId.get("gemini-3.8-flash")?.baseUrl, "https://rightapi.io/v1beta");
assert.equal(byId.get("gemini-3.8-flash")?.contextWindow, 200000);
assert.equal(byId.get("grok-4.7")?.api, "openai-responses");
assert.equal(byId.get("deepseek-v4-pro")?.api, "anthropic-messages");
assert.equal(byId.get("unknown-model")?.api, "openai-completions");
assert.equal(byId.has("gpt-image-2"), false);
assert.equal(byId.has("jev-1.14.0"), false);

let registered: { id: string; config: ProviderConfig } | undefined;
const pi = { registerProvider: (id: string, config: ProviderConfig) => { registered = { id, config }; } } as unknown as ExtensionAPI;
createRightApiExtension()(pi);
assert.equal(registered?.id, "rightcode");
assert.equal(registered?.config.name, "Right Code");
assert.equal(registered?.config.baseUrl, "https://rightapi.io/v1");
assert.equal(registered?.config.api, "openai-completions");
assert.deepEqual(registered?.config.models, []);
assert.equal(typeof registered?.config.refreshModels, "function");

function mockFetch(handler: (url: string, headers: Record<string, string>) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    return handler(String(input), headers);
  }) as typeof fetch;
}

const found = await fetchRightApiModels("sk-test", undefined, mockFetch((url) => {
  if (url.endsWith("/models/public")) return new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });
  if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-6-sol" }, { id: "claude-opus-4-8" }] }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response("not found", { status: 404 });
}));
assert.deepEqual(found.map((model) => `${model.id}:${model.api}`), ["claude-opus-4-8:anthropic-messages", "gpt-6-sol:openai-responses"]);

await assert.rejects(() => fetchRightApiModels("sk-bad", undefined, mockFetch((url) => {
  if (url.endsWith("/models/public")) return new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ error: "invalid key" }), { status: 401, headers: { "content-type": "application/json" } });
})), /rejected the API key/);

const fallback = await fetchRightApiModels("sk-test", undefined, mockFetch((url) => {
  if (url.endsWith("/models/public")) return new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ error: "unsupported" }), { status: 404, headers: { "content-type": "application/json" } });
}));
const fallbackIds = new Set(fallback.map((model) => model.id));
assert.ok(fallbackIds.has("gpt-6-sol") && fallbackIds.has("gemini-3.8-flash") && fallbackIds.has("deepseek-v4-pro"));
assert.equal(fallbackIds.has("gpt-image-2"), false);
assert.equal(fallbackIds.has("jev-1.14.0"), false);

console.log("Right Code extension checks passed");
