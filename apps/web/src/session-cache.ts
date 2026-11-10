import type { AgentSnapshot } from "./types";

export const SESSION_CACHE_LIMIT = 5;

const snapshots = new Map<string, AgentSnapshot>();

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

export function deleteCachedSessionSnapshot(key: string): void {
  snapshots.delete(key);
}
