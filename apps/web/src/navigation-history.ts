import type { PermalinkTarget } from "./permalinks";

export interface AgentReturnPosition {
  workspaceId: string;
  sessionId: string;
  messageId?: string;
  leafEntryId?: string;
  scrollTop: number;
  followOutput: boolean;
}

export function withAgentReturnPosition(state: unknown, position: AgentReturnPosition): Record<string, unknown> {
  return { ...(state && typeof state === "object" && !Array.isArray(state) ? state : {}), piArkAgentReturn: position };
}

export function readAgentReturnPosition(state: unknown, target: PermalinkTarget): AgentReturnPosition | undefined {
  if (target.page !== "agent" || !state || typeof state !== "object" || !("piArkAgentReturn" in state)) return;
  const position = state.piArkAgentReturn as AgentReturnPosition | undefined;
  if (!position || typeof position !== "object" || position.workspaceId !== target.workspaceId || position.sessionId !== target.sessionId || position.messageId !== target.messageId || position.leafEntryId !== target.leafEntryId) return;
  if (typeof position.scrollTop !== "number" || !Number.isFinite(position.scrollTop) || position.scrollTop < 0 || typeof position.followOutput !== "boolean") return;
  return position;
}
