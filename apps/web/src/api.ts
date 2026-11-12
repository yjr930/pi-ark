import { withBasePath } from "./base-path";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(withBasePath(path), {
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
  workspaces: () => request<{ workspaces: import("./types").Workspace[] }>("/api/workspaces"),
  addWorkspace: (workspace: { name?: string; path: string }) => request<import("./types").Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify(workspace) }),
  renameWorkspace: (workspaceId: string, name: string) => request<import("./types").Workspace>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  closeWorkspace: (workspaceId: string) => request<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: "DELETE" }),
  moveWorkspace: (workspaceId: string, direction: "up" | "down") => request<{ workspaces: import("./types").Workspace[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/move`, { method: "POST", body: JSON.stringify({ direction }) }),
  resolveFileLinks: (workspaceId: string, paths: string[], basePath = "") => request<{ links: Array<{ input: string; path: string; type: "file" | "directory" }> }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/file-links/resolve`, { method: "POST", body: JSON.stringify({ paths, basePath }) }),
  directories: (path: string) => request<{ basePath: string; directories: Array<{ name: string; path: string }> }>(`/api/directories?path=${encodeURIComponent(path)}`),
  globalSettings: () => request<import("./types").GlobalSettings>("/api/settings/global"),
  releaseInfo: (checkLatest = false) => request<import("./types").ReleaseInfo>(`/api/settings/release${checkLatest ? "?latest=true" : ""}`),
  updateRelease: () => request<import("./types").ReleaseInfo>("/api/settings/release/update", { method: "POST" }),
  rollbackRelease: () => request<import("./types").ReleaseInfo>("/api/settings/release/rollback", { method: "POST" }),
  saveGlobalSettings: (settings: Omit<import("./types").GlobalSettings, "providers"> & { apiKey?: string }) => request<import("./types").GlobalSettings>("/api/settings/global", { method: "PUT", body: JSON.stringify(settings) }),
  saveGlobalAgentDefaults: (settings: Pick<import("./types").GlobalSettings, "steeringMode" | "followUpMode" | "compactionEnabled" | "retryEnabled">) => request<typeof settings>("/api/settings/agent-defaults", { method: "PUT", body: JSON.stringify(settings) }),
  providerModels: (provider: string) => request<{ models: import("./types").ModelOption[] }>(`/api/settings/models?provider=${encodeURIComponent(provider)}`),
  modelPreferences: () => request<import("./types").ModelPreferences>("/api/settings/model-preferences"),
  saveModelPreferences: (preferences: Omit<import("./types").ModelPreferences, "models"> & { enabledModels: string[] }) => request<import("./types").ModelPreferences>("/api/settings/model-preferences", { method: "PUT", body: JSON.stringify(preferences) }),
  saveProviderApiKey: (providerId: string, apiKey: string) => request<import("./types").GlobalSettings>(`/api/settings/providers/${encodeURIComponent(providerId)}/api-key`, { method: "POST", body: JSON.stringify({ apiKey }) }),
  disconnectProvider: (providerId: string) => request<import("./types").GlobalSettings>(`/api/settings/providers/${encodeURIComponent(providerId)}/credential`, { method: "DELETE" }),
  sessionModels: () => request<{ models: import("./types").SessionModelOption[] }>("/api/settings/session-models"),
  startSubscriptionLogin: (providerId: string) => request<import("./types").SubscriptionAuthFlow>("/api/settings/subscription-logins", { method: "POST", body: JSON.stringify({ providerId }) }),
  subscriptionLogin: (flowId: string) => request<import("./types").SubscriptionAuthFlow>(`/api/settings/subscription-logins/${encodeURIComponent(flowId)}`),
  answerSubscriptionLogin: (flowId: string, promptId: string, value: string) => request<import("./types").SubscriptionAuthFlow>(`/api/settings/subscription-logins/${encodeURIComponent(flowId)}/answer`, { method: "POST", body: JSON.stringify({ promptId, value }) }),
  cancelSubscriptionLogin: (flowId: string) => request<void>(`/api/settings/subscription-logins/${encodeURIComponent(flowId)}`, { method: "DELETE" }),
  terminalSettings: () => request<import("./types").TerminalSettingsResponse>("/api/settings/terminal"),
  saveTerminalSettings: (settings: import("./types").TerminalSettings) => request<import("./types").TerminalSettingsResponse>("/api/settings/terminal", { method: "PUT", body: JSON.stringify(settings) }),
  terminals: (workspaceId: string) => request<{ terminals: import("./types").TerminalInfo[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminals`),
  createTerminal: (workspaceId: string, dimensions: { cols?: number; rows?: number } = {}) => request<import("./types").TerminalInfo>(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminals`, { method: "POST", body: JSON.stringify(dimensions) }),
  closeTerminal: (workspaceId: string, terminalId: string) => request<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}`, { method: "DELETE" }),
  globalPreferences: () => request<import("./types").GlobalPreferences>("/api/settings/preferences"),
  saveGlobalPreferences: (settings: { files: import("./types").GlobalPreferences["files"] }) => request<import("./types").GlobalPreferences>("/api/settings/preferences", { method: "PUT", body: JSON.stringify(settings) }),
  globalSystemPrompt: () => request<{ content: string; systemPromptPath: string; appendSystemPromptPath: string }>("/api/settings/system-prompt"),
  saveGlobalSystemPrompt: (setting: import("./types").GlobalPreferences["agent"]["systemPrompt"]) => request<import("./types").GlobalPreferences>("/api/settings/system-prompt", { method: "PUT", body: JSON.stringify(setting) }),
  skills: (workspaceId: string) => request<import("./types").SkillsResponse>(`/api/skills?workspaceId=${encodeURIComponent(workspaceId)}`),
  saveSkillSelection: (selection: import("./types").SkillSelection) => request<import("./types").SkillsResponse>("/api/skills/selection", { method: "PUT", body: JSON.stringify(selection) }),
  reloadSkills: () => request<{ reloaded: number }>("/api/skills/reload", { method: "POST" }),
  extensions: (workspaceId: string) => request<import("./types").ExtensionsResponse>(`/api/extensions?workspaceId=${encodeURIComponent(workspaceId)}`),
  reloadExtensions: () => request<{ reloaded: number }>("/api/extensions/reload", { method: "POST" }),
  mcpConfigured: () => request<{ servers: import("./types").McpConfiguredServer[] }>("/api/mcp/configured"),
  mcpServers: (workspaceId: string) => request<import("./types").McpServersResponse>(`/api/mcp?workspaceId=${encodeURIComponent(workspaceId)}`),
  setMcpServerState: (name: string, enabled: boolean) => request<{ ok: true }>(`/api/mcp/servers/${encodeURIComponent(name)}/state`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  setMcpAdvanced: (name: string, enabled: boolean) => request<{ ok: true }>(`/api/mcp/servers/${encodeURIComponent(name)}/advanced`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  mcpBrowser: () => request<import("./types").McpBrowserStatus>("/api/mcp/browser"),
  installMcpBrowser: () => request<import("./types").McpBrowserStatus>("/api/mcp/install-browser", { method: "POST" }),
  notebook: (workspaceId: string) => request<{ content: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/notebook`),
  saveNotebook: (workspaceId: string, content: string) => request<{ content: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/notebook`, { method: "PUT", body: JSON.stringify({ content }) }),
  sessions: (workspaceId: string) => request<{ sessions: import("./types").SessionInfo[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`),
  sessionStatuses: (workspaceId: string) => request<{ statuses: import("./types").SessionRuntimeStatus[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/session-statuses`),
  createSession: (workspaceId: string) => request<{ id: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`, { method: "POST" }),
  updateSession: (workspaceId: string, sessionId: string, patch: { name?: string; pinned?: boolean; archived?: boolean; groups?: string[] }) => request<{ name?: string; pinned: boolean; archived: boolean; groups: string[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSession: (workspaceId: string, sessionId: string) => request<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  stopSession: (workspaceId: string, sessionId: string) => request<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }),
  subagents: (workspaceId: string, sessionId: string) => request<import("./types").SubagentSessionState>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/subagents`),
  forkSession: (workspaceId: string, sessionId: string, entryId: string) => request<{ id: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/fork`, { method: "POST", body: JSON.stringify({ entryId }) }),
  rollbackSession: (workspaceId: string, sessionId: string, entryId: string) => request<NonNullable<import("./types").AgentSnapshot["rollback"]>>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/rollback`, { method: "POST", body: JSON.stringify({ entryId }) }),
  restoreRollback: (workspaceId: string, sessionId: string) => request<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/rollback/restore`, { method: "POST" }),
  updateQueuedMessage: (workspaceId: string, sessionId: string, itemId: string, update: { direction?: "up" | "down"; mode?: "steering" | "followUp" }, operationId: string) => request<import("./types").QueueState>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}`, { method: "PATCH", body: JSON.stringify({ ...update, operationId }) }),
  takeQueuedMessage: (workspaceId: string, sessionId: string, itemId: string, operationId: string) => request<{ text: string } & import("./types").QueueState>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}?operationId=${encodeURIComponent(operationId)}`, { method: "DELETE" }),
  mergeQueuedFollowUps: (workspaceId: string, sessionId: string, operationId: string) => request<import("./types").QueueState>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/queue/merge-follow-ups`, { method: "POST", body: JSON.stringify({ operationId }) }),
  sessionGroups: (workspaceId: string) => request<{ groups: import("./types").SessionGroup[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/session-groups`),
  createSessionGroup: (workspaceId: string, name: string) => request<import("./types").SessionGroup>(`/api/workspaces/${encodeURIComponent(workspaceId)}/session-groups`, { method: "POST", body: JSON.stringify({ name }) }),
  renameSessionGroup: (workspaceId: string, groupId: string, name: string) => request<import("./types").SessionGroup>(`/api/workspaces/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteSessionGroup: (workspaceId: string, groupId: string) => request<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}`, { method: "DELETE" }),
  searchWorkspaceFiles: (workspaceId: string, query: string, limit = 20) => request<import("./types").FileSearchResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/file-search?q=${encodeURIComponent(query)}&limit=${limit}`),
  files: (workspaceId: string, path: string) => request<{ entries: import("./types").FileEntry[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(path)}`),
  file: (workspaceId: string, path: string) => request<import("./types").FileContent>(`/api/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(path)}`),
  fileImageUrl: (workspaceId: string, path: string) => withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId)}/image?path=${encodeURIComponent(path)}`),
  fileDownloadUrl: (workspaceId: string, path: string) => withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId)}/download?path=${encodeURIComponent(path)}`),
};

export function websocketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${withBasePath(path)}`;
}
