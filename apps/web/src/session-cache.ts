import type { AgentSnapshot } from "./types";

export const SESSION_CACHE_LIMIT = 5;

export interface CachedSessionAttachment { id: string; file: File; preview?: string }
export interface SessionUiState { draft: string; attachments: CachedSessionAttachment[]; disclosures: Record<string, boolean> }

const snapshots = new Map<string, AgentSnapshot>();
const uiStates = new Map<string, SessionUiState>();

function releaseUiState(state: SessionUiState | undefined): void {
  for (const attachment of state?.attachments || []) if (attachment.preview) URL.revokeObjectURL(attachment.preview);
}

export function sessionCacheKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

export function getCachedSessionSnapshot(key: string): AgentSnapshot | undefined {
  const snapshot = snapshots.get(key);
  if (!snapshot) return undefined;
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  return snapshot;
}

export function cacheSessionSnapshot(key: string, snapshot: AgentSnapshot): void {
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  while (snapshots.size > SESSION_CACHE_LIMIT) snapshots.delete(snapshots.keys().next().value!);
}

export function getCachedSessionUiState(key: string): SessionUiState | undefined {
  const state = uiStates.get(key);
  if (!state) return undefined;
  uiStates.delete(key);
  uiStates.set(key, state);
  return state;
}

export function cacheSessionUiState(key: string, state: SessionUiState): void {
  uiStates.delete(key);
  uiStates.set(key, state);
  while (uiStates.size > SESSION_CACHE_LIMIT) {
    const oldestKey = uiStates.keys().next().value!;
    releaseUiState(uiStates.get(oldestKey));
    uiStates.delete(oldestKey);
  }
}

export function deleteCachedSessionSnapshot(key: string): void {
  snapshots.delete(key);
  releaseUiState(uiStates.get(key));
  uiStates.delete(key);
}
