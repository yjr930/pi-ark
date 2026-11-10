import assert from "node:assert/strict";
import { buildConversationSegments, previousConversationPageStart } from "../apps/web/src/conversation.ts";
import type { AgentMessage } from "../apps/web/src/types.ts";

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
const pagedMessages = Array.from({ length: 130 }, (_, index) => [{ role: "user", content: `Question ${index + 1}` }, { role: "assistant", content: [{ type: "text", text: `Answer ${index + 1}` }] }]).flat() as AgentMessage[];
assert.equal(previousConversationPageStart(pagedMessages), 160);
assert.equal(previousConversationPageStart(pagedMessages, 160), 60);
const unevenPage = [...pagedMessages.slice(0, 159), { role: "compactionSummary", summary: "Boundary" }, ...pagedMessages.slice(159)] as AgentMessage[];
assert.equal(previousConversationPageStart(unevenPage), 161);
console.log("conversation checks passed");
