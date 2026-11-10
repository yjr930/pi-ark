import { readFile, mkdir, writeFile, access, rename, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface WorkspaceDefinition {
  id: string;
  name: string;
  path: string;
}

export const ARK_THEMES = ["ark-dark", "graphite", "midnight", "paper", "snow"] as const;
export type ArkTheme = (typeof ARK_THEMES)[number];
export interface ArkUiSettings { theme: ArkTheme; hideReasoning: boolean }

export interface ArkConfig {
  listen: { host: string; port: number };
  tls: { keyPath: string; certPath: string };
  auth: { username: string; passwordHash: string };
  workspaces: WorkspaceDefinition[];
  ui: ArkUiSettings;
}

export const WORKSPACE_TOOLS = ["read", "bash", "edit", "write"] as const;
export type WorkspaceTool = (typeof WORKSPACE_TOOLS)[number];
export interface WorkspaceSettings {
  version: 5;
  workspaceId: string;
  agent: { tools: WorkspaceTool[]; systemPrompt: { append: string } };
  files: { showHiddenFiles: boolean; maxPreviewSizeMb: number };
}

export const arkHome = resolve(process.env.PI_ARK_HOME || join(homedir(), ".pi-ark"));
export const piArkAgentDir = resolve(process.env.PI_ARK_AGENT_DIR || join(arkHome, "pi-agent"));
export const configPath = join(arkHome, "config.json");

export async function ensurePiArkAgentState(previousAgentDir?: string): Promise<void> {
  await mkdir(piArkAgentDir, { recursive: true, mode: 0o700 });
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
    ui: { theme: ARK_THEMES.includes(parsed.ui?.theme) ? parsed.ui.theme : "ark-dark", hideReasoning: parsed.ui?.hideReasoning === true },
  };
}

let globalConfigWrite: Promise<void> = Promise.resolve();
const workspaceConfigWrites = new Map<string, Promise<void>>();

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

function queueWorkspaceConfig<T>(workspace: WorkspaceDefinition, operation: () => Promise<T>): Promise<T> {
  const target = join(workspace.path, ".pi-ark", "config.json");
  const task = (workspaceConfigWrites.get(target) || Promise.resolve()).catch(() => undefined).then(operation);
  workspaceConfigWrites.set(target, task.then(() => undefined, () => undefined));
  return task;
}

export async function loadUiSettings(): Promise<ArkUiSettings> {
  return (await loadConfig()).ui;
}

export async function saveGlobalArkSettings(settings: ArkUiSettings): Promise<ArkUiSettings> {
  if (!ARK_THEMES.includes(settings.theme)) throw Object.assign(new Error("Unknown theme"), { statusCode: 400 });
  if (typeof settings.hideReasoning !== "boolean") throw Object.assign(new Error("Invalid reasoning visibility setting"), { statusCode: 400 });
  const next = await updateGlobalConfig((current) => ({ ...current, ui: { theme: settings.theme, hideReasoning: settings.hideReasoning } }));
  return next.ui;
}

export async function saveWorkspaceDefinitions(workspaces: WorkspaceDefinition[]): Promise<void> {
  await updateGlobalConfig((current) => ({ ...current, workspaces }));
}

function defaultWorkspaceSettings(workspace: WorkspaceDefinition): WorkspaceSettings {
  return { version: 5, workspaceId: workspace.id, agent: { tools: [...WORKSPACE_TOOLS], systemPrompt: { append: "" } }, files: { showHiddenFiles: true, maxPreviewSizeMb: 10 } };
}

export async function ensureWorkspaceState(workspace: WorkspaceDefinition): Promise<string> {
  const stateDir = join(workspace.path, ".pi-ark");
  const sessionsDir = join(stateDir, "sessions");
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const workspaceConfig = join(stateDir, "config.json");
  try {
    await access(workspaceConfig);
  } catch {
    await writeFile(workspaceConfig, JSON.stringify(defaultWorkspaceSettings(workspace), null, 2) + "\n", { mode: 0o600 });
  }
  return sessionsDir;
}

export async function loadWorkspaceSettings(workspace: WorkspaceDefinition): Promise<WorkspaceSettings> {
  await ensureWorkspaceState(workspace);
  const defaults = defaultWorkspaceSettings(workspace);
  const parsed = JSON.parse(await readFile(join(workspace.path, ".pi-ark", "config.json"), "utf8")) as Partial<WorkspaceSettings>;
  const tools = parsed.agent?.tools?.filter((tool): tool is WorkspaceTool => WORKSPACE_TOOLS.includes(tool as WorkspaceTool));
  const rawPrompt = parsed.agent?.systemPrompt as unknown;
  const promptAppend = typeof rawPrompt === "object" && rawPrompt !== null && "append" in rawPrompt && typeof rawPrompt.append === "string" ? rawPrompt.append : "";
  const parsedPreviewSize = Number(parsed.files?.maxPreviewSizeMb);
  const maxPreviewSizeMb = Number.isInteger(parsedPreviewSize) && parsedPreviewSize >= 1 && parsedPreviewSize <= 100 ? parsedPreviewSize : defaults.files.maxPreviewSizeMb;
  return {
    ...defaults,
    ...parsed,
    version: 5,
    workspaceId: workspace.id,
    agent: { tools: tools?.length ? tools : defaults.agent.tools, systemPrompt: { append: promptAppend } },
    files: { showHiddenFiles: parsed.files?.showHiddenFiles ?? defaults.files.showHiddenFiles, maxPreviewSizeMb },
  };
}

function validatedWorkspaceSettings(workspace: WorkspaceDefinition, input: Pick<WorkspaceSettings, "agent" | "files">): WorkspaceSettings {
  const tools = input.agent?.tools?.filter((tool): tool is WorkspaceTool => WORKSPACE_TOOLS.includes(tool as WorkspaceTool));
  if (!tools?.length) throw Object.assign(new Error("Select at least one agent tool"), { statusCode: 400 });
  const promptAppend = typeof input.agent?.systemPrompt?.append === "string" ? input.agent.systemPrompt.append : "";
  if (promptAppend.length > 100000) throw Object.assign(new Error("System prompt append must be 100000 characters or fewer"), { statusCode: 400 });
  const maxPreviewSizeMb = Number(input.files?.maxPreviewSizeMb);
  if (!Number.isInteger(maxPreviewSizeMb) || maxPreviewSizeMb < 1 || maxPreviewSizeMb > 100) throw Object.assign(new Error("File preview size must be an integer from 1 to 100 MB"), { statusCode: 400 });
  return { version: 5, workspaceId: workspace.id, agent: { tools: [...new Set(tools)], systemPrompt: { append: promptAppend } }, files: { showHiddenFiles: Boolean(input.files?.showHiddenFiles), maxPreviewSizeMb } };
}

async function writeWorkspaceSettings(workspace: WorkspaceDefinition, input: Pick<WorkspaceSettings, "agent" | "files">): Promise<WorkspaceSettings> {
  const settings = validatedWorkspaceSettings(workspace, input);
  const target = join(workspace.path, ".pi-ark", "config.json");
  await ensureWorkspaceState(workspace);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, target);
  return settings;
}

export function saveWorkspaceSystemPrompt(workspace: WorkspaceDefinition, systemPrompt: WorkspaceSettings["agent"]["systemPrompt"]): Promise<WorkspaceSettings> {
  return queueWorkspaceConfig(workspace, async () => {
    const current = await loadWorkspaceSettings(workspace);
    return writeWorkspaceSettings(workspace, { ...current, agent: { ...current.agent, systemPrompt } });
  });
}

export function saveWorkspacePreferences(workspace: WorkspaceDefinition, input: { agent: { tools: WorkspaceTool[] }; files: WorkspaceSettings["files"] }): Promise<WorkspaceSettings> {
  return queueWorkspaceConfig(workspace, async () => {
    const current = await loadWorkspaceSettings(workspace);
    return writeWorkspaceSettings(workspace, { agent: { ...current.agent, tools: input.agent.tools }, files: input.files });
  });
}

export function saveWorkspaceSettings(workspace: WorkspaceDefinition, input: Pick<WorkspaceSettings, "agent" | "files">): Promise<WorkspaceSettings> {
  return queueWorkspaceConfig(workspace, () => writeWorkspaceSettings(workspace, input));
}
