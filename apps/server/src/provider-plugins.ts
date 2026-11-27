import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionFactory, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { piArkAgentDir } from "./config.js";

export const providerPluginDir = join(piArkAgentDir, "provider-plugins");
export const providerInstanceStatePath = join(piArkAgentDir, "provider-instances.json");
const providerPluginMarkerPath = join(piArkAgentDir, ".pi-ark-provider-plugins.json");

export const PROVIDER_PLUGIN_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export const PROVIDER_PLUGIN_KINDS = ["responses", "messages", "completions", "gemini"] as const;
export const PROVIDER_PLUGIN_AUTH = ["bearer", "x-api-key", "x-goog-api-key", "none"] as const;

export type ProviderPluginApi = (typeof PROVIDER_PLUGIN_APIS)[number];
export type ProviderPluginKind = (typeof PROVIDER_PLUGIN_KINDS)[number];
export type ProviderPluginAuth = (typeof PROVIDER_PLUGIN_AUTH)[number];

export interface ProviderPluginProtocol {
  kind: ProviderPluginKind;
  match?: string;
  api: ProviderPluginApi;
  baseUrl: string;
}

export interface ProviderPluginRule {
  match: string;
  value: number;
}

export interface ProviderPluginModelDefaults {
  input?: ("text" | "image")[];
  reasoning?: boolean;
  reasoningMatch?: string;
  contextWindow?: number;
  maxTokens?: number;
  contextWindowRules?: ProviderPluginRule[];
  maxTokensRules?: ProviderPluginRule[];
  compat?: Record<string, unknown>;
  compatRules?: Array<{ match: string; compat: Record<string, unknown> }>;
}

export interface ProviderPluginModels {
  url?: string;
  format?: "openai";
  auth?: ProviderPluginAuth | ProviderPluginAuth[];
  metadataUrl?: string;
  metadataFormat?: "rightcode-public";
  fallbackToMetadata?: boolean;
}

export interface ProviderPlugin {
  id: string;
  name: string;
  description?: string;
  baseUrl: string;
  api: ProviderPluginApi;
  models?: ProviderPluginModels;
  protocols?: ProviderPluginProtocol[];
  defaultProtocol?: ProviderPluginProtocol;
  modelDefaults?: ProviderPluginModelDefaults;
  path: string;
}

export interface ProviderPluginDiagnostic {
  path: string;
  message: string;
}

export interface ProviderPluginsResponse {
  directory: string;
  plugins: Array<Pick<ProviderPlugin, "id" | "name" | "description" | "baseUrl" | "path">>;
  errors: ProviderPluginDiagnostic[];
}

export interface ProviderInstance {
  id: string;
  name: string;
  plugin: string;
}

export interface ProviderInstanceState {
  version: 1;
  instances: ProviderInstance[];
}

export interface ProviderModelCache {
  signature: string;
  models: ProviderModelConfig[];
}

interface RightApiPublicModel {
  name?: unknown;
  is_available?: unknown;
  tiers?: unknown;
  base_price_config?: RightApiPriceConfig;
  effective_price_config?: RightApiPriceConfig;
}

interface RightApiPriceConfig {
  input_price?: unknown;
  output_price?: unknown;
  cache_read_input_price?: unknown;
  cache_creation_input_price?: unknown;
}

interface RightApiPublicUpstream {
  modality?: unknown;
  supported_protocols?: unknown;
  default_protocol?: unknown;
  models?: unknown;
}

interface RightApiPublicCatalog {
  upstreams?: unknown;
}

interface MetadataEntry {
  model: RightApiPublicModel;
  supportedKinds: ProviderPluginKind[];
  defaultKind?: ProviderPluginKind;
}

const DEFAULT_RIGHT_CODE_PLUGIN = {
  version: 1,
  name: "Right Code",
  description: "Right Code relay at rightapi.io. Create one provider instance for each channel.",
  baseUrl: "https://rightapi.io/v1",
  api: "openai-completions",
  models: {
    url: "https://rightapi.io/v1/models",
    format: "openai",
    auth: ["bearer", "x-api-key", "x-goog-api-key"],
    metadataUrl: "https://rightapi.io/models/public",
    metadataFormat: "rightcode-public",
    fallbackToMetadata: true,
  },
  protocols: [
    { match: "^claude", kind: "messages", api: "anthropic-messages", baseUrl: "https://rightapi.io" },
    { match: "^(gpt|codex|o[0-9])", kind: "responses", api: "openai-responses", baseUrl: "https://rightapi.io/v1" },
    { match: "^gemini", kind: "gemini", api: "google-generative-ai", baseUrl: "https://rightapi.io/v1beta" },
    { match: "^grok", kind: "responses", api: "openai-responses", baseUrl: "https://rightapi.io/v1" },
    { match: "^(deepseek|glm|kimi|minimax)", kind: "messages", api: "anthropic-messages", baseUrl: "https://rightapi.io" },
  ],
  defaultProtocol: { kind: "completions", api: "openai-completions", baseUrl: "https://rightapi.io/v1" },
  modelDefaults: {
    input: ["text"],
    reasoningMatch: "^(claude|gpt|codex|gemini|grok)",
    contextWindow: 128000,
    maxTokens: 16384,
    contextWindowRules: [
      { match: "^(gpt|codex)", value: 272000 },
      { match: "^(claude|gemini|grok)", value: 200000 },
    ],
    maxTokensRules: [
      { match: "^gemini", value: 65536 },
      { match: "^(claude|gpt|codex|grok)", value: 32000 },
    ],
    compatRules: [
      { match: "^claude-(opus|sonnet|fable|haiku)-(4-7|4-8|5)", compat: { forceAdaptiveThinking: true } },
    ],
  },
};

let instanceWrite: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isApi(value: unknown): value is ProviderPluginApi {
  return typeof value === "string" && (PROVIDER_PLUGIN_APIS as readonly string[]).includes(value);
}

function isKind(value: unknown): value is ProviderPluginKind {
  return typeof value === "string" && (PROVIDER_PLUGIN_KINDS as readonly string[]).includes(value);
}

function isAuth(value: unknown): value is ProviderPluginAuth {
  return typeof value === "string" && (PROVIDER_PLUGIN_AUTH as readonly string[]).includes(value);
}

function compileMatch(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty regular expression`);
  try {
    new RegExp(value);
  } catch {
    throw new Error(`${label} is not a valid regular expression`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
  return value;
}

function parseRules(value: unknown, label: string): ProviderPluginRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((rule, index) => {
    if (!isRecord(rule)) throw new Error(`${label}[${index}] must be an object`);
    const match = compileMatch(rule.match, `${label}[${index}].match`);
    if (!match) throw new Error(`${label}[${index}].match is required`);
    return { match, value: positiveNumber(rule.value, `${label}[${index}].value`)! };
  });
}

function parseProtocol(value: unknown, label: string): ProviderPluginProtocol {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const kind = value.kind;
  const api = value.api;
  const baseUrl = value.baseUrl;
  if (!isKind(kind)) throw new Error(`${label}.kind must be one of ${PROVIDER_PLUGIN_KINDS.join(", ")}`);
  if (!isApi(api)) throw new Error(`${label}.api must be one of ${PROVIDER_PLUGIN_APIS.join(", ")}`);
  if (!isHttpUrl(baseUrl)) throw new Error(`${label}.baseUrl must be an http(s) URL`);
  const match = compileMatch(value.match, `${label}.match`);
  return { kind, api, baseUrl, ...(match ? { match } : {}) };
}

function parseModelDefaults(value: unknown): ProviderPluginModelDefaults | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("modelDefaults must be an object");
  const input = value.input;
  if (input !== undefined && (!Array.isArray(input) || input.some((item) => item !== "text" && item !== "image"))) throw new Error("modelDefaults.input must contain text or image");
  if (value.reasoning !== undefined && typeof value.reasoning !== "boolean") throw new Error("modelDefaults.reasoning must be a boolean");
  const reasoningMatch = compileMatch(value.reasoningMatch, "modelDefaults.reasoningMatch");
  const contextWindow = positiveNumber(value.contextWindow, "modelDefaults.contextWindow");
  const maxTokens = positiveNumber(value.maxTokens, "modelDefaults.maxTokens");
  const contextWindowRules = parseRules(value.contextWindowRules, "modelDefaults.contextWindowRules");
  const maxTokensRules = parseRules(value.maxTokensRules, "modelDefaults.maxTokensRules");
  if (value.compat !== undefined && !isRecord(value.compat)) throw new Error("modelDefaults.compat must be an object");
  const compatRules = value.compatRules === undefined ? undefined : Array.isArray(value.compatRules) ? value.compatRules.map((rule, index) => {
    if (!isRecord(rule)) throw new Error(`modelDefaults.compatRules[${index}] must be an object`);
    const match = compileMatch(rule.match, `modelDefaults.compatRules[${index}].match`);
    if (!match) throw new Error(`modelDefaults.compatRules[${index}].match is required`);
    if (!isRecord(rule.compat)) throw new Error(`modelDefaults.compatRules[${index}].compat must be an object`);
    return { match, compat: rule.compat };
  }) : (() => { throw new Error("modelDefaults.compatRules must be an array"); })();
  return {
    ...(input ? { input: input as ("text" | "image")[] } : {}),
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
    ...(reasoningMatch ? { reasoningMatch } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(contextWindowRules ? { contextWindowRules } : {}),
    ...(maxTokensRules ? { maxTokensRules } : {}),
    ...(value.compat !== undefined ? { compat: value.compat as Record<string, unknown> } : {}),
    ...(compatRules ? { compatRules } : {}),
  };
}

function parseModels(value: unknown): ProviderPluginModels | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("models must be an object");
  if (value.url !== undefined && !isHttpUrl(value.url)) throw new Error("models.url must be an http(s) URL");
  if (value.metadataUrl !== undefined && !isHttpUrl(value.metadataUrl)) throw new Error("models.metadataUrl must be an http(s) URL");
  if (value.format !== undefined && value.format !== "openai") throw new Error("models.format must be openai");
  if (value.metadataUrl !== undefined && value.metadataFormat !== "rightcode-public") throw new Error("models.metadataFormat must be rightcode-public when metadataUrl is used");
  if (value.metadataFormat !== undefined && value.metadataUrl === undefined) throw new Error("models.metadataFormat requires models.metadataUrl");
  if (value.fallbackToMetadata !== undefined && typeof value.fallbackToMetadata !== "boolean") throw new Error("models.fallbackToMetadata must be a boolean");
  const rawAuth = value.auth;
  const auth = rawAuth === undefined ? undefined : Array.isArray(rawAuth) ? rawAuth : [rawAuth];
  if (auth && (auth.length === 0 || auth.some((item) => !isAuth(item)))) throw new Error(`models.auth must contain ${PROVIDER_PLUGIN_AUTH.join(", ")}`);
  if (!value.url && !(value.metadataUrl && value.fallbackToMetadata)) throw new Error("models.url or models.metadataUrl with fallbackToMetadata is required");
  return {
    ...(value.url ? { url: value.url } : {}),
    ...(value.format ? { format: value.format as "openai" } : {}),
    ...(auth ? { auth: auth as ProviderPluginAuth[] } : {}),
    ...(value.metadataUrl ? { metadataUrl: value.metadataUrl } : {}),
    ...(value.metadataFormat ? { metadataFormat: value.metadataFormat as "rightcode-public" } : {}),
    ...(typeof value.fallbackToMetadata === "boolean" ? { fallbackToMetadata: value.fallbackToMetadata } : {}),
  };
}

function parsePlugin(id: string, path: string, value: unknown): ProviderPlugin {
  if (!isRecord(value)) throw new Error("Plugin must be a JSON object");
  if (value.version !== 1) throw new Error("Plugin version must be 1");
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("name is required");
  if (!isHttpUrl(value.baseUrl)) throw new Error("baseUrl must be an http(s) URL");
  if (!isApi(value.api)) throw new Error(`api must be one of ${PROVIDER_PLUGIN_APIS.join(", ")}`);
  const protocols = value.protocols === undefined ? undefined : Array.isArray(value.protocols) ? value.protocols.map((protocol, index) => parseProtocol(protocol, `protocols[${index}]`)) : (() => { throw new Error("protocols must be an array"); })();
  const models = parseModels(value.models);
  const modelDefaults = parseModelDefaults(value.modelDefaults);
  const defaultProtocol = value.defaultProtocol !== undefined ? parseProtocol(value.defaultProtocol, "defaultProtocol") : undefined;
  return {
    id,
    name: value.name.trim(),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    baseUrl: value.baseUrl,
    api: value.api,
    ...(models ? { models } : {}),
    ...(protocols ? { protocols } : {}),
    ...(defaultProtocol ? { defaultProtocol } : {}),
    ...(modelDefaults ? { modelDefaults } : {}),
    path,
  };
}

async function migrateRightCodeCompatRules(path: string): Promise<void> {
  if (!existsSync(path)) return;
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value) || value.name !== "Right Code" || !isRecord(value.modelDefaults)) return;
    if (Array.isArray(value.modelDefaults.compatRules)) return;
    value.modelDefaults.compatRules = DEFAULT_RIGHT_CODE_PLUGIN.modelDefaults.compatRules;
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Invalid plugin files stay in place and surface through plugin diagnostics.
  }
}

export async function ensureProviderPluginState(): Promise<void> {
  await mkdir(providerPluginDir, { recursive: true, mode: 0o700 });
  const rightCodePath = join(providerPluginDir, "rightcode.json");
  if (existsSync(providerPluginMarkerPath)) {
    if (!existsSync(providerInstanceStatePath)) await writeFile(providerInstanceStatePath, `${JSON.stringify({ version: 1, instances: [] }, null, 2)}\n`, { mode: 0o600 });
    await migrateRightCodeCompatRules(rightCodePath);
    return;
  }
  if (!existsSync(rightCodePath)) await writeFile(rightCodePath, `${JSON.stringify(DEFAULT_RIGHT_CODE_PLUGIN, null, 2)}\n`, { mode: 0o600 });
  else await migrateRightCodeCompatRules(rightCodePath);
  if (!existsSync(providerInstanceStatePath)) await writeFile(providerInstanceStatePath, `${JSON.stringify({ version: 1, instances: [] }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(providerPluginMarkerPath, `${JSON.stringify({ version: 1, initializedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

export async function loadProviderPlugins(): Promise<{ plugins: ProviderPlugin[]; errors: ProviderPluginDiagnostic[] }> {
  await mkdir(providerPluginDir, { recursive: true, mode: 0o700 });
  let files: string[];
  try {
    files = readdirSync(providerPluginDir).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return { plugins: [], errors: [] };
  }
  const plugins: ProviderPlugin[] = [];
  const errors: ProviderPluginDiagnostic[] = [];
  for (const file of files) {
    const id = basename(file, ".json");
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
      errors.push({ path: join(providerPluginDir, file), message: "Plugin file name must contain only lowercase letters, numbers, underscores, and hyphens" });
      continue;
    }
    const path = join(providerPluginDir, file);
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      plugins.push(parsePlugin(id, path, value));
    } catch (error) {
      errors.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { plugins, errors };
}

export async function loadProviderInstances(): Promise<{ state: ProviderInstanceState; errors: ProviderPluginDiagnostic[] }> {
  const empty: ProviderInstanceState = { version: 1, instances: [] };
  if (!existsSync(providerInstanceStatePath)) return { state: empty, errors: [] };
  try {
    const value: unknown = JSON.parse(await readFile(providerInstanceStatePath, "utf8"));
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.instances)) throw new Error("provider-instances.json must use version 1 and contain an instances array");
    const instances: ProviderInstance[] = [];
    const errors: ProviderPluginDiagnostic[] = [];
    const ids = new Set<string>();
    for (const [index, item] of value.instances.entries()) {
      if (!isRecord(item) || typeof item.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(item.id) || typeof item.name !== "string" || !item.name.trim() || typeof item.plugin !== "string" || !item.plugin.trim()) {
        errors.push({ path: `${providerInstanceStatePath}#instances[${index}]`, message: "Instance must contain a valid id, name, and plugin" });
        continue;
      }
      if (ids.has(item.id)) {
        errors.push({ path: `${providerInstanceStatePath}#instances[${index}]`, message: `Duplicate provider instance id: ${item.id}` });
        continue;
      }
      ids.add(item.id);
      instances.push({ id: item.id, name: item.name.trim(), plugin: item.plugin });
    }
    return { state: { version: 1, instances }, errors };
  } catch (error) {
    return { state: empty, errors: [{ path: providerInstanceStatePath, message: error instanceof Error ? error.message : String(error) }] };
  }
}

export function saveProviderInstances(state: ProviderInstanceState): Promise<void> {
  const task = instanceWrite.catch(() => undefined).then(async () => {
    const temporary = `${providerInstanceStatePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, providerInstanceStatePath);
  });
  instanceWrite = task.then(() => undefined, () => undefined);
  return task;
}

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "provider";
}

export function uniqueProviderInstanceId(name: string, taken: Set<string>): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`.slice(0, 64);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function providerPluginSignature(plugin: ProviderPlugin, instance: ProviderInstance): string {
  return JSON.stringify({
    instance: { id: instance.id, name: instance.name, plugin: instance.plugin },
    plugin: {
      name: plugin.name,
      baseUrl: plugin.baseUrl,
      api: plugin.api,
      models: plugin.models,
      protocols: plugin.protocols,
      defaultProtocol: plugin.defaultProtocol,
      modelDefaults: plugin.modelDefaults,
    },
  });
}

export async function listProviderPlugins(): Promise<ProviderPluginsResponse> {
  const { plugins, errors } = await loadProviderPlugins();
  return {
    directory: providerPluginDir,
    plugins: plugins.map(({ id, name, description, baseUrl, path }) => ({ id, name, ...(description ? { description } : {}), baseUrl, path })),
    errors,
  };
}

export function createProviderPluginConfig(plugin: ProviderPlugin, instance: ProviderInstance, cache: ProviderModelCache): ProviderConfig {
  return {
    name: instance.name,
    baseUrl: plugin.baseUrl,
    api: plugin.api,
    models: [],
    async refreshModels({ credential, signal, allowNetwork }) {
      if (!allowNetwork) return cache.models;
      const apiKey = credential?.type === "api_key" ? credential.key : credential?.type === "oauth" ? credential.access : undefined;
      cache.models = await discoverProviderModels(plugin, apiKey, signal);
      return cache.models;
    },
  };
}

function modelIdFromPayload(payload: unknown): string[] {
  const entries = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : [];
  const ids: string[] = [];
  for (const entry of entries) {
    const id = typeof entry === "string"
      ? entry
      : isRecord(entry) && typeof entry.id === "string"
        ? entry.id
        : isRecord(entry) && typeof entry.name === "string"
          ? entry.name
          : undefined;
    if (id?.trim()) ids.push(id.trim());
  }
  return [...new Set(ids)];
}

function supportedKinds(value: unknown): ProviderPluginKind[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isKind);
}

function defaultKind(value: unknown): ProviderPluginKind | undefined {
  return isKind(value) ? value : undefined;
}

function publicUnknownOnlyModelNames(catalog: RightApiPublicCatalog | undefined): Set<string> {
  const valid = new Set<string>();
  const unknown = new Set<string>();
  if (!catalog || !Array.isArray(catalog.upstreams)) return unknown;
  for (const upstream of catalog.upstreams) {
    if (!isRecord(upstream) || upstream.modality !== "chat" || !Array.isArray(upstream.models)) continue;
    const rawProtocols = Array.isArray(upstream.supported_protocols) ? upstream.supported_protocols : [];
    const unknownOnly = rawProtocols.length > 0 && supportedKinds(rawProtocols).length === 0;
    for (const model of upstream.models) {
      if (!isRecord(model) || typeof model.name !== "string" || !model.name.trim()) continue;
      if (unknownOnly) unknown.add(model.name.trim());
      else valid.add(model.name.trim());
    }
  }
  return new Set([...unknown].filter((name) => !valid.has(name)));
}

function publicModelIndex(catalog: RightApiPublicCatalog | undefined): Map<string, MetadataEntry[]> {
  const index = new Map<string, MetadataEntry[]>();
  if (!catalog || !Array.isArray(catalog.upstreams)) return index;
  for (const upstream of catalog.upstreams) {
    if (!isRecord(upstream) || upstream.modality !== "chat" || !Array.isArray(upstream.models)) continue;
    const rawProtocols = Array.isArray(upstream.supported_protocols) ? upstream.supported_protocols : [];
    const kinds = supportedKinds(rawProtocols);
    if (rawProtocols.length > 0 && kinds.length === 0) continue;
    const fallbackKind = defaultKind(upstream.default_protocol);
    for (const model of upstream.models) {
      if (!isRecord(model) || typeof model.name !== "string" || !model.name.trim() || model.is_available === false) continue;
      const entries = index.get(model.name.trim()) ?? [];
      entries.push({ model: model as RightApiPublicModel, supportedKinds: kinds, ...(fallbackKind ? { defaultKind: fallbackKind } : {}) });
      index.set(model.name.trim(), entries);
    }
  }
  return index;
}

function publicChatModelNames(catalog: RightApiPublicCatalog | undefined): string[] {
  if (!catalog || !Array.isArray(catalog.upstreams)) return [];
  const names = new Set<string>();
  for (const upstream of catalog.upstreams) {
    if (!isRecord(upstream) || upstream.modality !== "chat" || !Array.isArray(upstream.models)) continue;
    const rawProtocols = Array.isArray(upstream.supported_protocols) ? upstream.supported_protocols : [];
    if (rawProtocols.length > 0 && supportedKinds(rawProtocols).length === 0) continue;
    for (const model of upstream.models) {
      if (isRecord(model) && typeof model.name === "string" && model.name.trim() && model.is_available !== false) names.add(model.name.trim());
    }
  }
  return [...names];
}

async function fetchMetadata(plugin: ProviderPlugin, fetchImpl: typeof fetch, signal: AbortSignal | undefined): Promise<RightApiPublicCatalog | undefined> {
  if (!plugin.models?.metadataUrl || plugin.models.metadataFormat !== "rightcode-public") return undefined;
  const response = await fetchImpl(plugin.models.metadataUrl, { headers: { accept: "application/json" }, signal });
  if (!response.ok) return undefined;
  const payload: unknown = await response.json();
  return isRecord(payload) ? payload as RightApiPublicCatalog : undefined;
}

async function requestModelIds(plugin: ProviderPlugin, apiKey: string | undefined, auth: ProviderPluginAuth, fetchImpl: typeof fetch, signal: AbortSignal | undefined): Promise<{ ids: string[]; status: number }> {
  if (!plugin.models?.url) return { ids: [], status: 0 };
  const headers: Record<string, string> = { accept: "application/json" };
  if (auth === "bearer" && apiKey) headers.authorization = `Bearer ${apiKey}`;
  else if (auth === "x-api-key" && apiKey) headers["x-api-key"] = apiKey;
  else if (auth === "x-goog-api-key" && apiKey) headers["x-goog-api-key"] = apiKey;
  else if (auth !== "none" && !apiKey) return { ids: [], status: 401 };
  const response = await fetchImpl(plugin.models.url, { headers, signal });
  if (!response.ok) return { ids: [], status: response.status };
  return { ids: modelIdFromPayload(await response.json()), status: response.status };
}

async function fetchModelIds(plugin: ProviderPlugin, apiKey: string | undefined, fetchImpl: typeof fetch, signal: AbortSignal | undefined, metadata: RightApiPublicCatalog | undefined): Promise<string[]> {
  const auth: ProviderPluginAuth[] = plugin.models?.auth === undefined ? ["bearer"] : Array.isArray(plugin.models.auth) ? plugin.models.auth : [plugin.models.auth];
  let rejected = 0;
  let responded = false;
  let lastStatus = 0;
  for (const method of auth) {
    const result = await requestModelIds(plugin, apiKey, method, fetchImpl, signal);
    if (result.ids.length > 0) return result.ids;
    lastStatus = result.status;
    if (result.status === 401 || result.status === 403) { rejected += 1; continue; }
    responded = true;
    break;
  }
  if (rejected > 0 && !responded) throw new Error(`Provider rejected the API key (${lastStatus})`);
  if (plugin.models?.fallbackToMetadata) return publicChatModelNames(metadata);
  return [];
}

function ruleValue(id: string, rules: ProviderPluginRule[] | undefined, fallback: number): number {
  if (!rules) return fallback;
  const match = rules.find((rule) => new RegExp(rule.match).test(id));
  return match?.value ?? fallback;
}

const PI_MODEL_CATALOG_BASE_URL = "https://pi.dev/api/models/providers";
const PI_MODEL_CATALOG_PROVIDERS = ["anthropic", "openai", "openai-codex", "google", "xai", "deepseek"];
const PI_MODEL_CATALOG_TTL_MS = 10 * 60 * 1000;
const PI_MODEL_CATALOG_VARIANT_SUFFIX = /-(?:xhigh|high|medium|low|tiered|\d{8})$/;

export interface PiCatalogModel {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
}

let piCatalogCache: { fetchedAt: number; models: Map<string, PiCatalogModel> } | undefined;

function piCatalogModel(value: unknown): PiCatalogModel | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return undefined;
  const contextWindow = typeof value.contextWindow === "number" && Number.isFinite(value.contextWindow) && value.contextWindow > 0 ? value.contextWindow : undefined;
  const maxTokens = typeof value.maxTokens === "number" && Number.isFinite(value.maxTokens) && value.maxTokens > 0 ? value.maxTokens : undefined;
  const thinkingLevelMap = isRecord(value.thinkingLevelMap)
    ? Object.fromEntries(Object.entries(value.thinkingLevelMap).filter(([, level]) => typeof level === "string" || level === null)) as Record<string, string | null>
    : undefined;
  return {
    id: value.id.trim(),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(thinkingLevelMap && Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
  };
}

export function buildPiCatalog(payloads: unknown[]): Map<string, PiCatalogModel> {
  const models = new Map<string, PiCatalogModel>();
  for (const payload of payloads) {
    if (!Array.isArray(payload)) continue;
    for (const entry of payload) {
      const model = piCatalogModel(entry);
      if (model && !models.has(model.id)) models.set(model.id, model);
    }
  }
  return models;
}

/** Resolve a relay model id such as `gemini-4-neon-high` against the pi model catalog. */
export function lookupPiCatalogModel(id: string, catalog: Map<string, PiCatalogModel> | undefined): PiCatalogModel | undefined {
  if (!catalog) return undefined;
  const direct = catalog.get(id);
  if (direct) return direct;
  let normalized = id;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = normalized.replace(PI_MODEL_CATALOG_VARIANT_SUFFIX, "");
    if (next === normalized) break;
    normalized = next;
    const model = catalog.get(normalized);
    if (model) return model;
  }
  return undefined;
}

/**
 * Pi publishes vendor model specs for its built-in providers. Relay model ids use the same vendor
 * names, so this catalog is the source for context window, output limit and thinking levels, while
 * relay price tiers stay the source for pricing only.
 */
export async function fetchPiCatalog(fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Map<string, PiCatalogModel> | undefined> {
  if (process.env.PI_OFFLINE !== undefined) return undefined;
  if (piCatalogCache && Date.now() - piCatalogCache.fetchedAt < PI_MODEL_CATALOG_TTL_MS) return piCatalogCache.models;
  const responses = await Promise.allSettled(PI_MODEL_CATALOG_PROVIDERS.map(async (provider) => {
    const response = await fetchImpl(`${PI_MODEL_CATALOG_BASE_URL}/${provider}?types=chat`, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
    if (!response.ok) return undefined;
    return await response.json() as unknown;
  }));
  const payloads = responses.flatMap((result) => (result.status === "fulfilled" && result.value !== undefined ? [result.value] : []));
  const models = buildPiCatalog(payloads);
  if (models.size === 0) return undefined;
  piCatalogCache = { fetchedAt: Date.now(), models };
  return models;
}

function contextWindowFor(id: string, entry: MetadataEntry | undefined, plugin: ProviderPlugin): number {
  const tiers = Array.isArray(entry?.model.tiers) ? entry.model.tiers : [];
  const lengths = tiers
    .map((tier) => isRecord(tier) && typeof tier.max_context_length === "number" ? tier.max_context_length : undefined)
    .filter((length): length is number => length !== undefined && length > 0);
  const raw = lengths.length > 0 ? Math.max(...lengths) : 0;
  if (raw >= 1000) return raw;
  if (raw > 0) return raw * 1000;
  return ruleValue(id, plugin.modelDefaults?.contextWindowRules, plugin.modelDefaults?.contextWindow ?? 128000);
}

function maxTokensFor(id: string, plugin: ProviderPlugin): number {
  return ruleValue(id, plugin.modelDefaults?.maxTokensRules, plugin.modelDefaults?.maxTokens ?? 16384);
}

function reasoningFor(id: string, plugin: ProviderPlugin): boolean {
  return plugin.modelDefaults?.reasoningMatch ? new RegExp(plugin.modelDefaults.reasoningMatch).test(id) : plugin.modelDefaults?.reasoning ?? false;
}

function compatFor(id: string, plugin: ProviderPlugin): Record<string, unknown> | undefined {
  const compat = { ...(plugin.modelDefaults?.compat ?? {}) };
  for (const rule of plugin.modelDefaults?.compatRules ?? []) {
    if (new RegExp(rule.match).test(id)) Object.assign(compat, rule.compat);
  }
  return Object.keys(compat).length > 0 ? compat : undefined;
}

function priceNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function costFor(entry: MetadataEntry | undefined): ProviderModelConfig["cost"] {
  const config = entry?.model.effective_price_config ?? entry?.model.base_price_config;
  return {
    input: priceNumber(config?.input_price),
    output: priceNumber(config?.output_price),
    cacheRead: priceNumber(config?.cache_read_input_price),
    cacheWrite: priceNumber(config?.cache_creation_input_price),
  };
}

function pickEntry(id: string, entries: MetadataEntry[], plugin: ProviderPlugin): MetadataEntry | undefined {
  const preferred = plugin.protocols?.find((protocol) => protocol.match && new RegExp(protocol.match).test(id))?.kind;
  return entries.find((entry) => entry.supportedKinds.length === 0 || (preferred ? entry.supportedKinds.includes(preferred) : false)) ?? entries[0];
}

function chooseProtocol(plugin: ProviderPlugin, id: string, entry: MetadataEntry | undefined): ProviderPluginProtocol | undefined {
  const preferred = plugin.protocols?.find((protocol) => protocol.match && new RegExp(protocol.match).test(id)) ?? plugin.defaultProtocol ?? { kind: "completions" as const, api: plugin.api, baseUrl: plugin.baseUrl };
  if (!entry || entry.supportedKinds.length === 0 || entry.supportedKinds.includes(preferred.kind)) return preferred;
  const kinds = [entry.defaultKind, ...entry.supportedKinds].filter((kind): kind is ProviderPluginKind => Boolean(kind));
  for (const kind of kinds) {
    const match = plugin.protocols?.find((protocol) => protocol.kind === kind && !protocol.match) ?? plugin.protocols?.find((protocol) => protocol.kind === kind);
    if (match) return match;
    if (plugin.defaultProtocol?.kind === kind) return plugin.defaultProtocol;
  }
  return undefined;
}

export function buildProviderModels(plugin: ProviderPlugin, ids: string[], metadata: RightApiPublicCatalog | undefined, catalog?: Map<string, PiCatalogModel>): ProviderModelConfig[] {
  const index = publicModelIndex(metadata);
  const unknownOnly = publicUnknownOnlyModelNames(metadata);
  const models = new Map<string, ProviderModelConfig>();
  for (const id of ids) {
    if (models.has(id)) continue;
    const entry = pickEntry(id, index.get(id) ?? [], plugin);
    if (!entry && unknownOnly.has(id)) continue;
    const protocol = chooseProtocol(plugin, id, entry);
    if (!protocol) continue;
    const compat = compatFor(id, plugin);
    const spec = lookupPiCatalogModel(id, catalog);
    models.set(id, {
      id,
      name: id,
      api: protocol.api,
      baseUrl: protocol.baseUrl,
      reasoning: reasoningFor(id, plugin),
      input: plugin.modelDefaults?.input ?? ["text"],
      cost: costFor(entry),
      contextWindow: spec?.contextWindow ?? contextWindowFor(id, entry, plugin),
      maxTokens: spec?.maxTokens ?? maxTokensFor(id, plugin),
      ...(spec?.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap as never } : {}),
      ...(compat ? { compat: compat as never } : {}),
    });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function discoverProviderModels(plugin: ProviderPlugin, apiKey: string | undefined, signal: AbortSignal | undefined, fetchImpl: typeof fetch = fetch): Promise<ProviderModelConfig[]> {
  const [metadata, catalog] = await Promise.all([
    fetchMetadata(plugin, fetchImpl, signal).catch(() => undefined),
    fetchPiCatalog(fetchImpl, signal).catch(() => undefined),
  ]);
  const ids = await fetchModelIds(plugin, apiKey, fetchImpl, signal, metadata);
  if (ids.length === 0) throw new Error("Provider returned no chat models");
  return buildProviderModels(plugin, ids, metadata, catalog);
}

export function createProviderPluginsExtension(): ExtensionFactory {
  return async (pi) => {
    const catalog = await loadProviderPlugins();
    const instanceState = await loadProviderInstances();
    const plugins = new Map(catalog.plugins.map((plugin) => [plugin.id, plugin]));
    for (const instance of instanceState.state.instances) {
      const plugin = plugins.get(instance.plugin);
      if (!plugin) continue;
      pi.registerProvider(instance.id, createProviderPluginConfig(plugin, instance, { signature: providerPluginSignature(plugin, instance), models: [] }));
    }
  };
}
