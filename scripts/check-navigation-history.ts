import assert from "node:assert/strict";
import { readAgentReturnPosition, withAgentReturnPosition, type AgentReturnPosition } from "../apps/web/src/navigation-history.ts";
import type { PermalinkTarget } from "../apps/web/src/permalinks.ts";

const target: PermalinkTarget = { page: "agent", workspaceId: "workspace", sessionId: "session", messageId: "m000001", leafEntryId: "historical-leaf" };
const position: AgentReturnPosition = { workspaceId: "workspace", sessionId: "session", messageId: "m000001", leafEntryId: "historical-leaf", scrollTop: 1234, followOutput: false };
const previous = { preserved: { value: true } };
const state = withAgentReturnPosition(previous, position);
assert.equal(readAgentReturnPosition(state, target), position);
assert.deepEqual(previous, { preserved: { value: true } });
assert.deepEqual(state.preserved, { value: true });
assert.equal(readAgentReturnPosition(withAgentReturnPosition(null, position), target), position);
for (const change of [{ page: "files" }, { workspaceId: "other" }, { sessionId: "other" }, { messageId: undefined }, { leafEntryId: undefined }]) assert.equal(readAgentReturnPosition(state, { ...target, ...change } as PermalinkTarget), undefined);
for (const invalid of [null, undefined, 1, "state", {}, { piArkAgentReturn: null }, { piArkAgentReturn: { ...position, scrollTop: -1 } }, { piArkAgentReturn: { ...position, scrollTop: Infinity } }, { piArkAgentReturn: { ...position, followOutput: "false" } }]) assert.equal(readAgentReturnPosition(invalid, target), undefined);
const currentTarget: PermalinkTarget = { page: "agent", workspaceId: "workspace", sessionId: "session" };
const bottom = { workspaceId: "workspace", sessionId: "session", scrollTop: 0, followOutput: true };
assert.equal(readAgentReturnPosition(withAgentReturnPosition({}, bottom), currentTarget), bottom);
console.log("Navigation history checks passed");
