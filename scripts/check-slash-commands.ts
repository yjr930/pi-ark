import assert from "node:assert/strict";
import { builtinCommandItems, compactCommandInstructions } from "../apps/web/src/slash-commands.ts";

assert.deepEqual(builtinCommandItems.map((item) => ({ label: item.label, kind: item.kind, status: item.status, insert: item.insert })), [{ label: "compact", kind: "command", status: "Built-in", insert: "/compact" }]);

assert.equal(compactCommandInstructions("/compact"), "");
assert.equal(compactCommandInstructions("  /compact  "), "");
assert.equal(compactCommandInstructions("/compact focus on the API changes"), "focus on the API changes");
assert.equal(compactCommandInstructions("  /compact  keep decisions  "), "keep decisions");
assert.equal(compactCommandInstructions("/compact\nkeep the file list"), "keep the file list");
assert.equal(compactCommandInstructions("/compaction"), null);
assert.equal(compactCommandInstructions("/ compact"), null);
assert.equal(compactCommandInstructions("compact"), null);
assert.equal(compactCommandInstructions(""), null);
