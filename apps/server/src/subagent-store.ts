import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceDefinition } from "./config.js";
import { isSubagentActive, type SubagentRun, type SubagentSessionState } from "./subagent-types.js";

export class SubagentStore {
  private readonly loaded = new Map<string, Promise<Map<string, SubagentRun>>>();
  private readonly records = new Map<string, Map<string, SubagentRun>>();
  private readonly writes = new Map<string, Promise<void>>();

  async load(workspace: WorkspaceDefinition): Promise<Map<string, SubagentRun>> {
    let loading = this.loaded.get(workspace.path);
    if (!loading) {
      loading = this.loadWorkspace(workspace);
      this.loaded.set(workspace.path, loading);
      loading.catch(() => { this.loaded.delete(workspace.path); });
    }
    return loading;
  }

  private async loadWorkspace(workspace: WorkspaceDefinition): Promise<Map<string, SubagentRun>> {
    const directory = join(workspace.path, ".pi-ark", "subagent-runs");
    await mkdir(directory, { recursive: true });
    const records = new Map<string, SubagentRun>();
    this.records.set(workspace.path, records);
    for (const name of await readdir(directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const run = JSON.parse(await readFile(join(directory, name), "utf8")) as SubagentRun;
      if (run.version !== 1 || `${run.id}.json` !== name || !Array.isArray(run.tasks)) throw new Error(`Invalid subagent record: ${name}`);
      records.set(run.id, run);
      let changed = false;
      for (const task of run.tasks) if (isSubagentActive(task.state)) {
        task.state = "interrupted";
        task.finishedAt = new Date().toISOString();
        task.updatedAt = task.finishedAt;
        task.error = "The service stopped before the delegated task finished. Delegate a new task to continue.";
        task.currentTool = undefined;
        changed = true;
      }
      if (changed) await this.save(workspace, run);
    }
    return records;
  }

  async save(workspace: WorkspaceDefinition, run: SubagentRun): Promise<void> {
    this.records.get(workspace.path)!.set(run.id, run);
    run.revision += 1;
    const target = join(workspace.path, ".pi-ark", "subagent-runs", `${run.id}.json`);
    const content = JSON.stringify(run, null, 2) + "\n";
    const previous = this.writes.get(target) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, target);
    });
    this.writes.set(target, operation);
    try { await operation; }
    finally { if (this.writes.get(target) === operation) this.writes.delete(target); }
  }

  state(workspace: WorkspaceDefinition, sessionId: string): SubagentSessionState {
    const records = [...(this.records.get(workspace.path)?.values() || [])];
    const source = this.findTask(workspace, sessionId);
    const run = source?.task.deleted ? undefined : source?.run;
    const task = run ? source?.task : undefined;
    return {
      runs: records.filter((record) => record.parentSessionId === sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      ...(run ? { parentRuns: records.filter((record) => record.parentSessionId === run.parentSessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) } : {}),
      ...(run && task ? { origin: { runId: run.id, parentSessionId: run.parentSessionId, parentLink: run.parentLink, parentLeafEntryId: run.parentLeafEntryId, parentDeleted: run.parentDeleted, title: task.title, state: task.state } } : {}),
      managed: Boolean(task && isSubagentActive(task.state)),
    };
  }

  findTask(workspace: WorkspaceDefinition, sessionId: string) {
    const records = [...(this.records.get(workspace.path)?.values() || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const run of records) {
      const task = run.tasks.find((item) => item.sessionId === sessionId);
      if (task) return { run, task };
    }
    return undefined;
  }
}
