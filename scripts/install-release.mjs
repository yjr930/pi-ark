import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
if (process.getuid?.() !== 0) throw new Error("The system installer must run as root");
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(source, "RELEASE.json"), "utf8"));
if (manifest.platform !== platform() || manifest.architecture !== arch()) throw new Error("Release metadata does not match this host");
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
const prefix = resolve(option("--prefix", instance === "default" ? "/opt/pi-ark" : `/opt/pi-ark-${instance}`));
const dataDir = resolve(option("--data-dir", instance === "default" ? "/var/lib/pi-ark" : `/var/lib/pi-ark-${instance}`));
const serviceUser = option("--user", "pi-ark");
const serviceGroup = option("--group", serviceUser);
const sourceData = option("--migrate-data", undefined);
const listenPortRaw = option("--port", undefined);
const listenPort = listenPortRaw === undefined ? undefined : Number(listenPortRaw);
if (listenPort !== undefined && (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535)) throw new Error("Port must be an integer from 1 to 65535");
const deferredRestartRaw = option("--deferred-restart", undefined);
const deferredRestart = deferredRestartRaw === undefined ? undefined : Number(deferredRestartRaw);
if (deferredRestart !== undefined && (!Number.isInteger(deferredRestart) || deferredRestart < 1 || deferredRestart > 300)) throw new Error("Deferred restart must be an integer from 1 to 300 seconds");
const destination = join(prefix, "releases", manifest.version);
if (listenPort !== undefined) {
  const configSource = sourceData ? join(resolve(sourceData), "config.json") : join(dataDir, "config.json");
  if (!(await lstat(configSource).then(() => true).catch(() => false))) throw new Error("--port requires an existing config.json or --migrate-data source; use setup --port for a fresh installation");
}

if (serviceUser !== "root") {
  try { execFileSync("id", [serviceUser], { stdio: "ignore" }); }
  catch { execFileSync("useradd", ["--system", "--home-dir", dataDir, "--create-home", "--shell", "/usr/sbin/nologin", serviceUser], { stdio: "inherit" }); }
}
await mkdir(join(prefix, "releases"), { recursive: true, mode: 0o755 });
await mkdir(dataDir, { recursive: true, mode: 0o700 });
if (sourceData && resolve(sourceData) !== dataDir) {
  const targetEntries = await lstat(join(dataDir, "config.json")).then(() => true).catch(() => false);
  if (!targetEntries) {
    await cp(resolve(sourceData), dataDir, { recursive: true, force: false });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (config.tls?.keyPath?.startsWith(resolve(sourceData))) config.tls.keyPath = join(dataDir, config.tls.keyPath.slice(resolve(sourceData).length));
    if (config.tls?.certPath?.startsWith(resolve(sourceData))) config.tls.certPath = join(dataDir, config.tls.certPath.slice(resolve(sourceData).length));
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  }
}
if (listenPort !== undefined) {
  const configPath = join(dataDir, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.listen.port = listenPort;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
if (source !== destination) {
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true, preserveTimestamps: true });
}
execFileSync(process.execPath, [join(destination, "scripts/pi-ark.mjs"), "verify", "--release", destination], { stdio: "inherit" });

const currentLink = join(prefix, "current");
let oldCurrent;
try { oldCurrent = await realpath(currentLink); } catch { /* first install */ }
if (oldCurrent && oldCurrent !== destination) {
  const temporaryPrevious = `${join(prefix, "previous")}.${process.pid}.tmp`;
  await rm(temporaryPrevious, { force: true });
  await symlink(oldCurrent, temporaryPrevious);
  await rename(temporaryPrevious, join(prefix, "previous"));
  await writeFile(join(prefix, "pending-release.json"), JSON.stringify({ current: destination, previous: oldCurrent }) + "\n");
}
const temporaryCurrent = `${currentLink}.${process.pid}.tmp`;
await rm(temporaryCurrent, { force: true });
await symlink(destination, temporaryCurrent);
await rename(temporaryCurrent, currentLink);

if (serviceUser !== "root") execFileSync("chown", ["-R", `${serviceUser}:${serviceGroup}`, dataDir, prefix], { stdio: "inherit" });
const unit = `[Unit]\nDescription=Pi-Ark Web Agent (${instance})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${serviceUser}\nGroup=${serviceGroup}\nWorkingDirectory=${currentLink}\nEnvironment=NODE_ENV=production\nEnvironment=PI_ARK_HOME=${dataDir}\nEnvironment=PI_ARK_AGENT_DIR=${join(dataDir, "pi-agent")}\nEnvironment=PI_ARK_INSTALL_PREFIX=${prefix}\nEnvironment=PI_ARK_INSTANCE=${instance}\nEnvironment=PI_ARK_BASE_PATH=${basePath}\nEnvironment=PI_ARK_SERVICE_NAME=${serviceName}\nEnvironment=PI_ARK_CLI_NAME=${cliName}\nExecStartPre=${currentLink}/scripts/pi-ark.mjs verify --release ${currentLink}\nExecStart=${currentLink}/scripts/pi-ark.mjs serve\nRestart=always\nRestartSec=5\nTimeoutStopSec=60\nKillSignal=SIGTERM\nUMask=0077\nLimitNOFILE=65535\n\n[Install]\nWantedBy=multi-user.target\n`;
await writeFile(join("/etc/systemd/system", serviceName), unit);
const cliPath = join("/usr/local/bin", cliName);
const cliEnvironment = { PI_ARK_HOME: dataDir, PI_ARK_AGENT_DIR: join(dataDir, "pi-agent"), PI_ARK_INSTALL_PREFIX: prefix, PI_ARK_INSTANCE: instance, PI_ARK_BASE_PATH: basePath, PI_ARK_SERVICE_NAME: serviceName, PI_ARK_CLI_NAME: cliName };
const cliLauncher = `#!/usr/bin/env node\nObject.assign(process.env, ${JSON.stringify(cliEnvironment)});\nawait import(${JSON.stringify(pathToFileURL(join(currentLink, "scripts/pi-ark.mjs")).href)});\n`;
await rm(cliPath, { force: true });
await writeFile(cliPath, cliLauncher, { mode: 0o755 });
execFileSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
if (!args.includes("--no-start")) {
  execFileSync("systemctl", ["enable", serviceName], { stdio: "inherit" });
  if (deferredRestart !== undefined) {
    const timerUnit = `${serviceName.replace(/\.service$/, "")}-deferred-restart-${Date.now()}`;
    execFileSync("systemd-run", ["--unit", timerUnit, "--on-active", `${deferredRestart}s`, "/bin/systemctl", "restart", serviceName], { stdio: "inherit" });
    console.log(`${serviceName} restart scheduled in ${deferredRestart} seconds`);
  } else {
    execFileSync("systemctl", ["restart", serviceName], { stdio: "inherit" });
    execFileSync("systemctl", ["is-active", "--quiet", serviceName]);
    const config = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
    const healthHost = ["0.0.0.0", "::"].includes(config.listen.host) ? "127.0.0.1" : config.listen.host;
    execFileSync("curl", ["--fail", "--silent", "--show-error", "--insecure", "--retry", "30", "--retry-delay", "1", "--retry-connrefused", `https://${healthHost}:${config.listen.port}/api/health`], { stdio: "inherit" });
  }
}
console.log(`Pi-Ark ${manifest.version} installed at ${destination}`);
console.log(`Pi-Ark instance: ${instance} (${serviceName}, ${basePath || "/"})`);
console.log(`Pi-Ark data directory: ${dataDir}`);
