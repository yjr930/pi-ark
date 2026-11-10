import type { SubagentRun } from "./types";

export interface SubagentListItem {
  runId: string;
  sessionId: string;
  sessionLink: string;
  title: string;
  state: SubagentRun["tasks"][number]["state"];
  updatedAt: string;
  error?: string;
}

export function subagentListItems(runs: SubagentRun[]): SubagentListItem[] {
  const latest = new Map<string, SubagentListItem & { deleted?: boolean }>();
  for (const run of [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) for (const task of run.tasks) {
    latest.set(task.sessionId, { runId: run.id, sessionId: task.sessionId, sessionLink: task.sessionLink, title: task.title, state: task.state, updatedAt: task.updatedAt || task.finishedAt || task.startedAt || run.createdAt, error: task.error, deleted: task.deleted });
  }
  return [...latest.values()].filter((item) => !item.deleted).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
}

export function subagentCounts(items: SubagentListItem[]) {
  return { running: items.filter((item) => item.state === "running").length, complete: items.filter((item) => item.state === "completed").length, total: items.length };
}

export function subagentFinished(item: SubagentListItem): boolean {
  return item.state !== "queued" && item.state !== "running";
}
