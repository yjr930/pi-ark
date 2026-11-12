import type { SessionRuntimeStatus, SessionStatusView } from "./types";

export type SessionStatusMap = Record<string, SessionStatusView>;

export function mergeSessionStatuses(current: SessionStatusMap, incoming: SessionRuntimeStatus[], viewedSessionId?: string): SessionStatusMap {
  const next = { ...current };
  for (const status of incoming) {
    const previous = next[status.id];
    if (previous && (status.statusRevision < previous.statusRevision || (status.statusRevision === previous.statusRevision && status.updateRevision < previous.updateRevision))) continue;
    const viewedUpdateRevision = status.id === viewedSessionId ? status.updateRevision : previous?.viewedUpdateRevision ?? 0;
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

export function acknowledgeSessionStatus(current: SessionStatusMap, sessionId: string): SessionStatusMap {
  const status = current[sessionId];
  if (!status || status.viewedUpdateRevision === status.updateRevision) return current;
  return { ...current, [sessionId]: { ...status, viewedUpdateRevision: status.updateRevision, unread: false } };
}
