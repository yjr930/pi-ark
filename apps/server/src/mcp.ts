import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { piArkAgentDir, type WorkspaceDefinition } from "./config.js";

export type McpServerSource = "built-in" | "user";
export type McpServerState = "connected" | "disabled" | "failed" | "needs-sign-in" | "starting";
export type McpBrowserState = "not-installed" | "installing" | "installed" | "failed";

export interface McpServerView {
  name: string;
  source: McpServerSource;
  advanced: boolean;
  enabled: boolean;
  exposure: string;
  transport: string;
  state: McpServerState;
  tools: string[];
  diagnostics: string[];
}

export interface McpServersResponse {
  servers: McpServerView[];
  errors: string[];
}

export interface McpBrowserStatus {
  state: McpBrowserState;
  version?: string;
  directory: string;
  log?: string;
}

interface McpProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}

interface McpListReport {
  name?: unknown;
  enabled?: unknown;
  exposure?: unknown;
  transport?: unknown;
  state?: unknown;
  tools?: unknown;
  error?: unknown;
}

interface McpListPayload {
  servers?: unknown;
  errors?: unknown;
}

const PLAYWRIGHT_SERVER = "playwright";
const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@0.0.85";
const ADVANCED_CAPABILITIES = "--caps=config,network,storage,devtools,vision";
const PLAYWRIGHT_BROWSER_ARGS = ["--browser=chromium", "--headless"];
const COMMAND_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_INSTALL_LOG = 64 * 1024;

const DEFAULT_MCP_CONFIG = {
  mcpServers: {
    [PLAYWRIGHT_SERVER]: {
      command: "npx",
      args: [PLAYWRIGHT_MCP_PACKAGE, ...PLAYWRIGHT_BROWSER_ARGS, ADVANCED_CAPABILITIES],
      enabled: false,
      exposure: "codemode",
      description: "Browser automation for web pages",
    },
  },
};

function piCoreCliPath(): string {
  return join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
}

function appendOutput(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next;
}

function runProcess(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onOutput?: (chunk: string) => void }): Promise<McpProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: McpProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: -1, stdout, stderr, error: `Command timed out after ${Math.round(options.timeoutMs / 1000)} seconds` });
    }, options.timeoutMs);
    timer.unref();
    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout = appendOutput(stdout, text);
      options.onOutput?.(text);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr = appendOutput(stderr, text);
      options.onOutput?.(text);
    });
    child.on("error", (error) => finish({ code: -1, stdout, stderr, error: error.message }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function mapServerState(state: unknown, enabled: boolean): McpServerState {
  if (!enabled) return "disabled";
  if (state === "connected") return "connected";
  if (state === "needs-auth") return "needs-sign-in";
  if (state === "connecting") return "starting";
  return "failed";
}

function mapServer(report: McpListReport): McpServerView | undefined {
  const name = optionalString(report.name);
  if (!name) return undefined;
  const enabled = report.enabled !== false;
  const error = optionalString(report.error);
  const diagnostics = error ? [error] : [];
  return {
    name,
    source: name === PLAYWRIGHT_SERVER ? "built-in" : "user",
    enabled,
    exposure: optionalString(report.exposure) ?? "codemode",
    transport: optionalString(report.transport) ?? "",
    advanced: (optionalString(report.transport) ?? "").includes("--caps="),
    state: mapServerState(report.state, enabled),
    tools: stringList(report.tools),
    diagnostics,
  };
}

function browserCacheDirectory(): string {
  return join(homedir(), ".cache", "ms-playwright");
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

export class McpService {
  private configReady?: Promise<void>;
  private configWrite: Promise<void> = Promise.resolve();
  private installState: McpBrowserState = "not-installed";
  private installLog = "";
  private installTask?: Promise<void>;

  constructor(private readonly reloadSessions: () => Promise<number> = async () => 0) {}

  ensureConfig(): Promise<void> {
    this.configReady ??= (async () => {
      await mkdir(piArkAgentDir, { recursive: true, mode: 0o700 });
      const path = join(piArkAgentDir, "mcp.json");
      if (!existsSync(path)) {
        await atomicWriteJson(path, DEFAULT_MCP_CONFIG);
        return;
      }
      try {
        const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        const servers = typeof config.mcpServers === "object" && config.mcpServers !== null && !Array.isArray(config.mcpServers) ? config.mcpServers as Record<string, unknown> : undefined;
        const current = servers?.[PLAYWRIGHT_SERVER];
        if (typeof current === "object" && current !== null && !Array.isArray(current)) {
          const entry = current as Record<string, unknown>;
          const args: string[] = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
          const usesDefaultArgs = args.filter((arg) => arg !== PLAYWRIGHT_MCP_PACKAGE && arg !== ADVANCED_CAPABILITIES).length === 0;
          if (usesDefaultArgs && !args.includes("--browser=") && !args.includes("--executable-path")) {
            const next = [PLAYWRIGHT_MCP_PACKAGE, ...PLAYWRIGHT_BROWSER_ARGS, ...(args.includes(ADVANCED_CAPABILITIES) ? [ADVANCED_CAPABILITIES] : [])];
            if (JSON.stringify(next) !== JSON.stringify(args)) {
              servers![PLAYWRIGHT_SERVER] = { ...entry, args: next };
              await atomicWriteJson(path, config);
            }
          }
        }
      } catch {
        // Invalid configuration is reported by the pi MCP command.
      }
    })();
    return this.configReady;
  }

  async list(workspace: WorkspaceDefinition): Promise<McpServersResponse> {
    await this.ensureConfig();
    const result = await runProcess(process.execPath, [piCoreCliPath(), "mcp", "list", "--json"], {
      cwd: workspace.path,
      env: { ...process.env, PI_CODING_AGENT_DIR: piArkAgentDir, NO_COLOR: "1" },
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const output = result.stdout.trim();
    if (!output) {
      const message = result.error || result.stderr.trim() || `The MCP command exited with code ${result.code}`;
      return { servers: [], errors: [message] };
    }
    let payload: McpListPayload;
    try {
      payload = JSON.parse(output) as McpListPayload;
    } catch {
      const message = result.stderr.trim() || "The MCP command returned invalid JSON";
      return { servers: [], errors: [message] };
    }
    const servers = Array.isArray(payload.servers) ? payload.servers.flatMap((report) => {
      const mapped = typeof report === "object" && report !== null ? mapServer(report as McpListReport) : undefined;
      return mapped ? [mapped] : [];
    }) : [];
    return { servers, errors: stringList(payload.errors) };
  }

  async setAdvanced(name: string, enabled: boolean): Promise<void> {
    if (name !== PLAYWRIGHT_SERVER) throw Object.assign(new Error("Advanced capabilities are only available for playwright"), { statusCode: 400 });
    if (typeof enabled !== "boolean") throw Object.assign(new Error("Advanced capabilities state must be a boolean"), { statusCode: 400 });
    await this.ensureConfig();
    const path = join(piArkAgentDir, "mcp.json");
    const task = this.configWrite.catch(() => undefined).then(async () => {
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      } catch (error) {
        throw Object.assign(new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 500 });
      }
      const servers = typeof config.mcpServers === "object" && config.mcpServers !== null && !Array.isArray(config.mcpServers) ? config.mcpServers as Record<string, unknown> : undefined;
      if (!servers) throw Object.assign(new Error(`Cannot read the MCP server list from ${path}`), { statusCode: 500 });
      const current = servers[name];
      if (typeof current !== "object" || current === null || Array.isArray(current)) throw Object.assign(new Error(`Unknown MCP server: ${name}`), { statusCode: 404 });
      const entry = current as Record<string, unknown>;
      const existing = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
      const args = existing.filter((arg) => !arg.startsWith("--caps="));
      if (!args.some((arg) => arg.startsWith("@playwright/mcp"))) args.unshift(PLAYWRIGHT_MCP_PACKAGE);
      if (enabled) args.push(ADVANCED_CAPABILITIES);
      servers[name] = { ...entry, args };
      await atomicWriteJson(path, config);
    });
    this.configWrite = task.then(() => undefined, () => undefined);
    await task;
    await this.reloadSessions();
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw Object.assign(new Error("Invalid MCP server name"), { statusCode: 400 });
    if (typeof enabled !== "boolean") throw Object.assign(new Error("MCP server state must be a boolean"), { statusCode: 400 });
    await this.ensureConfig();
    const path = join(piArkAgentDir, "mcp.json");
    const task = this.configWrite.catch(() => undefined).then(async () => {
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      } catch (error) {
        throw Object.assign(new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 500 });
      }
      const servers = typeof config.mcpServers === "object" && config.mcpServers !== null && !Array.isArray(config.mcpServers) ? config.mcpServers as Record<string, unknown> : undefined;
      if (!servers) throw Object.assign(new Error(`Cannot read the MCP server list from ${path}`), { statusCode: 500 });
      const current = servers[name];
      if (typeof current !== "object" || current === null || Array.isArray(current)) throw Object.assign(new Error(`Unknown MCP server: ${name}`), { statusCode: 404 });
      servers[name] = { ...(current as Record<string, unknown>), enabled };
      await atomicWriteJson(path, config);
    });
    this.configWrite = task.then(() => undefined, () => undefined);
    await task;
    await this.reloadSessions();
  }

  async browserStatus(): Promise<McpBrowserStatus> {
    const directory = browserCacheDirectory();
    const installed = await this.installedChromium(directory);
    const state: McpBrowserState = installed ? "installed" : this.installState === "installing" ? "installing" : this.installState === "failed" ? "failed" : "not-installed";
    return {
      state,
      ...(installed ? { version: installed } : {}),
      directory,
      ...(this.installLog ? { log: this.installLog } : {}),
    };
  }

  async installBrowser(): Promise<McpBrowserStatus> {
    const current = await this.browserStatus();
    if (current.state === "installed" || current.state === "installing") return current;
    this.installState = "installing";
    this.installLog = `Installing Chromium headless shell into ${browserCacheDirectory()}\n`;
    const task = this.runBrowserInstall();
    this.installTask = task;
    void task.finally(() => { if (this.installTask === task) this.installTask = undefined; });
    return this.browserStatus();
  }

  private async installedChromium(directory: string): Promise<string | undefined> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isDirectory() && /^chromium(?:_headless_shell)?-\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
      return candidates.find((name) => name.startsWith("chromium_headless_shell-")) ?? candidates[0];
    } catch {
      return undefined;
    }
  }

  private appendInstallLog(chunk: string): void {
    const next = this.installLog + chunk;
    this.installLog = next.length > MAX_INSTALL_LOG ? next.slice(-MAX_INSTALL_LOG) : next;
  }

  private async runBrowserInstall(): Promise<void> {
    try {
      await mkdir(piArkAgentDir, { recursive: true, mode: 0o700 });
      const result = await runProcess(process.platform === "win32" ? "npx.cmd" : "npx", [PLAYWRIGHT_MCP_PACKAGE, "install-browser", "chromium", "--only-shell"], {
        cwd: piArkAgentDir,
        env: { ...process.env, NO_COLOR: "1", npm_config_yes: "true" },
        timeoutMs: INSTALL_TIMEOUT_MS,
        onOutput: (chunk) => this.appendInstallLog(chunk),
      });
      const installed = await this.installedChromium(browserCacheDirectory());
      if (result.code === 0 && installed) {
        this.installState = "installed";
        this.appendInstallLog(`\nBrowser runtime installed: ${installed}\n`);
        return;
      }
      const failure = result.code === 0 ? "Browser installation finished without a Chromium directory" : result.error || result.stderr.trim() || `Browser installation exited with code ${result.code}`;
      this.appendInstallLog(`\n${failure}\n`);
      this.installState = "failed";
    } catch (error) {
      this.appendInstallLog(`\n${error instanceof Error ? error.message : String(error)}\n`);
      this.installState = "failed";
    }
  }
}
