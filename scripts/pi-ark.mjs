#!/usr/bin/env node

import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, open, readFile, rm, stat, unlink } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { atomicJson, delay, extractArchive, healthRequest, installationDefaults, optionalJson, readJson, readReleaseState, releaseAssetName, restoreFailedRelease, stageRelease, switchRelease, validateVersion } from "./platform.mjs";

const scrypt = promisify(scryptCallback);
const args = process.argv.slice(2);
const command = args[0];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRepository = process.env.PI_ARK_RELEASE_REPOSITORY || "yjr930/pi-ark";
const portable = process.env.PI_ARK_PORTABLE === "1" || process.platform !== "linux";

const formatMegabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function progressTicker(label, intervalMs) {
  const started = Date.now();
  return setInterval(() => console.log(`${label} (${Math.round((Date.now() - started) / 1000)}s)`), intervalMs);
}
const nodeExecutable = process.env.PI_ARK_NODE_PATH || process.execPath;
const arkHome = resolve(process.env.PI_ARK_HOME || join(homedir(), ".pi-ark"));
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };

function printHelp() {
  console.log(`Pi-Ark command line

Usage:
  pi-ark setup <setup options>
  pi-ark serve
  pi-ark start | stop | restart | status
  pi-ark logs [--follow]
  pi-ark password [--config <path>] [--no-restart]
  pi-ark update [--no-restart]
  pi-ark rollback [--no-restart]
  pi-ark verify [--release <path>]
  pi-ark mcp <list|add|remove|login|logout> ...
  pi-ark help

Portable installations run as the current user. serve stays in the foreground.
Portable logs prints the log; --follow follows new output.
mcp passes its arguments to the pi core MCP command and uses PI_ARK_AGENT_DIR as the pi agent directory.
Environment:
  PI_ARK_HOME                Pi-Ark data directory
  PI_ARK_AGENT_DIR           pi agent data directory (default: PI_ARK_HOME/pi-agent)
  PI_ARK_INSTALL_PREFIX      Release installation prefix
  PI_ARK_PORTABLE            1 for current-user background process management
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

async function changePassword() {
  const targetConfig = resolve(option("--config") || join(arkHome, "config.json"));
  const environmentPassword = process.env.PI_ARK_NEW_PASSWORD;
  const password = environmentPassword || await promptSecret("New Pi-Ark password: ");
  if (password.length < 6) throw new Error("Password must contain at least 6 characters");
  if (!environmentPassword && password !== await promptSecret("Confirm new password: ")) throw new Error("Passwords do not match");
  const config = await readJson(targetConfig);
  if (!config.auth?.username) throw new Error(`Invalid Pi-Ark configuration: ${targetConfig}`);
  const salt = randomBytes(16).toString("hex");
  config.auth.passwordHash = `scrypt$${salt}$${Buffer.from(await scrypt(password, salt, 64)).toString("hex")}`;
  await atomicJson(targetConfig, config);
  await chmod(targetConfig, 0o600);
  await unlink(join(dirname(targetConfig), "initial-credentials.txt")).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  console.log(`Password updated in ${targetConfig}`);
  if (!args.includes("--no-restart")) await restartService();
}

function installPrefix() {
  if (process.env.PI_ARK_INSTALL_PREFIX) return resolve(process.env.PI_ARK_INSTALL_PREFIX);
  if (basename(dirname(projectRoot)) === "releases") return dirname(dirname(projectRoot));
  return installationDefaults({ portable, instance: process.env.PI_ARK_INSTANCE || "default" }).prefix;
}

function systemdServiceName() {
  const name = process.env.PI_ARK_SERVICE_NAME || "pi-ark.service";
  if (!/^pi-ark(?:-[a-z0-9_-]+)?\.service$/.test(name)) throw new Error("Invalid PI_ARK_SERVICE_NAME");
  return name;
}

async function restartService() {
  if (portable) { console.log("Restarting Pi-Ark"); return portableCommand("restart"); }
  const service = systemdServiceName();
  console.log(`Restarting ${service}`);
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("systemctl", ["restart", service], { stdio: "inherit" });
    const ticker = progressTicker("Waiting for the service to stop and start", 5000);
    const settle = (error) => { clearInterval(ticker); error ? rejectPromise(error) : resolvePromise(); };
    child.once("error", (error) => settle(error));
    child.once("exit", (code, signal) => settle(code === 0 ? undefined : new Error(`systemctl restart exited with ${signal ? `signal ${signal}` : `code ${code}`}`)));
  });
  console.log(`${service} restarted`);
}

async function githubLatest() {
  const response = await fetch(`https://api.github.com/repos/${releaseRepository}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Pi-Ark" }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`);
  return response.json();
}

async function verifyRelease(path) {
  const root = resolve(path);
  const manifest = await readJson(join(root, "RELEASE.json"));
  validateVersion(manifest.version);
  if (manifest.platform !== process.platform || manifest.architecture !== process.arch) throw new Error("Release metadata does not match this host");
  for (const required of ["apps/server/dist/index.js", "apps/web/dist/index.html", "scripts/pi-ark.mjs", "scripts/setup.mjs", "node_modules/@earendil-works/pi-coding-agent/package.json"]) await readFile(join(root, required));
  const check = spawnSync(nodeExecutable, ["--input-type=module", "--eval", "await import('@earendil-works/pi-coding-agent'); await import('node-pty');"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (check.status !== 0) throw new Error(`Release dependency check failed: ${(check.stderr || check.stdout || check.error?.message || "unknown error").trim()}`);
  return manifest;
}

const runDirectory = () => join(installPrefix(), "run");
const statePath = () => join(runDirectory(), "daemon.json");
const logPath = () => join(installPrefix(), "logs", "pi-ark.log");

function controlRequest(state, action) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!state || !Number.isInteger(state.controlPort) || !state.token || state.prefix !== installPrefix() || state.dataDir !== arkHome) return resolvePromise(undefined);
    const request = httpRequest({ host: "127.0.0.1", port: state.controlPort, path: `/${action}`, method: action === "stop" ? "POST" : "GET", headers: { Authorization: `Bearer ${state.token}` }, timeout: 3000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; if (body.length > 65536) request.destroy(new Error("Invalid manager response")); });
      response.on("end", () => {
        try {
          const result = JSON.parse(body);
          resolvePromise(response.statusCode === 200 && result.pid === state.pid && result.prefix === state.prefix && result.dataDir === state.dataDir ? result : undefined);
        } catch { resolvePromise(undefined); }
      });
      response.on("error", rejectPromise);
    });
    request.on("timeout", () => request.destroy(new Error("Background manager timed out")));
    request.on("error", rejectPromise);
    request.end();
  });
}

async function managerStatus() {
  const state = await optionalJson(statePath());
  return controlRequest(state, "status").catch(() => undefined);
}

async function withManagerLock(callback) {
  await mkdir(runDirectory(), { recursive: true, mode: 0o700 });
  const lock = join(runDirectory(), "command.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await mkdir(lock); acquired = true; break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await optionalJson(join(lock, "owner.json"));
      if (!owner && Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 120000) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (owner) {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
        if (!alive) { await rm(lock, { recursive: true, force: true }); continue; }
      }
      await delay(500);
    }
  }
  if (!acquired) throw new Error("Another background management command is still running");
  try { await atomicJson(join(lock, "owner.json"), { pid: process.pid }); return await callback(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

async function stopPortable() {
  const state = await optionalJson(statePath());
  if (!await controlRequest(state, "status").catch(() => undefined)) { console.log("Pi-Ark is stopped"); return; }
  console.log("Stopping Pi-Ark");
  await controlRequest(state, "stop");
  const ticker = progressTicker("Waiting for Pi-Ark to stop", 10000);
  try {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (!await managerStatus()) { console.log("Pi-Ark stopped"); return; }
      await delay(250);
    }
    throw new Error("Background manager is still stopping; inspect the installation log");
  } finally { clearInterval(ticker); }
}

async function startPortable() {
  const existing = await managerStatus();
  if (existing) {
    console.log(JSON.stringify(existing, null, 2));
    if (!existing.healthy) throw new Error("Pi-Ark manager is running; inspect status and logs for startup progress");
    return;
  }
  let release = (await readReleaseState(installPrefix())).current;
  if (!release) throw new Error("Pi-Ark has no current installed release");
  try { await verifyRelease(release); }
  catch (error) {
    const pending = await optionalJson(join(installPrefix(), "pending-release.json"));
    if (pending?.current !== release || !pending.previous) throw error;
    await restoreFailedRelease(installPrefix(), pending);
    release = pending.previous;
    await verifyRelease(release);
    console.error(`Release preflight failed; previous release restored: ${error.message}`);
  }
  await readJson(join(arkHome, "config.json"));
  await mkdir(dirname(logPath()), { recursive: true, mode: 0o700 });
  const log = await open(logPath(), "a", 0o600);
  const token = randomBytes(32).toString("hex");
  console.log("Starting Pi-Ark");
  let spawnError;
  let child;
  try {
    child = spawn(nodeExecutable, [join(release, "scripts/pi-ark.mjs"), "__daemon"], { detached: true, stdio: ["ignore", log.fd, log.fd], windowsHide: true, env: { ...process.env, PI_ARK_PORTABLE: "1", PI_ARK_INSTALL_PREFIX: installPrefix(), PI_ARK_HOME: arkHome, PI_ARK_DAEMON_TOKEN: token } });
    child.once("error", (error) => { spawnError = error; });
    child.unref();
  } finally { await log.close(); }
  const ticker = progressTicker("Waiting for Pi-Ark to be ready", 10000);
  try {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (spawnError) throw spawnError;
      const state = await optionalJson(statePath());
      if (state?.token === token) {
        const status = await controlRequest(state, "status").catch(() => undefined);
        if (status?.healthy) { console.log(JSON.stringify(status, null, 2)); return; }
        if (state.error) throw new Error(`${state.error}; see ${logPath()}`);
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Background manager exited; see ${logPath()}`);
      await delay(250);
    }
    const state = await optionalJson(statePath());
    if (state?.token === token) await controlRequest(state, "stop").catch(() => undefined);
    throw new Error(`Pi-Ark startup timed out; see ${logPath()}`);
  } finally { clearInterval(ticker); }
}

async function portableCommand(name) {
  if (name === "status") {
    const current = (await readReleaseState(installPrefix())).current;
    const status = await managerStatus();
    console.log(JSON.stringify(status || { running: false, healthy: false, prefix: installPrefix(), dataDir: arkHome, current, logPath: logPath() }, null, 2));
    if (!status?.healthy) process.exitCode = 1;
    return;
  }
  if (name === "logs") {
    let position = 0;
    do {
      try {
        const log = await open(logPath(), "r");
        try {
          const size = (await log.stat()).size;
          if (size < position) position = 0;
          if (position === 0 && size > 256 * 1024) position = size - 256 * 1024;
          while (position < size) {
            const buffer = Buffer.alloc(Math.min(65536, size - position));
            const { bytesRead } = await log.read(buffer, 0, buffer.length, position);
            if (!bytesRead) break;
            process.stdout.write(buffer.subarray(0, bytesRead));
            position += bytesRead;
          }
        } finally { await log.close(); }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (args.includes("--follow")) await delay(500);
    } while (args.includes("--follow"));
    return;
  }
  return withManagerLock(async () => {
    if (["stop", "restart"].includes(name)) await stopPortable();
    if (["start", "restart"].includes(name)) await startPortable();
  });
}

// The authenticated loopback control channel identifies our own manager without signaling a persisted PID.
async function serve(background = false) {
  const prefix = installPrefix();
  const config = await readJson(join(arkHome, "config.json"));
  let child;
  let childStop;
  let stopping = false;
  let server;
  const state = { pid: process.pid, token: process.env.PI_ARK_DAEMON_TOKEN, prefix, dataDir: arkHome, controlPort: 0, running: true, healthy: false, logPath: logPath() };
  const publish = async () => { if (background) await atomicJson(statePath(), state); };
  const stopChild = async () => {
    const active = child;
    if (!active?.pid || active.exitCode !== null || active.signalCode !== null) return;
    if (childStop?.child === active) return childStop.promise;
    const exited = new Promise((resolvePromise) => active.once("exit", resolvePromise));
    const signalFallback = () => { if (active.exitCode === null && active.signalCode === null) active.kill("SIGTERM"); };
    const timer = setTimeout(() => { if (active.exitCode === null && active.signalCode === null) active.kill("SIGKILL"); }, 45000);
    childStop = { child: active, promise: exited.finally(() => clearTimeout(timer)) };
    if (active.connected) {
      try { active.send({ type: "pi-ark-shutdown" }, (error) => { if (error) signalFallback(); }); }
      catch { signalFallback(); }
    } else signalFallback();
    return childStop.promise;
  };
  const stop = () => { stopping = true; void stopChild(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    if (background) {
      if (!state.token) throw new Error("Background manager requires an installation token");
      if (await managerStatus()) throw new Error("Pi-Ark background manager is already running");
      server = createServer(async (request, response) => {
        if (request.headers.authorization !== `Bearer ${state.token}`) { response.writeHead(403); response.end(); return; }
        if (!["/status", "/stop"].includes(request.url) || (request.url === "/stop" && request.method !== "POST")) { response.writeHead(404); response.end(); return; }
        const current = (await readReleaseState(prefix).catch(() => ({}))).current;
        const healthy = Boolean(state.healthy && !stopping && current === state.release && child?.exitCode === null && child?.signalCode === null && await healthRequest(config));
        response.setHeader("Content-Type", "application/json");
        const { token, ...publicState } = state;
        response.end(JSON.stringify({ ...publicState, current, healthy }));
        if (request.url === "/stop") stop();
      });
      await new Promise((resolvePromise, rejectPromise) => { server.once("error", rejectPromise); server.listen(0, "127.0.0.1", resolvePromise); });
      state.controlPort = server.address().port;
      await publish();
    }
    while (!stopping) {
      const selected = (await readReleaseState(prefix)).current;
      const release = selected || projectRoot;
      const pendingPath = join(prefix, "pending-release.json");
      const pending = await optionalJson(pendingPath);
      let manifest;
      try {
        manifest = !selected && !background && !await optionalJson(join(release, "RELEASE.json")) ? await readJson(join(release, "package.json")) : await verifyRelease(release);
      }
      catch (error) {
        if (pending?.current === release && pending.previous) {
          await restoreFailedRelease(prefix, pending);
          console.error(`Release preflight failed; previous release restored: ${error.message}`);
          continue;
        }
        throw error;
      }
      if (await healthRequest(config)) throw new Error("The configured listen address already serves another process");
      state.release = release;
      state.version = manifest.version;
      state.healthy = false;
      delete state.error;
      console.log(`Starting Pi-Ark ${manifest.version} from ${release}`);
      child = spawn(nodeExecutable, [join(release, "apps/server/dist/index.js")], { stdio: ["inherit", "inherit", "inherit", "ipc"], env: process.env, windowsHide: true });
      const active = child;
      let childExit;
      const exited = new Promise((resolvePromise) => {
        active.once("exit", (code, signal) => { childExit = { code, signal }; resolvePromise(false); });
        active.on("error", (error) => {
          if (!active.pid) { childExit = { error }; resolvePromise(false); }
          else console.error(`Pi-Ark server process error: ${error.message}`);
        });
      });
      state.childPid = child.pid;
      await publish();
      let healthy = false;
      for (let attempt = 0; attempt < 30 && !stopping && !healthy && !childExit; attempt += 1) {
        healthy = await Promise.race([healthRequest(config), exited]);
        if (!healthy && !childExit) await delay(1000);
      }
      if (stopping) { await stopChild(); break; }
      if (!healthy) {
        await stopChild();
        if (pending?.current === release && pending.previous) {
          await restoreFailedRelease(prefix, pending);
          console.error("New release failed its startup health check; previous release restored");
          continue;
        }
        throw new Error(`Pi-Ark startup health check failed${childExit?.error ? `: ${childExit.error.message}` : ""}`);
      }
      if (pending?.current === release) await rm(pendingPath, { force: true });
      state.healthy = true;
      await publish();
      console.log(`Pi-Ark ${manifest.version} is healthy`);
      if (!childExit) await exited;
      state.healthy = false;
      await publish();
      if (!stopping) { console.log("Pi-Ark server exited; restarting from the selected release"); await delay(1000); }
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.healthy = false;
    await publish();
    throw error;
  } finally {
    stopping = true;
    await stopChild();
    if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    if (background) {
      const saved = await optionalJson(statePath());
      if (saved?.token === state.token && !state.error) await rm(statePath(), { force: true });
    }
  }
}

async function downloadReleaseAsset(url, destination, expectedSize) {
  const response = await fetch(url, { headers: { "User-Agent": "Pi-Ark" }, redirect: "follow", signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`Release download returned HTTP ${response.status}`);
  const total = expectedSize || Number(response.headers.get("content-length")) || 0;
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(destination, buffer);
    console.log(`Downloaded ${formatMegabytes(buffer.length)}`);
    return;
  }
  const chunks = [];
  let received = 0;
  let reportedAt = Date.now();
  for await (const chunk of response.body) {
    chunks.push(Buffer.from(chunk));
    received += chunk.length;
    if (total && Date.now() - reportedAt >= 2000) {
      reportedAt = Date.now();
      console.log(`Downloaded ${formatMegabytes(received)} of ${formatMegabytes(total)}`);
    }
  }
  const buffer = Buffer.concat(chunks);
  await writeFile(destination, buffer);
  console.log(total ? `Downloaded ${formatMegabytes(buffer.length)} of ${formatMegabytes(total)}` : `Downloaded ${formatMegabytes(buffer.length)}`);
}

async function updateRelease() {
  console.log("Checking the latest Pi-Ark release");
  const latest = await githubLatest();
  const version = validateVersion(String(latest.tag_name || "").replace(/^v/, ""));
  const assetName = releaseAssetName(version);
  const asset = latest.assets?.find((item) => item.name === assetName);
  if (!asset?.browser_download_url) throw new Error(`Release asset ${assetName} is unavailable`);
  const prefix = installPrefix();
  const current = (await readReleaseState(prefix)).current;
  if (current && (await readJson(join(current, "RELEASE.json"))).version === version) { console.log(`Pi-Ark ${version} is already current`); return; }
  console.log(`Latest Pi-Ark release: ${version}`);
  const temporary = await mkdtemp(join(tmpdir(), "pi-ark-update-"));
  try {
    const archive = join(temporary, assetName);
    console.log(`Downloading ${assetName}`);
    await downloadReleaseAsset(asset.browser_download_url, archive, Number(asset.size));
    const extracted = join(temporary, "extracted");
    await mkdir(extracted);
    extractArchive(archive, extracted);
    const source = join(extracted, `pi-ark-${version}-${process.platform}-${process.arch}`);
    console.log(`Verifying Pi-Ark ${version}`);
    const manifest = await verifyRelease(source);
    if (manifest.version !== version) throw new Error("Release version does not match the downloaded asset");
    console.log(`Installing Pi-Ark ${version}`);
    const destination = await stageRelease(source, prefix, version);
    await verifyRelease(destination);
    await switchRelease(prefix, destination);
    console.log(`Pi-Ark updated to ${manifest.version}`);
    if (!args.includes("--no-restart")) await restartService();
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function rollbackRelease() {
  const prefix = installPrefix();
  const { current, previous } = await readReleaseState(prefix);
  if (!previous || !current || current === previous) throw new Error("A previous Pi-Ark release is unavailable");
  const manifest = await verifyRelease(previous);
  await switchRelease(prefix, previous);
  console.log(`Pi-Ark rolled back to ${manifest.version}`);
  if (!args.includes("--no-restart")) await restartService();
}

async function runMcpCommand() {
  const candidates = [
    join(projectRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    join(projectRoot, "apps/server/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
  ];
  let coreCli;
  for (const candidate of candidates) {
    if (await stat(candidate).then(() => true, () => false)) { coreCli = candidate; break; }
  }
  if (!coreCli) throw new Error(`The pi core command line entry is unavailable under ${projectRoot}`);
  const agentDir = resolve(process.env.PI_ARK_AGENT_DIR || join(arkHome, "pi-agent"));
  const result = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(nodeExecutable, [coreCli, "mcp", ...args.slice(1)], { stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, windowsHide: true });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  if (result.signal) throw new Error(`pi mcp stopped by signal ${result.signal}`);
  process.exitCode = result.code ?? 1;
}

async function runServiceCommand(name) {
  if (portable) return portableCommand(name);
  const service = systemdServiceName();
  if (name === "logs") execFileSync("journalctl", ["-u", service, "-f"], { stdio: "inherit" });
  else if (name === "restart") await restartService();
  else if (name === "status") execFileSync("systemctl", ["status", service, "--no-pager"], { stdio: "inherit" });
  else execFileSync("systemctl", [name, service], { stdio: "inherit" });
}

try {
  if (command === "password" || command === "passwd") await changePassword();
  else if (command === "setup") {
    if (!args.includes("--port") && process.env.PI_ARK_PORT) process.argv.push("--port", process.env.PI_ARK_PORT);
    await import("./setup.mjs");
  }
  else if (command === "serve" || command === "__daemon") await serve(command === "__daemon");
  else if (command === "update") await updateRelease();
  else if (command === "rollback") await rollbackRelease();
  else if (command === "verify") { const manifest = await verifyRelease(option("--release") || projectRoot); console.log(`Pi-Ark ${manifest.version} release check passed`); }
  else if (command === "mcp") await runMcpCommand();
  else if (["start", "stop", "status", "logs", "restart"].includes(command)) await runServiceCommand(command);
  else if (!command || command === "help" || command === "--help" || command === "-h") printHelp();
  else { printHelp(); process.exitCode = 1; }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
