import assert from "node:assert/strict";
import { acknowledgeSessionStatus, countWorkingSessions, mergeSessionStatuses } from "../apps/web/src/session-status.ts";
import type { SessionRuntimeStatus } from "../apps/web/src/types.ts";

const sessionId = "session-a";
function runtimeStatus(state: SessionRuntimeStatus["state"], statusRevision: number, updateRevision: number): SessionRuntimeStatus {
  return { id: sessionId, state, statusRevision, updateRevision, ...(state === "error" ? { errorMessage: "Model request failed" } : {}) };
}

assert.equal(countWorkingSessions({}), 0);

const initial = mergeSessionStatuses({}, [runtimeStatus("ready", 0, 0)]);
assert.equal(initial[sessionId].unread, false);
assert.equal(initial[sessionId].viewedUpdateRevision, 0);
assert.equal(acknowledgeSessionStatus(initial, sessionId), initial);
assert.equal(acknowledgeSessionStatus(initial, "unknown-session"), initial);

const firstRun = mergeSessionStatuses(initial, [runtimeStatus("running", 1, 0)]);
assert.equal(firstRun[sessionId].state, "running");
assert.equal(firstRun[sessionId].unread, false);
const completed = mergeSessionStatuses(firstRun, [runtimeStatus("ready", 2, 1)]);
assert.equal(completed[sessionId].unread, true);
assert.equal(completed[sessionId].viewedUpdateRevision, 0);
assert.equal(mergeSessionStatuses({}, [runtimeStatus("ready", 2, 1)])[sessionId].unread, true);
assert.equal(mergeSessionStatuses(completed, [runtimeStatus("ready", 2, 1)])[sessionId].unread, true);

const runningWithUnviewedOutput = mergeSessionStatuses(completed, [runtimeStatus("running", 3, 1)]);
assert.equal(runningWithUnviewedOutput[sessionId].unread, false);
assert.equal(runningWithUnviewedOutput[sessionId].viewedUpdateRevision, 0);
const abortedWithUnviewedOutput = mergeSessionStatuses(runningWithUnviewedOutput, [runtimeStatus("ready", 4, 1)]);
assert.equal(abortedWithUnviewedOutput[sessionId].unread, true);
assert.equal(completed[sessionId].unread, true);

const firstObservedWhileRunning = mergeSessionStatuses({}, [runtimeStatus("running", 3, 1)]);
assert.equal(firstObservedWhileRunning[sessionId].unread, false);
assert.equal(mergeSessionStatuses(firstObservedWhileRunning, [runtimeStatus("ready", 4, 1)])[sessionId].unread, true);

const errorWithUnviewedOutput = mergeSessionStatuses(runningWithUnviewedOutput, [runtimeStatus("error", 4, 2)]);
assert.equal(errorWithUnviewedOutput[sessionId].state, "error");
assert.equal(errorWithUnviewedOutput[sessionId].errorMessage, "Model request failed");
assert.equal(errorWithUnviewedOutput[sessionId].unread, false);
assert.equal(errorWithUnviewedOutput[sessionId].viewedUpdateRevision, 0);
const retryingWithUnviewedOutput = mergeSessionStatuses(errorWithUnviewedOutput, [runtimeStatus("running", 5, 2)]);
assert.equal(retryingWithUnviewedOutput[sessionId].unread, false);
assert.equal(mergeSessionStatuses(retryingWithUnviewedOutput, [runtimeStatus("ready", 6, 2)])[sessionId].unread, true);
assert.equal(mergeSessionStatuses({}, [runtimeStatus("error", 2, 1)])[sessionId].unread, false);

for (const pending of [completed, runningWithUnviewedOutput, errorWithUnviewedOutput]) {
  const acknowledged = acknowledgeSessionStatus(pending, sessionId);
  assert.equal(acknowledged[sessionId].unread, false);
  assert.equal(acknowledged[sessionId].viewedUpdateRevision, pending[sessionId].updateRevision);
  assert.equal(acknowledged[sessionId].state, pending[sessionId].state);
  assert.equal(acknowledged[sessionId].errorMessage, pending[sessionId].errorMessage);
  assert.equal(acknowledgeSessionStatus(acknowledged, sessionId), acknowledged);
  const unchangedUpdate = mergeSessionStatuses(acknowledged, [runtimeStatus("ready", pending[sessionId].statusRevision + 2, pending[sessionId].updateRevision)]);
  assert.equal(unchangedUpdate[sessionId].unread, false);
  const newerUpdate = mergeSessionStatuses(unchangedUpdate, [runtimeStatus("ready", pending[sessionId].statusRevision + 4, pending[sessionId].updateRevision + 1)]);
  assert.equal(newerUpdate[sessionId].unread, true);
}

for (const state of ["ready", "running", "error"] as const) {
  const viewedDuringMerge = mergeSessionStatuses(completed, [runtimeStatus(state, 4, 2)], sessionId);
  assert.equal(viewedDuringMerge[sessionId].unread, false);
  assert.equal(viewedDuringMerge[sessionId].viewedUpdateRevision, 2);
  assert.equal(viewedDuringMerge[sessionId].state, state);
  assert.equal(mergeSessionStatuses(viewedDuringMerge, [runtimeStatus("ready", 6, 2)])[sessionId].unread, false);
  assert.equal(mergeSessionStatuses(viewedDuringMerge, [runtimeStatus("ready", 8, 3)])[sessionId].unread, true);
}
assert.equal(mergeSessionStatuses({}, [runtimeStatus("ready", 2, 1)], "another-session")[sessionId].unread, true);

const acknowledged = acknowledgeSessionStatus(completed, sessionId);
assert.deepEqual(mergeSessionStatuses(acknowledged, [runtimeStatus("running", 1, 0)]), acknowledged);
assert.deepEqual(mergeSessionStatuses(acknowledged, [runtimeStatus("ready", 2, 1)]), acknowledged);
assert.deepEqual(mergeSessionStatuses(runningWithUnviewedOutput, [runtimeStatus("ready", 2, 1)], sessionId), runningWithUnviewedOutput);
assert.deepEqual(mergeSessionStatuses(errorWithUnviewedOutput, [runtimeStatus("ready", 2, 1)]), errorWithUnviewedOutput);

const repeatedError = mergeSessionStatuses(errorWithUnviewedOutput, [runtimeStatus("error", 4, 3)]);
assert.deepEqual(mergeSessionStatuses(repeatedError, [runtimeStatus("error", 4, 2)], sessionId), repeatedError);
const mixedOrder = mergeSessionStatuses(initial, [runtimeStatus("ready", 2, 1), runtimeStatus("running", 3, 1), runtimeStatus("ready", 2, 1)]);
assert.deepEqual(mixedOrder, runningWithUnviewedOutput);
const workingStates = mergeSessionStatuses(mergeSessionStatuses({}, [runtimeStatus("running", 1, 0)]), [{ id: "session-b", state: "running", statusRevision: 2, updateRevision: 0 }, { id: "session-c", state: "ready", statusRevision: 3, updateRevision: 0 }]);
assert.equal(countWorkingSessions(workingStates), 2);
assert.equal(countWorkingSessions(mergeSessionStatuses(workingStates, [{ id: "session-a", state: "ready", statusRevision: 4, updateRevision: 1 }])), 1);
assert.equal(countWorkingSessions(mergeSessionStatuses({}, [{ id: "session-d", state: "error", statusRevision: 1, updateRevision: 0 }])), 0);

console.log("Session status checks passed.");
