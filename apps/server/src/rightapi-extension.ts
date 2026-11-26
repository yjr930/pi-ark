import type { ExtensionAPI, ExtensionFactory, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const RIGHTAPI_PROVIDER_ID = "rightcode";
export const RIGHTAPI_PROVIDER_NAME = "Right Code";
export const RIGHTAPI_ORIGIN = "https://rightapi.io";

export function rightApiOrigin(): string {
  const configured = process.env.PI_ARK_RIGHTAPI_ORIGIN?.trim();
  return configured ? configured.replace(/\/+$/, "") : RIGHTAPI_ORIGIN;
}
export const RIGHTAPI_EXTENSION_PATH = "builtin:rightcode";
export const RIGHTAPI_EXTENSION_DESCRIPTION = "Registers the Right Code relay at rightapi.io and discovers its chat models with the saved API key.";

type RightApiProtocol = "responses" | "messages" | "completions" | "gemini";

interface RightApiPriceConfig {
  input_price?: unknown;
  output_price?: unknown;
  cache_read_input_price?: unknown;
  cache_creation_input_price?: unknown;
}

interface RightApiPublicModel {
  name?: unknown;
  is_available?: unknown;
  tiers?: unknown;
  base_price_config?: RightApiPriceConfig;
  effective_price_config?: RightApiPriceConfig;
}

interface RightApiPublicUpstream {
  name?: unknown;
  modality?: unknown;
  supported_protocols?: unknown;
  default_protocol?: unknown;
  models?: unknown;
}

interface RightApiPublicCatalog {
  upstreams?: unknown;
}

interface PublicModelEntry {
  model: RightApiPublicModel;
  upstream: RightApiPublicUpstream;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProtocol(value: unknown): value is RightApiProtocol {
  return value === "responses" || value === "messages" || value === "completions" || value === "gemini";
}

function modelIdsFromPayload(payload: unknown): string[] {
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

function publicChatModelNames(catalog: RightApiPublicCatalog | undefined): string[] {
  if (!catalog || !Array.isArray(catalog.upstreams)) return [];
  const names = new Set<string>();
  for (const upstream of catalog.upstreams) {
    if (!isRecord(upstream) || upstream.modality !== "chat" || !Array.isArray(upstream.models)) continue;
    for (const model of upstream.models) {
      if (!isRecord(model) || typeof model.name !== "string" || !model.name.trim()) continue;
      if (model.is_available === false) continue;
      names.add(model.name.trim());
    }
  }
  return [...names];
}

function publicImageOnlyModelNames(catalog: RightApiPublicCatalog | undefined): Set<string> {
  const chat = new Set<string>();
  const image = new Set<string>();
  if (!catalog || !Array.isArray(catalog.upstreams)) return new Set();
  for (const upstream of catalog.upstreams) {
    if (!isRecord(upstream) || !Array.isArray(upstream.models)) continue;
    for (const model of upstream.models) {
      if (!isRecord(model) || typeof model.name !== "string" || !model.name.trim()) continue;
      if (upstream.modality === "chat") chat.add(model.name.trim());
      else if (upstream.modality === "image") image.add(model.name.trim());
    }
  }
  return new Set([...image].filter((name) => !chat.has(name)));
}

function publicModelIndex(catalog: RightApiPublicCatalog | undefined): Map<string, PublicModelEntry[]> {
  const index = new Map<string, PublicModelEntry[]>();
  if (!catalog || !Array.isArray(catalog.upstreams)) return index;
  for (const upstream of catalog.upstreams) {
    if (!isRecord(upstream) || upstream.modality !== "chat" || !Array.isArray(upstream.models)) continue;
    const supported = Array.isArray(upstream.supported_protocols) ? upstream.supported_protocols.filter((protocol): protocol is string => typeof protocol === "string") : [];
    const normalizedUpstream: RightApiPublicUpstream = { ...upstream, supported_protocols: supported };
    for (const model of upstream.models) {
      if (!isRecord(model) || typeof model.name !== "string" || !model.name.trim()) continue;
      if (model.is_available === false) continue;
      const entries = index.get(model.name.trim()) ?? [];
      entries.push({ model: model as RightApiPublicModel, upstream: normalizedUpstream });
      index.set(model.name.trim(), entries);
    }
  }
  return index;
}

function preferredProtocol(id: string): RightApiProtocol {
  const name = id.toLowerCase();
  if (name.startsWith("claude")) return "messages";
  if (name.startsWith("gpt") || name.startsWith("codex") || /^o[0-9]/.test(name)) return "responses";
  if (name.startsWith("gemini")) return "gemini";
  if (name.startsWith("grok")) return "responses";
  if (/^(deepseek|glm|kimi|minimax)/.test(name)) return "messages";
  return "completions";
}

function chooseProtocol(id: string, upstream: RightApiPublicUpstream | undefined): RightApiProtocol | undefined {
  const supported = Array.isArray(upstream?.supported_protocols) ? upstream.supported_protocols.filter((protocol): protocol is string => typeof protocol === "string") : [];
  const known = supported.filter(isProtocol);
  if (supported.length > 0 && known.length === 0) return undefined;
  const preferred = preferredProtocol(id);
  const fallback = upstream?.default_protocol;
  const candidates: RightApiProtocol[] = [preferred, ...(isProtocol(fallback) ? [fallback] : []), "responses", "messages", "completions", "gemini"];
  return candidates.find((candidate) => known.length === 0 || known.includes(candidate));
}

function protocolConfig(protocol: RightApiProtocol): { api: "openai-responses" | "anthropic-messages" | "google-generative-ai" | "openai-completions"; baseUrl: string } {
  switch (protocol) {
    case "responses": return { api: "openai-responses", baseUrl: `${rightApiOrigin()}/v1` };
    case "messages": return { api: "anthropic-messages", baseUrl: rightApiOrigin() };
    case "gemini": return { api: "google-generative-ai", baseUrl: `${rightApiOrigin()}/v1beta` };
    case "completions": return { api: "openai-completions", baseUrl: `${rightApiOrigin()}/v1` };
  }
}

function contextWindowFor(model: RightApiPublicModel | undefined, id: string): number {
  const tiers = Array.isArray(model?.tiers) ? model.tiers : [];
  const lengths = tiers
    .map((tier) => isRecord(tier) && typeof tier.max_context_length === "number" ? tier.max_context_length : undefined)
    .filter((length): length is number => length !== undefined && length > 0);
  const raw = lengths.length > 0 ? Math.max(...lengths) : 0;
  if (raw >= 1000) return raw;
  if (raw > 0) return raw * 1000;
  const name = id.toLowerCase();
  if (name.startsWith("gpt") || name.startsWith("codex")) return 272000;
  if (name.startsWith("claude") || name.startsWith("gemini") || name.startsWith("grok")) return 200000;
  return 128000;
}

function maxTokensFor(id: string): number {
  const name = id.toLowerCase();
  if (name.startsWith("gemini")) return 65536;
  if (name.startsWith("claude") || name.startsWith("gpt") || name.startsWith("codex") || name.startsWith("grok")) return 32000;
  return 16384;
}

function supportsReasoning(id: string): boolean {
  const name = id.toLowerCase();
  return name.startsWith("claude") || name.startsWith("gpt") || name.startsWith("codex") || name.startsWith("gemini") || name.startsWith("grok");
}

function priceNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function costFor(model: RightApiPublicModel | undefined): ProviderModelConfig["cost"] {
  const config = model?.effective_price_config ?? model?.base_price_config;
  return {
    input: priceNumber(config?.input_price),
    output: priceNumber(config?.output_price),
    cacheRead: priceNumber(config?.cache_read_input_price),
    cacheWrite: priceNumber(config?.cache_creation_input_price),
  };
}

function pickEntry(id: string, entries: PublicModelEntry[]): PublicModelEntry | undefined {
  const preferred = preferredProtocol(id);
  return entries.find((entry) => Array.isArray(entry.upstream.supported_protocols) && entry.upstream.supported_protocols.includes(preferred)) ?? entries[0];
}

export function buildRightApiModels(ids: string[], catalog: RightApiPublicCatalog | undefined): ProviderModelConfig[] {
  const index = publicModelIndex(catalog);
  const imageOnly = publicImageOnlyModelNames(catalog);
  const models = new Map<string, ProviderModelConfig>();
  for (const id of ids) {
    if (models.has(id)) continue;
    const entry = pickEntry(id, index.get(id) ?? []);
    if (!entry && imageOnly.has(id)) continue;
    const protocol = chooseProtocol(id, entry?.upstream);
    if (!protocol) continue;
    const { api, baseUrl } = protocolConfig(protocol);
    models.set(id, {
      id,
      name: id,
      api,
      baseUrl,
      reasoning: supportsReasoning(id),
      input: ["text"],
      cost: costFor(entry?.model),
      contextWindow: contextWindowFor(entry?.model, id),
      maxTokens: maxTokensFor(id),
    });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchPublicCatalog(fetchImpl: typeof fetch, signal: AbortSignal | undefined): Promise<RightApiPublicCatalog | undefined> {
  const response = await fetchImpl(`${rightApiOrigin()}/models/public`, { headers: { accept: "application/json" }, signal });
  if (!response.ok) return undefined;
  const payload: unknown = await response.json();
  return isRecord(payload) ? payload as RightApiPublicCatalog : undefined;
}

async function requestModelIds(apiKey: string, header: "authorization" | "x-api-key" | "x-goog-api-key", fetchImpl: typeof fetch, signal: AbortSignal | undefined): Promise<{ ids: string[]; status: number }> {
  const headers: Record<string, string> = { accept: "application/json" };
  headers[header] = header === "authorization" ? `Bearer ${apiKey}` : apiKey;
  const response = await fetchImpl(`${rightApiOrigin()}/v1/models`, { headers, signal });
  if (!response.ok) return { ids: [], status: response.status };
  const payload: unknown = await response.json();
  return { ids: modelIdsFromPayload(payload), status: response.status };
}

async function fetchRightApiModelIds(apiKey: string, fetchImpl: typeof fetch, signal: AbortSignal | undefined, catalog: RightApiPublicCatalog | undefined): Promise<string[]> {
  let lastAuthStatus = 0;
  for (const header of ["authorization", "x-api-key", "x-goog-api-key"] as const) {
    const result = await requestModelIds(apiKey, header, fetchImpl, signal);
    if (result.ids.length > 0) return result.ids;
    if (result.status === 401 || result.status === 403) { lastAuthStatus = result.status; continue; }
    break;
  }
  if (lastAuthStatus) throw new Error(`Right Code rejected the API key (${lastAuthStatus})`);
  return publicChatModelNames(catalog);
}

export async function fetchRightApiModels(apiKey: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ProviderModelConfig[]> {
  const catalog = await fetchPublicCatalog(fetchImpl, signal).catch(() => undefined);
  const ids = await fetchRightApiModelIds(apiKey, fetchImpl, signal, catalog);
  if (ids.length === 0) throw new Error("Right Code returned no chat models");
  return buildRightApiModels(ids, catalog);
}

let rightApiModelCache: ProviderModelConfig[] = [];

export function createRightApiExtension(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerProvider(RIGHTAPI_PROVIDER_ID, {
      name: RIGHTAPI_PROVIDER_NAME,
      baseUrl: `${rightApiOrigin()}/v1`,
      api: "openai-completions",
      models: [],
      async refreshModels({ credential, signal, allowNetwork }) {
        if (!allowNetwork) return rightApiModelCache;
        const apiKey = credential?.type === "api_key" ? credential.key : credential?.type === "oauth" ? credential.access : undefined;
        if (!apiKey) throw new Error("Right Code API key is required");
        rightApiModelCache = await fetchRightApiModels(apiKey, signal);
        return rightApiModelCache;
      },
    });
  };
}
