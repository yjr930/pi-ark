import assert from "node:assert/strict";
import { countWorkingSessions, formatWorkingCount, mergeSessionStatuses } from "../apps/web/src/session-status.ts";
import { normalizeAppearance } from "../apps/web/src/appearance.ts";
import type { SessionRuntimeStatus } from "../apps/web/src/types.ts";

const status = (id: string, state: SessionRuntimeStatus["state"]): SessionRuntimeStatus => ({ id, state, statusRevision: 1, updateRevision: 0 });

assert.equal(countWorkingSessions({}), 0);
assert.equal(countWorkingSessions(mergeSessionStatuses({}, [status("a", "ready")])), 0);
assert.equal(countWorkingSessions(mergeSessionStatuses({}, [status("a", "running")])), 1);
assert.equal(countWorkingSessions(mergeSessionStatuses({}, [status("a", "running"), status("b", "running"), status("c", "ready"), status("d", "error")])), 2);
assert.equal(countWorkingSessions(mergeSessionStatuses(mergeSessionStatuses({}, [status("a", "running")]), [status("a", "ready")])), 0);

assert.equal(formatWorkingCount(0), "");
assert.equal(formatWorkingCount(1), "\u2460");
assert.equal(formatWorkingCount(2), "\u2461");
assert.equal(formatWorkingCount(9), "\u2468");
assert.equal(formatWorkingCount(10), "\u2469");
assert.equal(formatWorkingCount(20), "\u2473");
assert.equal(formatWorkingCount(21), "21");

assert.equal(normalizeAppearance({}).showWorkingCount, true);
assert.equal(normalizeAppearance({ showWorkingCount: true }).showWorkingCount, true);
assert.equal(normalizeAppearance({ showWorkingCount: false }).showWorkingCount, false);
assert.equal(normalizeAppearance({ showWorkingCount: "false" }).showWorkingCount, true);
assert.equal(normalizeAppearance({ fontScale: 1.15, showWorkingCount: false }).fontScale, 1.15);

console.log("Working session count and formatting checks passed.");
