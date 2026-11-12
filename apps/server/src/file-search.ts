import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 60000;
const BUILD_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_QUERY_LENGTH = 120;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".venv", "_venv", "__pycache__"]);

export type FileListSource = "rg" | "git" | "walk";

export interface FileSearchEntry {
  path: string;
  score: number;
}

export interface FileSearchResult {
  query: string;
  entries: FileSearchEntry[];
  matches: number;
  total: number;
  truncated: boolean;
  source: FileListSource;
  builtAt: number;
  cached: boolean;
}

interface FileList {
  paths: string[];
  lowerPaths: string[];
  builtAt: number;
  truncated: boolean;
  source: FileListSource;
}

function normalizePaths(output: string): string[] {
  return output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("/")).map((line) => line.split(sep).join("/"));
}

function scorePath(lowerPath: string, query: string): number {
  const baseIndexInPath = lowerPath.lastIndexOf("/") + 1;
  const base = lowerPath.slice(baseIndexInPath);
  if (base === query) return 1200;
  if (base.startsWith(query)) return 1000 - base.length * 0.01;
  const baseIndex = base.indexOf(query);
  if (baseIndex > 0) return 900 - baseIndex - base.length * 0.01;
  if (lowerPath.startsWith(query)) return 800 - lowerPath.length * 0.01;
  const pathIndex = lowerPath.indexOf(query);
  if (pathIndex > 0) return 700 - pathIndex * 0.1 - lowerPath.length * 0.01;
  let cursor = 0;
  let gaps = 0;
  let previous = -1;
  for (let index = 0; index < lowerPath.length && cursor < query.length; index += 1) {
    if (lowerPath[index] !== query[cursor]) continue;
    if (previous >= 0) gaps += index - previous - 1;
    previous = index;
    cursor += 1;
  }
  if (cursor < query.length) return -1;
  return 500 - gaps * 0.6 - lowerPath.length * 0.02;
}

function depthOf(path: string): number {
  let depth = 0;
  for (const character of path) if (character === "/") depth += 1;
  return depth;
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value as number)));
}

export class FileSearchIndex {
  private readonly lists = new Map<string, FileList>();
  private readonly pending = new Map<string, Promise<FileList>>();

  invalidate(root: string): void {
    this.lists.delete(root);
  }

  async search(root: string, rawQuery: string, options: { limit?: number; refresh?: boolean } = {}): Promise<FileSearchResult> {
    const limit = clampLimit(options.limit);
    const query = rawQuery.trim().slice(0, MAX_QUERY_LENGTH).toLowerCase();
    const cached = this.isFresh(root);
    const list = await this.getList(root, options.refresh === true);
    const base = { query: rawQuery.trim(), matches: 0, total: list.paths.length, truncated: list.truncated, source: list.source, builtAt: list.builtAt, cached };
    if (!query) {
      const entries = list.paths.slice().sort((left, right) => depthOf(left) - depthOf(right) || left.length - right.length || left.localeCompare(right)).slice(0, limit).map((path) => ({ path, score: 0 }));
      return { ...base, entries, matches: entries.length };
    }
    const scored: FileSearchEntry[] = [];
    for (let index = 0; index < list.paths.length; index += 1) {
      const score = scorePath(list.lowerPaths[index], query);
      if (score < 0) continue;
      scored.push({ path: list.paths[index], score });
    }
    scored.sort((left, right) => right.score - left.score || left.path.length - right.path.length || left.path.localeCompare(right.path));
    return { ...base, entries: scored.slice(0, limit), matches: scored.length };
  }

  private isFresh(root: string): boolean {
    const list = this.lists.get(root);
    return Boolean(list && Date.now() - list.builtAt < CACHE_TTL_MS);
  }

  private async getList(root: string, refresh: boolean): Promise<FileList> {
    const cached = this.lists.get(root);
    if (!refresh && cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached;
    const pending = this.pending.get(root);
    if (pending) return pending;
    const build = this.build(root).then((list) => {
      this.lists.set(root, list);
      return list;
    }).finally(() => {
      this.pending.delete(root);
    });
    this.pending.set(root, build);
    return build;
  }

  private async build(root: string): Promise<FileList> {
    const fromRipgrep = await this.listWithRipgrep(root);
    if (fromRipgrep) return this.createList(fromRipgrep, false, "rg");
    const fromGit = await this.listWithGit(root);
    if (fromGit) return this.createList(fromGit, false, "git");
    const walked = await this.listByWalking(root);
    return this.createList(walked.paths, walked.truncated, "walk");
  }

  private createList(paths: string[], truncated: boolean, source: FileListSource): FileList {
    return { paths, lowerPaths: paths.map((path) => path.toLowerCase()), builtAt: Date.now(), truncated, source };
  }

  private async listWithRipgrep(root: string): Promise<string[] | undefined> {
    try {
      const { stdout } = await execFileAsync("rg", ["--files", "--color", "never", "--no-messages"], { cwd: root, timeout: BUILD_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES });
      const paths = normalizePaths(stdout);
      return paths.length > 0 ? paths.slice(0, MAX_ENTRIES) : undefined;
    } catch {
      return undefined;
    }
  }

  private async listWithGit(root: string): Promise<string[] | undefined> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"], { timeout: BUILD_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES });
      const paths = normalizePaths(stdout);
      return paths.length > 0 ? paths.slice(0, MAX_ENTRIES) : undefined;
    } catch {
      return undefined;
    }
  }

  private async listByWalking(root: string): Promise<{ paths: string[]; truncated: boolean }> {
    const deadline = Date.now() + BUILD_TIMEOUT_MS;
    const paths: string[] = [];
    let truncated = false;
    const walk = async (directory: string): Promise<void> => {
      if (truncated || paths.length >= MAX_ENTRIES || Date.now() > deadline) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (truncated || paths.length >= MAX_ENTRIES || Date.now() > deadline) {
          truncated = true;
          return;
        }
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        paths.push(relative(root, absolute).split(sep).join("/"));
      }
    };
    await walk(root);
    return { paths, truncated };
  }
}
