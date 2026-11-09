import { createAgentSession, SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { WebSocket } from "ws";
import type { WorkspaceDefinition } from "./config.js";
import { ensureWorkspaceState } from "./config.js";

interface AgentHandle {
  session: AgentSession;
  clients: Set<WebSocket>;
  unsubscribe: () => void;
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

export class AgentService {
  private readonly handles = new Map<string, AgentHandle>();

  private key(workspace: WorkspaceDefinition, sessionId: string): string {
    return `${workspace.id}:${sessionId}`;
  }

  async list(workspace: WorkspaceDefinition) {
    const sessionDir = await ensureWorkspaceState(workspace);
    const sessions = await SessionManager.list(workspace.path, sessionDir);
    return sessions.map(({ path: _path, ...info }) => info);
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

  async prompt(workspace: WorkspaceDefinition, sessionId: string, text: string): Promise<void> {
    const handle = await this.getOrOpen(workspace, sessionId);
    if (handle.session.isStreaming) await handle.session.followUp(text);
    else await handle.session.prompt(text);
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

  private async instantiate(workspace: WorkspaceDefinition, manager: SessionManager): Promise<AgentHandle> {
    const { session, modelFallbackMessage } = await createAgentSession({ cwd: workspace.path, sessionManager: manager });
    const handle: AgentHandle = { session, clients: new Set(), unsubscribe: () => undefined };
    handle.unsubscribe = session.subscribe((event) => this.onEvent(handle, event));
    this.handles.set(this.key(workspace, session.sessionId), handle);
    if (modelFallbackMessage) this.broadcast(handle, { type: "notice", message: modelFallbackMessage });
    return handle;
  }

  private onEvent(handle: AgentHandle, event: AgentSessionEvent): void {
    this.broadcast(handle, { type: "agent-event", event });
    if (event.type === "message_end" || event.type === "agent_settled" || event.type === "queue_update") this.sendSnapshot(handle);
  }

  private sendSnapshot(handle: AgentHandle, oneClient?: WebSocket): void {
    const payload = {
      type: "snapshot",
      session: {
        id: handle.session.sessionId,
        name: handle.session.sessionName,
        messages: handle.session.messages,
        isStreaming: handle.session.isStreaming,
        isIdle: handle.session.isIdle,
        model: handle.session.model ? { provider: handle.session.model.provider, id: handle.session.model.id } : null,
        thinkingLevel: handle.session.thinkingLevel,
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
