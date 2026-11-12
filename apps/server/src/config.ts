import { readFileSync } from "node:fs";
import { readFile, mkdir, writeFile, access, rename, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { normalizeTerminalSettings, resolveTerminalShell, validateTerminalSettings, type TerminalSettings } from "./terminal-shells.js";
export type { TerminalSettings, TerminalShell, TerminalProfile } from "./terminal-shells.js";

export interface WorkspaceDefinition {
  id: string;
  name: string;
  path: string;
}

export interface ArkConfig {
  listen: { host: string; port: number };
  tls: { keyPath: string; certPath: string };
  auth: { username: string; passwordHash: string };
  workspaces: WorkspaceDefinition[];
  preferences: GlobalPreferences;
}

export interface SkillSelection {
  disabledBuiltin: string[];
  disabledGlobal: string[];
  disabledWorkspace: Record<string, string[]>;
}

export interface GlobalPreferences {
  agent: { systemPrompt: { append: string } };
  files: { showHiddenFiles: boolean; maxPreviewSizeMb: number };
  terminal: TerminalSettings;
  skills: SkillSelection;
}

export const arkHome = resolve(process.env.PI_ARK_HOME || join(homedir(), ".pi-ark"));
export const piArkAgentDir = resolve(process.env.PI_ARK_AGENT_DIR || join(arkHome, "pi-agent"));
export const configPath = join(arkHome, "config.json");

export async function ensurePiArkAgentState(previousAgentDir?: string): Promise<void> {
  await mkdir(piArkAgentDir, { recursive: true, mode: 0o700 });
  await mkdir(join(piArkAgentDir, "extensions"), { recursive: true, mode: 0o700 });
  const markerPath = join(piArkAgentDir, ".pi-ark-migration.json");
  try { await access(markerPath); return; } catch { /* first Pi-Ark agent directory initialization */ }
  const copied: string[] = [];
  if (previousAgentDir && resolve(previousAgentDir) !== piArkAgentDir) {
    for (const filename of ["auth.json", "settings.json", "models.json", "models-store.json"]) {
      try { await copyFile(join(previousAgentDir, filename), join(piArkAgentDir, filename)); copied.push(filename); } catch { /* optional source file */ }
    }
  }
  await writeFile(markerPath, JSON.stringify({ version: 1, source: previousAgentDir ? resolve(previousAgentDir) : null, copied, createdAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
}

function resolveFromHome(path: string): string {
  return isAbsolute(path) ? path : resolve(arkHome, path);
}

export async function loadConfig(): Promise<ArkConfig> {
  let parsed: ArkConfig;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as ArkConfig;
  } catch (error) {
    throw new Error(`Cannot read Pi-Ark configuration at ${configPath}. Run npm run setup first.`, { cause: error });
  }

  if (!parsed.auth?.username || !parsed.auth?.passwordHash) throw new Error("Pi-Ark auth configuration is incomplete");
  if (!parsed.tls?.keyPath || !parsed.tls?.certPath) throw new Error("Pi-Ark TLS configuration is incomplete");
  if (!Array.isArray(parsed.workspaces)) throw new Error("Pi-Ark workspace registry is invalid");
  const ids = new Set<string>();
  for (const workspace of parsed.workspaces) {
    if (!/^[a-zA-Z0-9_-]+$/.test(workspace.id) || ids.has(workspace.id)) throw new Error(`Invalid or duplicate workspace id: ${workspace.id}`);
    if (!isAbsolute(workspace.path)) throw new Error(`Workspace path must be absolute: ${workspace.path}`);
    ids.add(workspace.id);
  }

  return {
    ...parsed,
    listen: { host: parsed.listen?.host || "127.0.0.1", port: parsed.listen?.port || 31415 },
    tls: { keyPath: resolveFromHome(parsed.tls.keyPath), certPath: resolveFromHome(parsed.tls.certPath) },
    workspaces: parsed.workspaces.map((workspace) => ({ ...workspace, path: resolve(workspace.path) })),
    preferences: normalizeGlobalPreferences(parsed.preferences),
  };
}

let globalConfigWrite: Promise<void> = Promise.resolve();

async function updateGlobalConfig(update: (current: ArkConfig) => ArkConfig): Promise<ArkConfig> {
  const task = globalConfigWrite.catch(() => undefined).then(async () => {
    const current = JSON.parse(await readFile(configPath, "utf8")) as ArkConfig;
    const next = update(current);
    const temporary = `${configPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, configPath);
    return next;
  });
  globalConfigWrite = task.then(() => undefined, () => undefined);
  return task;
}

export async function saveWorkspaceDefinitions(workspaces: WorkspaceDefinition[]): Promise<void> {
  await updateGlobalConfig((current) => ({ ...current, workspaces }));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeSkillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.filter((item): item is string => typeof item === "string"));
}

function normalizeSkillSelection(input: unknown): SkillSelection {
  const raw = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const workspaceRaw = typeof raw.disabledWorkspace === "object" && raw.disabledWorkspace !== null && !Array.isArray(raw.disabledWorkspace) ? raw.disabledWorkspace as Record<string, unknown> : {};
  const disabledWorkspace: Record<string, string[]> = {};
  for (const [workspaceId, names] of Object.entries(workspaceRaw)) {
    if (!Array.isArray(names)) continue;
    disabledWorkspace[workspaceId] = normalizeSkillNames(names);
  }
  return { disabledBuiltin: normalizeSkillNames(raw.disabledBuiltin), disabledGlobal: normalizeSkillNames(raw.disabledGlobal), disabledWorkspace };
}

function validateSkillNames(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw Object.assign(new Error(`${field} must be an array of skill names`), { statusCode: 400 });
  return uniqueStrings(value);
}

export function validateSkillSelection(input: unknown): SkillSelection {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw Object.assign(new Error("Invalid skill selection"), { statusCode: 400 });
  const raw = input as Record<string, unknown>;
  if (typeof raw.disabledWorkspace !== "object" || raw.disabledWorkspace === null || Array.isArray(raw.disabledWorkspace)) throw Object.assign(new Error("disabledWorkspace must map workspace ids to skill names"), { statusCode: 400 });
  const disabledWorkspace: Record<string, string[]> = {};
  for (const [workspaceId, names] of Object.entries(raw.disabledWorkspace as Record<string, unknown>)) {
    disabledWorkspace[workspaceId] = validateSkillNames(names, `disabledWorkspace.${workspaceId}`);
  }
  return { disabledBuiltin: validateSkillNames(raw.disabledBuiltin, "disabledBuiltin"), disabledGlobal: validateSkillNames(raw.disabledGlobal, "disabledGlobal"), disabledWorkspace };
}

function normalizeGlobalPreferences(input?: Partial<GlobalPreferences>): GlobalPreferences {
  const size = input?.files?.maxPreviewSizeMb;
  return { agent: { systemPrompt: { append: typeof input?.agent?.systemPrompt?.append === "string" ? input.agent.systemPrompt.append : "" } }, files: { showHiddenFiles: input?.files?.showHiddenFiles ?? true, maxPreviewSizeMb: Number.isInteger(size) && size! >= 1 && size! <= 100 ? size! : 10 }, terminal: normalizeTerminalSettings(input?.terminal), skills: normalizeSkillSelection(input?.skills) };
}

export async function loadSkillSelection(): Promise<SkillSelection> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as { preferences?: { skills?: unknown } };
    return normalizeSkillSelection(parsed.preferences?.skills);
  } catch {
    return normalizeSkillSelection(undefined);
  }
}

export function loadSkillSelectionSync(): SkillSelection {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { preferences?: { skills?: unknown } };
    return normalizeSkillSelection(parsed.preferences?.skills);
  } catch {
    return normalizeSkillSelection(undefined);
  }
}

export async function saveSkillSelection(input: unknown): Promise<SkillSelection> {
  const skills = validateSkillSelection(input);
  const next = await updateGlobalConfig((current) => ({ ...current, preferences: { ...normalizeGlobalPreferences(current.preferences), skills } }));
  return next.preferences.skills;
}

export async function ensureWorkspaceState(workspace: WorkspaceDefinition): Promise<string> {
  const sessionsDir = join(workspace.path, ".pi-ark", "sessions");
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  return sessionsDir;
}

export async function loadGlobalPreferences(): Promise<GlobalPreferences> {
  return (await loadConfig()).preferences;
}

export async function saveGlobalPreferences(input: { files: GlobalPreferences["files"] }): Promise<GlobalPreferences> {
  const size = input.files?.maxPreviewSizeMb;
  if (!Number.isInteger(size) || size < 1 || size > 100) throw Object.assign(new Error("File preview size must be an integer from 1 to 100 MB"), { statusCode: 400 });
  if (typeof input.files?.showHiddenFiles !== "boolean") throw Object.assign(new Error("Invalid hidden file setting"), { statusCode: 400 });
  const next = await updateGlobalConfig((current) => {
    const preferences = normalizeGlobalPreferences(current.preferences);
    return { ...current, preferences: { ...preferences, files: { ...input.files } } };
  });
  return next.preferences;
}

export async function saveTerminalSettings(input: TerminalSettings): Promise<TerminalSettings> {
  const terminal = validateTerminalSettings(input);
  resolveTerminalShell(terminal);
  const next = await updateGlobalConfig((current) => ({ ...current, preferences: { ...normalizeGlobalPreferences(current.preferences), terminal } }));
  return next.preferences.terminal;
}

export async function saveGlobalSystemPrompt(input: GlobalPreferences["agent"]["systemPrompt"]): Promise<GlobalPreferences> {
  if (typeof input.append !== "string" || input.append.length > 100000) throw Object.assign(new Error("System prompt append must be 100000 characters or fewer"), { statusCode: 400 });
  const next = await updateGlobalConfig((current) => {
    const preferences = normalizeGlobalPreferences(current.preferences);
    return { ...current, preferences: { ...preferences, agent: { ...preferences.agent, systemPrompt: { append: input.append } } } };
  });
  return next.preferences;
}
