import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, sessionEntryToContextMessages, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { WebSocket } from "ws";
import type { WorkspaceDefinition } from "./config.js";
import { ensureWorkspaceState, loadWorkspaceSettings, piArkAgentDir } from "./config.js";
import { getSessionMetadata, listSessionGroups, removeSessionMetadata, setSessionMetadata } from "./session-metadata.js";
import type { SettingsService } from "./settings.js";
import { saveAttachments, type IncomingAttachment, type SavedAttachment } from "./attachments.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type QueueItemMode = "steering" | "followUp";
interface QueueItem { id: string; mode: QueueItemMode; text: string; images: Array<NonNullable<SavedAttachment["image"]>> }
interface RollbackMarkerData { targetId: string; restoreEntryId: string; draft: string }
interface AgentHandle {
  session: AgentSession;
  clients: Set<WebSocket>;
  unsubscribe: () => void;
  queue: QueueItem[];
  rebuildingQueue: boolean;
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function isCompletedAssistantOutput(message: { role: string; content?: unknown; stopReason?: string }): boolean {
  if (message.role !== "assistant" || message.stopReason === "pending") return false;
  if (typeof message.content === "string") return Boolean(message.content.trim());
  return Array.isArray(message.content) && message.content.some((block) => block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" && Boolean(block.text.trim()));
}

function rollbackTargetEntryId(branch: ReturnType<SessionManager["getBranch"]>, latestUserIndex: number): string | undefined {
  let latestMessageId: string | undefined;
  for (let index = branch.length - 1; index > latestUserIndex; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "message") continue;
    latestMessageId ||= entry.id;
    if (isCompletedAssistantOutput(entry.message)) return entry.id;
  }
  return latestMessageId;
}

function userMessageText(message: unknown): string {
  const content = typeof message === "object" && message !== null && "content" in message ? message.content : undefined;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((block) => block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("\n\n") : "";
  return text.split("\n\nAttached files:\n", 1)[0].trim();
}

function isRollbackMarkerData(data: unknown): data is RollbackMarkerData {
  return typeof data === "object" && data !== null && "targetId" in data && typeof data.targetId === "string" && "restoreEntryId" in data && typeof data.restoreEntryId === "string" && "draft" in data && typeof data.draft === "string";
}

export function buildSessionDisplayMessages(manager: SessionManager, getContextWindow: (provider: string, model: string) => number | undefined = () => undefined) {
  return manager.getBranch().flatMap((entry) => sessionEntryToContextMessages(entry).filter((message) => message.role !== "system" && !(message.role === "custom" && !message.display)).map((message) => ({
    ...message,
    entryId: entry.id,
    ...(message.role === "assistant" ? { contextWindow: getContextWindow(message.provider, message.model) } : {}),
  })));
}

export class AgentService {
  private readonly handles = new Map<string, AgentHandle>();
  private readonly scheduledSnapshots = new WeakSet<AgentHandle>();

  constructor(private readonly settings: SettingsService) {}

  private key(workspace: WorkspaceDefinition, sessionId: string): string {
    return `${workspace.id}:${sessionId}`;
  }

  async list(workspace: WorkspaceDefinition) {
    const sessionDir = await ensureWorkspaceState(workspace);
    const [sessions, metadata] = await Promise.all([SessionManager.list(workspace.path, sessionDir), getSessionMetadata(workspace)]);
    return sessions.map(({ path: _path, ...info }) => ({ ...info, pinned: metadata[info.id]?.pinned || false, archived: metadata[info.id]?.archived || false, groups: metadata[info.id]?.groups || [] })).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.modified.getTime() - a.modified.getTime());
  }

  async updateSession(workspace: WorkspaceDefinition, sessionId: string, patch: { name?: string; pinned?: boolean; archived?: boolean; groups?: string[] }) {
    const cached = this.handles.get(this.key(workspace, sessionId));
    const sessionDir = await ensureWorkspaceState(workspace);
    const info = (await SessionManager.list(workspace.path, sessionDir)).find((session) => session.id === sessionId);
    if (!cached && !info) throw Object.assign(new Error("Unknown agent session"), { statusCode: 404 });
    let handle = cached;
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw Object.assign(new Error("Session title is required"), { statusCode: 400 });
      handle ||= await this.getOrOpen(workspace, sessionId);
      handle.session.setSessionName(name);
    }
    if (patch.groups !== undefined) {
      const knownGroups = new Set((await listSessionGroups(workspace)).map((group) => group.id));
      if (patch.groups.some((groupId) => !knownGroups.has(groupId))) throw Object.assign(new Error("Unknown session group"), { statusCode: 400 });
      patch.groups = [...new Set(patch.groups)];
    }
    const metadataPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "name")) as { pinned?: boolean; archived?: boolean; groups?: string[] };
    const current = (await getSessionMetadata(workspace))[sessionId] || { pinned: false, archived: false, groups: [], updatedAt: new Date(0).toISOString() };
    const metadata = Object.keys(metadataPatch).length ? await setSessionMetadata(workspace, sessionId, metadataPatch) : current;
    if (handle) this.sendSnapshot(handle);
    return { name: handle?.session.sessionName || info?.name, ...metadata };
  }

  async setModel(workspace: WorkspaceDefinition, sessionId: string, provider: string, modelId: string): Promise<void> {
    const handle = await this.getOrOpen(workspace, sessionId);
    await handle.session.setModel(await this.settings.resolveModel(provider, modelId));
    this.sendSnapshot(handle);
  }

  async setThinkingLevel(workspace: WorkspaceDefinition, sessionId: string, level: string): Promise<void> {
    if (!THINKING_LEVELS.includes(level as ThinkingLevel)) throw Object.assign(new Error("Invalid thinking level"), { statusCode: 400 });
    const handle = await this.getOrOpen(workspace, sessionId);
    handle.session.setThinkingLevel(level as ThinkingLevel);
    this.sendSnapshot(handle);
  }

  async fork(workspace: WorkspaceDefinition, sessionId: string, entryId: string): Promise<{ id: string }> {
    const handle = await this.getOrOpen(workspace, sessionId);
    if (!handle.session.isIdle) throw Object.assign(new Error("Wait for the session to finish before forking"), { statusCode: 409 });
    const entry = handle.session.sessionManager.getEntry(entryId);
    if (entry?.type !== "message" || entry.message.role !== "assistant") throw Object.assign(new Error("Fork target must be an assistant output"), { statusCode: 400 });
    if (!handle.session.sessionManager.getBranch().some((item) => item.id === entryId)) throw Object.assign(new Error("Fork target is not on the active conversation"), { statusCode: 409 });
    const sourcePath = handle.session.sessionFile;
    if (!sourcePath) throw new Error("Session storage is unavailable");
    const sessionDirectory = await ensureWorkspaceState(workspace);
    const forkManager = SessionManager.open(sourcePath, sessionDirectory);
    const path = forkManager.createBranchedSession(entryId);
    if (!path) throw new Error("Session storage is unavailable");
    const forked = await this.instantiate(workspace, SessionManager.open(path, sessionDirectory));
    if (handle.session.sessionName) forked.session.setSessionName(`${handle.session.sessionName} (fork)`);
    return { id: forked.session.sessionId };
  }

  async rollbackLatest(workspace: WorkspaceDefinition, sessionId: string, requestedEntryId?: string): Promise<RollbackMarkerData & { id: string }> {
    const handle = await this.getOrOpen(workspace, sessionId);
    if (!handle.session.isIdle || handle.session.pendingMessageCount > 0) throw Object.assign(new Error("Wait for the session and queue to finish before rolling back"), { statusCode: 409 });
    const manager = handle.session.sessionManager;
    if (this.rollbackState(handle)) throw Object.assign(new Error("Restore the rolled back message or send a new message before another rollback"), { statusCode: 409 });
    const branch = manager.getBranch();
    let latestUserIndex = -1;
    for (let index = branch.length - 1; index >= 0; index -= 1) { const entry = branch[index]; if (entry.type === "message" && entry.message.role === "user") { latestUserIndex = index; break; } }
    const latestAssistantId = rollbackTargetEntryId(branch, latestUserIndex);
    if (!latestAssistantId || (requestedEntryId && latestAssistantId !== requestedEntryId)) throw Object.assign(new Error("Only the latest conversation message can be rolled back"), { statusCode: 409 });
    const latestUserEntry = branch[latestUserIndex];
    if (latestUserEntry.type !== "message") throw Object.assign(new Error("Latest user message is unavailable"), { statusCode: 409 });
    const restoreEntryId = manager.getLeafId();
    if (!restoreEntryId) throw Object.assign(new Error("Rollback source is unavailable"), { statusCode: 409 });
    if (latestUserEntry.parentId) {
      const result = await handle.session.navigateTree(latestUserEntry.parentId, { summarize: false });
      if (result.cancelled) throw Object.assign(new Error("Rollback was cancelled"), { statusCode: 409 });
    } else manager.resetLeaf();
    manager.appendCustomEntry("pi-ark.rollback", { targetId: latestAssistantId, restoreEntryId, draft: userMessageText(latestUserEntry.message) } satisfies RollbackMarkerData);
    handle.session.refreshContext();
    const rollback = this.rollbackState(handle)!;
    this.sendSnapshot(handle);
    return rollback;
  }

  async restoreRollback(workspace: WorkspaceDefinition, sessionId: string): Promise<void> {
    const handle = await this.getOrOpen(workspace, sessionId);
    if (!handle.session.isIdle || handle.session.pendingMessageCount > 0) throw Object.assign(new Error("Wait for the session and queue to finish before restoring"), { statusCode: 409 });
    const rollback = this.rollbackState(handle);
    if (!rollback) throw Object.assign(new Error("Rolled back message is no longer available to restore"), { statusCode: 409 });
    const result = await handle.session.navigateTree(rollback.restoreEntryId, { summarize: false });
    if (result.cancelled) throw Object.assign(new Error("Restore was cancelled"), { statusCode: 409 });
    handle.session.sessionManager.appendCustomEntry("pi-ark.rollback-restored", { rollbackId: rollback.id });
    handle.session.refreshContext();
    this.sendSnapshot(handle);
  }

  async updateQueue(workspace: WorkspaceDefinition, sessionId: string, itemId: string, update: { direction?: "up" | "down"; mode?: QueueItemMode }): Promise<void> {
    if (update.direction && update.direction !== "up" && update.direction !== "down") throw Object.assign(new Error("Unknown queue direction"), { statusCode: 400 });
    if (update.mode && update.mode !== "steering" && update.mode !== "followUp") throw Object.assign(new Error("Unknown queue mode"), { statusCode: 400 });
    const handle = await this.getOrOpen(workspace, sessionId);
    if (handle.rebuildingQueue) throw Object.assign(new Error("Queue update is already in progress"), { statusCode: 409 });
    const index = handle.queue.findIndex((item) => item.id === itemId);
    if (index < 0) throw Object.assign(new Error("Queued message is no longer available"), { statusCode: 404 });
    const item = handle.queue[index];
    if (update.mode && update.mode !== item.mode) {
      handle.queue.splice(index, 1);
      item.mode = update.mode;
      let lastTarget = -1;
      for (let queuedIndex = handle.queue.length - 1; queuedIndex >= 0; queuedIndex -= 1) if (handle.queue[queuedIndex].mode === update.mode) { lastTarget = queuedIndex; break; }
      handle.queue.splice(lastTarget + 1, 0, item);
    } else if (update.direction) {
      const siblings = handle.queue.map((queued, queuedIndex) => queued.mode === item.mode ? queuedIndex : -1).filter((queuedIndex) => queuedIndex >= 0);
      const siblingIndex = siblings.indexOf(index);
      const targetSibling = update.direction === "up" ? siblingIndex - 1 : siblingIndex + 1;
      if (targetSibling < 0 || targetSibling >= siblings.length) return;
      const targetIndex = siblings[targetSibling];
      [handle.queue[index], handle.queue[targetIndex]] = [handle.queue[targetIndex], handle.queue[index]];
    } else throw Object.assign(new Error("Provide a queue update"), { statusCode: 400 });
    await this.rebuildQueue(handle);
  }

  async takeQueuedMessage(workspace: WorkspaceDefinition, sessionId: string, itemId: string): Promise<{ text: string }> {
    const handle = await this.getOrOpen(workspace, sessionId);
    if (handle.rebuildingQueue) throw Object.assign(new Error("Queue update is already in progress"), { statusCode: 409 });
    const index = handle.queue.findIndex((item) => item.id === itemId);
    if (index < 0) throw Object.assign(new Error("Queued message is no longer available"), { statusCode: 404 });
    const [item] = handle.queue.splice(index, 1);
    await this.rebuildQueue(handle);
    return { text: item.text };
  }

  async mergeFollowUps(workspace: WorkspaceDefinition, sessionId: string): Promise<void> {
    const handle = await this.getOrOpen(workspace, sessionId);
    if (handle.rebuildingQueue) throw Object.assign(new Error("Queue update is already in progress"), { statusCode: 409 });
    const followUps = handle.queue.filter((item) => item.mode === "followUp");
    if (followUps.length < 2) return;
    const firstFollowUpIndex = handle.queue.findIndex((item) => item.mode === "followUp");
    const merged: QueueItem = { id: followUps[0].id, mode: "followUp", text: followUps.map((item) => item.text).join("\n\n"), images: followUps.flatMap((item) => item.images) };
    handle.queue = handle.queue.filter((item) => item.mode !== "followUp");
    handle.queue.splice(firstFollowUpIndex, 0, merged);
    await this.rebuildQueue(handle);
  }

  async delete(workspace: WorkspaceDefinition, sessionId: string): Promise<void> {
    const sessionDir = await ensureWorkspaceState(workspace);
    const info = (await SessionManager.list(workspace.path, sessionDir)).find((session) => session.id === sessionId);
    if (!info) throw Object.assign(new Error("Unknown agent session"), { statusCode: 404 });
    const key = this.key(workspace, sessionId);
    const handle = this.handles.get(key);
    if (handle) {
      this.broadcast(handle, { type: "session-deleted" });
      handle.session.clearQueue();
      if (!handle.session.isIdle) await handle.session.abort();
      handle.unsubscribe();
      handle.session.dispose();
      for (const client of handle.clients) client.close(1000, "Session deleted");
      this.handles.delete(key);
    }
    await unlink(info.path);
    await rm(join(workspace.path, ".pi-ark", "attachments", sessionId), { recursive: true, force: true });
    await removeSessionMetadata(workspace, sessionId);
  }

  async create(workspace: WorkspaceDefinition): Promise<{ id: string }> {
    const sessionDir = await ensureWorkspaceState(workspace);
    const manager = SessionManager.create(workspace.path, sessionDir);
    const handle = await this.instantiate(workspace, manager);
    return { id: handle.session.sessionId };
  }

  async connect(workspace: WorkspaceDefinition, sessionId: string, socket: WebSocket): Promise<() => void> {
    const handle = await this.getOrOpen(workspace, sessionId);
    handle.clients.add(socket);
    this.sendSnapshot(handle, socket);
    return () => handle.clients.delete(socket);
  }

  async prompt(workspace: WorkspaceDefinition, sessionId: string, text: string, attachments: IncomingAttachment[] = []): Promise<void> {
    const handle = await this.getOrOpen(workspace, sessionId);
    const saved = attachments.length ? await saveAttachments(workspace, sessionId, attachments) : [];
    const attachmentNote = saved.length ? `\n\nAttached files:\n${saved.map((attachment) => `- ${attachment.name}: ${attachment.path}`).join("\n")}` : "";
    const promptText = `${text.trim() || (saved.length ? "Review the attached files." : "")}${attachmentNote}`;
    const images = saved.flatMap((attachment) => attachment.image ? [attachment.image] : []);
    if (handle.session.isStreaming) {
      const queued: QueueItem = { id: randomUUID(), mode: "followUp", text: promptText, images };
      handle.queue.push(queued);
      try { await handle.session.followUp(promptText, images); }
      catch (error) { handle.queue = handle.queue.filter((item) => item.id !== queued.id); throw error; }
    } else await handle.session.prompt(promptText, { images });
  }

  async abort(workspace: WorkspaceDefinition, sessionId: string): Promise<void> {
    const handle = await this.getOrOpen(workspace, sessionId);
    handle.session.clearQueue();
    if (!handle.session.isIdle) await handle.session.abort();
  }

  private async getOrOpen(workspace: WorkspaceDefinition, sessionId: string): Promise<AgentHandle> {
    const cached = this.handles.get(this.key(workspace, sessionId));
    if (cached) return cached;
    const sessionDir = await ensureWorkspaceState(workspace);
    const sessions = await SessionManager.list(workspace.path, sessionDir);
    const info = sessions.find((session) => session.id === sessionId);
    if (!info) throw Object.assign(new Error("Unknown agent session"), { statusCode: 404 });
    return this.instantiate(workspace, SessionManager.open(info.path, sessionDir));
  }

  async getGlobalSystemPrompt(workspace: WorkspaceDefinition): Promise<{ content: string; systemPromptPath: string; appendSystemPromptPath: string }> {
    const workspaceSettings = await loadWorkspaceSettings(workspace);
    const agentDir = piArkAgentDir;
    const systemPromptPath = join(agentDir, "SYSTEM.md");
    const appendSystemPromptPath = join(agentDir, "APPEND_SYSTEM.md");
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace.path,
      agentDir,
      ...(existsSync(systemPromptPath) ? { systemPrompt: systemPromptPath } : { systemPromptOverride: () => undefined }),
      appendSystemPrompt: existsSync(appendSystemPromptPath) ? [appendSystemPromptPath] : [],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd: workspace.path, sessionManager: SessionManager.inMemory(), tools: workspaceSettings.agent.tools, resourceLoader });
    try { return { content: session.systemPrompt, systemPromptPath, appendSystemPromptPath }; }
    finally { session.dispose(); }
  }

  private async createResourceLoader(workspace: WorkspaceDefinition, workspaceAppend: string): Promise<DefaultResourceLoader> {
    const resourceLoader = new DefaultResourceLoader({ cwd: workspace.path, agentDir: piArkAgentDir, ...(workspaceAppend ? { appendSystemPromptOverride: (base: string[]) => [...base, workspaceAppend] } : {}) });
    await resourceLoader.reload();
    return resourceLoader;
  }

  private async instantiate(workspace: WorkspaceDefinition, manager: SessionManager): Promise<AgentHandle> {
    const workspaceSettings = await loadWorkspaceSettings(workspace);
    const resourceLoader = await this.createResourceLoader(workspace, workspaceSettings.agent.systemPrompt.append);
    const modelConfiguration = await this.settings.getSessionModelConfiguration();
    const hasExistingSession = manager.buildSessionContext().messages.length > 0;
    const { session, modelFallbackMessage } = await createAgentSession({ cwd: workspace.path, sessionManager: manager, tools: workspaceSettings.agent.tools, resourceLoader, model: hasExistingSession ? undefined : modelConfiguration.model, scopedModels: modelConfiguration.scopedModels });
    const handle: AgentHandle = {
      session,
      clients: new Set(),
      unsubscribe: () => undefined,
      queue: [...session.getSteeringMessages().map((text) => ({ id: randomUUID(), mode: "steering" as const, text, images: [] })), ...session.getFollowUpMessages().map((text) => ({ id: randomUUID(), mode: "followUp" as const, text, images: [] }))],
      rebuildingQueue: false,
    };
    handle.unsubscribe = session.subscribe((event) => this.onEvent(handle, event));
    this.handles.set(this.key(workspace, session.sessionId), handle);
    if (modelFallbackMessage) this.broadcast(handle, { type: "notice", message: modelFallbackMessage });
    return handle;
  }

  private onEvent(handle: AgentHandle, event: AgentSessionEvent): void {
    if (event.type === "queue_update") {
      if (handle.rebuildingQueue) return;
      this.syncQueue(handle, event.steering, event.followUp);
    }
    this.broadcast(handle, { type: "agent-event", event });
    if (event.type === "message_end" || event.type === "agent_settled" || event.type === "queue_update") this.scheduleSnapshot(handle);
  }

  private scheduleSnapshot(handle: AgentHandle): void {
    if (this.scheduledSnapshots.has(handle)) return;
    this.scheduledSnapshots.add(handle);
    setTimeout(() => {
      this.scheduledSnapshots.delete(handle);
      if ([...this.handles.values()].includes(handle)) this.sendSnapshot(handle);
    }, 0);
  }

  private syncQueue(handle: AgentHandle, steering: readonly string[], followUp: readonly string[]): void {
    const remaining = [...handle.queue];
    const take = (mode: QueueItemMode, text: string): QueueItem => {
      const index = remaining.findIndex((item) => item.mode === mode && item.text === text);
      if (index >= 0) return remaining.splice(index, 1)[0];
      return { id: randomUUID(), mode, text, images: [] };
    };
    handle.queue = [...steering.map((text) => take("steering", text)), ...followUp.map((text) => take("followUp", text))];
  }

  private async rebuildQueue(handle: AgentHandle): Promise<void> {
    const queue = [...handle.queue];
    handle.rebuildingQueue = true;
    try {
      handle.session.clearQueue();
      for (const item of queue.filter((queued) => queued.mode === "steering")) await handle.session.steer(item.text, item.images);
      for (const item of queue.filter((queued) => queued.mode === "followUp")) await handle.session.followUp(item.text, item.images);
    } finally { handle.rebuildingQueue = false; }
    this.syncQueue(handle, handle.session.getSteeringMessages(), handle.session.getFollowUpMessages());
    this.sendSnapshot(handle);
  }

  private rollbackState(handle: AgentHandle): (RollbackMarkerData & { id: string }) | undefined {
    const leaf = handle.session.sessionManager.getLeafEntry();
    return leaf?.type === "custom" && leaf.customType === "pi-ark.rollback" && isRollbackMarkerData(leaf.data) ? { id: leaf.id, ...leaf.data } : undefined;
  }

  private rollbackEntryId(handle: AgentHandle): string | undefined {
    if (!handle.session.isIdle || handle.session.pendingMessageCount > 0 || this.rollbackState(handle)) return undefined;
    const manager = handle.session.sessionManager;
    const branch = manager.getBranch();
    let latestUserIndex = -1;
    for (let index = branch.length - 1; index >= 0; index -= 1) { const entry = branch[index]; if (entry.type === "message" && entry.message.role === "user") { latestUserIndex = index; break; } }
    if (latestUserIndex < 0) return undefined;
    return rollbackTargetEntryId(branch, latestUserIndex);
  }

  private snapshotMessages(handle: AgentHandle) {
    return buildSessionDisplayMessages(handle.session.sessionManager, (provider, model) => this.settings.getModelContextWindow(provider, model));
  }

  private sendSnapshot(handle: AgentHandle, oneClient?: WebSocket): void {
    const payload = {
      type: "snapshot",
      session: {
        id: handle.session.sessionId,
        name: handle.session.sessionName,
        messages: this.snapshotMessages(handle),
        isStreaming: handle.session.isStreaming,
        isIdle: handle.session.isIdle,
        model: handle.session.model ? { provider: handle.session.model.provider, id: handle.session.model.id } : null,
        thinkingLevel: handle.session.thinkingLevel,
        availableThinkingLevels: handle.session.getAvailableThinkingLevels(),
        queue: handle.queue.map(({ id, mode, text }) => ({ id, mode, text })),
        rollbackEntryId: this.rollbackEntryId(handle),
        rollback: this.rollbackState(handle),
        stats: handle.session.getSessionStats(),
      },
    };
    if (oneClient) send(oneClient, payload);
    else this.broadcast(handle, payload);
  }

  private broadcast(handle: AgentHandle, payload: unknown): void {
    for (const client of handle.clients) send(client, payload);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.handles.values()].map(async (handle) => {
      handle.unsubscribe();
      if (!handle.session.isIdle) await handle.session.abort();
      handle.session.dispose();
    }));
    this.handles.clear();
  }
}
