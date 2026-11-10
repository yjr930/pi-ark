import assert from "node:assert/strict";
import { buildConversationSegments, buildToolCallGroups } from "../apps/web/src/conversation.ts";
import type { AgentMessage, ContentBlock, SubagentRun } from "../apps/web/src/types.ts";
import { subagentCounts, subagentFinished, subagentListItems } from "../apps/web/src/subagent-view.ts";

const messages: AgentMessage[] = [
  { role: "user", content: "Inspect", timestamp: 1000 },
  { role: "assistant", content: [{ type: "thinking", thinking: "Plan" }, { type: "toolCall", name: "read", arguments: { path: "README.md" } }], timestamp: 2000 },
  { role: "toolResult", toolName: "read", content: [{ type: "text", text: "contents" }], timestamp: 4000 },
  { role: "assistant", content: [{ type: "text", text: "Final answer" }], timestamp: 7000 },
];
const completed = buildConversationSegments(messages, false);
assert.deepEqual(completed.map((segment) => segment.type), ["message", "collapsed", "message"]);
assert.equal(completed[1].type === "collapsed" && completed[1].messages.length, 2);
assert.equal(completed[1].type === "collapsed" && completed[1].duration, "用时 5 秒");
assert.equal(completed[1].type === "collapsed" && completed[1].aiStart, true);
assert.equal(completed[2].type === "message" && completed[2].message.content?.[0]?.text, "Final answer");
assert.equal(completed[2].type === "message" && completed[2].aiStart, undefined);
const interruptedMessages: AgentMessage[] = [
  { role: "user", content: "Inspect", timestamp: 1000 },
  { role: "assistant", content: [{ type: "text", text: "Checking files" }, { type: "toolCall", name: "read", arguments: { path: "README.md" } }, { type: "toolCall", name: "bash", arguments: { command: "pwd" } }], timestamp: 2000 },
  { role: "toolResult", toolName: "read", content: [{ type: "text", text: "contents" }], timestamp: 3000 },
  { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "/workspace" }], timestamp: 4000 },
  { role: "assistant", content: [{ type: "text", text: "Starting another command" }, { type: "toolCall", name: "bash", arguments: { command: "long-task" } }], timestamp: 5000 },
];
const interrupted = buildConversationSegments(interruptedMessages, false);
assert.deepEqual(interrupted.map((segment) => segment.type), ["message", "collapsed", "warning"]);
assert.equal(interrupted[1].type === "collapsed" && interrupted[1].messages.length, 4);
assert.equal(interrupted[1].type === "collapsed" && interrupted[1].toolMessages, 4);
assert.equal(interrupted[2].type === "warning" && interrupted[2].title, "Response interrupted");
const activeInterrupted = buildConversationSegments(interruptedMessages, true);
assert.deepEqual(activeInterrupted.map((segment) => segment.type), ["message", "collapsed"]);
assert.equal(activeInterrupted[1].type === "collapsed" && activeInterrupted[1].active, true);
assert.equal(activeInterrupted.some((segment) => segment.type === "warning"), false);
const streaming = buildConversationSegments(messages, true);
assert.deepEqual(streaming.map((segment) => segment.type), ["message", "collapsed", "message"]);
assert.equal(streaming[1].type === "collapsed" && streaming[1].messages.length, 2);
assert.equal(streaming[1].type === "collapsed" && streaming[1].active, true);
assert.equal(streaming[2].type === "message" && streaming[2].message.content?.[0]?.text, "Final answer");
const direct = buildConversationSegments([{ role: "user", content: "Hi", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "Hello" }], timestamp: 2 }], false);
assert.deepEqual(direct.map((segment) => segment.type), ["message", "message"]);
assert.equal(direct[1].type === "message" && direct[1].aiStart, true);
const compactBoundary = buildConversationSegments([
  { role: "user", content: "Before compact", timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "Before compact answer" }], timestamp: 2 },
  { role: "compactionSummary", summary: "Saved summary", tokensBefore: 120000, timestamp: 3 },
  { role: "user", content: "After compact", timestamp: 4 },
  { role: "assistant", content: [{ type: "text", text: "After compact answer" }], timestamp: 5 },
], false);
assert.deepEqual(compactBoundary.map((segment) => segment.type), ["message", "message", "message", "message", "message"]);
assert.equal(compactBoundary[1].type === "message" && compactBoundary[1].aiStart, true);
assert.equal(compactBoundary[2].type === "message" && compactBoundary[2].message.role, "compactionSummary");
assert.equal(compactBoundary[2].type === "message" && compactBoundary[2].aiStart, undefined);
assert.equal(compactBoundary[4].type === "message" && compactBoundary[4].aiStart, true);
assert.equal(compactBoundary.filter((segment) => segment.aiStart).length, 2);
const pageStartingInsideResponse = buildConversationSegments([
  { role: "compactionSummary", summary: "Page boundary summary", timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "Continued response" }], timestamp: 2 },
  { role: "assistant", content: [{ type: "text", text: "Same response" }], timestamp: 3 },
  { role: "user", content: "Next turn", timestamp: 4 },
  { role: "assistant", content: [{ type: "text", text: "Next response" }], timestamp: 5 },
], false);
assert.equal(pageStartingInsideResponse.filter((segment) => segment.aiStart).length, 2);
assert.equal(pageStartingInsideResponse[0].type === "message" && pageStartingInsideResponse[0].aiStart, true);
assert.equal(pageStartingInsideResponse[1].type === "message" && pageStartingInsideResponse[1].aiStart, undefined);
assert.equal(pageStartingInsideResponse[2].type === "message" && pageStartingInsideResponse[2].aiStart, undefined);
assert.equal(pageStartingInsideResponse[4].type === "message" && pageStartingInsideResponse[4].aiStart, true);
const pureTools = (name: string, count = 1): AgentMessage => ({ role: "assistant", entryId: name, content: Array.from({ length: count }, (_, index) => ({ type: "toolCall", id: `${name}-${index}`, name: "read", arguments: { path: `${name}-${index}.md` } })) });
const firstTools = pureTools("first", 2);
const secondTools = pureTools("second", 4);
const pairedResult: AgentMessage = { role: "toolResult", toolCallId: "first-0", content: "Result is tool output, not conversation text" };
const withText: AgentMessage = { role: "assistant", content: [{ type: "text", text: "Inspecting the next file" }, { type: "toolCall", id: "text-call", name: "read" }] };
const withReasoning: AgentMessage = { role: "assistant", content: [{ type: "thinking", thinking: "Choose the next action" }, { type: "toolCall", id: "thinking-call", name: "bash" }] };
const groups = buildToolCallGroups([withText, firstTools, pairedResult, secondTools, withReasoning, pureTools("third"), { role: "assistant", content: "Conversation between calls" }, pureTools("fourth")], new Set([pairedResult]));
assert.deepEqual(groups.map((group) => group.type), ["message", "tools", "message", "tools", "message", "tools"]);
assert.equal(groups[0].type === "message" && groups[0].message, withText);
assert.equal(groups[1].type === "tools" && groups[1].calls.length, 6);
assert.deepEqual(groups[1].type === "tools" && groups[1].messages, [firstTools, secondTools]);
assert.deepEqual(groups[1].type === "tools" && groups[1].calls.slice(-3).map((call) => call.id), ["second-1", "second-2", "second-3"]);
assert.equal(groups[2].type === "message" && groups[2].message, withReasoning);
const orphanResult: AgentMessage = { role: "toolResult", toolCallId: "orphan", content: "Unpaired result" };
assert.deepEqual(buildToolCallGroups([firstTools, orphanResult, secondTools], new Set()).map((group) => group.type), ["tools", "message", "tools"]);
assert.deepEqual(buildToolCallGroups([firstTools, { role: "compactionSummary", summary: "Context" }, secondTools], new Set()).map((group) => group.type), ["tools", "message", "tools"]);
assert.deepEqual(buildToolCallGroups([firstTools, { role: "user", content: "New turn" }, secondTools], new Set()).map((group) => group.type), ["tools", "message", "tools"]);
assert.deepEqual(buildToolCallGroups([], new Set()), []);
const hiddenReasoningOnly: AgentMessage = { role: "assistant", entryId: "hidden-reasoning", content: [{ type: "thinking", thinking: "Review the next operation" }, { type: "text", text: "  " }] };
const withEmptyReasoning: AgentMessage = { ...pureTools("empty-thinking"), content: [{ type: "thinking", thinking: "  " }, ...pureTools("empty-thinking").content as ContentBlock[]] };
assert.equal(buildToolCallGroups([firstTools, withEmptyReasoning, secondTools], new Set())[0].type, "tools");
const hiddenGroups = buildToolCallGroups([withText, firstTools, pairedResult, withReasoning, hiddenReasoningOnly, secondTools], new Set([pairedResult]), true);
assert.deepEqual(hiddenGroups.map((group) => group.type), ["message", "tools"]);
assert.equal(hiddenGroups[1].type === "tools" && hiddenGroups[1].calls.length, 7);
assert.equal(hiddenGroups[1].type === "tools" && hiddenGroups[1].messages.includes(hiddenReasoningOnly), true);
assert.deepEqual(buildToolCallGroups([firstTools, hiddenReasoningOnly, secondTools], new Set(), false).map((group) => group.type), ["tools", "message", "tools"]);
for (const boundary of [{ role: "assistant", content: [{ type: "image", data: "image", mimeType: "image/png" }] }, { role: "compactionSummary", summary: "Context" }, { role: "branchSummary", summary: "Branch" }, orphanResult, { role: "user", content: "Next turn" }] as AgentMessage[]) assert.deepEqual(buildToolCallGroups([firstTools, boundary, secondTools], new Set(), true).map((group) => group.type), ["tools", "message", "tools"]);
const delegation: AgentMessage = { role: "assistant", content: [{ type: "toolCall", id: "delegate", name: "subagent", arguments: { tasks: [] } }] };
const delegationResult: AgentMessage = { role: "toolResult", toolCallId: "delegate", toolName: "subagent", content: "Delegated result" };
const mixedDelegation: AgentMessage = { role: "assistant", content: [...firstTools.content as ContentBlock[], ...delegation.content as ContentBlock[], ...secondTools.content as ContentBlock[]] };
for (const hideReasoning of [false, true]) {
  for (const boundary of [delegation, mixedDelegation, { ...delegation, content: [{ type: "thinking", thinking: "Delegate independent work" }, ...delegation.content as ContentBlock[]] }]) {
    const separated = buildToolCallGroups([firstTools, boundary, delegationResult, secondTools], new Set([delegationResult]), hideReasoning);
    assert.deepEqual(separated.map((group) => group.type), ["tools", "message", "tools"]);
    assert.equal(separated[1].type === "message" && separated[1].message, boundary);
    assert.equal(separated.some((group) => group.type === "tools" && group.calls.some((call) => call.name === "subagent")), false);
  }
}
const time = (minute: number) => new Date(1700000000000 + minute * 60000).toISOString();
const task = (sessionId: string, state: SubagentRun["tasks"][number]["state"], updatedAt?: string): SubagentRun["tasks"][number] => ({ sessionId, sessionLink: `pi-ark://workspace/check/session/${sessionId}`, title: `Agent ${sessionId}`, task: "Inspect files", expectedResult: "Report", references: [], state, updatedAt });
const run = (id: string, createdAt: string, tasks: SubagentRun["tasks"]): SubagentRun => ({ version: 1, id, createdAt, tasks, parentSessionId: "parent", parentLink: "pi-ark://workspace/check/session/parent", toolCallId: id, revision: 1, model: { provider: "fixture", id: "model" }, thinkingLevel: "off", tools: [], systemPromptAppend: "" });
const olderRun = run("first-delegation", time(1), [task("continued", "completed", time(100)), task("failed", "failed", time(4)), task("complete", "completed", time(3)), task("deleted", "completed", time(2))]);
const nextRun = run("next-delegation", time(5), [task("continued", "running", time(7)), { ...task("deleted", "completed", time(6)), deleted: true }]);
const agents = subagentListItems([nextRun, olderRun]);
assert.deepEqual(agents.map((item) => item.sessionId), ["continued", "failed", "complete"]);
assert.equal(agents[0].runId, "next-delegation");
assert.deepEqual(subagentCounts(agents), { running: 1, complete: 1, total: 3 });
assert.deepEqual(agents.filter(subagentFinished).map((item) => item.state), ["failed", "completed"]);
assert.equal(subagentFinished({ ...agents[0], state: "queued" }), false);
for (const state of ["completed", "failed", "cancelled", "interrupted"] as const) assert.equal(subagentFinished({ ...agents[0], state }), true);
const legacyAgents = subagentListItems([run("legacy", time(1), [{ ...task("finished", "completed"), finishedAt: time(4), startedAt: time(2) }, { ...task("started", "running"), startedAt: time(3) }, task("queued", "queued")])]);
assert.deepEqual(legacyAgents.map((item) => item.updatedAt), [time(4), time(3), time(1)]);
assert.deepEqual(subagentCounts([]), { running: 0, complete: 0, total: 0 });
console.log("conversation checks passed");
