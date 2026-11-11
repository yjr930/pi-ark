import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";

export function installationDefaults({ platform = process.platform, instance = "default", portable = platform !== "linux", home = homedir(), env = process.env } = {}) {
  const suffix = instance === "default" ? "" : `-${instance}`;
  if (!portable && platform === "linux") return { prefix: `/opt/pi-ark${suffix}`, dataDir: `/var/lib/pi-ark${suffix}`, portable: false };
  if (platform === "darwin") {
    const base = join(home, "Library", "Application Support", `Pi-Ark${suffix}`);
    return { prefix: join(base, "app"), dataDir: join(base, "data"), portable: true };
  }
  if (platform === "win32") {
    const base = win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), `Pi-Ark${suffix}`);
    return { prefix: win32.join(base, "app"), dataDir: win32.join(base, "data"), portable: true };
  }
  return { prefix: join(home, ".local", "share", `pi-ark${suffix}`), dataDir: join(home, `.pi-ark${suffix}`), portable: true };
}

export function releaseAssetName(version, platform = process.platform, architecture = process.arch) {
  validateVersion(version);
  if (!["linux", "darwin", "win32"].includes(platform)) throw new Error(`Unsupported release platform: ${platform}`);
  return `pi-ark-${version}-${platform}-${architecture}.${platform === "win32" ? "zip" : "tar.gz"}`;
}

export function validateVersion(version) {
  if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(version)) throw new Error("Invalid release version");
  return version;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function optionalJson(path) {
  try { return await readJson(path); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

export async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    const deadline = Date.now() + 5000;
    for (let attempt = 1; ; attempt += 1) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || Date.now() >= deadline) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(attempt * 10, 100)));
      }
    }
  } finally { await rm(temporary, { force: true }); }
}

// Windows uses a single atomic JSON replacement; POSIX keeps the established symlink layout.
export async function readReleaseState(prefix, platform = process.platform) {
  if (platform === "win32") {
    const state = await optionalJson(join(prefix, "release-state.json"));
    if (!state) return {};
    for (const key of ["current", "previous"]) if (state[key] !== undefined && !isAbsolute(state[key])) throw new Error(`Release ${key} path must be absolute`);
    return { ...(state.current ? { current: state.current } : {}), ...(state.previous ? { previous: state.previous } : {}) };
  }
  const target = async (name) => { try { return await realpath(join(prefix, name)); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } };
  const current = await target("current");
  const previous = await target("previous");
  return { ...(current ? { current } : {}), ...(previous ? { previous } : {}) };
}

export async function writeReleaseState(prefix, state, platform = process.platform) {
  if (!state.current || !isAbsolute(state.current) || (state.previous && !isAbsolute(state.previous))) throw new Error("Release state requires absolute paths");
  await mkdir(prefix, { recursive: true });
  if (platform === "win32") return atomicJson(join(prefix, "release-state.json"), state);
  for (const name of ["previous", "current"]) {
    if (!state[name]) continue;
    const temporary = join(prefix, `${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try { await symlink(state[name], temporary); await rename(temporary, join(prefix, name)); }
    finally { await rm(temporary, { force: true }); }
  }
}

export async function switchRelease(prefix, destination, platform = process.platform) {
  const state = await readReleaseState(prefix, platform);
  destination = await realpath(resolve(destination));
  if (state.current === destination) return state;
  const next = { current: destination, ...(state.current ? { previous: state.current } : {}) };
  if (next.previous) await atomicJson(join(prefix, "pending-release.json"), next);
  await writeReleaseState(prefix, next, platform);
  return next;
}

export async function restoreFailedRelease(prefix, pending, platform = process.platform) {
  const state = await readReleaseState(prefix, platform);
  if (state.current !== pending.current) throw new Error("Release changed during startup health check");
  await writeReleaseState(prefix, { current: pending.previous, previous: pending.current }, platform);
  await rm(join(prefix, "pending-release.json"), { force: true });
}

// Existing version directories are reused, including the release serving this installer.
export async function stageRelease(source, prefix, version) {
  validateVersion(version);
  const releases = join(prefix, "releases");
  const destination = join(releases, version);
  await mkdir(releases, { recursive: true });
  if (await lstat(destination).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) return realpath(destination);
  const staging = await mkdtemp(join(releases, ".install-"));
  try {
    await cp(source, staging, { recursive: true, preserveTimestamps: true, dereference: process.platform === "win32", verbatimSymlinks: process.platform !== "win32" });
    try { await rename(staging, destination); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
    return realpath(destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function migratedPath(path, source, destination) {
  if (typeof path !== "string") return path;
  const remainder = relative(resolve(source), resolve(path));
  return remainder !== ".." && !remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(remainder) ? join(destination, remainder) : path;
}

export function shellQuote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
export function systemdQuote(value) { return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("\n", "\\n")}"`; }

export function extractArchive(archive, destination, platform = process.platform) {
  if (platform === "win32") {
    const literal = (value) => `'${value.replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${literal(archive)} -DestinationPath ${literal(destination)} -Force`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "inherit", windowsHide: true });
  } else execFileSync("tar", ["-xzf", archive, "-C", destination], { stdio: "inherit" });
}

export function healthRequest(config) {
  const host = ["0.0.0.0", "::"].includes(config.listen.host) ? "127.0.0.1" : config.listen.host;
  return new Promise((resolvePromise) => {
    const health = request({ host, port: config.listen.port, path: "/api/health", method: "GET", rejectUnauthorized: false, timeout: 2000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; if (body.length > 4096) health.destroy(); });
      response.on("end", () => { try { resolvePromise(response.statusCode === 200 && JSON.parse(body).status === "ok"); } catch { resolvePromise(false); } });
      response.on("error", () => resolvePromise(false));
    });
    health.on("timeout", () => { health.destroy(); resolvePromise(false); });
    health.on("error", () => resolvePromise(false));
    health.end();
  });
}

export const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
