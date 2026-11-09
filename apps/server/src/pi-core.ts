import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { arkHome, piArkAgentDir } from "./config.js";

const exec = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const releasePath = join(projectRoot, "RELEASE.json");
const repository = process.env.PI_ARK_RELEASE_REPOSITORY || "yjr930/pi-ark";

interface ReleaseManifest {
  version: string;
  piCoreVersion: string;
  platform: string;
  architecture: string;
  builtAt: string;
}

function packageRoot(packageName: string): string {
  let current = dirname(fileURLToPath(import.meta.resolve(packageName)));
  while (true) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`Cannot locate ${packageName} package root`);
    current = parent;
  }
}

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function currentVersion(): Promise<string> {
  return (await jsonFile<{ version: string }>(join(projectRoot, "package.json"))).version;
}

async function latestRelease(): Promise<{ version: string; url: string } | undefined> {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Pi-Ark" }, signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`);
  const release = await response.json() as { tag_name?: string; html_url?: string };
  if (!release.tag_name) return undefined;
  return { version: release.tag_name.replace(/^v/, ""), url: release.html_url || `https://github.com/${repository}/releases/tag/${release.tag_name}` };
}

function commandMessage(error: unknown): string {
  const message = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim() ? error.stderr.trim() : error instanceof Error ? error.message : String(error);
  return message.length > 4000 ? `${message.slice(0, 4000)}…` : message;
}

export class PiCoreService {
  private updating = false;
  private restartTimer?: NodeJS.Timeout;

  async info(checkLatest = false) {
    const corePath = packageRoot("@earendil-works/pi-coding-agent");
    const coreVersion = (await jsonFile<{ version: string }>(join(corePath, "package.json"))).version;
    const manifest = existsSync(releasePath) ? await jsonFile<ReleaseManifest>(releasePath) : undefined;
    const version = manifest?.version || await currentVersion();
    const installPath = await realpath(projectRoot).catch(() => projectRoot);
    const prefix = process.env.PI_ARK_INSTALL_PREFIX || resolve(installPath, "../..");
    const previousManifestPath = join(prefix, "previous", "RELEASE.json");
    const previousVersion = existsSync(previousManifestPath) ? (await jsonFile<ReleaseManifest>(previousManifestPath)).version : undefined;
    const latest = checkLatest ? await latestRelease() : undefined;
    const channel = version.includes("-") ? "development" : "stable";
    return {
      version,
      coreVersion,
      corePath,
      agentDir: piArkAgentDir,
      dataDir: arkHome,
      installPath,
      installedRelease: Boolean(manifest),
      channel,
      latestVersion: latest?.version,
      latestUrl: latest?.url,
      updateAvailable: Boolean(channel === "stable" && latest?.version && latest.version !== version),
      updating: this.updating,
      previousVersion,
      rollbackAvailable: Boolean(previousVersion),
      commands: {
        update: "pi-ark update",
        rollback: "pi-ark rollback",
        status: "pi-ark status",
        logs: "pi-ark logs",
        restart: "pi-ark restart",
      },
    };
  }

  async update() {
    if (this.updating) throw Object.assign(new Error("Pi-Ark update is already in progress"), { statusCode: 409 });
    if (!existsSync(releasePath)) throw Object.assign(new Error("Pi-Ark updates require an installed release"), { statusCode: 409 });
    this.updating = true;
    try {
      await exec(process.execPath, [join(projectRoot, "scripts/pi-ark.mjs"), "update", "--no-restart"], { cwd: projectRoot, timeout: 600000, maxBuffer: 10 * 1024 * 1024, env: process.env });
      this.scheduleRestart();
      return { ...(await this.info(false)), restartScheduled: true, restartDelaySeconds: 5 };
    } catch (error) {
      throw Object.assign(new Error(`Pi-Ark update failed: ${commandMessage(error)}`), { statusCode: 500 });
    } finally {
      this.updating = false;
    }
  }

  async rollback() {
    if (this.updating) throw Object.assign(new Error("Pi-Ark maintenance is already in progress"), { statusCode: 409 });
    if (!existsSync(releasePath)) throw Object.assign(new Error("Pi-Ark rollback requires an installed release"), { statusCode: 409 });
    this.updating = true;
    try {
      await exec(process.execPath, [join(projectRoot, "scripts/pi-ark.mjs"), "rollback", "--no-restart"], { cwd: projectRoot, timeout: 60000, maxBuffer: 1024 * 1024, env: process.env });
      this.scheduleRestart();
      return { ...(await this.info(false)), restartScheduled: true, restartDelaySeconds: 5 };
    } catch (error) {
      throw Object.assign(new Error(`Pi-Ark rollback failed: ${commandMessage(error)}`), { statusCode: 500 });
    } finally {
      this.updating = false;
    }
  }

  private scheduleRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => process.exit(0), 5000);
    this.restartTimer.unref();
  }
}
