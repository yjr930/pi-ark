import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
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
const EXA_SERVER = "exa";
const BUILTIN_SERVERS = new Set([PLAYWRIGHT_SERVER, EXA_SERVER]);
const EXA_DESCRIPTION = "Web search and page content fetching (Exa). Use for current technical docs, papers and news. web_search_exa requires query and objective: objective names the documents that should rank first and the facts to extract. web_fetch_exa takes urls.";
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
    [EXA_SERVER]: {
      url: "https://mcp.exa.ai/mcp",
      enabled: true,
      exposure: "codemode",
      description: EXA_DESCRIPTION,
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

const windowsExecutableExtensions = new Set([".exe", ".com"]);
const codePageEncodings = new Map<number, string>([[65001, "utf-8"], [936, "gbk"], [950, "big5"], [932, "shift_jis"], [949, "euc-kr"]]);

export interface ProcessLaunchPlan {
  command: string;
  args: string[];
  shell: boolean;
}

export function processLaunchPlan(command: string, args: string[], platform: NodeJS.Platform = process.platform): ProcessLaunchPlan {
  return { command, args, shell: platform === "win32" && !windowsExecutableExtensions.has(extname(command).toLowerCase()) };
}

export function encodingForCodePage(codePage: number): string | undefined {
  return codePageEncodings.get(codePage);
}

let outputEncodingPromise: Promise<string> | undefined;

async function detectWindowsConsoleEncoding(): Promise<string> {
  return new Promise((resolveEncoding) => {
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (encoding: string): void => {
      clearTimeout(timer);
      try { new TextDecoder(encoding); resolveEncoding(encoding); }
      catch { resolveEncoding("utf-8"); }
    };
    const timer = setTimeout(() => { child?.kill(); finish("utf-8"); }, 5000);
    timer.unref();
    let output = "";
    child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", "chcp"], { windowsHide: true });
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("latin1"); });
    child.on("error", () => finish("utf-8"));
    child.on("close", () => {
      const codePage = /(\d{3,5})/.exec(output)?.[1];
      finish((codePage && encodingForCodePage(Number(codePage))) || "utf-8");
    });
  });
}

function processOutputEncoding(): Promise<string> {
  if (process.platform !== "win32") return Promise.resolve("utf-8");
  outputEncodingPromise ||= detectWindowsConsoleEncoding().catch(() => "utf-8");
  return outputEncodingPromise;
}

function runProcess(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onOutput?: (chunk: string) => void }): Promise<McpProcessResult> {
  return processOutputEncoding().then((encoding) => new Promise<McpProcessResult>((resolve) => {
    let decoder: TextDecoder;
    try { decoder = new TextDecoder(encoding); }
    catch { decoder = new TextDecoder("utf-8"); }
    const plan = processLaunchPlan(command, args);
    let child: ReturnType<typeof spawn>;
    try { child = spawn(plan.command, plan.args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: plan.shell }); }
    catch (error) {
      resolve({ code: -1, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) });
      return;
    }
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
      const text = decoder.decode(data, { stream: true });
      stdout = appendOutput(stdout, text);
      options.onOutput?.(text);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = decoder.decode(data, { stream: true });
      stderr = appendOutput(stderr, text);
      options.onOutput?.(text);
    });
    child.on("error", (error) => finish({ code: -1, stdout, stderr, error: error.message }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));
  }));
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
    source: BUILTIN_SERVERS.has(name) ? "built-in" : "user",
    enabled,
    exposure: optionalString(report.exposure) ?? "codemode",
    transport: optionalString(report.transport) ?? "",
    advanced: (optionalString(report.transport) ?? "").includes("--caps="),
    state: mapServerState(report.state, enabled),
    tools: stringList(report.tools),
    diagnostics,
  };
}

export interface PlaywrightDirectoryOptions {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

// Playwright keeps its browsers in the registry directory, which is PLAYWRIGHT_BROWSERS_PATH when set, and otherwise the platform cache directory plus `ms-playwright`.
export function playwrightBrowsersDirectory(options: PlaywrightDirectoryOptions): string {
  const configured = options.env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured && configured !== "0") return resolve(configured);
  if (options.platform === "win32") return win32.join(options.env.LOCALAPPDATA || win32.join(options.home, "AppData", "Local"), "ms-playwright");
  if (options.platform === "darwin") return posix.join(options.home, "Library", "Caches", "ms-playwright");
  return posix.join(options.env.XDG_CACHE_HOME || posix.join(options.home, ".cache"), "ms-playwright");
}

function browserCacheDirectory(): string {
  return playwrightBrowsersDirectory({ platform: process.platform, home: homedir(), env: process.env });
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

export interface McpConfiguredServer {
  name: string;
  source: McpServerSource;
  enabled: boolean;
  exposure: string;
  description: string;
  transport: string;
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
        if (!servers) return;
        let changed = false;
        const current = servers[PLAYWRIGHT_SERVER];
        if (typeof current === "object" && current !== null && !Array.isArray(current)) {
          const entry = current as Record<string, unknown>;
          const args: string[] = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
          const usesDefaultArgs = args.filter((arg) => arg !== PLAYWRIGHT_MCP_PACKAGE && arg !== ADVANCED_CAPABILITIES).length === 0;
          if (usesDefaultArgs && !args.includes("--browser=") && !args.includes("--executable-path")) {
            const next = [PLAYWRIGHT_MCP_PACKAGE, ...PLAYWRIGHT_BROWSER_ARGS, ...(args.includes(ADVANCED_CAPABILITIES) ? [ADVANCED_CAPABILITIES] : [])];
            if (JSON.stringify(next) !== JSON.stringify(args)) {
              servers[PLAYWRIGHT_SERVER] = { ...entry, args: next };
              changed = true;
            }
          }
        }
        if (!(EXA_SERVER in servers)) {
          servers[EXA_SERVER] = DEFAULT_MCP_CONFIG.mcpServers[EXA_SERVER];
          changed = true;
        }
        if (changed) await atomicWriteJson(path, config);
      } catch {
        // Invalid configuration is reported by the pi MCP command.
      }
    })();
    return this.configReady;
  }

  async listConfigured(): Promise<McpConfiguredServer[]> {
    await this.ensureConfig();
    const path = join(piArkAgentDir, "mcp.json");
    try {
      const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      const servers = typeof config.mcpServers === "object" && config.mcpServers !== null && !Array.isArray(config.mcpServers) ? config.mcpServers as Record<string, unknown> : {};
      return Object.entries(servers).flatMap(([name, value]) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
        const entry = value as Record<string, unknown>;
        const command = typeof entry.command === "string" ? entry.command : "";
        const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
        const url = typeof entry.url === "string" ? entry.url : "";
        return [{
          name,
          source: BUILTIN_SERVERS.has(name) ? "built-in" as const : "user" as const,
          enabled: entry.enabled !== false,
          exposure: typeof entry.exposure === "string" ? entry.exposure : "codemode",
          description: typeof entry.description === "string" ? entry.description : "",
          transport: url || [command, ...args].filter(Boolean).join(" "),
        }];
      });
    } catch {
      return [];
    }
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
