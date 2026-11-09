import assert from "node:assert/strict";
import { buildConversationSegments } from "../apps/web/src/conversation.ts";
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
assert.equal(completed[2].type === "message" && completed[2].message.content?.[0]?.text, "Final answer");
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
assert.equal(interrupted[2].type === "warning" && interrupted[2].message, "Pi stopped before producing a final response.");
const activeInterrupted = buildConversationSegments(interruptedMessages, true);
assert.equal(activeInterrupted.some((segment) => segment.type === "collapsed" || segment.type === "warning"), false);
const streaming = buildConversationSegments(messages, true);
assert.equal(streaming.some((segment) => segment.type === "collapsed"), false);
const direct = buildConversationSegments([{ role: "user", content: "Hi", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "Hello" }], timestamp: 2 }], false);
assert.deepEqual(direct.map((segment) => segment.type), ["message", "message"]);
console.log("conversation checks passed");
