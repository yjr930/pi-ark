import type { SessionInfo } from "./types";

export interface SessionSelectionInput {
  currentSessionId: string;
  sessions: Array<Pick<SessionInfo, "id" | "archived" | "subagentOrigin">>;
  removedFromActiveId?: string;
  liveSessionIds?: readonly string[];
  pendingSessionId?: string;
}

export function resolveActiveSessionId({ currentSessionId, sessions, removedFromActiveId, liveSessionIds = [], pendingSessionId }: SessionSelectionInput): string {
  const keepCurrent = Boolean(currentSessionId) && currentSessionId !== removedFromActiveId && (sessions.some((session) => session.id === currentSessionId) || currentSessionId === pendingSessionId || liveSessionIds.includes(currentSessionId));
  if (keepCurrent) return currentSessionId;
  return sessions.find((session) => !session.archived && !session.subagentOrigin)?.id || "";
}
