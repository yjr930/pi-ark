import { sessionEntryToContextMessages, type SessionManager } from "@earendil-works/pi-coding-agent";
import { compactionStats, compactionTimings } from "./compaction-stats.js";

export const MAX_SESSION_MESSAGES = 10_000_000;
const MESSAGE_ID_SPACE = 0x80000000;
const MESSAGE_ID_MASK = MESSAGE_ID_SPACE - 1;
const MESSAGE_ID_MULTIPLIER_MASK = 0x3ffffffe;
const MESSAGE_ID_MULTIPLIER_HIGH_BIT = 0x40000001;
const MESSAGE_ID_WIDTH = 6;

function hashMessageIdSeed(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

export function sessionMessageId(sessionId: string, entryIndex: number): string {
  if (!Number.isInteger(entryIndex) || entryIndex < 0 || entryIndex >= MAX_SESSION_MESSAGES) throw Object.assign(new Error(`Session message limit is ${MAX_SESSION_MESSAGES}`), { statusCode: 409 });
  const multiplier = (hashMessageIdSeed(sessionId, 2166136261) & MESSAGE_ID_MULTIPLIER_MASK) | MESSAGE_ID_MULTIPLIER_HIGH_BIT;
  const offset = hashMessageIdSeed(sessionId, 2246822519) & MESSAGE_ID_MASK;
  const value = (Math.imul(multiplier, entryIndex) + offset) & MESSAGE_ID_MASK;
  return `m${value.toString(36).padStart(MESSAGE_ID_WIDTH, "0")}`;
}

export function buildSessionDisplayMessages(manager: SessionManager, getContextWindow: (provider: string, model: string) => number | undefined = () => undefined, leafEntryId?: string) {
  const entries = manager.getEntries();
  if (entries.length > MAX_SESSION_MESSAGES) throw Object.assign(new Error(`Session message limit is ${MAX_SESSION_MESSAGES}`), { statusCode: 409 });
  const entryIndexById = new Map(entries.map((entry, index) => [entry.id, index]));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (leafEntryId && !manager.getEntry(leafEntryId)) throw Object.assign(new Error("Unknown Session branch entry"), { statusCode: 404 });
  const branch = manager.getBranch(leafEntryId);
  const timings = compactionTimings(branch);
  return branch.flatMap((entry) => sessionEntryToContextMessages(entry).filter((message) => message.role !== "system" && !(message.role === "custom" && !message.display)).map((message) => ({
    ...message,
    entryId: entry.id,
    messageId: sessionMessageId(manager.getSessionId(), entryIndexById.get(entry.id)!),
    ...(message.role === "assistant" ? { contextWindow: getContextWindow(message.provider, message.model) } : {}),
    ...(entry.type === "compaction" && message.role === "compactionSummary" ? { compaction: compactionStats(entries, entry, byId, timings.get(entry.id)) } : {}),
  })));
}

export function resolveDisplayMessageIndex(messages: ReturnType<typeof buildSessionDisplayMessages>, target: string | undefined): number {
  if (!target) return -1;
  const index = messages.findIndex((message) => message.messageId === target);
  if (index >= 0 || !/^[1-9]\d*$/.test(target)) return index;
  const legacyIndex = Number(target) - 1;
  return Number.isSafeInteger(legacyIndex) && legacyIndex < messages.length ? legacyIndex : -1;
}
