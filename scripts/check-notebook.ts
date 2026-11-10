import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceNotebook, saveWorkspaceNotebook } from "../apps/server/src/workspace-notebook.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-notebook-check-"));
const workspace = { id: "notebook-check", name: "Notebook check", path: directory };

try {
  assert.deepEqual(await readWorkspaceNotebook(workspace), { content: "" });
  assert.deepEqual(await saveWorkspaceNotebook(workspace, "First note"), { content: "First note" });
  assert.deepEqual(await readWorkspaceNotebook(workspace), { content: "First note" });
  await Promise.all([saveWorkspaceNotebook(workspace, "Second note"), saveWorkspaceNotebook(workspace, "Latest note")]);
  assert.equal(await readFile(join(directory, ".pi-ark", "notebook.md"), "utf8"), "Latest note");
  await assert.rejects(() => saveWorkspaceNotebook(workspace, { content: "invalid" }), /must be text/);
  console.log("notebook checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
