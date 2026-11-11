import assert from "node:assert/strict";
import { resolveActiveSessionId } from "../apps/web/src/session-selection.ts";

const older = { id: "session-older", archived: false };
const current = { id: "session-current", archived: false };
const archived = { id: "session-archived", archived: true };
const subagent = { id: "session-subagent", archived: false, subagentOrigin: { runId: "run-1", parentSessionId: older.id, parentDeleted: false } };
const unsent = "session-unsent";
const sessions = [older, current, archived, subagent];

assert.equal(resolveActiveSessionId({ currentSessionId: current.id, sessions }), current.id);
assert.equal(resolveActiveSessionId({ currentSessionId: archived.id, sessions }), archived.id);
assert.equal(resolveActiveSessionId({ currentSessionId: subagent.id, sessions }), subagent.id);
assert.equal(resolveActiveSessionId({ currentSessionId: unsent, sessions, pendingSessionId: unsent }), unsent);
assert.equal(resolveActiveSessionId({ currentSessionId: unsent, sessions, liveSessionIds: [unsent] }), unsent);
assert.equal(resolveActiveSessionId({ currentSessionId: unsent, sessions, pendingSessionId: unsent, liveSessionIds: [unsent] }), unsent);
assert.equal(resolveActiveSessionId({ currentSessionId: unsent, sessions }), older.id);
assert.equal(resolveActiveSessionId({ currentSessionId: unsent, sessions, pendingSessionId: "session-other" }), older.id);
assert.equal(resolveActiveSessionId({ currentSessionId: current.id, sessions, removedFromActiveId: current.id }), older.id);
assert.equal(resolveActiveSessionId({ currentSessionId: unsent, sessions, liveSessionIds: [unsent], removedFromActiveId: unsent }), older.id);
assert.equal(resolveActiveSessionId({ currentSessionId: "", sessions }), older.id);
assert.equal(resolveActiveSessionId({ currentSessionId: "session-deleted", sessions: [] }), "");
assert.equal(resolveActiveSessionId({ currentSessionId: "session-deleted", sessions: [archived, subagent] }), "");
assert.equal(resolveActiveSessionId({ currentSessionId: "session-deleted", sessions }), older.id);
console.log("session selection checks passed");
