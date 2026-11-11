import { createContext } from "react";

export const FileLinksContext = createContext<{ workspaceId: string } | undefined>(undefined);
export const FILE_LINK_DELAY_MS = 1500;
export const FILE_LINK_MAX_PATH = 2048;
export const FILE_LINK_SCAN_CHARS = 2048;
export type CancelFileLinkWork = () => void;
export type FileLinkTimer = (run: () => void, delay: number) => CancelFileLinkWork;
export interface ResolvedFileLink { input: string; path: string; type: "file" | "directory" }
export type FileLinkTransport = (workspaceId: string, paths: string[], basePath: string) => Promise<{ links: ResolvedFileLink[] }>;
const timer: FileLinkTimer = (run, delay) => { const id = setTimeout(run, delay); return () => clearTimeout(id); };

export function deferFileLinks(run: () => void, schedule: FileLinkTimer = timer, delay = FILE_LINK_DELAY_MS): CancelFileLinkWork {
  return schedule(run, delay);
}

export function stripFileLineReference(path: string): string {
  return path.replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/, "");
}

/** href decoding happens once; literal percent characters in prose remain unchanged. */
export function localFileHref(href: string): string | undefined {
  if (!href || href.length > FILE_LINK_MAX_PATH || /^[#?]/.test(href) || href.startsWith("//")) return;
  const rawPath = stripFileLineReference(href.split(/[?#]/, 1)[0]!);
  if (/^[a-z][a-z\d+.-]*:/i.test(rawPath) && !/^[a-z]:[\\/]/i.test(rawPath)) return;
  try {
    const path = stripFileLineReference(decodeURIComponent(rawPath));
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return;
    return path && !/[\u0000-\u001f\u007f]/.test(path) ? path : undefined;
  } catch { return; }
}

export function isObviousFilePath(value: string, inlineCode = false): boolean {
  if (!value || value.length > FILE_LINK_MAX_PATH || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if ((!inlineCode && /\s/.test(value)) || value.includes("@") || value.startsWith("//")) return false;
  if (/^(?:www\.|[\w.-]+\.(?:com|org|net|io|dev|edu|gov)(?:\/|$))/i.test(value)) return false;
  const path = stripFileLineReference(value);
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return false;
  if (path.includes("://") || /^[#?]/.test(path)) return false;
  if (/^(?:\.{1,2}[\\/]|\/(?!\/)|[a-z]:[\\/]|\\\\)/i.test(path)) return /[^.\\/\s]/.test(path);
  if (/[\\/]/.test(path)) return /^[\p{L}\p{N}_.~%+-]/u.test(path) && !/[<>|*?]/.test(path);
  if (/^v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/i.test(path)) return false;
  return /^(?:[\p{L}\p{N}_%+ -]+\.)+[a-z][a-z\d_-]{0,15}$/iu.test(path) || /^\.[a-z][\w.-]*$/i.test(path);
}

export interface FilePathToken { start: number; end: number; input: string }
const delimiter = /[\s<>"'`()[\]{}，。；！？、：“”‘’「」《》,;!?]/u;

/** A single step examines at most maxChars, even for a very long unbroken token. */
export class FilePathScanner {
  private offset = 0;
  private start = -1;
  private wholeCodeChecked = false;
  constructor(private readonly source: string, private readonly inlineCode = false) {}
  get done() { return this.offset >= this.source.length && this.start < 0; }
  step(maxChars = FILE_LINK_SCAN_CHARS): FilePathToken[] {
    const tokens: FilePathToken[] = [];
    if (!this.wholeCodeChecked) {
      this.wholeCodeChecked = true;
      if (this.inlineCode && this.source.length <= Math.min(FILE_LINK_MAX_PATH, maxChars)) {
        const value = this.source.trim();
        if (isObviousFilePath(value, true)) {
          const start = this.source.indexOf(value);
          this.offset = this.source.length;
          return [{ start, end: start + value.length, input: stripFileLineReference(value) }];
        }
      }
    }
    const end = Math.min(this.source.length, this.offset + Math.max(1, maxChars));
    const finish = (position: number) => {
      if (this.start < 0) return;
      if (position - this.start <= FILE_LINK_MAX_PATH) {
        const raw = this.source.slice(this.start, position).replace(/[.:]+$/, "");
        if (isObviousFilePath(raw)) tokens.push({ start: this.start, end: this.start + raw.length, input: stripFileLineReference(raw) });
      }
      this.start = -1;
    };
    while (this.offset < end) {
      if (delimiter.test(this.source[this.offset]!)) finish(this.offset);
      else if (this.start < 0) this.start = this.offset;
      this.offset += 1;
    }
    if (this.offset === this.source.length) finish(this.offset);
    return tokens;
  }
}

export interface FileLinkTextSource { readonly data: string; readonly length: number; readonly isConnected: boolean }

/** Read a Text node once; later slices validate identity, length and mutation state. */
export class FileLinkTextSnapshot<T extends FileLinkTextSource> {
  readonly scanner: FilePathScanner;
  private expectedLength: number;
  private changed = false;
  constructor(public node: T, inlineCode = false) {
    this.expectedLength = node.length;
    this.scanner = new FilePathScanner(node.data, inlineCode);
  }
  isCurrent(): boolean { return !this.changed && this.node.isConnected && this.node.length === this.expectedLength; }
  invalidate() { this.changed = true; }
  useTail(node: T) { this.node = node; this.expectedLength = node.length; this.changed = false; }
}

interface Lookup {
  key: string; workspaceId: string; basePath: string; input: string;
  state: "queued" | "loading" | "ready";
  result?: ResolvedFileLink;
  listeners: Set<(result: ResolvedFileLink | undefined) => void>;
}
interface ResolverOptions {
  now?: () => number; schedule?: FileLinkTimer; batchSize?: number; concurrency?: number;
  cacheLimit?: number; pendingLimit?: number; subscriberLimit?: number;
}

/** Shared bounded transport queue; ready callbacks are delivered in bounded batches too. */
export class FileLinkResolver {
  private readonly entries = new Map<string, Lookup>();
  private readonly cache = new Map<string, { expires: number; result?: ResolvedFileLink }>();
  private readonly now: () => number;
  private readonly schedule: FileLinkTimer;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly cacheLimit: number;
  private readonly pendingLimit: number;
  private readonly subscriberLimit: number;
  private subscribers = 0;
  private active = 0;
  private wake?: CancelFileLinkWork;
  constructor(private readonly transport: FileLinkTransport, options: ResolverOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? timer;
    this.batchSize = Math.max(1, Math.min(64, options.batchSize ?? 64));
    this.concurrency = Math.max(1, Math.min(2, options.concurrency ?? 2));
    this.cacheLimit = Math.max(1, options.cacheLimit ?? 2048);
    this.pendingLimit = Math.max(1, options.pendingLimit ?? 4096);
    this.subscriberLimit = Math.max(1, options.subscriberLimit ?? 8192);
  }
  get size() { return { pending: this.entries.size, cached: this.cache.size, active: this.active, subscribers: this.subscribers }; }
  request(workspaceId: string, basePath: string, input: string, listener: (result: ResolvedFileLink | undefined) => void): CancelFileLinkWork {
    if (!input || input.length > FILE_LINK_MAX_PATH || this.subscribers >= this.subscriberLimit) { listener(undefined); return () => {}; }
    const key = JSON.stringify([workspaceId, basePath, input]);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.pendingLimit) { listener(undefined); return () => {}; }
      const cached = this.cache.get(key);
      const valid = cached && cached.expires > this.now();
      if (cached) this.cache.delete(key);
      if (valid) this.cache.set(key, cached);
      entry = { key, workspaceId, basePath, input, state: valid ? "ready" : "queued", result: valid ? cached.result : undefined, listeners: new Set() };
      this.entries.set(key, entry);
    }
    // Each subscription gets its own identity, including repeated callback functions.
    const receive = (result: ResolvedFileLink | undefined) => listener(result);
    entry.listeners.add(receive);
    this.subscribers += 1;
    this.poke();
    return () => {
      if (entry.listeners.delete(receive)) this.subscribers -= 1;
      if (!entry.listeners.size && entry.state !== "loading" && this.entries.get(key) === entry) this.entries.delete(key);
    };
  }
  private poke() {
    if (!this.wake) this.wake = this.schedule(() => { this.wake = undefined; this.flush(); }, 30);
  }
  private flush() {
    let delivered = 0;
    for (const [key, entry] of this.entries) {
      if (entry.state !== "ready") continue;
      for (const listener of entry.listeners) {
        entry.listeners.delete(listener);
        this.subscribers -= 1;
        listener(entry.result);
        delivered += 1;
        if (delivered >= 64) break;
      }
      if (!entry.listeners.size && this.entries.get(key) === entry) this.entries.delete(key);
      if (delivered >= 64) break;
    }
    while (this.active < this.concurrency) {
      const first = [...this.entries.values()].find((entry) => entry.state === "queued");
      if (!first) break;
      const batch: Lookup[] = [];
      for (const entry of this.entries.values()) {
        if (entry.state === "queued" && entry.workspaceId === first.workspaceId && entry.basePath === first.basePath) {
          entry.state = "loading";
          batch.push(entry);
          if (batch.length >= this.batchSize) break;
        }
      }
      this.active += 1;
      void Promise.resolve().then(() => this.transport(first.workspaceId, batch.map((entry) => entry.input), first.basePath)).then(
        (response) => this.finish(batch, response.links),
        () => this.finish(batch, []),
      );
    }
    if ([...this.entries.values()].some((entry) => entry.state === "ready")) this.poke();
  }
  private finish(batch: Lookup[], links: ResolvedFileLink[]) {
    this.active -= 1;
    const byInput = new Map(links.map((link) => [link.input, link]));
    for (const entry of batch) {
      entry.result = byInput.get(entry.input);
      entry.state = "ready";
      this.cache.delete(entry.key);
      this.cache.set(entry.key, { result: entry.result, expires: this.now() + (entry.result ? 60000 : 15000) });
      if (!entry.listeners.size) this.entries.delete(entry.key);
    }
    while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value!);
    this.poke();
  }
}

/** Round-robin idle work. A job must itself bound its characters/nodes per step. */
export class FileLinkWorkQueue {
  private readonly jobs = new Set<() => boolean>();
  private pending?: CancelFileLinkWork;
  constructor(private readonly schedule: FileLinkTimer, private readonly now: () => number = () => performance.now()) {}
  enqueue(step: () => boolean): CancelFileLinkWork {
    this.jobs.add(step);
    this.poke();
    return () => { this.jobs.delete(step); if (!this.jobs.size) { this.pending?.(); this.pending = undefined; } };
  }
  private poke() {
    if (!this.pending && this.jobs.size) this.pending = this.schedule(() => { this.pending = undefined; this.run(); }, 0);
  }
  private run() {
    const start = this.now();
    for (let count = 0; count < 16 && this.jobs.size && this.now() - start < 4; count += 1) {
      const job = this.jobs.values().next().value!;
      this.jobs.delete(job);
      if (!job()) this.jobs.add(job);
    }
    this.poke();
  }
}
