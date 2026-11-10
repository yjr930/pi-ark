import { validMessageTarget } from "../../server/src/internal-links";
export { internalMessageLink, internalSessionLink, parseInternalSessionLink, type InternalSessionTarget } from "../../server/src/internal-links";

export type AppPage = "agent" | "files" | "terminal" | "settings";

export interface PermalinkTarget {
  workspaceId?: string;
  sessionId?: string;
  messageId?: string;
  page: AppPage;
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
