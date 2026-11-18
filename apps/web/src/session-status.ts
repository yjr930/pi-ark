import type { SessionRuntimeStatus, SessionStatusView } from "./types";

export type SessionStatusMap = Record<string, SessionStatusView>;
type ViewedRevision = Pick<SessionStatusView, "runtimeId" | "viewedUpdateRevision">;

function viewedStorageKey(scope: string, workspaceId: string) {
  return `pi-ark-viewed-sessions:${JSON.stringify([scope, workspaceId])}`;
}

export function readViewedRevisions(scope: string, workspaceId: string): Map<string, ViewedRevision> {
  try {
    const records: Record<string, ViewedRevision> = JSON.parse(localStorage.getItem(viewedStorageKey(scope, workspaceId)) || "{}");
    return new Map(Object.entries(records).filter(([, value]) => value && typeof value.runtimeId === "string" && Number.isSafeInteger(value.viewedUpdateRevision) && value.viewedUpdateRevision > 0));
  } catch { return new Map(); }
}

export function saveViewedRevision(scope: string, workspaceId: string, status: SessionStatusView): void {
  if (!status.runtimeId || status.viewedUpdateRevision <= 0) return;
  const records = readViewedRevisions(scope, workspaceId);
  const previous = records.get(status.id);
  if (previous?.runtimeId === status.runtimeId && previous.viewedUpdateRevision >= status.viewedUpdateRevision) return;
  records.set(status.id, { runtimeId: status.runtimeId, viewedUpdateRevision: status.viewedUpdateRevision });
  try { localStorage.setItem(viewedStorageKey(scope, workspaceId), JSON.stringify(Object.fromEntries(records))); } catch { /* Storage can be disabled or full. */ }
}

export function mergeSessionStatuses(current: SessionStatusMap, incoming: SessionRuntimeStatus[], viewedSessionId?: string, saved?: ReadonlyMap<string, ViewedRevision>): SessionStatusMap {
  const next = { ...current };
  for (const status of incoming) {
    const previous = next[status.id];
    const sameRuntime = previous && previous.runtimeId === status.runtimeId ? previous : undefined;
    if (sameRuntime && (status.statusRevision < sameRuntime.statusRevision || (status.statusRevision === sameRuntime.statusRevision && status.updateRevision < sameRuntime.updateRevision))) continue;
    const stored = saved?.get(status.id);
    const storedRevision = stored && stored.runtimeId === status.runtimeId ? stored.viewedUpdateRevision : 0;
    const viewedUpdateRevision = status.id === viewedSessionId ? status.updateRevision : Math.max(sameRuntime?.viewedUpdateRevision ?? 0, storedRevision);
    next[status.id] = {
      ...status,
      viewedUpdateRevision,
      unread: status.state === "ready" && status.updateRevision > viewedUpdateRevision,
    };
  }
  return next;
}

export function countWorkingSessions(statuses: SessionStatusMap): number {
  return Object.values(statuses).filter((status) => status.state === "running").length;
}

export function formatWorkingCount(count: number): string {
  if (count <= 0) return "";
  return count <= 20 ? String.fromCodePoint(0x2460 + count - 1) : String(count);
}

export function acknowledgeSessionStatus(current: SessionStatusMap, sessionId: string): SessionStatusMap {
  const status = current[sessionId];
  if (!status || status.viewedUpdateRevision === status.updateRevision) return current;
  return { ...current, [sessionId]: { ...status, viewedUpdateRevision: status.updateRevision, unread: false } };
}
