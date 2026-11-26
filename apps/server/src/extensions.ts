import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Extension, LoadExtensionsResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { piArkAgentDir, type WorkspaceDefinition } from "./config.js";
import { isPathWithin } from "./resource-loader.js";
import type { WorkspaceService } from "./workspaces.js";

export const userExtensionDir = join(piArkAgentDir, "extensions");

export type ExtensionStatus = "loaded" | "failed";

export interface ExtensionToolView {
  name: string;
  active: boolean;
}

export interface ExtensionCommandView {
  name: string;
  description?: string;
}

export interface ExtensionView {
  name: string;
  path: string;
  entry: string;
  status: ExtensionStatus;
  tools: ExtensionToolView[];
  commands: ExtensionCommandView[];
  diagnostics: string[];
}

export interface ExtensionDiagnostic {
  path: string;
  message: string;
}

export interface ExtensionsResponse {
  directory: string;
  extensions: ExtensionView[];
  diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionDirectoryEntry {
  name: string;
  path: string;
  entries: string[];
}

interface ExtensionsSource {
  getExtensions(): LoadExtensionsResult;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function packageEntries(directory: string): string[] {
  const manifestPath = join(directory, "package.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pi?: { extensions?: unknown } };
    const declared = Array.isArray(manifest.pi?.extensions) ? manifest.pi.extensions.filter((entry): entry is string => typeof entry === "string") : [];
    return declared.map((entry) => resolve(directory, entry)).filter((entry) => isFile(entry));
  } catch {
    return [];
  }
}

export function scanExtensionEntries(directory = userExtensionDir): ExtensionDirectoryEntry[] {
  if (!existsSync(directory)) return [];
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch {
    return [];
  }
  const entries: ExtensionDirectoryEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(directory, name);
    if (isFile(path)) {
      if (!name.endsWith(".ts") && !name.endsWith(".js")) continue;
      entries.push({ name: name.replace(/\.(ts|js)$/, ""), path, entries: [resolve(path)] });
      continue;
    }
    if (!isDirectory(path)) continue;
    const declared = packageEntries(path);
    if (declared.length > 0) {
      entries.push({ name, path, entries: declared });
      continue;
    }
    const index = ["index.ts", "index.js"].map((file) => join(path, file)).find((candidate) => isFile(candidate));
    if (index) entries.push({ name, path, entries: [resolve(index)] });
  }
  return entries;
}

function belongsToEntry(entry: ExtensionDirectoryEntry, path: string): boolean {
  if (entry.entries.includes(resolve(path))) return true;
  return isDirectory(entry.path) && isPathWithin(path, entry.path);
}

function isDeclarable(definition: ToolDefinition): boolean {
  const exposure = definition.exposure ?? "direct";
  return exposure === "direct" || exposure === "model-only";
}

function isActiveTool(definition: ToolDefinition): boolean {
  return isDeclarable(definition) && definition.defaultActive !== false;
}

function matchesExtension(entry: ExtensionDirectoryEntry, extension: Extension): boolean {
  return entry.entries.includes(resolve(extension.resolvedPath));
}

export function extensionToolNames(loader: ExtensionsSource): string[] {
  const names = new Set<string>();
  for (const extension of loader.getExtensions().extensions) {
    if (extension.path.startsWith("<inline:") || extension.path.startsWith("builtin:")) continue;
    for (const [name, tool] of extension.tools) {
      if (isActiveTool(tool.definition)) names.add(name);
    }
  }
  return [...names];
}

function viewFor(entry: ExtensionDirectoryEntry, result: LoadExtensionsResult): ExtensionView {
  const extensions = result.extensions.filter((extension) => matchesExtension(entry, extension));
  const diagnostics = [
    ...result.errors.filter((error) => !error.path.startsWith("<") && belongsToEntry(entry, error.path)).map((error) => error.error),
    ...(result.warnings ?? []).filter((warning) => !warning.path.startsWith("<") && belongsToEntry(entry, warning.path)).map((warning) => warning.warning),
  ];
  const tools = new Map<string, ExtensionToolView>();
  for (const extension of extensions) {
    for (const [name, tool] of extension.tools) tools.set(name, { name, active: isActiveTool(tool.definition) });
  }
  const commands = new Map<string, ExtensionCommandView>();
  for (const extension of extensions) {
    for (const command of extension.commands.values()) commands.set(command.name, { name: command.name, ...(command.description ? { description: command.description } : {}) });
  }
  return {
    name: entry.name,
    path: entry.path,
    entry: entry.entries[0] ?? entry.path,
    status: extensions.length > 0 ? "loaded" : "failed",
    tools: [...tools.values()],
    commands: [...commands.values()],
    diagnostics: diagnostics.length > 0 ? diagnostics : extensions.length > 0 ? [] : ["Entry point was not loaded."],
  };
}

export class ExtensionService {
  constructor(
    private readonly workspaces: Pick<WorkspaceService, "list">,
    private readonly createLoader: (workspace: WorkspaceDefinition) => Promise<ExtensionsSource>,
    private readonly reloadSessions: () => Promise<number> = async () => 0,
  ) {}

  async list(workspace?: WorkspaceDefinition): Promise<ExtensionsResponse> {
    const target = workspace ?? this.workspaces.list()[0];
    const entries = scanExtensionEntries();
    if (!target) return { directory: userExtensionDir, extensions: [], diagnostics: [{ path: userExtensionDir, message: "Open a workspace to load extensions." }] };
    const loader = await this.createLoader(target);
    const result = loader.getExtensions();
    const views = entries.map((entry) => viewFor(entry, result));
    const diagnostics = [
      ...result.errors.filter((error) => !error.path.startsWith("<") && !entries.some((entry) => belongsToEntry(entry, error.path))).map((error) => ({ path: error.path, message: error.error })),
      ...(result.warnings ?? []).filter((warning) => !warning.path.startsWith("<") && !entries.some((entry) => belongsToEntry(entry, warning.path))).map((warning) => ({ path: warning.path, message: warning.warning })),
    ];
    return { directory: userExtensionDir, extensions: views, diagnostics };
  }

  async reloadIdleSessions(): Promise<number> {
    return this.reloadSessions();
  }
}
