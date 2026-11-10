import type { SessionRuntimeStatus, SessionStatusView } from "./types";

export type SessionStatusMap = Record<string, SessionStatusView>;

export function mergeSessionStatuses(current: SessionStatusMap, incoming: SessionRuntimeStatus[], viewedSessionId?: string): SessionStatusMap {
  const next = { ...current };
  for (const status of incoming) {
    const previous = current[status.id];
    if (previous && status.statusRevision < previous.statusRevision) continue;
    const hasNewUpdate = status.updateRevision > (previous?.updateRevision || 0);
    next[status.id] = {
      ...status,
      unread: status.id === viewedSessionId ? false : Boolean(previous?.unread || (hasNewUpdate && status.state === "ready")),
    };
  }
  return next;
}

export function acknowledgeSessionStatus(current: SessionStatusMap, sessionId: string): SessionStatusMap {
  const status = current[sessionId];
  if (!status?.unread) return current;
  return { ...current, [sessionId]: { ...status, unread: false } };
}
