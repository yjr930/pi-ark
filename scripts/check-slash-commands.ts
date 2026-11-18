import assert from "node:assert/strict";
import { builtinCommandItems, compactCommandInstructions, reloadCommandArguments, withBuiltinCommands } from "../apps/web/src/slash-commands.ts";

assert.deepEqual(builtinCommandItems.map(({ label, kind, status, insert }) => ({ label, kind, status, insert })), [
  { label: "compact", kind: "command", status: "Built-in", insert: "/compact" },
  { label: "reload", kind: "command", status: "Built-in", insert: "/reload" },
]);

assert.deepEqual(withBuiltinCommands([
  { id: "command:reload", kind: "command", label: "reload", insert: "/reload" },
  { id: "command:compact", kind: "command", label: "compact", insert: "/compact" },
  { id: "skill:reload", kind: "skill", label: "reload", insert: "/skill:reload" },
  { id: "command:reload-project", kind: "command", label: "reload-project", insert: "/reload-project" },
]).map(({ insert, status }) => [insert, status]), [
  ["/compact", "Built-in"],
  ["/reload", "Built-in"],
  ["/skill:reload", undefined],
  ["/reload-project", undefined],
]);

assert.equal(compactCommandInstructions("/compact"), "");
assert.equal(compactCommandInstructions("  /compact  "), "");
assert.equal(compactCommandInstructions("/compact focus on the API changes"), "focus on the API changes");
assert.equal(compactCommandInstructions("  /compact  keep decisions  "), "keep decisions");
assert.equal(compactCommandInstructions("/compact\nkeep the file list"), "keep the file list");
assert.equal(compactCommandInstructions("/compaction"), null);
assert.equal(compactCommandInstructions("/ compact"), null);
assert.equal(compactCommandInstructions("compact"), null);
assert.equal(compactCommandInstructions(""), null);

assert.equal(reloadCommandArguments("/reload"), "");
assert.equal(reloadCommandArguments("  /reload \t\n  "), "");
assert.equal(reloadCommandArguments("  /reload  extra text  "), "extra text");
assert.equal(reloadCommandArguments("/reload\nextra text"), "extra text");
assert.equal(reloadCommandArguments("/reload-project"), null);
assert.equal(reloadCommandArguments("/reloaded"), null);
assert.equal(reloadCommandArguments("/ reload"), null);
assert.equal(reloadCommandArguments("/skill:reload"), null);
assert.equal(reloadCommandArguments("Try /reload"), null);
assert.equal(reloadCommandArguments(""), null);
