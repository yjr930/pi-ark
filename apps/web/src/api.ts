async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || response.statusText);
  }
  return response.json() as Promise<T>;
}

export const api = {
  session: () => request<{ authenticated: boolean; username: string }>("/api/auth/session"),
  login: (username: string, password: string) => request<{ authenticated: boolean }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ authenticated: boolean }>("/api/auth/logout", { method: "POST" }),
  workspaces: () => request<{ workspaces: import("./types").Workspace[] }>("/api/workspaces"),
  sessions: (workspaceId: string) => request<{ sessions: import("./types").SessionInfo[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`),
  createSession: (workspaceId: string) => request<{ id: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`, { method: "POST" }),
  files: (workspaceId: string, path: string) => request<{ entries: import("./types").FileEntry[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(path)}`),
  file: (workspaceId: string, path: string) => request<import("./types").FileContent>(`/api/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(path)}`),
};

export function websocketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}
