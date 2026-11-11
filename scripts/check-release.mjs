import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
if (process.argv.length !== 3) throw new Error("Usage: node scripts/check-release.mjs <artifact-dir>");
const artifact = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(artifact, "RELEASE.json"), "utf8"));
assert.equal(manifest.platform, process.platform, "Artifact platform must match the smoke host");
assert.equal(manifest.architecture, process.arch, "Artifact architecture must match the smoke host");
const temporary = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "pi-ark-release-smoke-"));
const diagnostics = join(temporary, "diagnostics");
const prefix = join(temporary, "安装 prefix with spaces");
const dataDir = join(temporary, "数据 with spaces");
const workspace = join(temporary, "工作区 with spaces");
const cli = join(prefix, "bin/pi-ark.mjs");
const username = "release-smoke";
const password = "temporary-release-smoke-password";
const fileName = "文件 with spaces.txt";
const fileContent = "Pi-Ark native release: Unicode 文件\n";
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("PI_ARK_") || key === "PI_CODING_AGENT_DIR") delete env[key];
Object.assign(env, { HOME: join(temporary, "home"), USERPROFILE: join(temporary, "home"), PI_ARK_HOME: dataDir, PI_ARK_AGENT_DIR: join(dataDir, "pi-agent"), PI_CODING_AGENT_DIR: join(dataDir, "pi-agent"), PI_ARK_INSTALL_PREFIX: prefix, NODE_ENV: "production" });
let port;
let cookie = "";
let commandNumber = 0;
let installed = false;
let complete = false;
let cleanupComplete = false;
let failure;
await Promise.all([mkdir(diagnostics), mkdir(workspace), mkdir(env.HOME)]);
await writeFile(join(workspace, fileName), fileContent);

async function runNode(label, args, timeout = 120000) {
  const log = join(diagnostics, `${String(++commandNumber).padStart(2, "0")}-${label}.log`);
  try {
    const result = await exec(process.execPath, args, { cwd: temporary, env, encoding: "utf8", timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
    await writeFile(log, `${result.stdout}\n${result.stderr}`);
    console.log(`${label}: ${result.stdout.trim()}`);
    return result;
  } catch (error) {
    await writeFile(log, `${error.stdout || ""}\n${error.stderr || ""}\n${error.message}\n`);
    throw new Error(`${label} failed; see ${log}`, { cause: error });
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  const value = server.address().port;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return value;
}

function http(path, method = "GET", body, authenticated = true) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: "127.0.0.1", port, path, method, rejectUnauthorized: false, timeout: 10000, headers: { ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => resolvePromise({ status: response.statusCode, headers: response.headers, text }));
    });
    req.on("timeout", () => req.destroy(new Error(`HTTPS request timed out: ${method} ${path}`)));
    req.on("error", reject);
    req.end(payload);
  });
}

async function json(path, method = "GET", body, expectedStatus = 200) {
  const response = await http(path, method, body);
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${response.text}`);
  return JSON.parse(response.text);
}

async function waitHealth(healthy) {
  const deadline = Date.now() + 45000;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await http("/api/health", "GET", undefined, false);
      last = response;
      if (healthy && response.status === 200 && JSON.parse(response.text).status === "ok") return;
    } catch (error) {
      last = error;
      if (!healthy && ["ECONNREFUSED", "ECONNRESET"].includes(error.code)) return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  throw new Error(`Expected HTTPS health ${healthy ? "ready" : "stopped"}: ${JSON.stringify(last)}`);
}

async function login() {
  const response = await http("/api/auth/login", "POST", { username, password }, false);
  assert.equal(response.status, 200, response.text);
  assert.equal(JSON.parse(response.text).authenticated, true);
  cookie = response.headers["set-cookie"]?.map((value) => value.split(";", 1)[0]).join("; ");
  assert.ok(cookie, "Login must set an authentication cookie");
  assert.equal((await json("/api/auth/session")).username, username);
}

async function waitVersion(version) {
  const deadline = Date.now() + 45000;
  let last;
  while (Date.now() < deadline) {
    try {
      await login();
      const info = await json("/api/settings/release");
      if (info.version === version) return info;
      last = info.version;
    } catch (error) { last = error.message; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Expected running release ${version}, received ${last}`);
}

async function activeRelease() {
  if (process.platform === "win32") {
    const state = JSON.parse(await readFile(join(prefix, "release-state.json"), "utf8"));
    assert.ok(state.current, "Windows installation must record its active release");
    return resolve(prefix, state.current);
  }
  return realpath(join(prefix, "current"));
}

async function terminal(workspaceId) {
  const require = createRequire(join(artifact, "package.json"));
  const { default: WebSocket } = await import(pathToFileURL(require.resolve("ws")).href);
  const marker = "PI_ARK_PTY_NATIVE_OK";
  const command = process.platform === "win32" ? "Write-Output ('PI_ARK_PTY_' + 'NATIVE_OK')\r" : "printf '%s%s\\n' 'PI_ARK_PTY_' 'NATIVE_OK'\r";
  const socket = new WebSocket(`wss://127.0.0.1:${port}/ws/terminal/${encodeURIComponent(workspaceId)}`, { rejectUnauthorized: false, headers: { Cookie: cookie } });
  let output = "";
  try {
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("PTY did not produce the expected command output")), 45000);
      const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolvePromise(); };
      socket.once("error", finish);
      socket.once("open", () => {
        socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
        socket.send(JSON.stringify({ type: "input", data: command }));
      });
      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === "error") return finish(new Error(message.message));
          if (message.type === "output") {
            output += message.data;
            const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
            // The input splits the marker into two literals, so echoed input cannot satisfy this check.
            if (text.includes(marker)) finish();
          }
          if (message.type === "exit") finish(new Error(`PTY exited before producing command output: ${message.exitCode}`));
        } catch (error) { finish(error); }
      });
      socket.once("close", () => finish(new Error("PTY connection closed before producing command output")));
    });
  } finally {
    await writeFile(join(diagnostics, "pty.log"), output);
    socket.terminate();
  }
}

async function collectLogs(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectLogs(path);
    else if (entry.name.endsWith(".log")) await cp(path, join(diagnostics, `runtime-${entry.name}`));
  }
}

try {
  await runNode("verify-artifact", [join(artifact, "scripts/pi-ark.mjs"), "verify", "--release", artifact]);
  const install = (source, label) => runNode(label, [join(source, "scripts/install-release.mjs"), "--portable", "--prefix", prefix, "--data-dir", dataDir, "--no-start"]);
  // Set before invoking the installer so partial installs also receive cleanup.
  installed = true;
  await install(artifact, "install");
  assert.equal(JSON.parse(await readFile(join(await activeRelease(), "RELEASE.json"), "utf8")).version, manifest.version);
  port = await freePort();
  await runNode("setup", [cli, "setup", "--username", username, "--password", password, "--workspace", workspace, "--port", String(port)]);
  await writeFile(join(dataDir, "smoke-data-marker.txt"), "portable data survives release changes\n");
  await runNode("start", [cli, "start"]);
  await waitHealth(true);
  await runNode("status", [cli, "status"]);
  assert.equal((await http("/")).status, 200, "Compiled web assets must be served");
  await login();
  const releaseInfo = await json("/api/settings/release");
  assert.equal(releaseInfo.version, manifest.version);
  assert.ok(releaseInfo.commands.update.includes(cli), "Portable maintenance must show the stable CLI entry point");
  const workspaces = (await json("/api/workspaces")).workspaces;
  const selected = workspaces.find((item) => resolve(item.path) === workspace);
  assert.ok(selected, "Setup must register the temporary Unicode workspace");
  const api = `/api/workspaces/${encodeURIComponent(selected.id)}`;
  const entries = (await json(`${api}/files`)).entries;
  assert.ok(entries.some((entry) => entry.name === fileName));
  const preview = await json(`${api}/file?path=${encodeURIComponent(fileName)}`);
  assert.equal(preview.content, fileContent);
  const download = await http(`${api}/download?path=${encodeURIComponent(fileName)}`);
  assert.equal(download.status, 200);
  assert.equal(download.text, fileContent);
  const session = await json(`${api}/sessions`, "POST", {}, 201);
  assert.ok(session.id, "Session API must create a real SDK Session");
  assert.equal((await json(`${api}/sessions/${session.id}`, "PATCH", { name: "Native release smoke" })).name, "Native release smoke");
  assert.ok(Array.isArray((await json(`${api}/sessions`)).sessions));
  assert.ok((await json(`${api}/session-statuses`)).statuses.some((item) => item.id === session.id && item.state === "ready"));
  const notebook = "# Native release smoke\nUnicode 数据 survives restart\n";
  await json(`${api}/notebook`, "PUT", { content: notebook });
  await terminal(selected.id);
  await runNode("restart", [cli, "restart"]);
  await waitHealth(true);
  await login();
  assert.equal((await json(`${api}/notebook`)).content, notebook);
  await runNode("stop", [cli, "stop"]);
  await waitHealth(false);

  // Optional extended exercise creates a second version without altering the source artifact.
  if (process.env.PI_ARK_SMOKE_ROLLBACK === "1") {
    const fixture = join(temporary, "second release fixture");
    const version = `${manifest.version}-smoke.2`;
    await cp(artifact, fixture, { recursive: true });
    await writeFile(join(fixture, "RELEASE.json"), JSON.stringify({ ...manifest, version }, null, 2) + "\n");
    const configBefore = await readFile(join(dataDir, "config.json"), "utf8");
    await install(fixture, "install-second-version");
    assert.equal(JSON.parse(await readFile(join(await activeRelease(), "RELEASE.json"), "utf8")).version, version);
    assert.equal(await readFile(join(dataDir, "config.json"), "utf8"), configBefore);
    await runNode("start-second-version", [cli, "start"]);
    await waitHealth(true);
    await login();
    const secondReleaseInfo = await json("/api/settings/release");
    assert.equal(secondReleaseInfo.version, version);
    assert.equal(secondReleaseInfo.previousVersion, manifest.version);
    assert.equal(secondReleaseInfo.rollbackAvailable, true);
    const rollbackResponse = await json("/api/settings/release/rollback", "POST", {});
    assert.equal(rollbackResponse.restartScheduled, true);
    const restoredInfo = await waitVersion(manifest.version);
    assert.equal(restoredInfo.previousVersion, version);
    assert.equal(JSON.parse(await readFile(join(await activeRelease(), "RELEASE.json"), "utf8")).version, manifest.version);
    assert.equal((await json(`${api}/notebook`)).content, notebook);
    assert.equal((await json(`${api}/file?path=${encodeURIComponent(fileName)}`)).content, fileContent);
    assert.equal(await readFile(join(dataDir, "smoke-data-marker.txt"), "utf8"), "portable data survives release changes\n");
    await runNode("stop-rollback", [cli, "stop"]);
    await waitHealth(false);
  }
  complete = true;
} catch (error) {
  failure = error;
} finally {
  if (installed) {
    try {
      await runNode("cleanup-stop", [cli, "stop"], 60000);
      if (port) await waitHealth(false);
      cleanupComplete = true;
    } catch (error) { failure ||= error; complete = false; }
  } else cleanupComplete = true;
  await collectLogs(dataDir);
  await collectLogs(join(prefix, "logs"));
  if (complete) await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  else {
    await writeFile(join(diagnostics, "failure.log"), `${failure?.stack || failure}\n${failure?.cause?.stack || ""}\n`);
    if (cleanupComplete) {
      for (const entry of await readdir(temporary)) if (entry !== "diagnostics") await rm(join(temporary, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
    console.error(`Release smoke failed. Diagnostics retained in ${diagnostics}`);
    for (const name of await readdir(diagnostics)) {
      const text = await readFile(join(diagnostics, name), "utf8");
      console.error(`--- ${name} ---\n${text.slice(-12000)}`);
    }
  }
}
if (failure) throw failure;
console.log(`Release smoke passed: ${manifest.platform}/${manifest.architecture} ${manifest.version}`);
