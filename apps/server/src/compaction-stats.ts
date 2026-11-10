import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { buildSessionProjection, estimateTokens, type CompactionEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const COMPACTION_TIMING_TYPE = "pi-ark.compaction-timing";
export interface CompactionTiming { compactionEntryId: string; durationMs: number; reason: "manual" | "threshold" | "overflow" }
export interface CompactionStats {
  tokensAfter: number;
  systemPromptTokens?: number;
  summaryTokens: number;
  retainedTokens: number;
  durationMs?: number;
  reason?: CompactionTiming["reason"];
  summarizerInputTokens?: number;
  summarizerOutputTokens?: number;
}

export function compactionTimings(branch: SessionEntry[]): Map<string, CompactionTiming> {
  const timings = new Map<string, CompactionTiming>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== COMPACTION_TIMING_TYPE || !entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as Partial<CompactionTiming>;
    if (typeof data.compactionEntryId !== "string" || typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs) || data.durationMs < 0 || !["manual", "threshold", "overflow"].includes(data.reason || "")) continue;
    timings.set(data.compactionEntryId, data as CompactionTiming);
  }
  return timings;
}

export function compactionStats(entries: SessionEntry[], entry: CompactionEntry, byId: Map<string, SessionEntry>, timing?: CompactionTiming): CompactionStats {
  const projection = buildSessionProjection(entries, entry.id, byId);
  const system = getCurrentSystemMessage(projection.messages);
  const systemPromptTokens = system ? estimateTokens(system) : undefined;
  const summary = projection.messages.find((message) => message.role === "compactionSummary");
  const summaryTokens = summary ? estimateTokens(summary) : Math.ceil(entry.summary.length / 4);
  const retainedTokens = projection.messages.filter((message) => message.role !== "system" && message !== summary).reduce((total, message) => total + estimateTokens(message), 0);
  return {
    tokensAfter: (systemPromptTokens || 0) + summaryTokens + retainedTokens,
    ...(systemPromptTokens !== undefined ? { systemPromptTokens } : {}),
    summaryTokens,
    retainedTokens,
    ...(timing ? { durationMs: timing.durationMs, reason: timing.reason } : {}),
    ...(entry.usage ? { summarizerInputTokens: entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite, summarizerOutputTokens: entry.usage.output } : {}),
  };
}
