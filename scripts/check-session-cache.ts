import assert from "node:assert/strict";
import { cacheResolvedFileLinks, cacheSessionSnapshot, cacheSessionUiState, clearSessionCache, deleteCachedSessionSnapshot, getCachedSessionSnapshot, getCachedSessionUiState, getSessionCacheSummary, readPersistedFileLinks, SESSION_CACHE_LIMIT } from "../apps/web/src/session-cache.ts";
import type { AgentSnapshot } from "../apps/web/src/types.ts";

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
const summaryBeforeClear = getSessionCacheSummary();
assert.equal(summaryBeforeClear.persistent, false);
assert.ok(summaryBeforeClear.snapshots > 0 && summaryBeforeClear.uiStates > 0);
cacheResolvedFileLinks([{ workspaceId: "workspace", basePath: "", input: "README.md", path: "README.md", type: "file", resolvedAt: 0 }]);
assert.deepEqual(await readPersistedFileLinks(), [], "Saved file links need IndexedDB");
assert.deepEqual(getSessionCacheSummary(), summaryBeforeClear);
await clearSessionCache();
assert.deepEqual(getSessionCacheSummary(), { snapshots: 0, uiStates: 0, persistent: false });
console.log("session cache checks passed");
