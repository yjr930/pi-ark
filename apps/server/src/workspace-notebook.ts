import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { WorkspaceDefinition } from "./config.js";

const writes = new Map<string, Promise<void>>();

function notebookPath(workspace: WorkspaceDefinition): string {
  return join(workspace.path, ".pi-ark", "notebook.md");
}

export async function readWorkspaceNotebook(workspace: WorkspaceDefinition): Promise<{ content: string }> {
  try { return { content: await readFile(notebookPath(workspace), "utf8") }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "" };
    throw error;
  }
}

export async function saveWorkspaceNotebook(workspace: WorkspaceDefinition, content: unknown): Promise<{ content: string }> {
  if (typeof content !== "string") throw Object.assign(new Error("Notebook content must be text"), { statusCode: 400 });
  const path = notebookPath(workspace);
  const previous = writes.get(path) || Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    await mkdir(join(workspace.path, ".pi-ark"), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  });
  writes.set(path, task);
  try { await task; }
  finally { if (writes.get(path) === task) writes.delete(path); }
  return { content };
}
