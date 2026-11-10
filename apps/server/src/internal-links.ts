export interface PiArkLinkTarget {
  workspaceId: string;
  sessionId?: string;
  messageId?: string;
}

export interface InternalSessionTarget extends PiArkLinkTarget { sessionId: string }

export function validMessageTarget(value: string | null): string | undefined {
  const target = value?.trim();
  return target && (/^m[0-9a-z]{6}$/.test(target) || /^[1-9]\d*$/.test(target)) ? target : undefined;
}

export function internalWorkspaceLink(workspaceId: string): string {
  return `pi-ark://workspace/${encodeURIComponent(workspaceId)}`;
}

export function internalSessionLink(workspaceId: string, sessionId: string): string {
  return `${internalWorkspaceLink(workspaceId)}/session/${encodeURIComponent(sessionId)}`;
}

export function internalMessageLink(workspaceId: string, sessionId: string, messageId: string): string {
  return `${internalSessionLink(workspaceId, sessionId)}/message/${encodeURIComponent(messageId)}`;
}

export function parsePiArkLink(value: string): PiArkLinkTarget | undefined {
  const match = /^pi-ark:\/\/workspace\/([^/?#]+)(?:\/session\/([^/?#]+)(?:\/message\/([^/?#]+))?)?$/.exec(value.trim());
  if (!match) return undefined;
  try {
    const segments = match.slice(1).map((segment) => segment === undefined ? undefined : decodeURIComponent(segment));
    if (segments.some((segment) => segment !== undefined && (!segment.trim() || /[/\\\u0000]/.test(segment) || segment === "." || segment === ".."))) return undefined;
    const [workspaceId, sessionId, rawMessageId] = segments;
    const messageId = validMessageTarget(rawMessageId ?? null);
    if (rawMessageId !== undefined && !messageId) return undefined;
    return { workspaceId: workspaceId!, ...(sessionId ? { sessionId, messageId } : {}) };
  } catch { return undefined; }
}

export function parseInternalSessionLink(value: string): InternalSessionTarget | undefined {
  const target = parsePiArkLink(value);
  return target?.sessionId ? { ...target, sessionId: target.sessionId } : undefined;
}
