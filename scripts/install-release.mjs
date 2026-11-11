import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, delay, healthRequest, installationDefaults, migratedPath, optionalJson, readJson, shellQuote, stageRelease, switchRelease, systemdServiceUnit, validateVersion, verifySystemdUnit } from "./platform.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Pi-Ark release installer

Usage: node scripts/install-release.mjs [options]

  --portable                  Install for the current user (default on macOS and Windows)
  --prefix <path>             Installation directory
  --data-dir <path>           Global data directory
  --instance <name>           Instance identity (default: default)
  --base-path <path>          Public URL prefix
  --port <number>             Listen port
  --no-start                  Complete installation before setup and start
  --migrate-data <path>       Copy existing Global data during initialization
  --user <name>               Linux system service user
  --group <name>              Linux system service group
  --service-name <name>       Linux systemd service unit
  --cli-name <name>           Installed CLI name
  --deferred-restart <seconds> Schedule a Linux systemd restart
  --help                      Display installation options
`);
  process.exit(0);
}
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
};
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await readJson(join(source, "RELEASE.json"));
validateVersion(manifest.version);
if (manifest.platform !== process.platform || manifest.architecture !== process.arch) throw new Error("Release metadata does not match this host");
const portable = args.includes("--portable") || process.platform !== "linux";
if (!portable && process.getuid?.() !== 0) throw new Error("The system installer must run as root; use --portable for a current-user installation");
const instance = String(option("--instance", "default")).trim().toLowerCase();
if (!/^[a-z0-9_-]+$/.test(instance)) throw new Error("Instance must contain only letters, numbers, underscores, and hyphens");
const rawBasePath = String(option("--base-path", "")).trim();
const basePath = !rawBasePath || rawBasePath === "/" ? "" : rawBasePath.replace(/\/$/, "");
if (basePath && (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(basePath) || basePath.split("/").some((segment) => segment === "." || segment === ".."))) throw new Error("Base path must be an absolute URL path with URL-safe segments");
const defaultSuffix = instance === "default" ? "" : `-${instance}`;
const serviceName = option("--service-name", `pi-ark${defaultSuffix}.service`);
const cliName = option("--cli-name", `pi-ark${defaultSuffix}`);
if (!/^pi-ark(?:-[a-z0-9_-]+)?\.service$/.test(serviceName)) throw new Error("Invalid service name");
if (!/^pi-ark(?:-[a-z0-9_-]+)?$/.test(cliName)) throw new Error("Invalid CLI name");
const defaults = installationDefaults({ instance, portable });
const prefix = resolve(option("--prefix", defaults.prefix));
const dataDir = resolve(option("--data-dir", defaults.dataDir));
const dataRelative = relative(join(prefix, "releases"), dataDir);
if (dataRelative === "" || (!isAbsolute(dataRelative) && dataRelative !== ".." && !dataRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))) throw new Error("Data directory must be outside the releases directory");
const serviceUser = option("--user", "pi-ark");
const serviceGroup = option("--group", serviceUser);
if (!portable && (!/^[a-z_][a-z0-9_-]*\$?$/.test(serviceUser) || !/^[a-z_][a-z0-9_-]*\$?$/.test(serviceGroup))) throw new Error("Invalid service user or group");
const sourceData = option("--migrate-data", undefined);
const listenPortRaw = option("--port", undefined);
const listenPort = listenPortRaw === undefined ? undefined : Number(listenPortRaw);
if (listenPort !== undefined && (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535)) throw new Error("Port must be an integer from 1 to 65535");
const deferredRestartRaw = option("--deferred-restart", undefined);
const deferredRestart = deferredRestartRaw === undefined ? undefined : Number(deferredRestartRaw);
if (deferredRestart !== undefined && (!Number.isInteger(deferredRestart) || deferredRestart < 1 || deferredRestart > 300)) throw new Error("Deferred restart must be an integer from 1 to 300 seconds");
if (portable && deferredRestart !== undefined) throw new Error("--deferred-restart is available for systemd installations");

if (!portable && serviceUser !== "root") {
  try { execFileSync("id", [serviceUser], { stdio: "ignore" }); }
  catch { execFileSync("useradd", ["--system", "--home-dir", dataDir, "--create-home", "--shell", "/usr/sbin/nologin", serviceUser], { stdio: "inherit" }); }
}
await mkdir(prefix, { recursive: true, mode: 0o755 });
await mkdir(dataDir, { recursive: true, mode: 0o700 });
if (sourceData && resolve(sourceData) !== dataDir && !await optionalJson(join(dataDir, "config.json"))) {
  await cp(resolve(sourceData), dataDir, { recursive: true, force: false, dereference: process.platform === "win32", verbatimSymlinks: process.platform !== "win32" });
  const configPath = join(dataDir, "config.json");
  const config = await readJson(configPath);
  if (config.tls) {
    config.tls.keyPath = migratedPath(config.tls.keyPath, sourceData, dataDir);
    config.tls.certPath = migratedPath(config.tls.certPath, sourceData, dataDir);
  }
  await atomicJson(configPath, config);
}
if (listenPort !== undefined) {
  const configPath = join(dataDir, "config.json");
  const config = await optionalJson(configPath);
  if (config) { config.listen.port = listenPort; await atomicJson(configPath, config); }
}
const destination = await stageRelease(source, prefix, manifest.version);
execFileSync(process.execPath, [join(source, "scripts/pi-ark.mjs"), "verify", "--release", destination], { stdio: "inherit", windowsHide: true });

const cliEnvironment = { NODE_ENV: "production", PI_ARK_NODE_PATH: process.execPath, PI_ARK_HOME: dataDir, PI_ARK_AGENT_DIR: join(dataDir, "pi-agent"), PI_ARK_INSTALL_PREFIX: prefix, PI_ARK_INSTANCE: instance, PI_ARK_BASE_PATH: basePath, PI_ARK_SERVICE_NAME: serviceName, PI_ARK_CLI_NAME: cliName, PI_ARK_PORTABLE: portable ? "1" : "0", ...(listenPort === undefined ? {} : { PI_ARK_PORT: String(listenPort) }) };
const existingInstall = await optionalJson(join(prefix, "install.json"));
if (listenPort === undefined && existingInstall?.environment?.PI_ARK_PORT) cliEnvironment.PI_ARK_PORT = existingInstall.environment.PI_ARK_PORT;
const bin = join(prefix, "bin");
const cliPath = join(bin, `${cliName}.mjs`);
const unit = portable ? undefined : systemdServiceUnit({ prefix, nodePath: process.execPath, cliPath, environment: cliEnvironment, instance, serviceUser, serviceGroup });
if (!portable) await verifySystemdUnit(prefix, serviceName, unit);
await switchRelease(prefix, destination);
await atomicJson(join(prefix, "install.json"), { mode: portable ? "portable" : "systemd", nodePath: process.execPath, instance, dataDir, cliName, serviceName, environment: cliEnvironment });
await mkdir(bin, { recursive: true });
await cp(join(source, "scripts/platform.mjs"), join(bin, "platform.mjs"));
const cliLauncher = `#!/usr/bin/env node\nimport { pathToFileURL } from "node:url";\nimport { join } from "node:path";\nimport { readReleaseState } from "./platform.mjs";\nObject.assign(process.env, ${JSON.stringify(cliEnvironment)});\nconst state = await readReleaseState(${JSON.stringify(prefix)});\nif (!state.current) throw new Error("Pi-Ark has no current installed release");\nawait import(pathToFileURL(join(state.current, "scripts/pi-ark.mjs")).href);\n`;
await writeFile(cliPath, cliLauncher, { mode: 0o755 });
const posixLauncher = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} "$@"\n`;
await writeFile(join(bin, cliName), posixLauncher, { mode: 0o755 });
// cmd.exe expands percent expressions even inside quotes; double them in literal installed paths.
const cmdLiteral = (value) => value.replaceAll("%", "%%");
await writeFile(join(bin, `${cliName}.cmd`), `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n"${cmdLiteral(process.execPath)}" "%~dp0${cliName}.mjs" %*\r\n`);

if (!portable) {
  await writeFile(join("/etc/systemd/system", serviceName), unit);
  const globalCliPath = join("/usr/local/bin", cliName);
  await rm(globalCliPath, { force: true });
  await writeFile(globalCliPath, posixLauncher, { mode: 0o755 });
  if (serviceUser !== "root") execFileSync("chown", ["-R", `${serviceUser}:${serviceGroup}`, dataDir, prefix], { stdio: "inherit" });
  execFileSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
  const loadState = execFileSync("systemctl", ["show", serviceName, "--property=LoadState", "--value"], { encoding: "utf8" }).trim();
  if (loadState !== "loaded") throw new Error(`${serviceName} failed to load: ${loadState}`);
  if (!args.includes("--no-start")) {
    execFileSync("systemctl", ["enable", serviceName], { stdio: "inherit" });
    if (deferredRestart !== undefined) {
      const timerUnit = `${serviceName.replace(/\.service$/, "")}-deferred-restart-${Date.now()}`;
      execFileSync("systemd-run", ["--unit", timerUnit, "--on-active", `${deferredRestart}s`, "/bin/systemctl", "restart", serviceName], { stdio: "inherit" });
      console.log(`${serviceName} restart scheduled in ${deferredRestart} seconds`);
    } else {
      execFileSync("systemctl", ["restart", serviceName], { stdio: "inherit" });
      execFileSync("systemctl", ["is-active", "--quiet", serviceName]);
      const config = await readJson(join(dataDir, "config.json"));
      let healthy = false;
      for (let attempt = 0; attempt < 30 && !healthy; attempt += 1) { healthy = await healthRequest(config); if (!healthy) await delay(1000); }
      if (!healthy) throw new Error("Pi-Ark startup health check failed");
    }
  }
} else if (!args.includes("--no-start")) {
  if (await optionalJson(join(dataDir, "config.json"))) execFileSync(process.execPath, [cliPath, "restart"], { stdio: "inherit", windowsHide: true });
  else console.log(`Run ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} setup --username <name> --password <password> --workspace <path> before starting`);
}
console.log(`Pi-Ark ${manifest.version} installed at ${destination}`);
console.log(`Pi-Ark instance: ${instance} (${portable ? "portable" : serviceName}, ${basePath || "/"})`);
console.log(`Pi-Ark data directory: ${dataDir}`);
console.log(`CLI: ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} <command>`);
