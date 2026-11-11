import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodemodeExtension, createMcpExtension, DefaultResourceLoader, type Skill } from "@earendil-works/pi-coding-agent";
import { loadSkillSelectionSync, piArkAgentDir, type SkillSelection, type WorkspaceDefinition } from "./config.js";
import { createGlobalSettingsManager } from "./settings.js";

export const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const builtinSkillDir = join(installRoot, "skills");
export const globalSkillDir = join(piArkAgentDir, "skills");

export function workspaceSkillDir(workspace: WorkspaceDefinition): string {
  return join(workspace.path, ".pi-ark", "skills");
}

export function skillDirectories(workspace: WorkspaceDefinition): { builtin: string; global: string; workspace: string } {
  return { builtin: builtinSkillDir, global: globalSkillDir, workspace: workspaceSkillDir(workspace) };
}

export function isPathWithin(candidate: string, directory: string): boolean {
  const target = resolve(candidate);
  const base = resolve(directory);
  const normalize = process.platform === "win32" ? (path: string) => path.toLowerCase() : (path: string) => path;
  return normalize(target) === normalize(base) || normalize(target).startsWith(`${normalize(base)}${sep}`);
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
  const isDisabled = (skill: Skill): boolean => {
    const selection = typeof selectionSource === "function" ? selectionSource() : selectionSource;
    const workspaceRoot = workspaceSkillDir(workspace);
    if (isPathWithin(skill.filePath, builtinSkillDir)) return selection.disabledBuiltin.includes(skill.name);
    if (isPathWithin(skill.filePath, globalSkillDir)) return selection.disabledGlobal.includes(skill.name);
    if (isPathWithin(skill.filePath, workspaceRoot)) return (selection.disabledWorkspace[workspace.id] ?? []).includes(skill.name);
    return false;
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace.path,
    agentDir: piArkAgentDir,
    settingsManager,
    ...(existsSync(systemPromptPath) ? { systemPrompt: systemPromptPath } : { systemPromptOverride: () => undefined }),
    appendSystemPrompt: existsSync(appendSystemPromptPath) ? [appendSystemPromptPath] : [],
    appendSystemPromptOverride: (base) => options.globalAppend ? [...base, options.globalAppend] : base,
    additionalSkillPaths,
    extensionFactories: [createMcpExtension(), createCodemodeExtension()],
    skillsOverride: ({ skills, diagnostics }) => ({ skills: skills.filter((skill) => !isDisabled(skill)), diagnostics }),
  });
  await resourceLoader.reload();
  return resourceLoader;
}
