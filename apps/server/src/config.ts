import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
}

export const arkHome = resolve(process.env.PI_ARK_HOME || join(homedir(), ".pi-ark"));
export const configPath = join(arkHome, "config.json");

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
  if (!Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0) throw new Error("Configure at least one workspace");
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
  };
}

export async function ensureWorkspaceState(workspace: WorkspaceDefinition): Promise<string> {
  const stateDir = join(workspace.path, ".pi-ark");
  const sessionsDir = join(stateDir, "sessions");
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const workspaceConfig = join(stateDir, "config.json");
  try {
    await access(workspaceConfig);
  } catch {
    await writeFile(workspaceConfig, JSON.stringify({ version: 1, workspaceId: workspace.id }, null, 2) + "\n", { mode: 0o600 });
  }
  return sessionsDir;
}
