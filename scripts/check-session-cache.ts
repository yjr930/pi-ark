import assert from "node:assert/strict";
import { cacheResolvedFileLinks, cacheSessionList, cacheSessionSnapshot, cacheSessionUiState, clearSessionCache, deleteCachedSessionSnapshot, formatCacheSize, getCachedSessionList, getCachedSessionSnapshot, getCachedSessionUiState, getSessionCacheSummary, readPersistedFileLinks, SESSION_CACHE_LIMIT, SESSION_LIST_CACHE_LIMIT } from "../apps/web/src/session-cache.ts";
import type { AgentSnapshot, SessionInfo } from "../apps/web/src/types.ts";

function snapshot(id: string): AgentSnapshot {
  return {
    id,
    messages: [{ role: "user", content: id }],
    messageNumberOffset: 0,
    totalDisplayMessages: 1,
    hasEarlierMessages: false,
    isStreaming: false,
    isIdle: true,
    model: null,
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    queue: [],
    queueRevision: 0,
    stats: { userMessages: 1, assistantMessages: 0, toolCalls: 0, totalMessages: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
  };
}

function sessionInfo(id: string): SessionInfo {
  return { id, cwd: "/workspace", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, firstMessage: id, pinned: false, archived: false, groups: [] };
}

for (let index = 0; index < SESSION_CACHE_LIMIT; index += 1) cacheSessionSnapshot(`workspace:session-${index}`, snapshot(`session-${index}`));
assert.equal(getCachedSessionSnapshot("workspace:session-0")?.id, "session-0");
cacheSessionSnapshot("workspace:session-new", snapshot("session-new"));
assert.equal(getCachedSessionSnapshot("workspace:session-1"), undefined);
assert.equal(getCachedSessionSnapshot("workspace:session-0")?.id, "session-0");
assert.equal(getCachedSessionSnapshot("workspace:session-new")?.id, "session-new");
deleteCachedSessionSnapshot("workspace:session-new");
assert.equal(getCachedSessionSnapshot("workspace:session-new"), undefined);

for (let index = 0; index < SESSION_CACHE_LIMIT; index += 1) cacheSessionUiState(`workspace:ui-${index}`, { draft: `draft-${index}`, attachments: [], disclosures: { [`tool-${index}`]: true } });
assert.equal(getCachedSessionUiState("workspace:ui-0")?.draft, "draft-0");
cacheSessionUiState("workspace:ui-new", { draft: "new draft", attachments: [], disclosures: { "run-new": false } });
assert.equal(getCachedSessionUiState("workspace:ui-1"), undefined);
assert.deepEqual(getCachedSessionUiState("workspace:ui-0")?.disclosures, { "tool-0": true });
deleteCachedSessionSnapshot("workspace:ui-new");
assert.equal(getCachedSessionUiState("workspace:ui-new"), undefined);

for (let index = 0; index < SESSION_LIST_CACHE_LIMIT; index += 1) cacheSessionList(`workspace-${index}`, [sessionInfo(`session-${index}`)]);
assert.equal(getCachedSessionList("workspace-0")?.[0].id, "session-0");
cacheSessionList("workspace-new", [sessionInfo("session-new")]);
assert.equal(getCachedSessionList("workspace-1"), undefined);
assert.equal(getCachedSessionList("workspace-0")?.[0].id, "session-0");
assert.equal(getCachedSessionList("workspace-new")?.[0].id, "session-new");

const summaryBeforeLinks = getSessionCacheSummary();
assert.equal(summaryBeforeLinks.persistent, false);
assert.equal(summaryBeforeLinks.entries, (SESSION_CACHE_LIMIT - 1) * 2 + SESSION_LIST_CACHE_LIMIT);
assert.ok(summaryBeforeLinks.bytes > 0);
cacheResolvedFileLinks([{ workspaceId: "workspace", basePath: "", input: "README.md", path: "README.md", type: "file", resolvedAt: 0 }]);
assert.deepEqual(await readPersistedFileLinks(), [], "Saved file links need IndexedDB");
const summaryAfterLinks = getSessionCacheSummary();
assert.equal(summaryAfterLinks.entries, summaryBeforeLinks.entries + 1);
assert.ok(summaryAfterLinks.bytes > summaryBeforeLinks.bytes);

assert.equal(formatCacheSize(0), "0 KB");
assert.equal(formatCacheSize(512), "512 B");
assert.equal(formatCacheSize(1536), "1.5 KB");
assert.equal(formatCacheSize(12.4 * 1024 * 1024), "12.4 MB");
assert.equal(formatCacheSize(3 * 1024 * 1024 * 1024), "3 GB");

await clearSessionCache();
assert.deepEqual(getSessionCacheSummary(), { bytes: 0, entries: 0, persistent: false });
console.log("session cache checks passed");
