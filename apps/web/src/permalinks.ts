export type AppPage = "agent" | "files" | "terminal" | "settings";

export interface PermalinkTarget {
  workspaceId?: string;
  sessionId?: string;
  messageId?: string;
  page: AppPage;
}

function validMessageTarget(value: string | null): string | undefined {
  const target = value?.trim();
  return target && (/^m[0-9a-z]{6}$/.test(target) || /^[1-9]\d*$/.test(target)) ? target : undefined;
}

export function readPermalink(): PermalinkTarget {
  const params = new URLSearchParams(window.location.search);
  const messageId = validMessageTarget(params.get("message"));
  const rawPage = params.get("page");
  const page: AppPage = rawPage === "files" || rawPage === "terminal" || rawPage === "settings" ? rawPage : "agent";
  return {
    workspaceId: params.get("workspace") || undefined,
    sessionId: params.get("session") || undefined,
    messageId,
    page,
  };
}

export interface InternalSessionTarget {
  workspaceId: string;
  sessionId: string;
  messageId?: string;
}

export function internalSessionLink(workspaceId: string, sessionId: string): string {
  return `pi-ark://workspace/${encodeURIComponent(workspaceId)}/session/${encodeURIComponent(sessionId)}`;
}

export function internalMessageLink(workspaceId: string, sessionId: string, messageId: string): string {
  return `${internalSessionLink(workspaceId, sessionId)}/message/${encodeURIComponent(messageId)}`;
}

export function parseInternalSessionLink(value: string): InternalSessionTarget | undefined {
  const match = /^pi-ark:\/\/workspace\/([^/]+)\/session\/([^/]+)(?:\/message\/([^/]+))?$/.exec(value.trim());
  if (!match) return undefined;
  try {
    const messageId = validMessageTarget(match[3] ? decodeURIComponent(match[3]) : null);
    if (match[3] && !messageId) return undefined;
    return { workspaceId: decodeURIComponent(match[1]), sessionId: decodeURIComponent(match[2]), messageId };
  } catch { return undefined; }
}

export function sessionPermalink(workspaceId: string, sessionId: string, messageId?: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("page", "agent");
  url.searchParams.set("workspace", workspaceId);
  url.searchParams.set("session", sessionId);
  if (messageId) url.searchParams.set("message", messageId);
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
