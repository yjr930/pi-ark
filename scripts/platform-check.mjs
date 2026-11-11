import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, installationDefaults, migratedPath, optionalJson, readJson, readReleaseState, releaseAssetName, restoreFailedRelease, shellQuote, stageRelease, switchRelease, systemdQuote, systemdServiceUnit, systemdWorkingDirectory, validateVersion, verifySystemdUnit, writeReleaseState } from "./platform.mjs";

const temporary = await mkdtemp(join(tmpdir(), "pi-ark-platform-"));
try {
  const linux = installationDefaults({ platform: "linux", home: temporary });
  assert.equal(linux.prefix, "/opt/pi-ark");
  assert.equal(linux.dataDir, "/var/lib/pi-ark");
  assert.equal(linux.portable, false);
  const linuxDev = installationDefaults({ platform: "linux", instance: "dev", home: temporary });
  assert.equal(linuxDev.prefix, "/opt/pi-ark-dev");
  const linuxPortable = installationDefaults({ platform: "linux", instance: "dev", portable: true, home: temporary });
  assert.equal(linuxPortable.prefix, join(temporary, ".local/share/pi-ark-dev"));
  assert.equal(linuxPortable.dataDir, join(temporary, ".pi-ark-dev"));
  const mac = installationDefaults({ platform: "darwin", instance: "backup", home: temporary });
  assert.equal(mac.prefix, join(temporary, "Library/Application Support/Pi-Ark-backup/app"));
  assert.equal(mac.dataDir, join(temporary, "Library/Application Support/Pi-Ark-backup/data"));
  const windows = installationDefaults({ platform: "win32", home: "C:\\用户\\User Name", env: { LOCALAPPDATA: "C:\\用户\\Local Data" } });
  assert.equal(windows.prefix, win32.join("C:\\用户\\Local Data", "Pi-Ark", "app"));
  assert.equal(windows.dataDir, win32.join("C:\\用户\\Local Data", "Pi-Ark", "data"));
  assert.equal(releaseAssetName("0.2.0-dev.1", "win32", "x64"), "pi-ark-0.2.0-dev.1-win32-x64.zip");
  assert.equal(releaseAssetName("0.2.0", "darwin", "arm64"), "pi-ark-0.2.0-darwin-arm64.tar.gz");
  assert.equal(releaseAssetName("0.2.0", "linux", "x64"), "pi-ark-0.2.0-linux-x64.tar.gz");
  for (const invalid of ["", "../other", "v/path", ".", "..", "a\\b"]) assert.throws(() => validateVersion(invalid));
  assert.throws(() => releaseAssetName("0.2.0", "other", "x64"));

  const source = join(temporary, "来源 source");
  const prefix = join(temporary, "安装 prefix with spaces");
  const data = join(temporary, "数据 with spaces");
  await mkdir(source);
  await writeFile(join(source, "marker.txt"), "original");
  if (process.platform !== "win32") await symlink("marker.txt", join(source, "relative-marker"));
  const first = await stageRelease(source, prefix, "0.2.0");
  await writeFile(join(first, "running-marker.txt"), "keep current release");
  await writeFile(join(source, "marker.txt"), "changed source");
  assert.equal(await stageRelease(source, prefix, "0.2.0"), first);
  assert.equal(await readFile(join(first, "marker.txt"), "utf8"), "original");
  if (process.platform !== "win32") assert.equal(await readFile(join(first, "relative-marker"), "utf8"), "original");
  assert.equal(await readFile(join(first, "running-marker.txt"), "utf8"), "keep current release");
  const second = await stageRelease(source, prefix, "0.2.1");
  const statePlatform = process.platform === "win32" ? "win32" : "linux";
  assert.deepEqual(await readReleaseState(prefix, statePlatform), {});
  await switchRelease(prefix, first, statePlatform);
  assert.equal((await readReleaseState(prefix, statePlatform)).current, first);
  await switchRelease(prefix, second, statePlatform);
  assert.deepEqual(await readReleaseState(prefix, statePlatform), { current: second, previous: first });
  assert.deepEqual(await readJson(join(prefix, "pending-release.json")), { current: second, previous: first });
  await switchRelease(prefix, second, statePlatform);
  assert.equal((await readReleaseState(prefix, statePlatform)).previous, first);
  await restoreFailedRelease(prefix, { current: second, previous: first }, statePlatform);
  assert.deepEqual(await readReleaseState(prefix, statePlatform), { current: first, previous: second });
  assert.equal(await optionalJson(join(prefix, "pending-release.json")), undefined);

  const aliasPrefix = join(temporary, "directory alias");
  await symlink(prefix, aliasPrefix, process.platform === "win32" ? "junction" : "dir");
  await switchRelease(aliasPrefix, join(aliasPrefix, "releases", "0.2.1"), statePlatform);
  assert.deepEqual(await readJson(join(aliasPrefix, "pending-release.json")), { current: second, previous: first });
  await restoreFailedRelease(aliasPrefix, { current: second, previous: first }, statePlatform);
  assert.deepEqual(await readReleaseState(prefix, statePlatform), { current: first, previous: second });

  const windowsPrefix = join(temporary, "Windows JSON state");
  await mkdir(windowsPrefix);
  await writeReleaseState(windowsPrefix, { current: first }, "win32");
  assert.equal((await readReleaseState(windowsPrefix, "win32")).current, first);
  await switchRelease(windowsPrefix, second, "win32");
  assert.deepEqual(await readReleaseState(windowsPrefix, "win32"), { current: second, previous: first });
  await restoreFailedRelease(windowsPrefix, { current: second, previous: first }, "win32");
  assert.deepEqual(await readReleaseState(windowsPrefix, "win32"), { current: first, previous: second });
  await assert.rejects(writeReleaseState(windowsPrefix, { current: "relative/path" }, "win32"));
  const atomicPath = join(temporary, "atomic.json");
  await atomicJson(atomicPath, { iteration: 0 });
  let reading = true;
  const reader = (async () => { while (reading) assert.equal(typeof (await readJson(atomicPath)).iteration, "number"); })();
  try { for (let iteration = 1; iteration <= 20; iteration += 1) await atomicJson(atomicPath, { iteration }); }
  finally { reading = false; await reader; }
  assert.equal((await readJson(atomicPath)).iteration, 20);
  assert.equal(migratedPath(join(source, "tls/server.key"), source, data), join(data, "tls/server.key"));
  const outside = join(`${source}-other`, "server.key");
  assert.equal(migratedPath(outside, source, data), outside);
  assert.equal(migratedPath(undefined, source, data), undefined);
  const quoted = "Unicode 用户's path with spaces and $symbols";
  if (process.platform !== "win32") assert.equal(execFileSync("sh", ["-c", `printf '%s' ${shellQuote(quoted)}`], { encoding: "utf8" }), quoted);
  assert.equal(systemdQuote('a "b" 10%'), '"a \\"b\\" 10%%"');
  assert.equal(systemdWorkingDirectory('/安装 prefix "quoted" \\ path 10%/current'), '/安装 prefix "quoted" \\ path 10%%/current');
  for (const invalid of ["relative/path", "/line\nbreak", "/line\rbreak", "/nul\0byte"]) assert.throws(() => systemdWorkingDirectory(invalid));
  if (process.platform === "linux") {
    const unitPrefix = join(temporary, '安装 unit prefix "quoted" \\ 10%');
    await mkdir(unitPrefix);
    const unitOptions = { prefix: unitPrefix, nodePath: process.execPath, cliPath: join(unitPrefix, "bin/pi-ark.mjs"), environment: { PI_ARK_HOME: data }, instance: "check", serviceUser: "root", serviceGroup: "root" };
    const unit = systemdServiceUnit(unitOptions);
    assert.ok(unit.includes(`WorkingDirectory=${unitPrefix.replaceAll("%", "%%")}/current\n`));
    await verifySystemdUnit(unitPrefix, "pi-ark-check.service", unit);
    assert.deepEqual(await readdir(unitPrefix), []);
    await assert.rejects(verifySystemdUnit(unitPrefix, "../invalid.service", unit));
    const oldQuotedUnit = unit.replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${systemdQuote(join(unitPrefix, "current"))}`);
    await assert.rejects(verifySystemdUnit(unitPrefix, "pi-ark-check.service", oldQuotedUnit));
    assert.deepEqual(await readdir(unitPrefix), []);

    // Exercise the actual installer while redirecting system files and intercepting service commands.
    const fixture = join(temporary, "installer source");
    await mkdir(join(fixture, "scripts"), { recursive: true });
    for (const name of ["install-release.mjs", "platform.mjs"]) await cp(fileURLToPath(new URL(name, import.meta.url)), join(fixture, "scripts", name));
    await atomicJson(join(fixture, "RELEASE.json"), { version: "0.2.2", platform: process.platform, architecture: process.arch });
    await writeFile(join(fixture, "scripts/pi-ark.mjs"), 'if (process.argv[2] !== "verify") throw new Error("Unexpected fixture CLI command");\n');
    const intercept = join(temporary, "installer-intercept.mjs");
    await writeFile(intercept, `import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { appendFileSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const exec = childProcess.execFileSync;
const write = fs.writeFile;
const remove = fs.rm;
const root = process.env.PI_ARK_CHECK_INSTALL_ROOT;
const mode = process.env.PI_ARK_CHECK_INSTALL_MODE;
const log = (event) => appendFileSync(join(root, "events.jsonl"), JSON.stringify(event) + "\\n");
const systemPath = (path) => path.startsWith("/etc/systemd/system/") || path.startsWith("/usr/local/bin/");
fs.writeFile = async (path, ...rest) => {
  if (systemPath(String(path))) { log({ command: "write-system-file", path }); return write(join(root, "system", basename(path)), ...rest); }
  return write(path, ...rest);
};
fs.rm = async (path, ...rest) => remove(systemPath(String(path)) ? join(root, "system", basename(path)) : path, ...rest);
childProcess.execFileSync = (command, args, options) => {
  if (command === "systemd-analyze") {
    const candidate = args[1];
    log({ command, args, unit: readFileSync(candidate, "utf8"), current: readlinkSync(join(root, "prefix", "current")), previous: readlinkSync(join(root, "prefix", "previous")) });
    if (mode === "verify-failure") writeFileSync(candidate, readFileSync(candidate, "utf8").replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory="/quoted/path"'));
    return exec(command, args, options);
  }
  if (command === "systemctl" || command === "systemd-run") {
    log({ command, args });
    if (command === "systemctl" && args[0] === "show") return mode === "load-failure" ? "error\\n" : "loaded\\n";
    return Buffer.alloc(0);
  }
  if (command !== process.execPath) throw new Error("Unexpected external command: " + command);
  return exec(command, args, options);
};
process.getuid = () => 0;
syncBuiltinESMExports();
`);
    for (const [mode, options] of [["verify-failure", ["--deferred-restart", "15"]], ["no-start", ["--no-start"]], ["no-start-deferred", ["--no-start", "--deferred-restart", "15"]], ["deferred", ["--deferred-restart", "15"]], ["load-failure", ["--deferred-restart", "15"]]]) {
      const root = join(temporary, `installer ${mode} 用户 10%`);
      const installPrefix = join(root, "prefix");
      const old = join(installPrefix, "releases/0.2.0");
      const previous = join(installPrefix, "releases/0.1.9");
      await mkdir(old, { recursive: true });
      await mkdir(previous, { recursive: true });
      await symlink(old, join(installPrefix, "current"));
      await symlink(previous, join(installPrefix, "previous"));
      await mkdir(join(root, "system"));
      const oldUnit = "existing service unit\n";
      const isolatedUnit = join(root, "system/pi-ark-check.service");
      await writeFile(isolatedUnit, oldUnit);
      const installation = { environment: { PI_ARK_PORT: "14116" } };
      await atomicJson(join(installPrefix, "install.json"), installation);
      const command = ["--import", intercept, join(fixture, "scripts/install-release.mjs"), "--prefix", installPrefix, "--data-dir", join(root, "data"), "--user", "root", "--group", "root", "--service-name", "pi-ark-check.service", "--cli-name", "pi-ark-check", ...options];
      const run = () => execFileSync(process.execPath, command, { encoding: "utf8", stdio: "pipe", env: { ...process.env, PI_ARK_CHECK_INSTALL_ROOT: root, PI_ARK_CHECK_INSTALL_MODE: mode } });
      if (mode === "verify-failure") assert.throws(run, (error) => /WorkingDirectory=.*path is not absolute/.test(error.stderr));
      else if (mode === "load-failure") assert.throws(run, (error) => /failed to load: error/.test(error.stderr));
      else run();
      const events = (await readFile(join(root, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const checked = events[0];
      assert.equal(checked.command, "systemd-analyze");
      assert.equal(checked.args[0], "verify");
      assert.equal(basename(checked.args[1]), "pi-ark-check.service");
      assert.equal(checked.current, old);
      assert.equal(checked.previous, previous);
      assert.ok(checked.unit.includes("PI_ARK_PORT=14116"));
      assert.equal((await readdir(installPrefix)).some((name) => name.startsWith(".unit-check-")), false);
      if (mode === "verify-failure") {
        assert.deepEqual(await readReleaseState(installPrefix), { current: old, previous });
        assert.equal(await readFile(isolatedUnit, "utf8"), oldUnit);
        assert.deepEqual(await readJson(join(installPrefix, "install.json")), installation);
        assert.equal(await optionalJson(join(installPrefix, "pending-release.json")), undefined);
        assert.equal(events.length, 1);
      } else {
        assert.deepEqual(await readReleaseState(installPrefix), { current: join(installPrefix, "releases/0.2.2"), previous: old });
        assert.equal(await readFile(isolatedUnit, "utf8"), checked.unit);
        const reloadIndex = events.findIndex((event) => event.command === "systemctl" && event.args[0] === "daemon-reload");
        const loadIndex = events.findIndex((event) => event.command === "systemctl" && event.args[0] === "show");
        assert.ok(reloadIndex > 0 && loadIndex > reloadIndex);
        const timerIndex = events.findIndex((event) => event.command === "systemd-run");
        assert.equal(events.some((event) => event.command === "systemctl" && event.args[0] === "restart"), false);
        if (mode === "deferred") {
          assert.ok(timerIndex > loadIndex);
          assert.deepEqual(events[timerIndex].args.slice(-5), ["--on-active", "15s", "/bin/systemctl", "restart", "pi-ark-check.service"]);
        } else {
          assert.equal(timerIndex, -1);
          assert.equal(events.some((event) => event.command === "systemctl" && event.args[0] === "enable"), false);
        }
      }
    }
  }
  const installer = new URL("./install-release.mjs", import.meta.url);
  const help = execFileSync(process.execPath, [fileURLToPath(installer), "--help"], { encoding: "utf8" });
  assert.match(help, /Usage: node scripts\/install-release\.mjs/);
  console.log("Platform helper checks passed");
} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
