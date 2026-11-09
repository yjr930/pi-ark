async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || response.statusText);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  session: () => request<{ authenticated: boolean; username: string }>("/api/auth/session"),
  login: (username: string, password: string) => request<{ authenticated: boolean }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ authenticated: boolean }>("/api/auth/logout", { method: "POST" }),
  uiSettings: () => request<{ theme: import("./types").ThemeId }>("/api/ui"),
  saveUiSettings: (theme: import("./types").ThemeId) => request<{ theme: import("./types").ThemeId }>("/api/ui", { method: "PUT", body: JSON.stringify({ theme }) }),
  workspaces: () => request<{ workspaces: import("./types").Workspace[] }>("/api/workspaces"),
  addWorkspace: (workspace: { name?: string; path: string }) => request<import("./types").Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify(workspace) }),
  renameWorkspace: (workspaceId: string, name: string) => request<import("./types").Workspace>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  closeWorkspace: (workspaceId: string) => request<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: "DELETE" }),
  directories: (path: string) => request<{ basePath: string; directories: Array<{ name: string; path: string }> }>(`/api/directories?path=${encodeURIComponent(path)}`),
  globalSettings: () => request<import("./types").GlobalSettings>("/api/settings/global"),
  releaseInfo: (checkLatest = false) => request<import("./types").ReleaseInfo>(`/api/settings/release${checkLatest ? "?latest=true" : ""}`),
  updateRelease: () => request<import("./types").ReleaseInfo>("/api/settings/release/update", { method: "POST" }),
  rollbackRelease: () => request<import("./types").ReleaseInfo>("/api/settings/release/rollback", { method: "POST" }),
  saveGlobalSettings: (settings: Omit<import("./types").GlobalSettings, "providers"> & { apiKey?: string }) => request<import("./types").GlobalSettings>("/api/settings/global", { method: "PUT", body: JSON.stringify(settings) }),
  saveGlobalAgentDefaults: (settings: Pick<import("./types").GlobalSettings, "steeringMode" | "followUpMode" | "compactionEnabled" | "retryEnabled">) => request<typeof settings>("/api/settings/agent-defaults", { method: "PUT", body: JSON.stringify(settings) }),
  providerModels: (provider: string) => request<{ models: import("./types").ModelOption[] }>(`/api/settings/models?provider=${encodeURIComponent(provider)}`),
  sessionModels: () => request<{ models: import("./types").SessionModelOption[] }>("/api/settings/session-models"),
  startSubscriptionLogin: (providerId: string) => request<import("./types").SubscriptionAuthFlow>("/api/settings/subscription-logins", { method: "POST", body: JSON.stringify({ providerId }) }),
  subscriptionLogin: (flowId: string) => request<import("./types").SubscriptionAuthFlow>(`/api/settings/subscription-logins/${encodeURIComponent(flowId)}`),
  answerSubscriptionLogin: (flowId: string, promptId: string, value: string) => request<import("./types").SubscriptionAuthFlow>(`/api/settings/subscription-logins/${encodeURIComponent(flowId)}/answer`, { method: "POST", body: JSON.stringify({ promptId, value }) }),
  cancelSubscriptionLogin: (flowId: string) => request<void>(`/api/settings/subscription-logins/${encodeURIComponent(flowId)}`, { method: "DELETE" }),
  workspaceSettings: (workspaceId: string) => request<import("./types").WorkspaceSettings>(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`),
  saveWorkspaceSettings: (workspaceId: string, settings: { agent: { tools: import("./types").WorkspaceSettings["agent"]["tools"] }; files: import("./types").WorkspaceSettings["files"] }) => request<import("./types").WorkspaceSettings>(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`, { method: "PUT", body: JSON.stringify(settings) }),
  globalSystemPrompt: (workspaceId?: string) => request<{ content: string; systemPromptPath: string; appendSystemPromptPath: string }>(`/api/settings/system-prompt${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`),
  saveWorkspaceSystemPrompt: (workspaceId: string, setting: import("./types").WorkspaceSettings["agent"]["systemPrompt"]) => request<import("./types").WorkspaceSettings>(`/api/workspaces/${encodeURIComponent(workspaceId)}/system-prompt`, { method: "PUT", body: JSON.stringify(setting) }),
  sessions: (workspaceId: string) => request<{ sessions: import("./types").SessionInfo[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`),
  createSession: (workspaceId: string) => request<{ id: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`, { method: "POST" }),
  updateSession: (workspaceId: string, sessionId: string, patch: { name?: string; pinned?: boolean; archived?: boolean; groups?: string[] }) => request<{ name?: string; pinned: boolean; archived: boolean; groups: string[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSession: (workspaceId: string, sessionId: string) => request<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  forkSession: (workspaceId: string, sessionId: string, entryId: string) => request<{ id: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/fork`, { method: "POST", body: JSON.stringify({ entryId }) }),
  rollbackSession: (workspaceId: string, sessionId: string, entryId: string) => request<NonNullable<import("./types").AgentSnapshot["rollback"]>>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/rollback`, { method: "POST", body: JSON.stringify({ entryId }) }),
  restoreRollback: (workspaceId: string, sessionId: string) => request<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/rollback/restore`, { method: "POST" }),
  updateQueuedMessage: (workspaceId: string, sessionId: string, itemId: string, update: { direction?: "up" | "down"; mode?: "steering" | "followUp" }) => request<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}`, { method: "PATCH", body: JSON.stringify(update) }),
  sessionGroups: (workspaceId: string) => request<{ groups: import("./types").SessionGroup[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/session-groups`),
  createSessionGroup: (workspaceId: string, name: string) => request<import("./types").SessionGroup>(`/api/workspaces/${encodeURIComponent(workspaceId)}/session-groups`, { method: "POST", body: JSON.stringify({ name }) }),
  renameSessionGroup: (workspaceId: string, groupId: string, name: string) => request<import("./types").SessionGroup>(`/api/workspaces/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteSessionGroup: (workspaceId: string, groupId: string) => request<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}`, { method: "DELETE" }),
  files: (workspaceId: string, path: string) => request<{ entries: import("./types").FileEntry[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(path)}`),
  file: (workspaceId: string, path: string) => request<import("./types").FileContent>(`/api/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(path)}`),
  fileImageUrl: (workspaceId: string, path: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/image?path=${encodeURIComponent(path)}`,
  fileDownloadUrl: (workspaceId: string, path: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/download?path=${encodeURIComponent(path)}`,
};

export function websocketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}
