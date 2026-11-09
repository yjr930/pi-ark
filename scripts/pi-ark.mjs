#!/usr/bin/env node

import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { homedir, platform, arch, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const args = process.argv.slice(2);
const command = args[0];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRepository = process.env.PI_ARK_RELEASE_REPOSITORY || "yjr930/pi-ark";

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp() {
  console.log(`Pi-Ark command line

Usage:
  pi-ark setup <setup options>
  pi-ark serve
  pi-ark password [--config <path>] [--no-restart]
  pi-ark update [--no-restart]
  pi-ark rollback [--no-restart]
  pi-ark verify [--release <path>]
  pi-ark status
  pi-ark logs
  pi-ark restart
  pi-ark help

Environment:
  PI_ARK_HOME                Pi-Ark data directory (default: ~/.pi-ark)
  PI_ARK_INSTALL_PREFIX      Release installation prefix (default: /opt/pi-ark)
  PI_ARK_INSTANCE            Instance identity used for cookie and service isolation
  PI_ARK_BASE_PATH           Public URL path prefix (for example: /pi-ark)
  PI_ARK_SERVICE_NAME        systemd service unit (default: pi-ark.service)
  PI_ARK_CLI_NAME            Installed CLI command name (default: pi-ark)
  PI_ARK_RELEASE_REPOSITORY  GitHub owner/repository (default: yjr930/pi-ark)
  PI_ARK_NEW_PASSWORD        Non-interactive password input
`);
}

async function promptSecret(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") throw new Error("Interactive password input requires a TTY. Use PI_ARK_NEW_PASSWORD for non-interactive input.");
  process.stdout.write(label);
  emitKeypressEvents(process.stdin);
  const previousRawMode = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolvePromise, rejectPromise) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(Boolean(previousRawMode));
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) rejectPromise(error); else resolvePromise(value);
    };
    const onKeypress = (text, key) => {
      if (key?.ctrl && key.name === "c") return finish(new Error("Password change cancelled"));
      if (key?.name === "return" || key?.name === "enter") return finish();
      if (key?.name === "backspace") {
        if (value.length > 0) { value = value.slice(0, -1); process.stdout.write("\b \b"); }
        return;
      }
      if (text && !key?.ctrl && !key?.meta) { value += text; process.stdout.write("*".repeat([...text].length)); }
    };
    process.stdin.on("keypress", onKeypress);
  });
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const digest = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(digest).toString("hex")}`;
}

async function changePassword() {
  const arkHome = resolve(process.env.PI_ARK_HOME || join(homedir(), ".pi-ark"));
  const targetConfig = resolve(option("--config") || join(arkHome, "config.json"));
  const environmentPassword = process.env.PI_ARK_NEW_PASSWORD;
  const password = environmentPassword || await promptSecret("New Pi-Ark password: ");
  if (password.length < 6) throw new Error("Password must contain at least 6 characters");
  if (!environmentPassword && password !== await promptSecret("Confirm new password: ")) throw new Error("Passwords do not match");
  const config = JSON.parse(await readFile(targetConfig, "utf8"));
  if (!config.auth?.username) throw new Error(`Invalid Pi-Ark configuration: ${targetConfig}`);
  config.auth.passwordHash = await hashPassword(password);
  await mkdir(dirname(targetConfig), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetConfig}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(temporaryPath, targetConfig);
  await chmod(targetConfig, 0o600);
  await unlink(join(dirname(targetConfig), "initial-credentials.txt")).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  console.log(`Password updated in ${targetConfig}`);
  if (!args.includes("--no-restart")) restartService();
}

function installPrefix() {
  if (process.env.PI_ARK_INSTALL_PREFIX) return resolve(process.env.PI_ARK_INSTALL_PREFIX);
  if (basename(dirname(projectRoot)) === "releases") return dirname(dirname(projectRoot));
  return "/opt/pi-ark";
}

function systemdServiceName() {
  const name = process.env.PI_ARK_SERVICE_NAME || "pi-ark.service";
  if (!/^pi-ark(?:-[a-z0-9_-]+)?\.service$/.test(name)) throw new Error("Invalid PI_ARK_SERVICE_NAME");
  return name;
}

function restartService() {
  const service = systemdServiceName();
  execFileSync("systemctl", ["restart", service], { stdio: "inherit" });
  console.log(`${service} restarted`);
}

async function githubLatest() {
  const response = await fetch(`https://api.github.com/repos/${releaseRepository}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Pi-Ark" }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`);
  return response.json();
}

async function verifyRelease(path) {
  const root = resolve(path);
  const manifest = JSON.parse(await readFile(join(root, "RELEASE.json"), "utf8"));
  if (!manifest.version || manifest.platform !== platform() || manifest.architecture !== arch()) throw new Error("Release metadata does not match this host");
  for (const required of ["apps/server/dist/index.js", "apps/web/dist/index.html", "scripts/pi-ark.mjs", "node_modules/@earendil-works/pi-coding-agent/package.json"]) await readFile(join(root, required));
  const check = spawnSync(process.execPath, ["--input-type=module", "--eval", "await import('@earendil-works/pi-coding-agent'); await import('node-pty');"], { cwd: root, encoding: "utf8" });
  if (check.status !== 0) throw new Error(`Release dependency check failed: ${(check.stderr || check.stdout).trim()}`);
  return manifest;
}

async function switchRelease(prefix, destination) {
  const currentLink = join(prefix, "current");
  const previousLink = join(prefix, "previous");
  let currentTarget;
  try { currentTarget = await realpath(currentLink); } catch { /* first release */ }
  if (currentTarget && currentTarget !== destination) {
    const previousTemporary = `${previousLink}.${process.pid}.tmp`;
    await rm(previousTemporary, { force: true });
    await symlink(currentTarget, previousTemporary);
    await rename(previousTemporary, previousLink);
  }
  const currentTemporary = `${currentLink}.${process.pid}.tmp`;
  await rm(currentTemporary, { force: true });
  await symlink(destination, currentTemporary);
  await rename(currentTemporary, currentLink);
  if (currentTarget && currentTarget !== destination) await writeFile(join(prefix, "pending-release.json"), JSON.stringify({ current: destination, previous: currentTarget }) + "\n");
}

function healthRequest(config) {
  const host = ["0.0.0.0", "::"].includes(config.listen.host) ? "127.0.0.1" : config.listen.host;
  return new Promise((resolvePromise) => {
    const health = request({ host, port: config.listen.port, path: "/api/health", method: "GET", rejectUnauthorized: false, timeout: 2000 }, (response) => {
      response.resume();
      resolvePromise(response.statusCode === 200);
    });
    health.on("timeout", () => { health.destroy(); resolvePromise(false); });
    health.on("error", () => resolvePromise(false));
    health.end();
  });
}

async function restoreFailedRelease(prefix, pending) {
  const currentTemporary = `${join(prefix, "current")}.${process.pid}.failed`;
  const previousTemporary = `${join(prefix, "previous")}.${process.pid}.failed`;
  await symlink(pending.previous, currentTemporary);
  await symlink(pending.current, previousTemporary);
  await rename(currentTemporary, join(prefix, "current"));
  await rename(previousTemporary, join(prefix, "previous"));
  await rm(join(prefix, "pending-release.json"), { force: true });
}

async function serve() {
  const prefix = installPrefix();
  const pendingPath = join(prefix, "pending-release.json");
  const child = spawn(process.execPath, [join(projectRoot, "apps/server/dist/index.js")], { stdio: "inherit", env: process.env });
  let childExit;
  const exited = new Promise((resolvePromise) => { child.once("exit", (code, signal) => { childExit = { code, signal }; resolvePromise(false); }); });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  let pending;
  try { pending = JSON.parse(await readFile(pendingPath, "utf8")); } catch { /* regular start */ }
  if (pending && await realpath(join(prefix, "current")).catch(() => "") === pending.current) {
    const config = JSON.parse(await readFile(join(process.env.PI_ARK_HOME || join(homedir(), ".pi-ark"), "config.json"), "utf8"));
    let healthy = false;
    for (let attempt = 0; attempt < 30 && !healthy; attempt += 1) {
      healthy = await Promise.race([healthRequest(config), exited]);
      if (!healthy && childExit) break;
      if (!healthy) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
    if (!healthy) {
      child.kill("SIGTERM");
      await restoreFailedRelease(prefix, pending);
      throw new Error("New release failed its startup health check; previous release restored");
    }
    await rm(pendingPath, { force: true });
    console.log("Pi-Ark release startup health check passed");
  }
  if (!childExit) await exited;
  process.exitCode = childExit?.code ?? (childExit?.signal ? 1 : 0);
}

async function updateRelease() {
  if (platform() !== "linux") throw new Error("Release updates currently support Linux");
  const latest = await githubLatest();
  const version = String(latest.tag_name || "").replace(/^v/, "");
  const assetName = `pi-ark-${version}-linux-${arch()}.tar.gz`;
  const asset = latest.assets?.find((item) => item.name === assetName);
  if (!version || !asset?.browser_download_url) throw new Error(`Release asset ${assetName} is unavailable`);
  const prefix = installPrefix();
  const destination = join(prefix, "releases", version);
  try {
    const current = JSON.parse(await readFile(join(prefix, "current", "RELEASE.json"), "utf8"));
    if (current.version === version) { console.log(`Pi-Ark ${version} is already current`); return; }
  } catch { /* no current release */ }
  const temporary = await mkdtemp(join(tmpdir(), "pi-ark-update-"));
  try {
    const archive = join(temporary, assetName);
    const response = await fetch(asset.browser_download_url, { headers: { "User-Agent": "Pi-Ark" }, redirect: "follow", signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`Release download returned HTTP ${response.status}`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const extracted = join(temporary, "extracted");
    await mkdir(extracted);
    execFileSync("tar", ["-xzf", archive, "-C", extracted], { stdio: "inherit" });
    const source = join(extracted, `pi-ark-${version}-linux-${arch()}`);
    const manifest = await verifyRelease(source);
    await mkdir(join(prefix, "releases"), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true, preserveTimestamps: true });
    await verifyRelease(destination);
    await switchRelease(prefix, destination);
    console.log(`Pi-Ark updated to ${manifest.version}`);
    if (!args.includes("--no-restart")) restartService();
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function rollbackRelease() {
  const prefix = installPrefix();
  const current = await realpath(join(prefix, "current"));
  const previous = await realpath(join(prefix, "previous"));
  if (current === previous) throw new Error("A previous Pi-Ark release is unavailable");
  await verifyRelease(previous);
  const currentTemporary = `${join(prefix, "current")}.${process.pid}.tmp`;
  const previousTemporary = `${join(prefix, "previous")}.${process.pid}.tmp`;
  await symlink(previous, currentTemporary);
  await symlink(current, previousTemporary);
  await rename(currentTemporary, join(prefix, "current"));
  await rename(previousTemporary, join(prefix, "previous"));
  await writeFile(join(prefix, "pending-release.json"), JSON.stringify({ current: previous, previous: current }) + "\n");
  console.log(`Pi-Ark rolled back to ${(JSON.parse(await readFile(join(previous, "RELEASE.json"), "utf8"))).version}`);
  if (!args.includes("--no-restart")) restartService();
}

function runServiceCommand(commandName) {
  const service = systemdServiceName();
  if (commandName === "logs") execFileSync("journalctl", ["-u", service, "-f"], { stdio: "inherit" });
  else if (commandName === "restart") restartService();
  else execFileSync("systemctl", ["status", service, "--no-pager"], { stdio: "inherit" });
}

try {
  if (command === "password" || command === "passwd") await changePassword();
  else if (command === "setup") await import("./setup.mjs");
  else if (command === "serve") await serve();
  else if (command === "update") await updateRelease();
  else if (command === "rollback") await rollbackRelease();
  else if (command === "verify") { const manifest = await verifyRelease(option("--release") || projectRoot); console.log(`Pi-Ark ${manifest.version} release check passed`); }
  else if (["status", "logs", "restart"].includes(command)) runServiceCommand(command);
  else if (!command || command === "help" || command === "--help" || command === "-h") printHelp();
  else { printHelp(); process.exitCode = 1; }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
