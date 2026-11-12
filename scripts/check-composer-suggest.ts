import assert from "node:assert/strict";
import { applySuggestion, detectTrigger, filterSuggestItems, splitMcpQuery } from "../apps/web/src/composer-suggest.ts";

assert.deepEqual(detectTrigger("hello /web", 10), { symbol: "/", kind: "skill", query: "web", start: 6, end: 10 });
assert.deepEqual(detectTrigger("/", 1), { symbol: "/", kind: "skill", query: "", start: 0, end: 1 });
assert.equal(detectTrigger("hello world", 11), null, "a plain word has no trigger");
assert.equal(detectTrigger("a/b", 3), null, "a path has no trigger");
assert.equal(detectTrigger("plain@word", 10), null, "a trigger inside a word has no match");
assert.deepEqual(detectTrigger("see @apps", 5), { symbol: "@", kind: "file", query: "", start: 4, end: 5 });

const fileTrigger = detectTrigger("use @apps/srv now", 13);
assert.equal(fileTrigger?.kind, "file");
assert.equal(fileTrigger?.start, 4);
const applied = applySuggestion("use @apps/srv now", fileTrigger!, "@apps/server/src/index.ts");
assert.equal(applied.text, "use @apps/server/src/index.ts now");
assert.equal(applied.caret, "use @apps/server/src/index.ts".length);

const appended = applySuggestion("/web", detectTrigger("/web", 4)!, "/webfetch");
assert.equal(appended.text, "/webfetch ");
assert.equal(appended.caret, 10);

assert.deepEqual(splitMcpQuery("exa/web"), { server: "exa", tool: "web" });
assert.equal(splitMcpQuery("exa"), null);

const items = [
  { id: "1", kind: "skill" as const, label: "browser", detail: "Playwright MCP", insert: "/browser" },
  { id: "2", kind: "skill" as const, label: "mcp-servers", detail: "MCP onboarding", insert: "/mcp-servers" },
];
assert.equal(filterSuggestItems(items, "mcp")[0]?.label, "mcp-servers", "a label match outranks a detail match");
assert.equal(filterSuggestItems(items, "onboarding")[0]?.label, "mcp-servers", "detail text also matches");
assert.deepEqual(filterSuggestItems(items, "brw").map((item) => item.label), ["browser"]);
assert.deepEqual(filterSuggestItems(items, "").map((item) => item.label), ["browser", "mcp-servers"]);
assert.deepEqual(filterSuggestItems(items, "zzz"), []);

console.log("composer suggest checks passed");
