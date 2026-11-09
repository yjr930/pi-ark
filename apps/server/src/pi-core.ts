import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { piArkAgentDir } from "./config.js";

const exec = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageJsonPath = join(projectRoot, "apps/server/package.json");
const packageLockPath = join(projectRoot, "package-lock.json");

function packageRoot(packageName: string): string {
  let current = dirname(fileURLToPath(import.meta.resolve(packageName)));
  while (true) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`Cannot locate ${packageName} package root`);
    current = parent;
  }
}

async function packageVersion(path: string): Promise<string> {
  const parsed = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as { version?: string };
  if (!parsed.version) throw new Error(`Package version is missing at ${path}`);
  return parsed.version;
}

function commandMessage(error: unknown): string {
  const message = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim() ? error.stderr.trim() : error instanceof Error ? error.message : String(error);
  return message.length > 4000 ? `${message.slice(0, 4000)}…` : message;
}

export class PiCoreService {
  private updating = false;

  async info(checkLatest = false) {
    const corePath = packageRoot("@earendil-works/pi-coding-agent");
    const version = await packageVersion(corePath);
    let latestVersion: string | undefined;
    if (checkLatest) {
      const result = await exec("npm", ["view", "@earendil-works/pi-coding-agent", "version", "--json"], { cwd: projectRoot, timeout: 30000, maxBuffer: 1024 * 1024 });
      latestVersion = String(JSON.parse(result.stdout)).trim();
    }
    return { agentDir: piArkAgentDir, corePath, version, latestVersion, updateAvailable: Boolean(latestVersion && latestVersion !== version), updating: this.updating };
  }

  async update() {
    if (this.updating) throw Object.assign(new Error("Pi core update is already in progress"), { statusCode: 409 });
    this.updating = true;
    const packageJson = await readFile(packageJsonPath, "utf8");
    const packageLock = await readFile(packageLockPath, "utf8");
    try {
      const before = await this.info(true);
      if (!before.latestVersion || before.latestVersion === before.version) return { ...before, restartScheduled: false, restartDelaySeconds: 0 };
      await exec("npm", ["install", "--save-exact", "-w", "@pi-ark/server", `@earendil-works/pi-coding-agent@${before.latestVersion}`, `@earendil-works/pi-ai@${before.latestVersion}`], { cwd: projectRoot, timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
      await exec("npm", ["run", "check", "-w", "@pi-ark/server"], { cwd: projectRoot, timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
      await exec("npm", ["run", "build", "-w", "@pi-ark/server"], { cwd: projectRoot, timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
      const restartDelaySeconds = 5;
      const unit = `pi-ark-core-restart-${Date.now()}`;
      await exec("systemd-run", ["--unit", unit, `--on-active=${restartDelaySeconds}s`, "/bin/systemctl", "restart", "pi-ark.service"], { timeout: 30000, maxBuffer: 1024 * 1024 });
      return { ...(await this.info(false)), previousVersion: before.version, latestVersion: before.latestVersion, updateAvailable: false, restartScheduled: true, restartDelaySeconds };
    } catch (error) {
      await writeFile(packageJsonPath, packageJson);
      await writeFile(packageLockPath, packageLock);
      await exec("npm", ["install", "--ignore-scripts"], { cwd: projectRoot, timeout: 300000, maxBuffer: 10 * 1024 * 1024 }).catch(() => undefined);
      throw Object.assign(new Error(`Pi core update failed: ${commandMessage(error)}`), { statusCode: 500 });
    } finally { this.updating = false; }
  }
}
