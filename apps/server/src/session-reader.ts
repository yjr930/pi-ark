import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkspaceDefinition } from "./config.js";
import { internalMessageLink, internalSessionLink, internalWorkspaceLink, parsePiArkLink } from "./internal-links.js";
import { buildSessionDisplayMessages, resolveDisplayMessageIndex } from "./session-display.js";
import type { WorkspaceService } from "./workspaces.js";

export const MAX_LINK_RESULT_BYTES = 48 * 1024;
export interface ReadPiArkLinkInput { link: string; context?: number; start?: number; limit?: number; offset?: number }
type DisplayMessage = ReturnType<typeof buildSessionDisplayMessages>[number];
interface ReadMessage {
  messageId: string;
  entryId: string;
  position: number;
  link: string;
  role: string;
  timestamp?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  content: string;
  contentOffset: number;
  totalContentCharacters: number;
  nextContentOffset?: number;
}
interface Pagination { start: number; end: number; total: number; hasEarlier: boolean; hasLater: boolean; nextStart?: number }
interface SessionSummary { id: string; name?: string; link: string; created: string; modified: string; messageCount: number; firstMessage: string }
export interface ReadPiArkLinkResult {
  kind: "workspace" | "session" | "message";
  workspace: { id: string; name: string; link: string };
  session?: { id: string; name?: string; link: string; leafEntryId: string | null; totalDisplayMessages: number };
  target?: { messageId: string; entryId: string; position: number; link: string };
  sessions?: SessionSummary[];
  messages?: ReadMessage[];
  pagination: Pagination;
  truncated: boolean;
}

export function serializeLinkResult(result: ReadPiArkLinkResult): string {
  return JSON.stringify(result, null, 2);
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function integerOption(name: string, value: number | undefined, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) throw failure("INVALID_ARGUMENT", `${name} must be an integer from ${minimum} to ${maximum}`);
}

function pagination(start: number, end: number, total: number): Pagination {
  return { start, end, total, hasEarlier: start > 1, hasLater: end < total, ...(end < total ? { nextStart: end + 1 } : {}) };
}

function contentText(message: DisplayMessage): string {
  if ("summary" in message && typeof message.summary === "string") return message.summary;
  if ("content" in message) {
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) return message.content.map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return `[Reasoning]\n${block.thinking}`;
      if (block.type === "toolCall") return `[Tool call ${block.name}; toolCallId=${block.id}]\n${JSON.stringify(block.arguments, null, 2)}`;
      return `[Image: ${block.mimeType}]`;
    }).join("\n\n");
  }
  if (message.role === "bashExecution") return `$ ${message.command}\n${message.output}`;
  return "";
}

function readMessage(message: DisplayMessage, workspaceId: string, sessionId: string, index: number, content: string, offset: number, length: number): ReadMessage {
  const nextOffset = offset + length;
  return {
    messageId: message.messageId,
    entryId: message.entryId,
    position: index + 1,
    link: internalMessageLink(workspaceId, sessionId, message.messageId),
    role: message.role,
    timestamp: message.timestamp,
    ...(message.role === "assistant" ? { provider: message.provider, model: message.model, stopReason: message.stopReason, errorMessage: message.errorMessage } : {}),
    ...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}),
    content: content.slice(offset, nextOffset),
    contentOffset: offset,
    totalContentCharacters: content.length,
    ...(nextOffset < content.length ? { nextContentOffset: nextOffset } : {}),
  };
}

export class SessionReader {
  constructor(private readonly workspaces: Pick<WorkspaceService, "get">, private readonly getOpenManager: (workspace: WorkspaceDefinition, sessionId: string) => SessionManager | undefined = () => undefined) {}

  async read(input: ReadPiArkLinkInput, signal?: AbortSignal): Promise<ReadPiArkLinkResult> {
    signal?.throwIfAborted();
    const target = typeof input.link === "string" ? parsePiArkLink(input.link) : undefined;
    if (!target) throw failure("INVALID_LINK", "Expected a Pi-Ark Workspace, Session, or Message link");
    integerOption("context", input.context, 0, 20);
    integerOption("start", input.start, 1);
    integerOption("limit", input.limit, 1, 100);
    integerOption("offset", input.offset, 0);
    if (target.messageId && (input.start !== undefined || input.limit !== undefined)) throw failure("INVALID_ARGUMENT", "Use context and offset with a Message link; use start and limit with a Session link");
    if (!target.messageId && (input.context !== undefined || input.offset !== undefined)) throw failure("INVALID_ARGUMENT", "context and offset require a Message link");
    let workspace: WorkspaceDefinition;
    try { workspace = this.workspaces.get(target.workspaceId); }
    catch { throw failure("UNKNOWN_WORKSPACE", "The linked Workspace is not registered in this Pi-Ark instance"); }
    const workspaceInfo = { id: workspace.id, name: workspace.name, link: internalWorkspaceLink(workspace.id) };
    if (!target.sessionId) return this.readWorkspace(workspace, workspaceInfo, input, signal);
    const manager = await this.resolveSession(workspace, target.sessionId, signal);
    signal?.throwIfAborted();
    const messages = buildSessionDisplayMessages(manager);
    const targetIndex = target.messageId ? resolveDisplayMessageIndex(messages, target.messageId) : -1;
    if (target.messageId && targetIndex < 0) throw failure("MESSAGE_NOT_FOUND", "The Message target is outside the current active branch display projection");
    const context = input.context ?? 0;
    const limit = input.limit ?? 20;
    const start = targetIndex >= 0 ? Math.max(0, targetIndex - context) : (input.start ?? Math.max(1, messages.length - limit + 1)) - 1;
    if (start > 0 && start >= messages.length) throw failure("PAGE_OUT_OF_RANGE", `start exceeds the ${messages.length} display messages`);
    const end = Math.min(messages.length, targetIndex >= 0 ? targetIndex + context + 1 : start + limit);
    const session = { id: manager.getSessionId(), name: manager.getSessionName(), link: internalSessionLink(workspace.id, manager.getSessionId()), leafEntryId: manager.getLeafId(), totalDisplayMessages: messages.length };
    const resolvedTarget = targetIndex >= 0 ? { messageId: messages[targetIndex].messageId, entryId: messages[targetIndex].entryId, position: targetIndex + 1, link: internalMessageLink(workspace.id, session.id, messages[targetIndex].messageId) } : undefined;
    const selected: ReadMessage[] = [];
    const compose = (items: ReadMessage[]): ReadPiArkLinkResult => {
      const ordered = [...items].sort((a, b) => a.position - b.position);
      return { kind: resolvedTarget ? "message" : "session", workspace: workspaceInfo, session, ...(resolvedTarget ? { target: resolvedTarget } : {}), messages: ordered, pagination: pagination(ordered[0]?.position ?? start + 1, ordered.at(-1)?.position ?? start, messages.length), truncated: ordered.length < end - start || ordered.some((item) => item.nextContentOffset !== undefined || item.contentOffset > 0) };
    };
    const indexes: number[] = [];
    if (targetIndex >= 0) {
      indexes.push(targetIndex);
      for (let distance = 1; distance <= context; distance += 1) {
        if (targetIndex - distance >= start) indexes.push(targetIndex - distance);
        if (targetIndex + distance < end) indexes.push(targetIndex + distance);
      }
    } else for (let index = start; index < end; index += 1) indexes.push(index);
    for (const index of indexes) {
      signal?.throwIfAborted();
      const content = contentText(messages[index]);
      const offset = index === targetIndex ? input.offset ?? 0 : 0;
      if (offset > content.length) throw failure("CONTENT_OUT_OF_RANGE", `offset exceeds the ${content.length} content characters`);
      const candidate = (length: number) => readMessage(messages[index], workspace.id, session.id, index, content, offset, length);
      const fits = (length: number) => Buffer.byteLength(serializeLinkResult(compose([...selected, candidate(length)])), "utf8") <= MAX_LINK_RESULT_BYTES;
      let length = content.length - offset;
      if (!fits(length)) {
        let low = 0;
        let high = length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (fits(middle)) low = middle;
          else high = middle - 1;
        }
        length = low;
        if (!fits(length) || (length === 0 && content.length > offset)) break;
      }
      selected.push(candidate(length));
      if (offset + length < content.length) break;
    }
    return compose(selected);
  }

  private async resolveSession(workspace: WorkspaceDefinition, sessionId: string, signal?: AbortSignal): Promise<SessionManager> {
    const open = this.getOpenManager(workspace, sessionId);
    if (open) return open;
    const sessionDirectory = join(workspace.path, ".pi-ark", "sessions");
    const path = SessionManager.findById(workspace.path, sessionId, sessionDirectory);
    if (!path) throw failure("UNKNOWN_SESSION", "The linked Session does not exist in this Workspace");
    const entries = parseSessionEntries(await readFile(path, { encoding: "utf8", signal }));
    if (!entries.some((entry) => entry.type === "session" && entry.id === sessionId)) throw failure("UNKNOWN_SESSION", "The linked Session header does not match");
    return SessionManager.inMemory(workspace.path, undefined, entries);
  }

  private async readWorkspace(workspace: WorkspaceDefinition, workspaceInfo: ReadPiArkLinkResult["workspace"], input: ReadPiArkLinkInput, signal?: AbortSignal): Promise<ReadPiArkLinkResult> {
    const sessions = await SessionManager.list(workspace.path, join(workspace.path, ".pi-ark", "sessions"), undefined, signal);
    signal?.throwIfAborted();
    const start = (input.start ?? 1) - 1;
    if (start > 0 && start >= sessions.length) throw failure("PAGE_OUT_OF_RANGE", `start exceeds the ${sessions.length} Sessions`);
    const requested = sessions.slice(start, start + (input.limit ?? 20));
    const result: ReadPiArkLinkResult = { kind: "workspace", workspace: workspaceInfo, sessions: [], pagination: pagination(start + 1, start, sessions.length), truncated: false };
    for (const info of requested) {
      const summary = { id: info.id, name: info.name, link: internalSessionLink(workspace.id, info.id), created: info.created.toISOString(), modified: info.modified.toISOString(), messageCount: info.messageCount, firstMessage: info.firstMessage.slice(0, 500) };
      const candidate = { ...result, sessions: [...result.sessions!, summary], pagination: pagination(start + 1, start + result.sessions!.length + 1, sessions.length), truncated: true };
      if (Buffer.byteLength(serializeLinkResult(candidate), "utf8") > MAX_LINK_RESULT_BYTES) break;
      result.sessions!.push(summary);
    }
    result.pagination = pagination(start + 1, start + result.sessions!.length, sessions.length);
    result.truncated = result.sessions!.length < requested.length;
    return result;
  }
}
