import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceDefinition } from "./config.js";

const IMAGE_MIME_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export type FilePreview = { name: string; path: string; size: number } & ({ kind: "text"; content: string; markdown: boolean } | { kind: "image"; mimeType: string });

export class WorkspaceService {
  private readonly byId: Map<string, WorkspaceDefinition>;

  constructor(workspaces: WorkspaceDefinition[]) {
    this.byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  }

  list(): WorkspaceDefinition[] {
    return [...this.byId.values()];
  }

  get(id: string): WorkspaceDefinition {
    const workspace = this.byId.get(id);
    if (!workspace) throw Object.assign(new Error("Unknown workspace"), { statusCode: 404 });
    return workspace;
  }

  async add(input: { name?: string; path: string }): Promise<WorkspaceDefinition> {
    if (!input.path || !isAbsolute(input.path)) throw Object.assign(new Error("Workspace path must be absolute"), { statusCode: 400 });
    const workspacePath = await realpath(input.path).catch(() => { throw Object.assign(new Error("Workspace directory does not exist"), { statusCode: 400 }); });
    const workspaceStat = await lstat(workspacePath);
    if (!workspaceStat.isDirectory()) throw Object.assign(new Error("Workspace path must be a directory"), { statusCode: 400 });
    for (const existing of this.byId.values()) {
      if (await realpath(existing.path) === workspacePath) throw Object.assign(new Error("Workspace is already in the list"), { statusCode: 409 });
    }
    const name = input.name?.trim() || basename(workspacePath) || workspacePath;
    const baseId = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workspace";
    let id = baseId;
    let suffix = 2;
    while (this.byId.has(id)) id = `${baseId}-${suffix++}`;
    const workspace = { id, name, path: workspacePath };
    this.byId.set(id, workspace);
    return workspace;
  }

  rename(id: string, inputName: string): WorkspaceDefinition {
    const workspace = this.get(id);
    const name = inputName?.trim();
    if (!name) throw Object.assign(new Error("Workspace name is required"), { statusCode: 400 });
    const updated = { ...workspace, name };
    this.byId.set(id, updated);
    return updated;
  }

  remove(id: string): WorkspaceDefinition {
    const workspace = this.get(id);
    this.byId.delete(id);
    return workspace;
  }

  restore(workspace: WorkspaceDefinition): void {
    this.byId.set(workspace.id, workspace);
  }

  async suggestDirectories(inputPath: string): Promise<{ basePath: string; directories: Array<{ name: string; path: string }> }> {
    if (!inputPath || !isAbsolute(inputPath)) throw Object.assign(new Error("Directory path must be absolute"), { statusCode: 400 });
    const requested = resolve(inputPath);
    let directory: string;
    let prefix = "";
    try {
      const existing = await realpath(requested);
      if (!(await lstat(existing)).isDirectory()) throw Object.assign(new Error("Path must point to a directory"), { statusCode: 400 });
      directory = existing;
    } catch (error) {
      if ("statusCode" in (error as object)) throw error;
      prefix = basename(requested).toLowerCase();
      directory = await realpath(dirname(requested)).catch(() => { throw Object.assign(new Error("Parent directory does not exist or is not accessible"), { statusCode: 400 }); });
    }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { throw Object.assign(new Error("Directory is not accessible"), { statusCode: 403 }); }
    const children = entries.filter((entry) => entry.isDirectory() && (prefix.startsWith(".") || !entry.name.startsWith(".")) && entry.name.toLowerCase().startsWith(prefix)).slice(0, 100).map((entry) => ({ name: entry.name, path: join(directory, entry.name) })).sort((a, b) => a.name.localeCompare(b.name));
    const directories = prefix ? children : [{ name: basename(directory) || directory, path: directory }, ...children].slice(0, 100);
    return { basePath: directory, directories };
  }

  async safePath(workspace: WorkspaceDefinition, requestedPath = ""): Promise<string> {
    const pathSegments = requestedPath.split(/[\\/]+/).filter(Boolean);
    if (pathSegments.includes(".pi-ark")) throw Object.assign(new Error("Pi-Ark workspace state is private"), { statusCode: 403 });
    const root = await realpath(workspace.path);
    const candidate = await realpath(resolve(root, requestedPath));
    if (candidate !== root && !candidate.startsWith(root + sep)) throw Object.assign(new Error("Path leaves the workspace"), { statusCode: 403 });
    return candidate;
  }

  async listDirectory(workspace: WorkspaceDefinition, requestedPath = "", showHiddenFiles = true): Promise<Array<{ name: string; path: string; type: "file" | "directory" | "symlink"; size: number }>> {
    const root = await realpath(workspace.path);
    const directory = await this.safePath(workspace, requestedPath);
    const stat = await lstat(directory);
    if (!stat.isDirectory()) throw Object.assign(new Error("Path is not a directory"), { statusCode: 400 });
    const entries = await readdir(directory, { withFileTypes: true });
    const result = await Promise.all(entries.filter((entry) => entry.name !== ".pi-ark" && (showHiddenFiles || !entry.name.startsWith("."))).map(async (entry) => {
      const absolute = join(directory, entry.name);
      const entryStat = await lstat(absolute);
      return {
        name: entry.name,
        path: relative(root, absolute).split(sep).join("/"),
        type: entry.isSymbolicLink() ? "symlink" as const : entry.isDirectory() ? "directory" as const : "file" as const,
        size: entryStat.size,
      };
    }));
    return result.sort((a, b) => (a.type === "directory" ? 0 : 1) - (b.type === "directory" ? 0 : 1) || a.name.localeCompare(b.name));
  }

  private async openWorkspaceFile(workspace: WorkspaceDefinition, requestedPath: string) {
    const root = await realpath(workspace.path);
    const candidate = await this.safePath(workspace, requestedPath);
    const handle = await open(candidate, "r");
    try {
      const file = await realpath(`/proc/self/fd/${handle.fd}`);
      if (file !== root && !file.startsWith(root + sep)) throw Object.assign(new Error("Path leaves the workspace"), { statusCode: 403 });
      const stat = await handle.stat();
      if (!stat.isFile()) throw Object.assign(new Error("Path is not a file"), { statusCode: 400 });
      return { root, file, stat, handle };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async readFilePreview(workspace: WorkspaceDefinition, requestedPath: string, maxSizeBytes: number): Promise<FilePreview> {
    const opened = await this.openWorkspaceFile(workspace, requestedPath);
    try {
      if (opened.stat.size > maxSizeBytes) throw Object.assign(new Error(`File exceeds the ${Math.round(maxSizeBytes / 1024 / 1024)} MB preview limit. Download the file to open it locally.`), { statusCode: 413 });
      const common = { name: basename(opened.file), path: relative(opened.root, opened.file).split(sep).join("/"), size: opened.stat.size };
      const mimeType = IMAGE_MIME_TYPES[extname(opened.file).toLowerCase()];
      if (mimeType) return { ...common, kind: "image", mimeType };
      const buffer = await opened.handle.readFile();
      if (buffer.includes(0)) throw Object.assign(new Error("This binary file cannot be previewed. Download the file to open it locally."), { statusCode: 415 });
      return { ...common, kind: "text", content: buffer.toString("utf8"), markdown: /\.(md|markdown|mdx)$/i.test(opened.file) };
    } finally { await opened.handle.close(); }
  }

  async readImage(workspace: WorkspaceDefinition, requestedPath: string, maxSizeBytes: number) {
    const opened = await this.openWorkspaceFile(workspace, requestedPath);
    const mimeType = IMAGE_MIME_TYPES[extname(opened.file).toLowerCase()];
    if (!mimeType || opened.stat.size > maxSizeBytes) {
      await opened.handle.close();
      if (!mimeType) throw Object.assign(new Error("Unsupported image"), { statusCode: 415 });
      throw Object.assign(new Error(`Image exceeds the ${Math.round(maxSizeBytes / 1024 / 1024)} MB preview limit`), { statusCode: 413 });
    }
    return { content: opened.handle.createReadStream(), size: opened.stat.size, mimeType };
  }

  async downloadFile(workspace: WorkspaceDefinition, requestedPath: string) {
    const opened = await this.openWorkspaceFile(workspace, requestedPath);
    return { content: opened.handle.createReadStream(), name: basename(opened.file), size: opened.stat.size };
  }
}
