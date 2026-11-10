import assert from "node:assert/strict";
import { cacheSessionSnapshot, deleteCachedSessionSnapshot, getCachedSessionSnapshot, SESSION_CACHE_LIMIT } from "../apps/web/src/session-cache.ts";
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
console.log("session cache checks passed");
