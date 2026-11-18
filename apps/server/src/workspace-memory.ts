import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parsePiArkLink, validLeafEntryId } from "./internal-links.js";
import { effectiveMemorySettings, MEMORY_SETTING_KEYS, normalizeMemoryDefaults, validateLegacyMemorySettings, validateMemorySettingsPatch, type MemorySettings, type MemorySettingsPatch, type WorkspaceMemorySettings } from "./memory-settings.js";

export type { MemorySettings, WorkspaceMemorySettings } from "./memory-settings.js";

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryStatus = "active" | "review" | "archived";
export type MemoryMessageSource = { kind: "message"; link: string; entryId: string; sessionId: string };
export type MemorySource = MemoryMessageSource | { kind: "manual" | "notebook" } | { kind: "external"; url: string };
export interface MemoryDraft {
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  pinned: boolean;
  reviewAfter?: string | null;
  sourceUrl?: string | null;
  fromNotebook?: boolean;
}
export interface MemoryEntry extends Pick<MemoryDraft, "type" | "title" | "summary" | "body" | "tags" | "pinned"> {
  id: string;
  revision: number;
  source: MemorySource;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  reviewAfter?: string;
  changeReason?: string;
}
export interface MemoryProposal {
  id: string;
  draft: MemoryDraft;
  source: MemoryMessageSource;
  status: "pending" | "confirmed" | "dismissed";
  createdAt: string;
  entryId?: string;
}
export type MemoryMetadata = Pick<MemoryEntry, "id" | "type" | "title" | "summary" | "tags" | "status" | "reviewAfter">;
export interface MemorySnapshot {
  enabled: boolean;
  autoIndex: boolean;
  entries: MemoryEntry[];
  proposals: MemoryProposal[];
}

type StoredProposal = MemoryProposal & { callId?: string };
type Store = { overrides: Partial<MemorySettings>; entries: MemoryEntry[]; proposals: StoredProposal[] };
type Mutation<T> = { value: T; unchanged?: boolean };

const MAX_BODY_BYTES = 8 * 1024;
const DIRECTORY_BYTES = 2 * 1024;
const PROJECT_REVIEW_MS = 90 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const writes = new Map<string, Promise<void>>();
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

function error(statusCode: number, message: string, cause?: unknown) {
  return Object.assign(new Error(message, { cause }), { statusCode });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error(400, "Expected a Memory object");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, limit: number, multiline = false): string {
  if (typeof value !== "string" || value.length > limit || (!multiline && /[\p{Cc}\u2028\u2029]/u.test(value)) || value.includes("\0")) {
    throw error(400, `Invalid Memory ${field} (maximum ${limit} characters)`);
  }
  return value.trim();
}
function requiredText(value: unknown, field: string, limit: number): string {
  const result = text(value, field, limit);
  if (!result) throw error(400, `Memory ${field} is required`);
  return result;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw error(400, "Invalid Memory revision");
  return value;
}
function status(value: unknown): MemoryStatus {
  if (value !== "active" && value !== "review" && value !== "archived") throw error(400, "Invalid Memory status");
  return value;
}
function isoDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw error(400, "Invalid Memory review date (expected an ISO date or timestamp)");
  }
  const day = value.slice(0, 10);
  const calendar = new Date(day);
  const time = new Date(value);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day || !Number.isFinite(time.getTime())) {
    throw error(400, "Invalid Memory review date");
  }
  const timestamp = time.toISOString();
  if (!/^\d{4}-/.test(timestamp)) throw error(400, "Invalid Memory review date");
  return timestamp;
}
function externalUrl(value: unknown): string {
  const input = requiredText(value, "source URL", 2048);
  try {
    if (!/^https?:\/\/[^/\\\s]/i.test(input) || /[\s\\<>]/u.test(input)) throw new Error();
    const url = new URL(input);
    if (!url.hostname || url.username || url.password || url.href.length > 2048) throw new Error();
    return url.href;
  } catch {
    throw error(400, "Memory source URL must be an HTTP(S) URL without credentials");
  }
}
function messageSource(value: unknown): MemoryMessageSource {
  const { kind, link, entryId, sessionId } = object(value);
  if (kind !== "message" || typeof entryId !== "string" || !validLeafEntryId(entryId)) throw error(400, "Invalid Memory message source");
  const cleanLink = requiredText(link, "message source link", 2048);
  const target = parsePiArkLink(cleanLink);
  if (/[\s<>]/u.test(cleanLink) || typeof sessionId !== "string" || target?.sessionId !== sessionId || !target.messageId || !target.leafEntryId) {
    throw error(400, "Memory source must be a message link pinned to its session branch");
  }
  return { kind, link: cleanLink, entryId, sessionId };
}
function source(value: unknown): MemorySource {
  const input = object(value);
  if (input.kind === "message") return messageSource(input);
  if (input.kind === "external") return { kind: "external", url: externalUrl(input.url) };
  if (input.kind === "manual" || input.kind === "notebook") return { kind: input.kind };
  throw error(400, "Invalid Memory source");
}
function draft(value: unknown): MemoryDraft {
  const input = object(value);
  const { type, pinned, tags, body, reviewAfter, sourceUrl, fromNotebook } = input;
  if (type !== "user" && type !== "feedback" && type !== "project" && type !== "reference") throw error(400, "Invalid Memory type");
  if (typeof pinned !== "boolean" || (fromNotebook !== undefined && typeof fromNotebook !== "boolean")) throw error(400, "Invalid Memory draft flags");
  if (!Array.isArray(tags) || tags.length > 12) throw error(400, "Memory tags must be a list of up to 12 tags");
  if (typeof body !== "string" || !body.trim() || body.includes("\0")) throw error(400, "Memory body must be nonempty text");
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw error(413, "Memory body exceeds 8 KiB of UTF-8 text");
  return {
    type, pinned, body,
    title: requiredText(input.title, "title", 160),
    summary: requiredText(input.summary, "summary", 360),
    tags: [...new Set(tags.map((tag) => requiredText(tag, "tag", 40)))],
    ...(reviewAfter !== undefined ? { reviewAfter: reviewAfter === null ? null : isoDate(reviewAfter) } : {}),
    ...(sourceUrl !== undefined ? { sourceUrl: sourceUrl === null ? null : externalUrl(sourceUrl) } : {}),
    ...(fromNotebook !== undefined ? { fromNotebook } : {}),
  };
}
function draftSource(value: MemoryDraft, previous: MemorySource = { kind: "manual" }): MemorySource {
  if (value.sourceUrl) return { kind: "external", url: value.sourceUrl };
  if (value.fromNotebook) return { kind: "notebook" };
  return value.sourceUrl === null && previous.kind === "external" ? { kind: "manual" } : previous;
}
function content({ type, title, summary, body, tags, pinned }: MemoryDraft) {
  return { type, title, summary, body, tags, pinned };
}
function freshEntry(value: MemoryDraft, origin: MemorySource, now: Date, previous?: MemoryEntry, reason?: string): MemoryEntry {
  const timestamp = now.toISOString();
  const reviewAfter = value.reviewAfter === undefined && value.type === "project" ? projectDeadline(now) : value.reviewAfter ?? undefined;
  return {
    ...content(value), id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1,
    source: origin, status: "active", createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, verifiedAt: timestamp,
    ...(reviewAfter ? { reviewAfter } : {}), ...(reason ? { changeReason: reason } : {}),
  };
}
function projectDeadline(now: Date): string {
  return new Date(now.getTime() + PROJECT_REVIEW_MS).toISOString();
}
function effectiveEntry(entry: MemoryEntry, now: Date): MemoryEntry {
  return entry.status === "active" && entry.reviewAfter && Date.parse(entry.reviewAfter) <= now.getTime()
    ? { ...entry, status: "review" } : entry;
}
function entryIndex(data: Store, id: string): number {
  const index = data.entries.findIndex((entry) => entry.id === id);
  if (index < 0) throw error(404, "Memory entry not found");
  return index;
}
function checkRevision(entry: MemoryEntry, expected: number): void {
  if (entry.revision !== expected) throw error(409, "Memory entry has changed; reload and try again");
}
function getStoredProposal(data: Store, id: string): StoredProposal {
  const proposal = data.proposals.find((item) => item.id === id);
  if (!proposal) throw error(404, "Memory proposal not found");
  return proposal;
}
function publicProposal({ callId: _callId, ...proposal }: StoredProposal): MemoryProposal {
  return proposal;
}
function requireEnabled({ enabled }: MemorySettings): void {
  if (!enabled) throw error(409, "Workspace Memory is disabled");
}
function emptyStore(): Store {
  return { overrides: {}, entries: [], proposals: [] };
}
function workspaceSettings(defaults: MemorySettings, overrides: Partial<MemorySettings>): WorkspaceMemorySettings {
  return { defaults, overrides, effective: effectiveMemorySettings(defaults, overrides) };
}
function applySettingsPatch(overrides: Partial<MemorySettings>, patch: MemorySettingsPatch): boolean {
  let changed = false;
  for (const key of MEMORY_SETTING_KEYS) {
    const value = patch[key];
    if (value === undefined || (value === null ? !Object.hasOwn(overrides, key) : overrides[key] === value)) continue;
    if (value === null) delete overrides[key];
    else overrides[key] = value;
    changed = true;
  }
  return changed;
}
function asSnapshot(data: Store, now: Date, { enabled, autoIndex }: MemorySettings): MemorySnapshot {
  return {
    enabled, autoIndex,
    entries: data.entries.map((entry) => effectiveEntry(entry, now)),
    proposals: data.proposals.filter((proposal) => proposal.status === "pending").map(publicProposal),
  };
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function decodeStore(input: unknown): Store {
  const data = object(input);
  const { version, enabled, autoIndex, entries, proposals } = data;
  if (version !== 1 || typeof enabled !== "boolean" || typeof autoIndex !== "boolean" || !Array.isArray(entries) || !Array.isArray(proposals)) {
    throw new Error("Invalid Memory store format");
  }
  // Even an empty overrides object is authoritative. A v1 file without it has two explicit flags.
  const overrides = Object.hasOwn(data, "overrides") ? validateMemorySettingsPatch(data.overrides) : { enabled, autoIndex };
  return { overrides, entries, proposals };
}
function validateStoreContent(data: Store): void {
  for (const raw of data.entries) {
    const entry = object(raw);
    if (typeof entry.id !== "string" || !UUID.test(entry.id)) throw new Error("Invalid Memory entry id");
    draft(entry);
    source(entry.source);
    revision(entry.revision);
    status(entry.status);
    isoDate(entry.createdAt);
    isoDate(entry.updatedAt);
    if (entry.verifiedAt !== undefined) isoDate(entry.verifiedAt);
    if (entry.reviewAfter !== undefined) isoDate(entry.reviewAfter);
    if (entry.changeReason !== undefined) text(entry.changeReason, "change reason", 500);
  }
  for (const raw of data.proposals) {
    const proposal = object(raw);
    if (typeof proposal.id !== "string" || !UUID.test(proposal.id) || (proposal.status !== "pending" && proposal.status !== "confirmed" && proposal.status !== "dismissed")) {
      throw new Error("Invalid Memory proposal record");
    }
    if (proposal.status === "confirmed" && (typeof proposal.entryId !== "string" || !UUID.test(proposal.entryId))) throw new Error("Invalid confirmed Memory entry id");
    draft(proposal.draft);
    messageSource(proposal.source);
    isoDate(proposal.createdAt);
    if (proposal.callId !== undefined) requiredText(proposal.callId, "tool call id", 512);
  }
}
async function load(path: string | undefined, validateContent = true): Promise<Store> {
  if (!path) return emptyStore();
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (cause) {
    if (isMissing(cause)) return emptyStore();
    throw error(500, "Could not read Workspace Memory", cause);
  }
  try {
    const data = decodeStore(JSON.parse(raw));
    if (validateContent) validateStoreContent(data);
    return data;
  } catch (cause) { throw error(500, "Workspace Memory data is invalid", cause); }
}
async function serial<T>(path: string, action: () => Promise<T>): Promise<T> {
  const task = (writes.get(path) ?? Promise.resolve()).then(action);
  const settled = task.then(() => undefined, () => undefined);
  writes.set(path, settled);
  try { return await task; }
  finally { if (writes.get(path) === settled) writes.delete(path); }
}

function normalize(value: string): string { return value.normalize("NFKC").toLowerCase(); }
function words(value: string): string[] {
  return [...segmenter.segment(value)].filter(({ isWordLike }) => isWordLike).map(({ segment }) => segment);
}
function keywords(query: string): string[] {
  return [...new Set(words(normalize(query.slice(0, 2048))))].slice(0, 48);
}
function score(entries: string[], terms: string[]): number {
  if (!terms.length) return 0;
  const normalized = entries.map(normalize);
  const tokens = new Set(normalized.flatMap(words));
  return terms.filter((term) => tokens.has(term) || (/\p{Script=Han}/u.test(term) && normalized.some((field) => field.includes(term)))).length;
}
function compareStable(a: MemoryEntry, b: MemoryEntry): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function ranked(data: Store, query: string, now: Date, includeReview: boolean) {
  const terms = keywords(query);
  return data.entries.map((entry) => effectiveEntry(entry, now))
    .filter((entry) => entry.status === "active" || (includeReview && entry.status === "review"))
    .map((entry) => ({
      entry, relevance: 4 * score([entry.title], terms) + 3 * score(entry.tags, terms) + score([entry.summary], terms),
    }));
}
function metadata({ id, type, title, summary, tags, status, reviewAfter }: MemoryEntry): MemoryMetadata {
  return { id, type, title, summary, tags, status, ...(status === "review" && reviewAfter ? { reviewAfter } : {}) };
}
function promptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>\p{Cc}\p{Cf}\u2028\u2029]/gu, (character) => character.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}
function shortPromptText(value: string, budget: number): string {
  if (Buffer.byteLength(promptJson(value)) - 2 <= budget) return value;
  let result = "";
  let used = Buffer.byteLength("…");
  for (const character of value) {
    used += Buffer.byteLength(promptJson(character)) - 2;
    if (used > budget) break;
    result += character;
  }
  return `${result}…`;
}
function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|<>]/g, "\\$&");
}

export class WorkspaceMemory {
  private readonly root: string;

  constructor(
    directory: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly loadDefaults: () => MemorySettings | Promise<MemorySettings> = normalizeMemoryDefaults,
  ) {
    this.root = resolve(directory);
  }

  private path(storeId: string | undefined): string | undefined {
    if (storeId === undefined) return undefined;
    if (typeof storeId !== "string" || !UUID.test(storeId)) throw error(400, "Invalid Workspace Memory store id");
    return join(this.root, `${storeId.toLowerCase()}.json`);
  }

  private async loadWithSettings(path: string | undefined, validateContent = true) {
    const data = await load(path, validateContent);
    const defaults = normalizeMemoryDefaults(await this.loadDefaults());
    return { data, settings: workspaceSettings(defaults, data.overrides) };
  }

  private async save(path: string, data: Store, defaults: MemorySettings): Promise<void> {
    const { enabled, autoIndex } = { ...defaults, ...data.overrides };
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const file = await open(temporary, "wx", 0o600);
      try {
        // Keep the resolved choices for v1 readers. Current readers use overrides and live defaults.
        try { await file.writeFile(`${JSON.stringify({ version: 1, enabled, autoIndex, ...data }, null, 2)}\n`, "utf8"); }
        finally { await file.close(); }
        await rename(temporary, path);
      } catch (cause) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw cause;
      }
    } catch (cause) { throw error(500, "Could not save Workspace Memory", cause); }
  }

  private async mutate<T>(storeId: string | undefined, edit: (data: Store, now: Date, settings: WorkspaceMemorySettings) => Mutation<T>): Promise<T> {
    const path = this.path(storeId);
    if (!path) throw error(409, "Workspace Memory has no store");
    return serial(path, async () => {
      const { data, settings } = await this.loadWithSettings(path);
      const result = edit(data, this.clock(), settings);
      if (!result.unchanged) await this.save(path, data, settings.defaults);
      return result.value;
    });
  }

  async snapshot(storeId: string | undefined): Promise<MemorySnapshot> {
    const { data, settings } = await this.loadWithSettings(this.path(storeId));
    return asSnapshot(data, this.clock(), settings.effective);
  }

  async getSettings(storeId: string | undefined): Promise<WorkspaceMemorySettings> {
    return (await this.loadWithSettings(this.path(storeId), false)).settings;
  }

  async isEnabled(storeId: string | undefined): Promise<boolean> {
    return (await this.getSettings(storeId)).effective.enabled;
  }

  async patchSettings(storeId: string | undefined, input: unknown): Promise<WorkspaceMemorySettings> {
    const patch = validateMemorySettingsPatch(input, true);
    const values = Object.values(patch);
    if (!values.length || (storeId === undefined && values.every((value) => value === null))) return this.getSettings(storeId);
    return this.mutate(storeId, (data, _now, { defaults }) => {
      const changed = applySettingsPatch(data.overrides, patch);
      return { value: workspaceSettings(defaults, data.overrides), unchanged: !changed };
    });
  }

  async setSettings(storeId: string | undefined, input: unknown): Promise<MemorySnapshot> {
    const patch = validateLegacyMemorySettings(input);
    if (storeId === undefined && !patch.enabled) {
      const current = await this.snapshot(undefined);
      if (!current.enabled) return current;
    }
    return this.mutate(storeId, (data, now, { defaults }) => {
      const changed = applySettingsPatch(data.overrides, patch);
      return { value: asSnapshot(data, now, effectiveMemorySettings(defaults, data.overrides)), unchanged: !changed };
    });
  }

  async create(storeId: string | undefined, input: unknown, origin?: MemorySource, ensureStore?: () => Promise<string>): Promise<MemoryEntry> {
    // Check inheritance and validate the draft before asking the registry to persist a store ID.
    if (storeId === undefined && ensureStore) requireEnabled((await this.getSettings(undefined)).effective);
    const value = draft(input);
    const entrySource = origin === undefined ? draftSource(value) : source(origin);
    return this.mutate(ensureStore ? await ensureStore() : storeId, (data, now, { effective }) => {
      requireEnabled(effective);
      const entry = freshEntry(value, entrySource, now);
      data.entries.push(entry);
      return { value: effectiveEntry(entry, now) };
    });
  }

  async update(storeId: string | undefined, entryId: string, input: unknown): Promise<MemoryEntry> {
    return this.mutate(storeId, (data, now) => {
      const body = object(input);
      const index = entryIndex(data, entryId);
      const previous = data.entries[index];
      checkRevision(previous, revision(body.revision));
      const value = draft(body);
      const { reverify } = body;
      if (reverify !== undefined && typeof reverify !== "boolean") throw error(400, "Invalid Memory reverify flag");
      const timestamp = now.toISOString();
      const verifiedAt = reverify ? timestamp : previous.verifiedAt;
      const changeReason = body.changeReason === undefined ? previous.changeReason : text(body.changeReason, "change reason", 500);
      let reviewAfter = value.reviewAfter === undefined ? previous.reviewAfter : value.reviewAfter ?? undefined;
      if (value.reviewAfter === undefined && value.type === "project" && (previous.type !== "project" || (reverify && previous.reviewAfter))) {
        reviewAfter = projectDeadline(new Date(verifiedAt ?? timestamp));
      }
      const nextStatus = body.status !== undefined ? status(body.status)
        : reverify && previous.status !== "archived" ? "active" : effectiveEntry(previous, now).status;
      const entry: MemoryEntry = {
        ...content(value), id: previous.id, revision: previous.revision + 1, source: draftSource(value, previous.source),
        status: nextStatus, createdAt: previous.createdAt, updatedAt: timestamp,
        ...(verifiedAt ? { verifiedAt } : {}), ...(reviewAfter ? { reviewAfter } : {}), ...(changeReason ? { changeReason } : {}),
      };
      data.entries[index] = entry;
      return { value: effectiveEntry(entry, now) };
    });
  }

  async remove(storeId: string | undefined, entryId: string, expected: unknown): Promise<void> {
    await this.mutate(storeId, (data) => {
      const index = entryIndex(data, entryId);
      checkRevision(data.entries[index], revision(expected));
      data.entries.splice(index, 1);
      return { value: undefined };
    });
  }

  async getProposal(storeId: string | undefined, proposalId: string): Promise<MemoryProposal> {
    return publicProposal(getStoredProposal(await load(this.path(storeId)), proposalId));
  }

  async propose(storeId: string | undefined, input: unknown, origin: MemoryMessageSource, callId?: string, ensureStore?: () => Promise<string>): Promise<MemoryProposal> {
    if (storeId === undefined) requireEnabled((await this.getSettings(undefined)).effective);
    const source = messageSource(origin);
    const key = callId === undefined ? undefined : requiredText(callId, "tool call id", 512);
    const value = draft(input);
    return this.mutate(ensureStore ? await ensureStore() : storeId, (data, now, { effective }) => {
      requireEnabled(effective);
      const existing = key && data.proposals.find((item) => item.callId === key && item.source.sessionId === source.sessionId && item.source.entryId === source.entryId);
      if (existing) return { value: publicProposal(existing), unchanged: true };
      const proposal: StoredProposal = {
        id: randomUUID(), status: "pending", createdAt: now.toISOString(), draft: value, source,
        ...(key ? { callId: key } : {}),
      };
      data.proposals.push(proposal);
      return { value: publicProposal(proposal) };
    });
  }

  async confirm(storeId: string | undefined, proposalId: string, input: unknown): Promise<MemoryProposal> {
    return this.mutate(storeId, (data, now, { effective }) => {
      const proposal = getStoredProposal(data, proposalId);
      if (proposal.status === "confirmed") return { value: publicProposal(proposal), unchanged: true };
      if (proposal.status === "dismissed") throw error(409, "Memory proposal was dismissed");
      requireEnabled(effective);
      const body = object(input);
      const value = draft(body.draft);
      const reason = body.reason === undefined ? undefined : text(body.reason, "change reason", 500);
      let index: number | undefined;
      if (body.target !== undefined) {
        const target = object(body.target);
        if (typeof target.id !== "string" || !target.id) throw error(400, "Invalid Memory target id");
        index = entryIndex(data, target.id);
        checkRevision(data.entries[index], revision(target.revision));
      }
      const entry = freshEntry(value, proposal.source, now, index === undefined ? undefined : data.entries[index], reason);
      if (index === undefined) data.entries.push(entry);
      else data.entries[index] = entry;
      Object.assign(proposal, { status: "confirmed", draft: value, entryId: entry.id });
      return { value: publicProposal(proposal) };
    });
  }

  async dismiss(storeId: string | undefined, proposalId: string): Promise<MemoryProposal> {
    return this.mutate(storeId, (data) => {
      const proposal = getStoredProposal(data, proposalId);
      if (proposal.status === "dismissed") return { value: publicProposal(proposal), unchanged: true };
      if (proposal.status === "confirmed") throw error(409, "Memory proposal was already confirmed");
      proposal.status = "dismissed";
      return { value: publicProposal(proposal) };
    });
  }

  async matches(storeId: string | undefined, proposalId: string): Promise<MemoryEntry[]> {
    const data = await load(this.path(storeId));
    const { draft: proposed } = getStoredProposal(data, proposalId);
    const terms = keywords(proposed.title);
    const now = this.clock();
    return data.entries.filter((entry) => entry.type === proposed.type)
      .map((entry) => ({ entry, relevance: normalize(entry.title) === normalize(proposed.title) ? terms.length + 1 : score([entry.title], terms) }))
      .filter(({ relevance }) => relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || compareStable(a.entry, b.entry))
      .slice(0, 5).map(({ entry }) => effectiveEntry(entry, now));
  }

  async recall(storeId: string | undefined, query: string): Promise<MemoryMetadata[]> {
    if (storeId === undefined) return [];
    const { data, settings } = await this.loadWithSettings(this.path(storeId));
    if (!settings.effective.enabled) return [];
    return ranked(data, query, this.clock(), settings.effective.reviewEntries).filter(({ relevance }) => relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || compareStable(a.entry, b.entry)).slice(0, 5).map(({ entry }) => metadata(entry));
  }

  async read(storeId: string | undefined, entryId: string): Promise<MemoryEntry> {
    const { data, settings } = await this.loadWithSettings(this.path(storeId));
    requireEnabled(settings.effective);
    const entry = effectiveEntry(data.entries[entryIndex(data, entryId)], this.clock());
    if (entry.status === "archived" || (entry.status === "review" && !settings.effective.reviewEntries)) throw error(404, "Memory entry is not available for recall");
    return entry;
  }

  async directory(storeId: string | undefined, query: string): Promise<string | undefined> {
    if (storeId === undefined) return undefined;
    const { data, settings } = await this.loadWithSettings(this.path(storeId));
    if (!settings.effective.autoIndex) return undefined;
    const selected = ranked(data, query, this.clock(), settings.effective.reviewEntries).filter(({ entry, relevance }) => entry.pinned || relevance > 0)
      .sort((a, b) => Number(b.entry.pinned) - Number(a.entry.pinned) || b.relevance - a.relevance || compareStable(a.entry, b.entry));
    const lines: string[] = [];
    let bytes = 2; // JSON array delimiters.
    for (const { entry: { id, type, title, summary, status, reviewAfter } } of selected.slice(0, 8)) {
      const line = promptJson({
        id, type, title: shortPromptText(title, 160), summary: shortPromptText(summary, 320), status,
        ...(status === "review" && reviewAfter ? { reviewAfter: reviewAfter.slice(0, 10) } : {}),
      });
      const next = Buffer.byteLength(line) + (lines.length ? 2 : 0);
      if (bytes + next > DIRECTORY_BYTES) break;
      lines.push(line);
      bytes += next;
    }
    return lines.length ? `[${lines.join(",\n")}]` : undefined;
  }

  async exportMarkdown(storeId: string | undefined): Promise<string> {
    const { entries } = await this.snapshot(storeId);
    const sections = entries.slice().sort(compareStable).map((entry) => {
      const origin = entry.source;
      const sourceLabel = origin.kind === "message" ? `<${origin.link}>` : origin.kind === "external" ? `<${origin.url}>` : origin.kind;
      return [
        `## ${escapeMarkdown(entry.title)}`, "", escapeMarkdown(entry.summary), "",
        `- ID: ${entry.id}`, `- Revision: ${entry.revision}`, `- Type: ${entry.type}`, `- Status: ${entry.status}`, `- Pinned: ${entry.pinned ? "yes" : "no"}`,
        `- Source: ${sourceLabel}`, `- Created: ${entry.createdAt}`, `- Updated: ${entry.updatedAt}`,
        ...(entry.verifiedAt ? [`- Verified: ${entry.verifiedAt}`] : []),
        ...(entry.reviewAfter ? [`- Review after: ${entry.reviewAfter}`] : []),
        ...(entry.tags.length ? [`- Tags: ${entry.tags.map(escapeMarkdown).join(", ")}`] : []),
        ...(entry.changeReason ? [`- Change reason: ${escapeMarkdown(entry.changeReason)}`] : []),
        "", entry.body,
      ].join("\n");
    });
    return ["# Workspace Memory", ...sections].join("\n\n") + "\n";
  }

  async purge(storeId: string | undefined): Promise<void> {
    const path = this.path(storeId);
    if (!path) return;
    return serial(path, async () => {
      try { await rm(path, { force: true }); }
      catch (cause) { throw error(500, "Could not purge Workspace Memory", cause); }
    });
  }

  async markSourceMissing(storeId: string | undefined, entryId: string, expected: number): Promise<MemoryEntry> {
    return this.mutate(storeId, (data, now) => {
      const index = entryIndex(data, entryId);
      const entry = data.entries[index];
      checkRevision(entry, revision(expected));
      if (entry.status !== "active") return { value: entry, unchanged: true };
      const updated: MemoryEntry = { ...entry, status: "review", revision: entry.revision + 1, updatedAt: now.toISOString() };
      data.entries[index] = updated;
      return { value: updated };
    });
  }
}
