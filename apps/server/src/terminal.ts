import { randomUUID } from "node:crypto";
import type { IDisposable, IPty } from "node-pty";
import pty from "node-pty";
import type { WebSocket } from "ws";
import type { WorkspaceDefinition } from "./config.js";
import { defaultTerminalSettings, resolveTerminalShell, type TerminalSettings } from "./terminal-shells.js";

export interface TerminalInfo {
  id: string;
  title: string;
  createdAt: string;
  status: "running" | "exited";
  exitCode?: number;
  shell: string;
  cols: number;
  rows: number;
}
interface TerminalHandle {
  info: TerminalInfo;
  process: IPty;
  chunks: Array<{ start: number; data: string }>;
  offset: number;
  subscriptions: Map<WebSocket, () => void>;
  listeners: IDisposable[];
  temporary: boolean;
}
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function dimension(value: unknown, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw fail(`Terminal dimension must be an integer of at least ${minimum}`);
  return value as number;
}
function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) {
    try { socket.send(JSON.stringify(message)); } catch { /* The socket close event releases the subscriber. */ }
  }
}

export class TerminalService {
  private readonly handles = new Map<string, Map<string, TerminalHandle>>();
  private readonly nextTitle = new Map<string, number>();
  constructor(private readonly workspaces: { get(id: string): WorkspaceDefinition }) {}

  list(workspaceId: string): TerminalInfo[] {
    this.workspaces.get(workspaceId);
    return [...(this.handles.get(workspaceId)?.values() ?? [])].filter((handle) => !handle.temporary).map((handle) => ({ ...handle.info }));
  }

  create(workspaceId: string, settings: TerminalSettings = defaultTerminalSettings(), dimensions: { cols?: number; rows?: number } = {}): TerminalInfo {
    const workspace = this.workspaces.get(workspaceId);
    const cols = dimension(dimensions.cols, 100, 2);
    const rows = dimension(dimensions.rows, 30, 1);
    const shell = resolveTerminalShell(settings);
    const processPty = pty.spawn(shell.executable, shell.args, { name: "xterm-256color", cwd: workspace.path, cols, rows, env: shell.env });
    const number = (this.nextTitle.get(workspaceId) ?? 0) + 1;
    this.nextTitle.set(workspaceId, number);
    const info: TerminalInfo = { id: randomUUID(), title: `Terminal ${number}`, createdAt: new Date().toISOString(), status: "running", shell: shell.executable, cols, rows };
    const handle: TerminalHandle = { info, process: processPty, chunks: [], offset: 0, subscriptions: new Map(), listeners: [], temporary: false };
    let workspaceHandles = this.handles.get(workspaceId);
    if (!workspaceHandles) this.handles.set(workspaceId, workspaceHandles = new Map());
    workspaceHandles.set(info.id, handle);
    handle.listeners.push(processPty.onData((data) => {
      handle.chunks.push({ start: handle.offset, data });
      handle.offset += data.length;
      for (const socket of handle.subscriptions.keys()) send(socket, { type: "output", data, offset: handle.offset });
    }));
    handle.listeners.push(processPty.onExit(({ exitCode }) => {
      info.status = "exited";
      info.exitCode = exitCode;
      for (const socket of handle.subscriptions.keys()) send(socket, { type: "exit", exitCode });
      if (handle.temporary) this.release(workspaceId, info.id, handle);
    }));
    return { ...info };
  }

  private get(workspaceId: string, terminalId: string): TerminalHandle {
    this.workspaces.get(workspaceId);
    const handle = this.handles.get(workspaceId)?.get(terminalId);
    if (!handle) throw fail("Unknown terminal", 404);
    return handle;
  }

  connect(workspaceId: string, terminalId: string, socket: WebSocket, requestedOffset: unknown = 0): () => void {
    const handle = this.get(workspaceId, terminalId);
    const valid = typeof requestedOffset === "number" ? Number.isSafeInteger(requestedOffset) : typeof requestedOffset === "string" && /^\d+$/.test(requestedOffset) && Number.isSafeInteger(Number(requestedOffset));
    const offset = Number(requestedOffset);
    if (!valid || offset < 0 || offset > handle.offset) {
      send(socket, { type: "error", code: "INVALID_OFFSET", message: "Terminal offset must be a non-negative integer within the output history", offset: handle.offset });
      socket.close(1008, "Invalid terminal offset");
      return () => undefined;
    }
    // Each chunk stores its UTF-16 start, so reconnect only joins the requested suffix.
    let low = 0;
    let high = handle.chunks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const chunk = handle.chunks[middle]!;
      if (chunk.start + chunk.data.length <= offset) low = middle + 1;
      else high = middle;
    }
    const data = handle.chunks.slice(low).map((chunk, index) => index === 0 ? chunk.data.slice(Math.max(0, offset - chunk.start)) : chunk.data).join("");
    send(socket, { type: "ready", terminal: { ...handle.info }, data, offset: handle.offset });
    if (handle.info.status === "exited") send(socket, { type: "exit", exitCode: handle.info.exitCode });
    const onMessage = (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
        if (message.type === "input" && typeof message.data === "string") {
          if (handle.info.status === "running") handle.process.write(message.data);
        } else if (message.type === "resize") {
          const cols = dimension(message.cols, handle.info.cols, 2);
          const rows = dimension(message.rows, handle.info.rows, 1);
          if (handle.info.status === "running") handle.process.resize(cols, rows);
          Object.assign(handle.info, { cols, rows });
        } else throw fail("Invalid terminal message");
      } catch (error) { send(socket, { type: "error", message: error instanceof Error ? error.message : "Invalid terminal message" }); }
    };
    const disconnect = () => {
      socket.off("message", onMessage);
      socket.off("close", disconnect);
      handle.subscriptions.delete(socket);
    };
    handle.subscriptions.get(socket)?.();
    handle.subscriptions.set(socket, disconnect);
    socket.on("message", onMessage);
    socket.on("close", disconnect);
    return disconnect;
  }

  close(workspaceId: string, terminalId: string): void {
    this.release(workspaceId, terminalId, this.get(workspaceId, terminalId));
  }

  private release(workspaceId: string, terminalId: string, handle: TerminalHandle): void {
    if (this.handles.get(workspaceId)?.get(terminalId) !== handle) return;
    this.handles.get(workspaceId)!.delete(terminalId);
    if (!this.handles.get(workspaceId)!.size) this.handles.delete(workspaceId);
    for (const listener of handle.listeners) listener.dispose();
    handle.listeners = [];
    for (const [socket, disconnect] of [...handle.subscriptions]) {
      send(socket, { type: "closed" });
      disconnect();
      socket.close();
    }
    if (handle.info.status === "running") {
      try { handle.process.kill(); } catch { /* PTY exit may already be in progress. */ }
    }
    handle.chunks = [];
  }

  closeWorkspace(workspaceId: string): void {
    for (const [terminalId, handle] of this.handles.get(workspaceId) ?? []) this.release(workspaceId, terminalId, handle);
    this.nextTitle.delete(workspaceId);
  }

  dispose(): void {
    for (const workspaceId of this.handles.keys()) this.closeWorkspace(workspaceId);
    this.nextTitle.clear();
  }

  openTemporary(workspaceId: string, socket: WebSocket, settings: TerminalSettings = defaultTerminalSettings()): () => void {
    const terminal = this.create(workspaceId, settings);
    const handle = this.get(workspaceId, terminal.id);
    handle.temporary = true;
    const disconnect = this.connect(workspaceId, terminal.id, socket);
    const close = () => {
      socket.off("close", close);
      disconnect();
      if (this.handles.get(workspaceId)?.has(terminal.id)) this.release(workspaceId, terminal.id, handle);
    };
    socket.on("close", close);
    return close;
  }
}

// Release smoke clients keep their connection-scoped PTY lifecycle.
export function openTerminal(socket: WebSocket, cwd: string): () => void {
  const service = new TerminalService({ get: () => ({ id: "temporary", name: "Temporary terminal", path: cwd }) });
  return service.openTemporary("temporary", socket);
}
