import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodemodeExtension, createMcpExtension, DefaultResourceLoader, type Skill } from "@earendil-works/pi-coding-agent";
import { ensureWorkspaceTrust, loadSkillSelectionSync, piArkAgentDir, type SkillSelection, type WorkspaceDefinition } from "./config.js";
import { createGlobalSettingsManager } from "./settings.js";

export const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const builtinSkillDir = join(installRoot, "skills");
export const globalSkillDir = join(piArkAgentDir, "skills");

export function workspaceSkillDir(workspace: WorkspaceDefinition): string {
  return join(workspace.path, ".pi-ark", "skills");
}

export function projectPiSkillDir(workspace: WorkspaceDefinition): string {
  return join(workspace.path, ".pi", "skills");
}

export function userAgentsSkillDir(): string {
  return join(homedir(), ".agents", "skills");
}

export function skillDirectories(workspace: WorkspaceDefinition): { builtin: string; global: string; workspace: string } {
  return { builtin: builtinSkillDir, global: globalSkillDir, workspace: workspaceSkillDir(workspace) };
}

export type SkillScope = "builtin" | "global" | "workspace";
export type SkillOrigin = "built-in" | "pi-ark" | "pi" | "agents";

export interface SkillLocation {
  directory: string;
  scope: SkillScope;
  origin: SkillOrigin;
}

function repositoryRoot(from: string): string | undefined {
  let current = resolve(from);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

// Pi scans `.agents/skills` from the working directory up to the repository root. Without a
// repository root Pi-Ark keeps the scan inside the workspace, so a parent directory never feeds
// skills into an unrelated workspace.
export function workspaceAgentsSkillDirs(workspace: WorkspaceDefinition): string[] {
  const root = repositoryRoot(workspace.path);
  const directories: string[] = [];
  let current = resolve(workspace.path);
  while (true) {
    directories.push(join(current, ".agents", "skills"));
    if (!root || current === root) return directories;
    const parent = dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

// The order matches Pi's own discovery order: `.pi`, `.agents`, the agent directory, `~/.agents`,
// then the extra directories Pi-Ark passes to the SDK. The first skill with a name wins.
export function skillSources(workspace?: WorkspaceDefinition): SkillLocation[] {
  const sources: SkillLocation[] = [];
  const seen = new Set<string>();
  const push = (directory: string, scope: SkillScope, origin: SkillOrigin): void => {
    const key = resolve(directory);
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ directory, scope, origin });
  };
  if (workspace) {
    push(projectPiSkillDir(workspace), "workspace", "pi");
    for (const directory of workspaceAgentsSkillDirs(workspace)) push(directory, "workspace", "agents");
  }
  push(globalSkillDir, "global", "pi-ark");
  push(userAgentsSkillDir(), "global", "agents");
  push(builtinSkillDir, "builtin", "built-in");
  if (workspace) push(workspaceSkillDir(workspace), "workspace", "pi-ark");
  return sources;
}

export function isPathWithin(candidate: string, directory: string): boolean {
  const target = resolve(candidate);
  const base = resolve(directory);
  const normalize = process.platform === "win32" ? (path: string) => path.toLowerCase() : (path: string) => path;
  return normalize(target) === normalize(base) || normalize(target).startsWith(`${normalize(base)}${sep}`);
}

function playwrightEnabledSync(): boolean {
  try {
    const config = JSON.parse(readFileSync(join(piArkAgentDir, "mcp.json"), "utf8")) as { mcpServers?: Record<string, { enabled?: boolean }> };
    return config.mcpServers?.playwright?.enabled === true;
  } catch {
    return false;
  }
}

function resourceGuide(workspace: WorkspaceDefinition): string {
  return [
    "## Pi-Ark resource locations",
    `Install a skill for every workspace in ${globalSkillDir}. Install a skill for this workspace in ${workspaceSkillDir(workspace)}.`,
    `Install MCP servers in ${join(piArkAgentDir, "mcp.json")} through the $PI_ARK_CLI_NAME mcp command.`,
    `Pi-Ark also loads skills from ${projectPiSkillDir(workspace)}, ${join(workspace.path, ".agents", "skills")} up to the repository root, and ${userAgentsSkillDir()}, and MCP servers from ${join(workspace.path, ".pi", "mcp.json")}. Those directories belong to the project. Add new resources to the Pi-Ark directories unless the user asks for a repository-scoped setup.`,
  ].join("\n\n");
}

export type SkillSelectionSource = SkillSelection | (() => SkillSelection);

export interface CreateResourceLoaderOptions {
  workspace: WorkspaceDefinition;
  globalAppend: string;
  settingsManager?: ReturnType<typeof createGlobalSettingsManager>;
  selection?: SkillSelectionSource;
}

export async function createResourceLoader(options: CreateResourceLoaderOptions): Promise<DefaultResourceLoader> {
  const workspace = options.workspace;
  const settingsManager = options.settingsManager ?? createGlobalSettingsManager(workspace.path);
  const systemPromptPath = join(piArkAgentDir, "SYSTEM.md");
  const appendSystemPromptPath = join(piArkAgentDir, "APPEND_SYSTEM.md");
  const selectionSource = options.selection ?? loadSkillSelectionSync;
  const additionalSkillPaths = Object.values(skillDirectories(workspace)).filter((directory) => existsSync(directory));
  const sources = skillSources(workspace);
  const isDisabled = (skill: Skill): boolean => {
    const selection = typeof selectionSource === "function" ? selectionSource() : selectionSource;
    const source = sources.find((candidate) => isPathWithin(skill.filePath, candidate.directory));
    if (!source) return false;
    if (source.scope === "builtin") {
      if (skill.name === "browser") return !playwrightEnabledSync();
      return selection.disabledBuiltin.includes(skill.name);
    }
    if (source.scope === "global") return selection.disabledGlobal.includes(skill.name);
    return (selection.disabledWorkspace[workspace.id] ?? []).includes(skill.name);
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace.path,
    agentDir: piArkAgentDir,
    settingsManager,
    ...(existsSync(systemPromptPath) ? { systemPrompt: systemPromptPath } : { systemPromptOverride: () => undefined }),
    appendSystemPrompt: existsSync(appendSystemPromptPath) ? [appendSystemPromptPath] : [],
    appendSystemPromptOverride: (base) => [resourceGuide(workspace), ...base, ...(options.globalAppend ? [options.globalAppend] : [])],
    additionalSkillPaths,
    extensionFactories: [createMcpExtension(), createCodemodeExtension()],
    skillsOverride: ({ skills, diagnostics }) => ({ skills: skills.filter((skill) => !isDisabled(skill)), diagnostics }),
  });
  ensureWorkspaceTrust(workspace.path);
  await resourceLoader.reload({ resolveProjectTrust: async () => true });
  return resourceLoader;
}
