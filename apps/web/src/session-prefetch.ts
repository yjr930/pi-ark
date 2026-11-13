import { websocketUrl } from "./api";
import { cacheSessionSnapshot, sessionCacheKey } from "./session-cache";
import type { AgentSnapshot } from "./types";

export interface SessionPrefetchTarget { workspaceId: string; sessionId: string }

interface PrefetchSocket {
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface SessionPrefetcherOptions {
  createSocket?: (target: SessionPrefetchTarget) => PrefetchSocket;
  cache?: (key: string, snapshot: AgentSnapshot) => void;
  now?: () => number;
  maxConnections?: number;
  retryMs?: number;
}

export const PREFETCH_MAX_CONNECTIONS = 6;
export const PREFETCH_RETRY_MS = 3000;

/** Keeps a snapshot-only connection per running Session so its cached conversation stays current while another Session is open. */
export class SessionPrefetcher {
  private targets = new Map<string, SessionPrefetchTarget>();
  private sockets = new Map<string, PrefetchSocket>();
  private retryAt = new Map<string, number>();
  private skipKey: string | undefined;
  private active = true;
  private disposed = false;
  private readonly createSocket: (target: SessionPrefetchTarget) => PrefetchSocket;
  private readonly cache: (key: string, snapshot: AgentSnapshot) => void;
  private readonly now: () => number;
  private readonly maxConnections: number;
  private readonly retryMs: number;

  constructor(options: SessionPrefetcherOptions = {}) {
    this.createSocket = options.createSocket || ((target) => new WebSocket(this.url(target)) as unknown as PrefetchSocket);
    this.cache = options.cache || cacheSessionSnapshot;
    this.now = options.now || Date.now;
    this.maxConnections = options.maxConnections ?? PREFETCH_MAX_CONNECTIONS;
    this.retryMs = options.retryMs ?? PREFETCH_RETRY_MS;
  }

  /** Replaces the running Session targets and the Session currently shown in the conversation. */
  update(targets: SessionPrefetchTarget[], skipKey?: string): void {
    if (this.disposed) return;
    const next = new Map<string, SessionPrefetchTarget>();
    for (const target of targets) next.set(sessionCacheKey(target.workspaceId, target.sessionId), target);
    this.targets = next;
    this.skipKey = skipKey;
    this.reconcile();
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    this.reconcile();
  }

  dispose(): void {
    this.disposed = true;
    this.targets.clear();
    for (const key of [...this.sockets.keys()]) this.close(key);
    this.retryAt.clear();
  }

  private reconcile(): void {
    if (this.disposed) return;
    for (const key of [...this.sockets.keys()]) {
      if (this.active && this.targets.has(key) && key !== this.skipKey) continue;
      this.close(key);
    }
    if (!this.active) return;
    for (const [key, target] of this.targets) {
      if (this.sockets.size >= this.maxConnections) break;
      if (key === this.skipKey || this.sockets.has(key)) continue;
      if ((this.retryAt.get(key) || 0) > this.now()) continue;
      this.open(key, target);
    }
  }

  private open(key: string, target: SessionPrefetchTarget): void {
    let socket: PrefetchSocket;
    try { socket = this.createSocket(target); }
    catch { this.retryAt.set(key, this.now() + this.retryMs); return; }
    this.sockets.set(key, socket);
    let lost = false;
    const disconnected = () => {
      if (lost) return;
      lost = true;
      if (this.sockets.get(key) === socket) this.sockets.delete(key);
      this.retryAt.set(key, this.now() + this.retryMs);
    };
    socket.onmessage = (event) => this.handleMessage(key, event.data);
    socket.onclose = disconnected;
    socket.onerror = disconnected;
  }

  private close(key: string): void {
    const socket = this.sockets.get(key);
    if (!socket) return;
    this.sockets.delete(key);
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try { socket.close(); } catch { /* The socket is already closed. */ }
  }

  private handleMessage(key: string, data: unknown): void {
    if (this.disposed || key === this.skipKey || !this.targets.has(key)) return;
    let payload: { type?: string; session?: AgentSnapshot };
    try { payload = JSON.parse(String(data)); }
    catch { return; }
    if (payload?.type === "snapshot" && payload.session) this.cache(key, payload.session);
  }

  private url(target: SessionPrefetchTarget): string {
    return websocketUrl(`/ws/agent/${encodeURIComponent(target.workspaceId)}/${encodeURIComponent(target.sessionId)}?snapshotsOnly=1`);
  }
}
