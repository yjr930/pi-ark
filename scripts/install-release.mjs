import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
if (process.getuid?.() !== 0) throw new Error("The system installer must run as root");
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(source, "RELEASE.json"), "utf8"));
if (manifest.platform !== platform() || manifest.architecture !== arch()) throw new Error("Release metadata does not match this host");
const prefix = resolve(option("--prefix", "/opt/pi-ark"));
const dataDir = resolve(option("--data-dir", "/var/lib/pi-ark"));
const serviceUser = option("--user", "pi-ark");
const serviceGroup = option("--group", serviceUser);
const sourceData = option("--migrate-data", undefined);
const destination = join(prefix, "releases", manifest.version);

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
  await symlink(oldCurrent, temporaryPrevious);
  await rename(temporaryPrevious, join(prefix, "previous"));
  await writeFile(join(prefix, "pending-release.json"), JSON.stringify({ current: destination, previous: oldCurrent }) + "\n");
}
const temporaryCurrent = `${currentLink}.${process.pid}.tmp`;
await rm(temporaryCurrent, { force: true });
await symlink(destination, temporaryCurrent);
await rename(temporaryCurrent, currentLink);

if (serviceUser !== "root") {
  execFileSync("chown", ["-R", `${serviceUser}:${serviceGroup}`, dataDir, prefix], { stdio: "inherit" });
}
const unit = `[Unit]\nDescription=Pi-Ark Web Agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${serviceUser}\nGroup=${serviceGroup}\nWorkingDirectory=${currentLink}\nEnvironment=NODE_ENV=production\nEnvironment=PI_ARK_HOME=${dataDir}\nEnvironment=PI_ARK_AGENT_DIR=${join(dataDir, "pi-agent")}\nEnvironment=PI_ARK_INSTALL_PREFIX=${prefix}\nExecStartPre=${currentLink}/scripts/pi-ark.mjs verify --release ${currentLink}\nExecStart=${currentLink}/scripts/pi-ark.mjs serve\nRestart=always\nRestartSec=5\nTimeoutStopSec=60\nKillSignal=SIGTERM\nUMask=0077\nLimitNOFILE=65535\n\n[Install]\nWantedBy=multi-user.target\n`;
await writeFile("/etc/systemd/system/pi-ark.service", unit);
await rm("/usr/local/bin/pi-ark", { force: true });
await symlink(join(currentLink, "scripts/pi-ark.mjs"), "/usr/local/bin/pi-ark");
execFileSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
if (!args.includes("--no-start")) {
  execFileSync("systemctl", ["enable", "pi-ark.service"], { stdio: "inherit" });
  execFileSync("systemctl", ["restart", "pi-ark.service"], { stdio: "inherit" });
  execFileSync("systemctl", ["is-active", "--quiet", "pi-ark.service"]);
  const config = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
  const healthHost = ["0.0.0.0", "::"].includes(config.listen.host) ? "127.0.0.1" : config.listen.host;
  execFileSync("curl", ["--fail", "--silent", "--show-error", "--insecure", "--retry", "30", "--retry-delay", "1", "--retry-connrefused", `https://${healthHost}:${config.listen.port}/api/health`], { stdio: "inherit" });
}
console.log(`Pi-Ark ${manifest.version} installed at ${destination}`);
console.log(`Pi-Ark data directory: ${dataDir}`);
