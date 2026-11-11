import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { loadSkillSelection, piArkAgentDir, saveSkillSelection, validateSkillSelection, type SkillSelection, type WorkspaceDefinition } from "./config.js";
import { builtinSkillDir, globalSkillDir, workspaceSkillDir } from "./resource-loader.js";
import type { WorkspaceService } from "./workspaces.js";

export type SkillScope = "builtin" | "global" | "workspace";
export type SkillSource = "built-in" | "managed";

export interface SkillView {
  name: string;
  description: string;
  scope: SkillScope;
  source: SkillSource;
  location: string;
  enabled: boolean;
  explicitOnly: boolean;
}

export interface SkillDiagnostic {
  path: string;
  message: string;
}

export interface SkillsResponse {
  builtin: SkillView[];
  global: SkillView[];
  workspace: SkillView[];
  diagnostics: SkillDiagnostic[];
}

interface ScannedSkill {
  name: string;
  description: string;
  scope: SkillScope;
  source: SkillSource;
  location: string;
  explicitOnly: boolean;
  filePath: string;
}

interface ScanResult {
  builtin: ScannedSkill[];
  global: ScannedSkill[];
  workspace: ScannedSkill[];
  diagnostics: SkillDiagnostic[];
}

function scanWorkspace(workspace?: WorkspaceDefinition): ScanResult {
  const result: ScanResult = { builtin: [], global: [], workspace: [], diagnostics: [] };
  const winners = new Map<string, string>();
  const add = (scope: SkillScope, directory: string): void => {
    if (!existsSync(directory)) return;
    const loaded = loadSkillsFromDir({ dir: directory, source: scope === "builtin" ? "builtin" : "user" });
    for (const diagnostic of loaded.diagnostics) result.diagnostics.push({ path: diagnostic.path || directory, message: diagnostic.message });
    for (const skill of loaded.skills) {
      const winner = winners.get(skill.name);
      if (winner) {
        result.diagnostics.push({ path: skill.filePath, message: `Skill name "${skill.name}" is already defined at ${winner}; the first skill is used.` });
        continue;
      }
      winners.set(skill.name, skill.filePath);
      result[scope].push({
        name: skill.name,
        description: skill.description,
        scope,
        source: scope === "builtin" ? "built-in" : "managed",
        location: skill.baseDir,
        explicitOnly: skill.disableModelInvocation,
        filePath: skill.filePath,
      });
    }
  };
  add("builtin", builtinSkillDir);
  add("global", globalSkillDir);
  if (workspace) add("workspace", workspaceSkillDir(workspace));
  return result;
}

function toViews(skills: ScannedSkill[], disabled: string[]): SkillView[] {
  const disabledNames = new Set(disabled);
  return skills.map(({ filePath: _filePath, ...skill }) => ({ ...skill, enabled: !disabledNames.has(skill.name) }));
}

async function playwrightEnabled(): Promise<boolean> {
  try {
    const config = JSON.parse(await readFile(join(piArkAgentDir, "mcp.json"), "utf8")) as { mcpServers?: Record<string, { enabled?: boolean }> };
    return config.mcpServers?.playwright?.enabled === true;
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export class SkillService {
  private lastWorkspace?: WorkspaceDefinition;

  constructor(private readonly workspaces: Pick<WorkspaceService, "list">, private readonly reloadSessions: () => Promise<number> = async () => 0) {}

  async list(workspace: WorkspaceDefinition, selection?: SkillSelection): Promise<SkillsResponse> {
    this.lastWorkspace = workspace;
    const active = selection ?? await loadSkillSelection();
    const scan = scanWorkspace(workspace);
    const browserEnabled = await playwrightEnabled();
    return {
      builtin: toViews(scan.builtin, active.disabledBuiltin).map((skill) => skill.name === "browser" ? { ...skill, enabled: browserEnabled } : skill),
      global: toViews(scan.global, active.disabledGlobal),
      workspace: toViews(scan.workspace, active.disabledWorkspace[workspace.id] ?? []),
      diagnostics: scan.diagnostics,
    };
  }

  workspaceForSelection(): WorkspaceDefinition | undefined {
    return this.lastWorkspace ?? this.workspaces.list()[0];
  }

  async saveSelection(input: unknown): Promise<{ selection: SkillSelection; reloaded: number }> {
    const parsed = validateSkillSelection(input);
    const existing = await loadSkillSelection();
    const builtinGlobal = scanWorkspace();
    const workspaceNames = new Map(this.workspaces.list().map((workspace) => [workspace.id, new Set(scanWorkspace(workspace).workspace.map((skill) => skill.name))]));
    const requestedWorkspaces = { ...existing.disabledWorkspace, ...parsed.disabledWorkspace };
    const disabledWorkspace: Record<string, string[]> = {};
    for (const [workspaceId, names] of Object.entries(requestedWorkspaces)) {
      const known = workspaceNames.get(workspaceId);
      disabledWorkspace[workspaceId] = unique(known ? names.filter((name) => known.has(name)) : names);
    }
    const selection: SkillSelection = {
      disabledBuiltin: unique(parsed.disabledBuiltin.filter((name) => name !== "browser" && builtinGlobal.builtin.some((skill) => skill.name === name))),
      disabledGlobal: unique(parsed.disabledGlobal.filter((name) => builtinGlobal.global.some((skill) => skill.name === name))),
      disabledWorkspace,
    };
    const saved = await saveSkillSelection(selection);
    const reloaded = await this.reloadSessions();
    return { selection: saved, reloaded };
  }

  async reloadIdleSessions(): Promise<number> {
    return this.reloadSessions();
  }
}
