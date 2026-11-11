import { execFile } from "node:child_process";
import { access, chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, machine, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { readBuildSource, verifyBuildSource } from "./release-source.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const serverPackage = JSON.parse(await readFile(join(root, "apps/server/package.json"), "utf8"));
const initialSource = await readBuildSource(root);
verifyBuildSource(initialSource, initialSource, packageJson.version);
const targetPlatform = process.env.PI_ARK_TARGET_PLATFORM || platform();
const targetArchitecture = process.env.PI_ARK_TARGET_ARCH || arch();
const nativeArchitecture = ({ x86_64: "x64", AMD64: "x64", arm64: "arm64", aarch64: "arm64" })[machine()];
if (targetPlatform !== platform() || targetArchitecture !== arch() || targetArchitecture !== nativeArchitecture) throw new Error(`Release target ${targetPlatform}/${targetArchitecture} must match the native build host ${platform()}/${machine()} (Node ${arch()})`);
if (!new Set(["linux/x64", "linux/arm64", "darwin/x64", "darwin/arm64", "win32/x64"]).has(`${targetPlatform}/${targetArchitecture}`)) throw new Error(`Unsupported release platform: ${targetPlatform}/${targetArchitecture}`);

// Invoke npm's JavaScript entry point on Windows; execFile cannot execute npm.cmd.
async function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath || (platform() === "win32" ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : undefined);
  if (npmCli) await access(npmCli);
  try {
    const result = await exec(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...args] : args, { cwd, timeout: 600000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, npm_config_platform: platform(), npm_config_arch: arch(), npm_config_build_from_source: "true" } });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    process.stdout.write(error.stdout || "");
    process.stderr.write(error.stderr || "");
    throw error;
  }
}
if (!process.env.PI_ARK_SKIP_BUILD) await runNpm(["run", "build"], root);

const name = `pi-ark-${packageJson.version}-${targetPlatform}-${targetArchitecture}`;
const output = join(root, "dist/release");
const staging = join(output, name);
await rm(staging, { recursive: true, force: true });
await mkdir(join(staging, "apps/server"), { recursive: true });
await mkdir(join(staging, "apps/web"), { recursive: true });
await mkdir(join(staging, "scripts"), { recursive: true });
await cp(join(root, "apps/server/dist"), join(staging, "apps/server/dist"), { recursive: true });
await cp(join(root, "apps/web/dist"), join(staging, "apps/web/dist"), { recursive: true });
for (const file of ["package.json", "package-lock.json"]) await cp(join(root, file), join(staging, file));
const runtimeScripts = ["install-release.mjs", "pi-ark.mjs", "platform.mjs", "setup.mjs"];
for (const file of runtimeScripts) await cp(join(root, "scripts", file), join(staging, "scripts", file));
await cp(join(root, "apps/server/package.json"), join(staging, "apps/server/package.json"));
await cp(join(root, "apps/web/package.json"), join(staging, "apps/web/package.json"));
await runNpm(["ci", "--omit=dev", "--include=optional"], staging);
const source = verifyBuildSource(initialSource, await readBuildSource(root), packageJson.version);
await writeFile(join(staging, "RELEASE.json"), JSON.stringify({ version: packageJson.version, piCoreVersion: serverPackage.dependencies["@earendil-works/pi-coding-agent"], platform: targetPlatform, architecture: targetArchitecture, builtAt: new Date().toISOString(), repository: "yjr930/pi-ark", ...source }, null, 2) + "\n");
await chmod(join(staging, "scripts/pi-ark.mjs"), 0o755);
await exec(process.execPath, [join(staging, "scripts/pi-ark.mjs"), "verify", "--release", staging], { cwd: staging, timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
const archive = join(output, `${name}.${targetPlatform === "win32" ? "zip" : "tar.gz"}`);
await rm(archive, { force: true });
// Windows' bundled bsdtar creates ZIPs and includes dotfiles. Dereference npm's workspace junctions.
const tar = targetPlatform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32/tar.exe") : "tar";
await exec(tar, targetPlatform === "win32" ? ["-a", "-h", "-cf", archive, "-C", output, name] : ["-czf", archive, "-C", output, name], { cwd: root, timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
console.log(archive);
