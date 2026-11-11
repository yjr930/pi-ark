import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { defaultTerminalSettings, discoverTerminalProfiles, resolveTerminalShell, terminalEnvironment, type TerminalSettings } from "../apps/server/src/terminal-shells.ts";

const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-ark-terminal-")));
process.env.PI_ARK_HOME = join(directory, "home");
process.env.PI_ARK_AGENT_DIR = join(directory, "home", "agent");
const workspace = { id: "terminal-check", name: "Terminal check", path: join(directory, "workspace") };
const other = { id: "other-workspace", name: "Other workspace", path: join(directory, "other") };
const config = await import("../apps/server/src/config.ts");
const { TerminalService, openTerminal } = await import("../apps/server/src/terminal.ts");
const { WorkspaceService } = await import("../apps/server/src/workspaces.ts");

class Client extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  messages: Array<Record<string, any>> = [];
  closeCode?: number;
  get socket(): WebSocket { return this as unknown as WebSocket; }
  send(raw: string): void { this.messages.push(JSON.parse(raw)); }
  close(code = 1000): void { if (this.readyState !== 1) return; this.closeCode = code; this.readyState = 3; this.emit("close"); }
  input(data: string): void { this.emit("message", Buffer.from(JSON.stringify({ type: "input", data: process.platform === "win32" ? data.replace(/\r?\n/g, "\r") : data }))); }
  output(): string { return this.messages.filter((message) => message.type === "ready" || message.type === "output").map((message) => message.data).join(""); }
  offset(): number { return this.messages.filter((message) => message.type === "ready" || message.type === "output").at(-1)?.offset ?? 0; }
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const pids = new Set<number>();
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function startup(client: Client): { pid: number; cwd: string; text: string; value: string } | undefined {
  const match = client.output().match(/__START__(\{[^\r\n]+\})/);
  return match ? JSON.parse(match[1]!) : undefined;
}
let service: InstanceType<typeof TerminalService> | undefined;
try {
  await Promise.all([mkdir(config.arkHome, { recursive: true }), mkdir(workspace.path), mkdir(other.path)]);
  await writeFile(config.configPath, JSON.stringify({ auth: { username: "check", passwordHash: "check" }, tls: { keyPath: join(directory, "key"), certPath: join(directory, "cert") }, workspaces: [workspace, other] }));
  assert.deepEqual((await config.loadGlobalPreferences()).terminal, defaultTerminalSettings());
  const nodeProgram = `console.log('__START__'+JSON.stringify({pid:process.pid,cwd:process.cwd(),text:'中文🙂',value:process.env.TERMINAL_CHECK})); const readline=require('node:readline').createInterface({input:process.stdin,terminal:false}); readline.on('line',line=>{if(line==='exit')process.exit(7);else if(line==='defer')setTimeout(()=>console.log('__LATER__中文🙂'),180);else console.log('__VALUE__'+line)});`;
  const custom: TerminalSettings = { shell: "custom", executable: process.execPath, args: ["-e", nodeProgram], env: { HOME: directory, ZDOTDIR: directory, XDG_CONFIG_HOME: directory, USERPROFILE: directory, TERMINAL_CHECK: "配置中文" } };
  assert.deepEqual(await config.saveTerminalSettings(custom), custom);
  await Promise.all([
    config.saveGlobalPreferences({ files: { showHiddenFiles: false, maxPreviewSizeMb: 21 } }),
    config.saveGlobalSystemPrompt({ append: "Terminal configuration retained" }),
    config.saveGlobalArkSettings({ theme: "paper", hideReasoning: true }),
  ]);
  const preferences = await config.loadGlobalPreferences();
  assert.deepEqual(preferences.terminal, custom);
  assert.equal(preferences.files.maxPreviewSizeMb, 21);
  assert.equal(preferences.agent.systemPrompt.append, "Terminal configuration retained");
  const stale = { files: { showHiddenFiles: true, maxPreviewSizeMb: 22 }, terminal: defaultTerminalSettings() };
  assert.deepEqual((await config.saveGlobalPreferences(stale)).terminal, custom);
  assert.deepEqual(JSON.parse(await readFile(config.configPath, "utf8")).preferences.terminal, custom);
  const notExecutable = join(directory, "not-executable");
  await writeFile(notExecutable, "check");
  await chmod(notExecutable, 0o600);
  for (const input of [null, { ...custom, shell: "invalid" }, { ...custom, executable: "" }, { ...custom, executable: "missing-shell" }, { ...custom, executable: join(directory, "missing") }, { ...custom, executable: notExecutable }, { ...custom, args: "echo hi" }, { ...custom, args: [null] }, { ...custom, env: { A: 1 } }, { ...custom, env: { "A=B": "value" } }, { ...custom, env: { A: "\0" } }]) {
    await assert.rejects(config.saveTerminalSettings(input as TerminalSettings), { statusCode: 400 });
  }
  assert.deepEqual((await config.loadGlobalPreferences()).terminal, custom);
  const historical = JSON.parse(await readFile(config.configPath, "utf8"));
  historical.preferences.terminal = { shell: "bash" };
  await writeFile(config.configPath, JSON.stringify(historical));
  assert.deepEqual((await config.loadGlobalPreferences()).terminal, { ...defaultTerminalSettings(), shell: "bash" });
  await config.saveTerminalSettings(custom);

  // Platform inputs and executable probes exercise the same resolver used to spawn PTYs.
  for (const platform of ["linux", "darwin"] as const) {
    const fallback = platform === "darwin" ? "/bin/zsh" : "/bin/bash";
    const executable = (candidate: string) => ["/opt/shell/fish", fallback].includes(candidate);
    assert.equal(resolveTerminalShell(defaultTerminalSettings(), { platform, env: { SHELL: "/opt/shell/fish" }, executable }).executable, "/opt/shell/fish");
    assert.equal(resolveTerminalShell(defaultTerminalSettings(), { platform, env: { SHELL: "/missing" }, executable }).executable, fallback);
    assert.equal(resolveTerminalShell(defaultTerminalSettings(), { platform, env: { SHELL: "relative" }, executable }).executable, fallback);
  }
  const windowsEnv = { PATH: "C:\\shells", ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" };
  const pwsh = "C:\\shells\\pwsh.exe";
  const powershell = "C:\\shells\\powershell.exe";
  let available = new Set([pwsh, powershell, "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\shells\\wsl.exe"]);
  const windowsOptions = { platform: "win32" as const, env: windowsEnv, executable: (candidate: string) => available.has(candidate) };
  const resolvedWindows = resolveTerminalShell(defaultTerminalSettings(), windowsOptions);
  assert.equal(resolvedWindows.executable, pwsh);
  assert.ok(resolvedWindows.args.includes("-NoExit"));
  assert.equal(resolvedWindows.args.at(-2), "-Command");
  for (const encoding of ["[Console]::InputEncoding", "[Console]::OutputEncoding", "$OutputEncoding", "UTF8Encoding"]) assert.ok(resolvedWindows.args.at(-1)!.includes(encoding));
  const windowsProfiles = discoverTerminalProfiles(windowsOptions);
  for (const id of ["pwsh", "powershell", "git-bash", "wsl"]) assert.equal(windowsProfiles.find((profile) => profile.id === id)?.available, true);
  available.delete(pwsh);
  assert.equal(resolveTerminalShell(defaultTerminalSettings(), windowsOptions).executable, powershell);
  available = new Set();
  assert.throws(() => resolveTerminalShell(defaultTerminalSettings(), windowsOptions), { statusCode: 400 });
  assert.equal(terminalEnvironment(defaultTerminalSettings(), "linux", { LANG: "zh_CN.UTF-8", LC_CTYPE: "zh_CN.UTF-8" }, ["C.UTF-8", "zh_CN.utf8"]).LANG, "zh_CN.UTF-8");
  assert.equal(terminalEnvironment(defaultTerminalSettings(), "linux", { LANG: "C", LC_ALL: "C" }, ["C", "C.UTF-8"]).LC_ALL, "C.UTF-8");
  assert.equal(terminalEnvironment(defaultTerminalSettings(), "linux", { LANG: "missing.UTF-8" }, ["C", "C.utf8"]).LANG, "C.utf8");
  assert.equal(terminalEnvironment({ ...custom, env: { LANG: "explicit", LC_ALL: "explicit" } }, "linux", { LANG: "C" }).LC_ALL, "explicit");
  assert.deepEqual(resolveTerminalShell({ ...custom, args: ["argument with spaces", "$(literal)"] }).args, ["argument with spaces", "$(literal)"]);

  const registry = new WorkspaceService([workspace, other]);
  service = new TerminalService(registry);
  assert.throws(() => service!.list("unknown"), { statusCode: 404 });
  assert.throws(() => service!.create("unknown", custom), { statusCode: 404 });
  for (const dimensions of [{ cols: -1 }, { rows: 0 }, { cols: 2.5 }]) assert.throws(() => service!.create(workspace.id, custom, dimensions), { statusCode: 400 });
  const defaultTab = service.create(workspace.id, { ...defaultTerminalSettings(), env: { HOME: directory, ZDOTDIR: directory, XDG_CONFIG_HOME: directory, USERPROFILE: directory } });
  assert.equal(defaultTab.status, "running");
  const defaultClient = new Client();
  service.connect(workspace.id, defaultTab.id, defaultClient.socket);
  defaultClient.input(process.platform === "win32" ? "Write-Output ('__DEFAULT_' + 'READY__')\r" : "printf '__DEFAULT_%s__\\n' READY\n");
  await until(() => defaultClient.output().includes("__DEFAULT_READY__"), "default shell startup");
  service.close(workspace.id, defaultTab.id);
  const first = service.create(workspace.id, custom);
  const second = service.create(workspace.id, custom, { cols: 80, rows: 24 });
  assert.notEqual(first.id, second.id);
  assert.equal(second.cols, 80);
  assert.equal(service.list(workspace.id).length, 2);
  assert.throws(() => service!.connect(other.id, first.id, new Client().socket), { statusCode: 404 });
  const firstClient = new Client();
  const secondClient = new Client();
  service.connect(workspace.id, first.id, firstClient.socket);
  service.connect(workspace.id, second.id, secondClient.socket);
  await until(() => Boolean(startup(firstClient) && startup(secondClient)), "PTY startup");
  for (const client of [firstClient, secondClient]) {
    const start = startup(client)!;
    pids.add(start.pid);
    assert.equal(start.cwd, workspace.path);
    assert.equal(start.text, "中文🙂");
    assert.equal(start.value, "配置中文");
  }
  assert.notEqual(startup(firstClient)!.pid, startup(secondClient)!.pid);
  firstClient.input("中文输入🙂\n");
  await until(() => firstClient.output().includes("__VALUE__中文输入🙂"), "Chinese PTY input");
  firstClient.input("first-tab\n");
  secondClient.input("second-tab\n");
  await until(() => firstClient.output().includes("__VALUE__first-tab") && secondClient.output().includes("__VALUE__second-tab"), "separate PTY output");
  assert.equal(firstClient.output().includes("__VALUE__second-tab"), false);
  assert.equal(secondClient.output().includes("__VALUE__first-tab"), false);
  firstClient.emit("message", Buffer.from(JSON.stringify({ type: "resize", cols: 120, rows: 40 })));
  assert.equal(service.list(workspace.id).find((terminal) => terminal.id === first.id)!.cols, 120);
  firstClient.input("defer\n");
  await sleep(30);
  const previousOutput = firstClient.output();
  const previousOffset = firstClient.offset();
  assert.equal(previousOffset, previousOutput.length);
  firstClient.close();
  assert.equal(firstClient.listenerCount("message"), 0);
  await sleep(250);
  assert.ok(alive(startup(firstClient)!.pid));
  const reconnect = new Client();
  service.connect(workspace.id, first.id, reconnect.socket, String(previousOffset));
  assert.equal(reconnect.messages[0]!.type, "ready");
  assert.ok(reconnect.messages[0]!.data.includes("__LATER__中文🙂"));
  assert.equal(reconnect.messages[0]!.offset, previousOffset + reconnect.messages[0]!.data.length);
  const full = new Client();
  service.connect(workspace.id, first.id, full.socket, 0);
  assert.equal(full.messages[0]!.data, previousOutput + reconnect.messages[0]!.data);
  const noDuplicate = new Client();
  service.connect(workspace.id, first.id, noDuplicate.socket, full.offset());
  assert.equal(noDuplicate.messages[0]!.data, "");
  for (const offset of [-1, "-1", "1.5", "", "bad", full.offset() + 1]) {
    const invalid = new Client();
    service.connect(workspace.id, first.id, invalid.socket, offset);
    assert.equal(invalid.messages[0]!.code, "INVALID_OFFSET");
    assert.equal(invalid.closeCode, 1008);
  }
  reconnect.input("exit\n");
  await until(() => service!.list(workspace.id).find((terminal) => terminal.id === first.id)?.status === "exited", "natural exit");
  assert.equal(service.list(workspace.id).length, 2);
  const exited = new Client();
  service.connect(workspace.id, first.id, exited.socket, 0);
  assert.equal(exited.messages[0]!.terminal.exitCode, 7);
  assert.ok(exited.output().includes("__VALUE__first-tab"));
  assert.equal(exited.messages[1]!.type, "exit");
  assert.equal(exited.readyState, 1);
  service.close(workspace.id, first.id);
  assert.equal(exited.messages.at(-1)!.type, "closed");
  assert.equal(exited.readyState, 3);
  assert.throws(() => service!.connect(workspace.id, first.id, new Client().socket), { statusCode: 404 });
  service.close(workspace.id, second.id);
  await until(() => !alive(startup(secondClient)!.pid), "explicit close releases PTY");
  assert.equal(secondClient.messages.at(-1)!.type, "closed");
  assert.deepEqual(service.list(workspace.id), []);

  const workspaceTab = service.create(workspace.id, custom);
  const otherTab = service.create(other.id, custom);
  const workspaceClient = new Client();
  const otherClient = new Client();
  service.connect(workspace.id, workspaceTab.id, workspaceClient.socket);
  service.connect(other.id, otherTab.id, otherClient.socket);
  await until(() => Boolean(startup(workspaceClient) && startup(otherClient)), "cleanup PTYs startup");
  for (const client of [workspaceClient, otherClient]) pids.add(startup(client)!.pid);
  registry.remove(workspace.id);
  service.closeWorkspace(workspace.id);
  await until(() => !alive(startup(workspaceClient)!.pid), "Workspace cleanup releases PTY");
  assert.equal(workspaceClient.readyState, 3);
  assert.ok(alive(startup(otherClient)!.pid));
  service.dispose();
  await until(() => !alive(startup(otherClient)!.pid), "shutdown releases PTY");
  assert.equal(otherClient.readyState, 3);
  assert.deepEqual(service.list(other.id), []);
  service.dispose();

  // The public compatibility export retains connection-scoped cleanup.
  const legacy = new Client();
  const savedEnvironment = { ...process.env };
  let closeLegacy: (() => void) | undefined;
  try {
    Object.assign(process.env, { HOME: directory, ZDOTDIR: directory, XDG_CONFIG_HOME: directory, USERPROFILE: directory });
    closeLegacy = openTerminal(legacy.socket, other.path);
    legacy.input(process.platform === "win32" ? "Write-Output LEGACY_READY\r" : "printf 'LEGACY_READY\\n'\n");
    await until(() => legacy.output().includes("LEGACY_READY"), "legacy terminal input");
  } finally {
    legacy.close();
    closeLegacy?.();
    for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
    Object.assign(process.env, savedEnvironment);
  }
  console.log("terminal configuration, platform resolution, PTY isolation, reconnect and cleanup checks passed");
} finally {
  service?.dispose();
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid); } catch { /* Process exited during cleanup. */ } }
  await rm(directory, { recursive: true, force: true });
}
