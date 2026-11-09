export type AppPage = "agent" | "files" | "terminal" | "settings";

export interface PermalinkTarget {
  workspaceId?: string;
  sessionId?: string;
  messageNumber?: number;
  page: AppPage;
}

export function readPermalink(): PermalinkTarget {
  const params = new URLSearchParams(window.location.search);
  const rawMessage = Number(params.get("message"));
  const rawPage = params.get("page");
  const page: AppPage = rawPage === "files" || rawPage === "terminal" || rawPage === "settings" ? rawPage : "agent";
  return {
    workspaceId: params.get("workspace") || undefined,
    sessionId: params.get("session") || undefined,
    messageNumber: Number.isInteger(rawMessage) && rawMessage > 0 ? rawMessage : undefined,
    page,
  };
}

export interface InternalSessionTarget {
  workspaceId: string;
  sessionId: string;
  messageNumber?: number;
}

export function internalSessionLink(workspaceId: string, sessionId: string): string {
  return `pi-ark://workspace/${encodeURIComponent(workspaceId)}/session/${encodeURIComponent(sessionId)}`;
}

export function internalMessageLink(workspaceId: string, sessionId: string, messageNumber: number): string {
  return `${internalSessionLink(workspaceId, sessionId)}/message/${messageNumber}`;
}

export function parseInternalSessionLink(value: string): InternalSessionTarget | undefined {
  const match = /^pi-ark:\/\/workspace\/([^/]+)\/session\/([^/]+)(?:\/message\/(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const messageNumber = match[3] ? Number(match[3]) : undefined;
  if (messageNumber != null && (!Number.isInteger(messageNumber) || messageNumber < 1)) return undefined;
  try { return { workspaceId: decodeURIComponent(match[1]), sessionId: decodeURIComponent(match[2]), messageNumber }; }
  catch { return undefined; }
}

export function sessionPermalink(workspaceId: string, sessionId: string, messageNumber?: number): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("page", "agent");
  url.searchParams.set("workspace", workspaceId);
  url.searchParams.set("session", sessionId);
  if (messageNumber) url.searchParams.set("message", String(messageNumber));
  return url.toString();
}

export function appLocation(page: AppPage, workspaceId?: string, sessionId?: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("page", page);
  if (workspaceId) url.searchParams.set("workspace", workspaceId);
  if (workspaceId && sessionId) url.searchParams.set("session", sessionId);
  return `${url.pathname}${url.search}`;
}

export function workspaceLocation(workspaceId: string): string {
  return appLocation("agent", workspaceId);
}

export function sessionLocation(workspaceId: string, sessionId: string): string {
  return appLocation("agent", workspaceId, sessionId);
}
