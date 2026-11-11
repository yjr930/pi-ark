import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { chromium, expect as playwrightExpect, request } from "@playwright/test";

// Run against an isolated HTTPS instance whose service account can access PI_ARK_CHECK_WORKSPACE.
// This check registers its own child Workspaces and only removes the directories it created.
const configuredURL = process.env.PI_ARK_CHECK_URL;
const suppliedWorkspace = process.env.PI_ARK_CHECK_WORKSPACE;
if (!configuredURL || !suppliedWorkspace) throw new Error("Set PI_ARK_CHECK_URL and PI_ARK_CHECK_WORKSPACE for an isolated Pi-Ark service");
const rootURL = new URL(configuredURL);
rootURL.search = "";
rootURL.hash = "";
if (!rootURL.pathname.endsWith("/")) rootURL.pathname += "/";
const endpoint = (path) => new URL(path.replace(/^\//, ""), rootURL).toString();
const tag = randomUUID().slice(0, 8);
const mark = (name) => `T${tag}_${name}`;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const nodeCommand = (source) => `node -e ${quote(`eval(Buffer.from(${JSON.stringify(Buffer.from(source).toString("base64"))},"base64").toString())`)}`;
const screenshot = (name) => `/tmp/pi-ark-terminal-dev33-${name}.png`;
const timeout = Number(process.env.PI_ARK_CHECK_TIMEOUT || 20000);
const expect = playwrightExpect.configure({ timeout });

let apiContext;
let browser;
let context;
let peerContext;
let page;
let fixtureDirectory;
let originalTerminalSettings;
let originalUiSettings;
let failure;
const ownedWorkspaces = [];
const stopFiles = new Set();
const cleanupErrors = [];
const pageErrors = [];
const steps = [];
let stage = "setup";

async function api(path, method = "GET", data) {
  const response = await apiContext.fetch(endpoint(path), { method, ...(data === undefined ? {} : { data }) });
  if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()} ${await response.text()}`);
  return response.status() === 204 ? undefined : response.json();
}
const terminalPath = (workspace, id = "") => `api/workspaces/${encodeURIComponent(workspace.id)}/terminals${id ? `/${encodeURIComponent(id)}` : ""}`;
const listTerminals = async (workspace) => (await api(terminalPath(workspace))).terminals;
const terminalURL = (workspace) => {
  const url = new URL(rootURL);
  url.searchParams.set("page", "terminal");
  url.searchParams.set("workspace", workspace.id);
  return url.toString();
};
const terminalPage = (target = page, workspace = ownedWorkspaces[0]) => target.locator(`[data-testid="terminal-page"][data-workspace-id="${workspace.id}"]`);
const tab = (info, target = page, workspace = ownedWorkspaces[0]) => terminalPage(target, workspace).locator(`.terminal-tab-item[data-terminal-id="${info.id}"] [role="tab"]`);
const pane = (info, target = page, workspace = ownedWorkspaces[0]) => terminalPage(target, workspace).locator(`[role="tabpanel"][data-terminal-id="${info.id}"]`);
const terminalRows = (info, target = page, workspace = ownedWorkspaces[0]) => pane(info, target, workspace).locator(".xterm-rows > div");
const screenLines = async (info, target = page, workspace = ownedWorkspaces[0]) => terminalRows(info, target, workspace).evaluateAll((rows) => rows.map((row) => row.textContent.replace(/\s+$/u, "")));
const nav = (name, target = page) => target.locator(".sidebar-navigation").getByRole("button", { name, exact: true });
const settingsNav = (name) => page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name, exact: true });
const shellSection = () => page.getByRole("region", { name: "Server shell settings", exact: true });
const argsField = () => shellSection().getByLabel("Terminal shell arguments", { exact: true });
const envField = () => shellSection().getByLabel("Terminal environment variables", { exact: true });

function progress(name) {
  stage = name;
  console.log(`Terminal UI: ${name}`);
  steps.push(name);
}

async function waitLine(info, text, target = page, workspace = ownedWorkspaces[0]) {
  await expect.poll(async () => {
    const lines = await screenLines(info, target, workspace);
    return lines.includes(text) || lines.join("").includes(text);
  }, { timeout, message: `Rendered PTY output: ${text}` }).toBe(true);
}

async function selectTab(info, target = page, workspace = ownedWorkspaces[0]) {
  await tab(info, target, workspace).click();
  await expect(tab(info, target, workspace)).toHaveAttribute("aria-selected", "true");
  await expect(pane(info, target, workspace)).toBeVisible();
}

async function connected(target = page, workspace = ownedWorkspaces[0]) {
  await expect(terminalPage(target, workspace).getByTestId("terminal-connection")).toHaveClass(/\bconnected\b/);
}

async function enter(info, command, target = page, workspace = ownedWorkspaces[0]) {
  await selectTab(info, target, workspace);
  await connected(target, workspace);
  const input = pane(info, target, workspace).locator(".xterm-helper-textarea");
  await input.focus();
  await input.pressSequentially(command);
  await input.press("Enter");
}

async function runNode(info, source, expected, target = page, workspace = ownedWorkspaces[0]) {
  await enter(info, nodeCommand(source), target, workspace);
  if (expected) await waitLine(info, expected, target, workspace);
}

async function initialize(info, target = page, workspace = ownedWorkspaces[0]) {
  const ready = mark(`READY${info.id.slice(0, 4)}`);
  // Expected output markers are encoded in commands, so a shell echo cannot satisfy the assertions.
  await enter(info, `export HISTFILE=/dev/null; stty -echo; export PS1='fixture> '; ${nodeCommand(`console.log(${JSON.stringify(ready)})`)}`, target, workspace);
  await waitLine(info, ready, target, workspace);
}

async function createTab(target = page, workspace = ownedWorkspaces[0], empty = false) {
  const response = target.waitForResponse((item) => item.request().method() === "POST" && item.url() === endpoint(terminalPath(workspace)));
  if (empty) await terminalPage(target, workspace).getByTestId("terminal-empty").getByRole("button", { name: "New terminal", exact: true }).click();
  else await terminalPage(target, workspace).getByRole("button", { name: "New terminal tab", exact: true }).click();
  const created = await response;
  assert.equal(created.ok(), true, await created.text());
  const info = await created.json();
  await expect(tab(info, target, workspace)).toHaveAttribute("aria-selected", "true");
  await connected(target, workspace);
  return info;
}

async function closeTab(info, target = page, workspace = ownedWorkspaces[0]) {
  const response = target.waitForResponse((item) => item.request().method() === "DELETE" && item.url() === endpoint(terminalPath(workspace, info.id)));
  await terminalPage(target, workspace).locator(`.terminal-tab-item[data-terminal-id="${info.id}"]`).getByRole("button", { name: `Close terminal ${info.title}`, exact: true }).click();
  assert.equal((await response).ok(), true);
  await expect(tab(info, target, workspace)).toHaveCount(0);
  assert.equal((await listTerminals(workspace)).some((entry) => entry.id === info.id), false);
}

async function readRecord(workspace, info) {
  const cookies = (await apiContext.storageState()).cookies;
  const url = new URL(endpoint(`ws/terminal/${encodeURIComponent(workspace.id)}/${encodeURIComponent(info.id)}?offset=0`));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new Promise((resolveRecord, reject) => {
    const socket = new WebSocket(url, { rejectUnauthorized: false, headers: { Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") } });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error(`Timed out reading record for ${info.title}`)); }, timeout);
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("message", (message) => {
      const payload = JSON.parse(String(message));
      if (payload.type === "ready") { clearTimeout(timer); socket.close(); resolveRecord(payload); }
      else if (payload.type === "error") { clearTimeout(timer); socket.close(); reject(new Error(payload.message)); }
    });
  });
}

function installObserver(target) {
  const connections = new Map();
  const blocked = new Set();
  const held = [];
  const inputs = new Map();
  const requests = new Map();
  target.on("pageerror", (error) => pageErrors.push(error.message));
  target.on("request", (item) => {
    const path = new URL(item.url()).pathname;
    const key = `${item.method()} ${path}`;
    requests.set(key, (requests.get(key) || 0) + 1);
  });
  function bridge(route, entry) {
    const server = route.connectToServer();
    entry.server = server;
    route.onMessage((message) => {
      const payload = JSON.parse(String(message));
      if (payload.type === "input") inputs.set(entry.id, `${inputs.get(entry.id) || ""}${payload.data}`);
      server.send(message);
    });
    server.onMessage((message) => {
      const payload = JSON.parse(String(message));
      entry.messages.push(payload);
      if (payload.type === "output" || payload.type === "ready") entry.offset = payload.offset;
      route.send(message);
    });
  }
  const installed = target.routeWebSocket(/\/ws\/terminal\//, (route) => {
    const url = new URL(route.url());
    const id = decodeURIComponent(url.pathname.split("/").at(-1));
    const entry = { id, route, url, messages: [], offset: Number(url.searchParams.get("offset") || 0) };
    const entries = connections.get(id) || [];
    entries.push(entry);
    connections.set(id, entries);
    if (blocked.has(id)) held.push({ route, entry });
    else bridge(route, entry);
  });
  return {
    installed, connections, requests, inputs,
    count: (id) => connections.get(id)?.length || 0,
    latest: (id) => connections.get(id)?.at(-1),
    requestCount: (method, path) => requests.get(`${method} ${new URL(endpoint(path)).pathname}`) || 0,
    async disconnect(id) {
      blocked.add(id);
      const entry = connections.get(id)?.at(-1);
      assert.ok(entry?.server, "A real Terminal WebSocket must be connected before disconnecting");
      await Promise.all([entry.route.close({ code: 1012, reason: "Terminal UI reconnect fixture" }), entry.server.close()]);
      return entry.offset;
    },
    resume(id) {
      blocked.delete(id);
      for (let index = held.length - 1; index >= 0; index--) if (held[index].entry.id === id) {
        const [{ route, entry }] = held.splice(index, 1);
        bridge(route, entry);
      }
    },
  };
}

async function openSettings(category = "Terminal") {
  await nav("Settings").click();
  await settingsNav(category).click();
  if (category === "Terminal") await expect(argsField()).toBeVisible();
}

async function chooseProfile(label) {
  await shellSection().getByRole("button", { name: "Terminal shell profile", exact: true }).click();
  await shellSection().getByRole("option").filter({ has: page.locator("strong", { hasText: label }) }).click();
}

async function saveShell() {
  const response = page.waitForResponse((item) => item.request().method() === "PUT" && item.url() === endpoint("api/settings/terminal"));
  await shellSection().getByRole("button", { name: "Save shell settings", exact: true }).click();
  const saved = await response;
  assert.equal(saved.ok(), true, await saved.text());
  await expect(shellSection().getByRole("button", { name: "Save shell settings", exact: true })).toBeDisabled();
  return (await saved.json()).settings;
}

async function assertGeometry(target = page) {
  const layout = await target.evaluate(() => {
    const host = document.querySelector(".terminal-page-host:not([hidden])");
    const controls = [...host.querySelectorAll(".terminal-toolbar button, .terminal-add")].map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    });
    const bounds = host.getBoundingClientRect();
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, left: bounds.left, right: bounds.right, controls };
  });
  assert.ok(layout.documentWidth <= layout.viewport, JSON.stringify(layout));
  assert.ok(layout.left >= 0 && layout.right <= layout.viewport + 1, JSON.stringify(layout));
  assert.equal(layout.controls.length, 4);
  for (const control of layout.controls) assert.ok(control.left >= 0 && control.right <= layout.viewport + 1 && control.width >= 28 && control.height >= 28, JSON.stringify(control));
}

try {
  fixtureDirectory = await mkdtemp(join(resolve(suppliedWorkspace), ".pi-ark-terminal-ui-"));
  await mkdir(join(fixtureDirectory, "alpha", "nested"), { recursive: true });
  await mkdir(join(fixtureDirectory, "beta"), { recursive: true });
  apiContext = await request.newContext({ ignoreHTTPSErrors: true, timeout });
  await api("api/auth/login", "POST", { username: process.env.PI_ARK_CHECK_USERNAME || "check", password: process.env.PI_ARK_CHECK_PASSWORD || "check-password" });
  originalTerminalSettings = (await api("api/settings/terminal")).settings;
  originalUiSettings = await api("api/ui");
  for (const name of ["alpha", "beta"]) ownedWorkspaces.push(await api("api/workspaces", "POST", { name: `Terminal UI ${tag} ${name}`, path: join(fixtureDirectory, name) }));
  const [alpha, beta] = ownedWorkspaces;
  const originalValue = "original value=before";
  const baseline = { shell: "bash", executable: "", args: ["--noprofile", "--norc"], env: { PI_ARK_UI_VALUE: originalValue, HISTFILE: "/dev/null", PS1: "fixture> " } };
  await api("api/settings/terminal", "PUT", baseline);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true, storageState: await apiContext.storageState(), permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  page.setDefaultTimeout(timeout);
  const observer = installObserver(page);
  await observer.installed;

  progress("first tab, Chinese output, native paste, clipboard button, and IME events");
  await page.goto(terminalURL(alpha));
  await expect(terminalPage().getByRole("tab")).toHaveCount(1);
  await connected();
  let first = (await listTerminals(alpha))[0];
  assert.ok(first);
  assert.equal(observer.requestCount("POST", terminalPath(alpha)), 1);
  await initialize(first);
  const chineseOutput = `${mark("OUTPUT")}:终端中文输出`;
  await runNode(first, `console.log(${JSON.stringify(chineseOutput)})`, chineseOutput);

  const nativeLine = `${mark("PASTE")}:原生粘贴`;
  const nativeCommand = nodeCommand(`console.log(${JSON.stringify(nativeLine)})`);
  await page.evaluate(async (text) => { window.__terminalCheckPasteEvents = []; document.addEventListener("paste", (event) => window.__terminalCheckPasteEvents.push({ text: event.clipboardData?.getData("text/plain"), trusted: event.isTrusted }), true); await navigator.clipboard.writeText(text); }, nativeCommand);
  await pane(first).locator(".xterm-helper-textarea").focus();
  // Linux Chromium's native paste shortcut is exercised without assigning any meaning to Ctrl+V.
  await page.keyboard.press("Control+Shift+V");
  await page.waitForFunction((text) => window.__terminalCheckPasteEvents.some((event) => event.trusted && event.text === text), nativeCommand);
  await expect.poll(() => observer.inputs.get(first.id) || "").toContain(nativeCommand);
  await page.keyboard.press("Enter");
  await waitLine(first, nativeLine);

  const buttonLine = `${mark("BUTTON")}:按钮粘贴`;
  const buttonCommand = nodeCommand(`console.log(${JSON.stringify(buttonLine)})`);
  await page.evaluate((text) => navigator.clipboard.writeText(text), buttonCommand);
  await terminalPage().getByRole("button", { name: "Paste into terminal", exact: true }).click();
  await expect.poll(() => observer.inputs.get(first.id) || "").toContain(buttonCommand);
  await pane(first).locator(".xterm-helper-textarea").press("Enter");
  await waitLine(first, buttonLine);

  const imeText = "中文输入";
  const imeLine = `${mark("IME")}:${imeText}`;
  const imePrefix = `${nodeCommand(`console.log(${JSON.stringify(`${mark("IME")}:`)} + process.argv[1])`)} '`;
  await pane(first).locator(".xterm-helper-textarea").focus();
  await pane(first).locator(".xterm-helper-textarea").pressSequentially(imePrefix);
  await expect.poll(() => observer.inputs.get(first.id) || "").toContain(imePrefix);
  const inputBeforeComposition = observer.inputs.get(first.id) || "";
  await pane(first).locator(".xterm-helper-textarea").evaluate((input, text) => {
    input.value = "";
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Process", keyCode: 229, isComposing: true }));
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
    input.value = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: text, isComposing: true }));
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
  }, imeText);
  await expect.poll(() => (observer.inputs.get(first.id) || "").slice(inputBeforeComposition.length)).toBe(imeText);
  await pane(first).locator(".xterm-helper-textarea").pressSequentially("'");
  await pane(first).locator(".xterm-helper-textarea").press("Enter");
  await waitLine(first, imeLine);
  for (const text of [chineseOutput, nativeLine, buttonLine, imeLine]) assert.equal((await readRecord(alpha, first)).data.split(text).length - 1, 1, `PTY output must contain one ${text}`);

  progress("independent shells, background output, selection, scroll, and page/Workspace cache");
  const firstState = mark("FIRST");
  await enter(first, `export PI_ARK_TAB_STATE=alpha; cd ${quote(join(alpha.path, "nested"))}; ${nodeCommand(`console.log(${JSON.stringify(`${firstState}:`)} + process.env.PI_ARK_TAB_STATE + ':' + process.cwd())`)}`);
  await waitLine(first, `${firstState}:alpha:${join(alpha.path, "nested")}`);
  let second = await createTab();
  await initialize(second);
  const secondState = `${mark("SECOND")}:unset:${alpha.path}`;
  await runNode(second, `console.log(${JSON.stringify(`${mark("SECOND")}:`)} + (process.env.PI_ARK_TAB_STATE || 'unset') + ':' + process.cwd())`, secondState);
  const writerStop = join(fixtureDirectory, "writer-stop");
  stopFiles.add(writerStop);
  const writerStart = mark("WRITER");
  const writerDone = mark("WRITERDONE");
  const tick = mark("TICK");
  await runNode(second, `const fs=require('node:fs');let i=0;console.log(${JSON.stringify(writerStart)});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(writerStop)})){clearInterval(timer);console.log(${JSON.stringify(writerDone)});return;}console.log(${JSON.stringify(tick)} + String(i++).padStart(3,'0'));},100);`, writerStart);
  await selectTab(first);
  const ticksBefore = (await readRecord(alpha, second)).data.split(tick).length - 1;
  await expect.poll(async () => (await readRecord(alpha, second)).data.split(tick).length - 1).toBeGreaterThanOrEqual(ticksBefore + 3);
  await writeFile(writerStop, "stop", { flag: "wx" });
  await expect.poll(async () => (await readRecord(alpha, second)).data.includes(writerDone)).toBe(true);
  await selectTab(second);
  await waitLine(second, writerDone);
  await selectTab(first);
  await waitLine(first, `${firstState}:alpha:${join(alpha.path, "nested")}`);

  const scrollPrefix = mark("SCROLL");
  const scrollDone = mark("SCROLLDONE");
  await runNode(first, `for(let i=0;i<160;i++)console.log(${JSON.stringify(scrollPrefix)} + String(i).padStart(3,'0'));console.log(${JSON.stringify(scrollDone)});`, scrollDone);
  const viewport = pane(first).locator(".xterm-viewport");
  await viewport.evaluate((element) => { element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * .45); });
  await expect.poll(async () => {
    const line = (await screenLines(first)).find((text) => text.startsWith(scrollPrefix));
    return line ? Number(line.slice(scrollPrefix.length)) : 999;
  }).toBeLessThan(90);
  assert.ok(await viewport.evaluate((element) => element.scrollTop) > 0);
  const row = terminalRows(first).nth(5);
  const rowBounds = await row.boundingBox();
  const columns = (await listTerminals(alpha)).find((entry) => entry.id === first.id).cols;
  const screenBounds = await pane(first).locator(".xterm-screen").boundingBox();
  const cellWidth = screenBounds.width / columns;
  await page.mouse.move(rowBounds.x + cellWidth * .2, rowBounds.y + rowBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowBounds.x + cellWidth * 12.2, rowBounds.y + rowBounds.height / 2, { steps: 8 });
  await page.mouse.up();
  const copy = terminalPage().getByRole("button", { name: "Copy terminal selection", exact: true });
  await expect(copy).toBeEnabled();
  await copy.click();
  const selection = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(selection.includes(scrollPrefix.slice(0, 9)), `Unexpected xterm selection: ${selection}`);
  await pane(first).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+Shift+C");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selection);
  const xtermElement = await pane(first).locator(".xterm").elementHandle();
  const firstConnections = observer.count(first.id);
  const firstReadyMessages = observer.connections.get(first.id).flatMap((entry) => entry.messages).filter((message) => message.type === "ready").length;
  const readingLine = (await screenLines(first))[0];
  await nav("Files").click();
  await expect(page.locator(".file-browser")).toBeVisible();
  await nav("Terminal").click();
  await expect(pane(first)).toBeVisible();
  assert.equal(await pane(first).locator(".xterm").evaluate((element, saved) => element === saved, xtermElement), true);
  await expect.poll(async () => (await screenLines(first))[0]).toBe(readingLine);
  await expect(copy).toBeEnabled();
  await page.locator(".workspace-open").filter({ hasText: beta.name }).click();
  await nav("Terminal").click();
  await expect(terminalPage(page, beta).getByRole("tab")).toHaveCount(1);
  await connected(page, beta);
  const betaTab = (await listTerminals(beta))[0];
  await initialize(betaTab, page, beta);
  const betaLine = mark("BETA");
  await runNode(betaTab, `console.log(${JSON.stringify(betaLine)})`, betaLine, page, beta);
  await page.locator(".workspace-open").filter({ hasText: alpha.name }).click();
  await nav("Terminal").click();
  await expect(pane(first)).toBeVisible();
  assert.equal(await pane(first).locator(".xterm").evaluate((element, saved) => element === saved, xtermElement), true);
  await expect.poll(async () => (await screenLines(first))[0]).toBe(readingLine);
  await expect(copy).toBeEnabled();
  await copy.click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selection);
  assert.equal(observer.count(first.id), firstConnections);
  assert.equal(observer.connections.get(first.id).flatMap((entry) => entry.messages).filter((message) => message.type === "ready").length, firstReadyMessages);
  await xtermElement.dispose();

  progress("refresh restores Tab IDs, active Tab, shell state, and rendered records");
  await selectTab(second);
  const beforeRefreshIds = (await listTerminals(alpha)).map((entry) => entry.id).sort();
  const selectedStorageKey = await page.evaluate((id) => Object.keys(localStorage).find((key) => key.startsWith("pi-ark-terminal-active:") && localStorage.getItem(key) === id), second.id);
  assert.ok(selectedStorageKey);
  await page.reload();
  await expect(tab(second)).toHaveAttribute("aria-selected", "true");
  await connected();
  await waitLine(second, writerDone);
  assert.deepEqual((await listTerminals(alpha)).map((entry) => entry.id).sort(), beforeRefreshIds);
  assert.equal(observer.requestCount("POST", terminalPath(alpha)), 2);
  await selectTab(first);
  await pane(first).locator(".xterm-viewport").evaluate((element) => { element.scrollTop = 0; });
  await waitLine(first, chineseOutput);
  await pane(first).locator(".xterm-viewport").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await waitLine(first, scrollDone);
  const restoredState = `${mark("RESTORED")}:alpha:${join(alpha.path, "nested")}`;
  await runNode(first, `console.log(${JSON.stringify(`${mark("RESTORED")}:`)} + process.env.PI_ARK_TAB_STATE + ':' + process.cwd())`, restoredState);

  progress("disconnected browser resumes the same PTY without duplicate output");
  const reconnectGate = join(fixtureDirectory, "reconnect-go");
  stopFiles.add(reconnectGate);
  const armed = mark("ARMED");
  const afterReconnect = mark("RECOVERED");
  await runNode(first, `const fs=require('node:fs');console.log(${JSON.stringify(armed)});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(reconnectGate)})){clearInterval(timer);console.log(${JSON.stringify(afterReconnect)});}},25);`, armed);
  const postsBeforeReconnect = observer.requestCount("POST", terminalPath(alpha));
  const connectionsBefore = observer.count(first.id);
  const offsetBeforeDisconnect = await observer.disconnect(first.id);
  await expect(terminalPage().getByTestId("terminal-connection")).toHaveClass(/\breconnecting\b/);
  await expect(terminalPage().getByRole("button", { name: "Reconnect terminal", exact: true })).toBeVisible();
  await writeFile(reconnectGate, "go", { flag: "wx" });
  await expect.poll(async () => (await readRecord(alpha, first)).data.includes(afterReconnect)).toBe(true);
  observer.resume(first.id);
  await connected();
  await waitLine(first, afterReconnect);
  await expect.poll(() => observer.count(first.id)).toBeGreaterThan(connectionsBefore);
  assert.ok(Number(observer.latest(first.id).url.searchParams.get("offset")) >= offsetBeforeDisconnect);
  const resumed = observer.latest(first.id).messages.find((message) => message.type === "ready");
  assert.ok(resumed);
  assert.equal(resumed.data.includes(armed), false);
  assert.equal(resumed.data.includes(afterReconnect), true);
  assert.equal((await screenLines(first)).filter((line) => line === armed).length, 1);
  assert.equal((await screenLines(first)).filter((line) => line === afterReconnect).length, 1);
  const recoveredRecord = await readRecord(alpha, first);
  assert.equal(recoveredRecord.data.split(armed).length - 1, 1);
  assert.equal(recoveredRecord.data.split(afterReconnect).length - 1, 1);
  assert.equal(observer.requestCount("POST", terminalPath(alpha)), postsBeforeReconnect);
  assert.deepEqual((await listTerminals(alpha)).map((entry) => entry.id).sort(), beforeRefreshIds);

  progress("lazy Terminal settings, Save/Cancel, preserved drafts, and custom shell environment");
  const terminalGetsBeforeSettings = observer.requestCount("GET", "api/settings/terminal");
  await nav("Settings").click();
  await expect(settingsNav("Interface")).toBeVisible();
  assert.equal(observer.requestCount("GET", "api/settings/terminal"), terminalGetsBeforeSettings);
  const profilesResponse = page.waitForResponse((item) => item.request().method() === "GET" && item.url() === endpoint("api/settings/terminal"));
  await settingsNav("Terminal").click();
  await expect(argsField()).toHaveValue(JSON.stringify(baseline.args));
  assert.equal(observer.requestCount("GET", "api/settings/terminal"), terminalGetsBeforeSettings + 1);
  const profiles = (await (await profilesResponse).json()).profiles;
  await shellSection().getByRole("button", { name: "Terminal shell profile", exact: true }).click();
  assert.deepEqual(await shellSection().getByRole("option").locator(".ark-select-copy strong").allTextContents(), ["Auto (Server default)", ...profiles.filter((profile) => profile.available && !["auto", "custom"].includes(profile.id)).map((profile) => profile.label), "Custom executable"]);
  await shellSection().getByRole("button", { name: "Terminal shell profile", exact: true }).click();
  const draftArgs = '["--noprofile","--norc","-i"]';
  const draftEnv = "PI_ARK_UI_VALUE=pending value=with=equals\nHISTFILE=/dev/null\nPS1=fixture> ";
  await argsField().fill(draftArgs);
  await envField().fill(draftEnv);
  await nav("Files").click();
  await expect(page.locator(".file-browser")).toBeVisible();
  await openSettings();
  await expect(argsField()).toHaveValue(draftArgs);
  await expect(envField()).toHaveValue(draftEnv);
  assert.equal(observer.requestCount("GET", "api/settings/terminal"), terminalGetsBeforeSettings + 1);
  const refreshSettings = page.waitForResponse((item) => item.request().method() === "GET" && item.url() === endpoint("api/settings/terminal"));
  await page.getByRole("button", { name: "Refresh settings", exact: true }).click();
  assert.equal((await refreshSettings).ok(), true);
  await expect(argsField()).toHaveValue(draftArgs);
  await expect(envField()).toHaveValue(draftEnv);
  await shellSection().getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(argsField()).toHaveValue(JSON.stringify(baseline.args));
  assert.equal((await api("api/settings/terminal")).settings.env.PI_ARK_UI_VALUE, originalValue);
  await chooseProfile("Custom executable");
  await shellSection().getByLabel("Custom shell executable", { exact: true }).fill("/bin/bash");
  await argsField().fill('["--noprofile","--norc","-i"]');
  const changedValue = "changed value=after=still";
  await envField().fill(`PI_ARK_UI_VALUE=${changedValue}\nPI_ARK_UI_EQUALS=left = right=tail\nHISTFILE=/dev/null\nPS1=fixture> `);
  const customSettings = await saveShell();
  assert.equal(customSettings.shell, "custom");
  assert.equal(customSettings.executable, "/bin/bash");
  assert.deepEqual(customSettings.args, ["--noprofile", "--norc", "-i"]);
  assert.equal(customSettings.env.PI_ARK_UI_VALUE, changedValue);
  assert.equal(customSettings.env.PI_ARK_UI_EQUALS, "left = right=tail");
  await nav("Terminal").click();
  const oldEnv = `${mark("OLDENV")}:${originalValue}`;
  await runNode(first, `console.log(${JSON.stringify(`${mark("OLDENV")}:`)} + process.env.PI_ARK_UI_VALUE)`, oldEnv);
  const customTab = await createTab();
  await initialize(customTab);
  assert.equal(customTab.shell, "/bin/bash");
  const newEnv = `${mark("NEWENV")}:${changedValue}`;
  await runNode(customTab, `console.log(${JSON.stringify(`${mark("NEWENV")}:`)} + process.env.PI_ARK_UI_VALUE);console.log(${JSON.stringify(`${mark("EQUALS")}:`)} + process.env.PI_ARK_UI_EQUALS);`, newEnv);
  await waitLine(customTab, `${mark("EQUALS")}:left = right=tail`);
  await openSettings();
  await shellSection().getByLabel("Custom shell executable", { exact: true }).fill("");
  await chooseProfile("Auto (Server default)");
  await argsField().fill("[]");
  await envField().fill("");
  const restoredAuto = await saveShell();
  assert.deepEqual(restoredAuto, { shell: "auto", executable: "", args: [], env: {} });

  progress("browser fonts update cached xterm immediately, persist, and reset");
  const appearance = page.getByRole("region", { name: "Browser Terminal appearance", exact: true });
  const defaultAppearance = await page.evaluate(() => JSON.parse(localStorage.getItem("pi-ark-terminal-appearance") || "null"));
  await appearance.getByLabel("Terminal font size", { exact: true }).fill("18");
  await appearance.getByLabel("Terminal font family", { exact: true }).fill('Consolas, "Noto Sans Mono CJK SC", monospace');
  await expect.poll(() => pane(customTab).locator(".xterm-rows").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBe(18);
  await expect.poll(() => pane(customTab).locator(".xterm-rows").evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Consolas");
  const savedAppearance = await page.evaluate(() => JSON.parse(localStorage.getItem("pi-ark-terminal-appearance")));
  assert.equal(savedAppearance.fontSize, 18);
  assert.ok(savedAppearance.fontFamily.includes("Noto Sans Mono CJK SC"));
  await page.screenshot({ path: screenshot("settings"), fullPage: true });
  await nav("Terminal").click();
  await expect(pane(customTab)).toBeVisible();
  await page.reload();
  await expect(tab(customTab)).toHaveAttribute("aria-selected", "true");
  await connected();
  await waitLine(customTab, `${mark("EQUALS")}:left = right=tail`);
  await expect.poll(() => pane(customTab).locator(".xterm-rows").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBe(18);
  await openSettings();
  await expect(appearance.getByLabel("Terminal font size", { exact: true })).toHaveValue("18");
  await expect(appearance.getByLabel("Terminal font family", { exact: true })).toHaveValue(savedAppearance.fontFamily);
  await appearance.getByRole("button", { name: "Reset font defaults", exact: true }).click();
  await expect(appearance.getByLabel("Terminal font size", { exact: true })).toHaveValue("13");
  const resetAppearance = await page.evaluate(() => JSON.parse(localStorage.getItem("pi-ark-terminal-appearance")));
  assert.ok(resetAppearance.fontFamily.includes("CJK") || resetAppearance.fontFamily.includes("PingFang"));
  assert.notEqual(resetAppearance.fontFamily, savedAppearance.fontFamily);
  if (defaultAppearance) assert.deepEqual(resetAppearance, defaultAppearance);
  await nav("Terminal").click();
  await expect.poll(() => pane(customTab).locator(".xterm-rows").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBe(13);

  progress("natural exit retains records and cross-browser close synchronizes");
  const exitLine = mark("EXIT");
  await enter(second, `${nodeCommand(`console.log(${JSON.stringify(exitLine)})`)}; exit 7`);
  await waitLine(second, exitLine);
  await expect(tab(second)).toContainText("Exited (7)");
  await expect(terminalPage().getByTestId("terminal-connection")).toContainText("Exited (7)");
  assert.equal((await listTerminals(alpha)).find((entry) => entry.id === second.id).status, "exited");
  assert.equal((await readRecord(alpha, second)).data.includes(exitLine), true);
  await nav("Files").click();
  await nav("Terminal").click();
  await waitLine(second, exitLine);
  await expect(tab(second)).toContainText("Exited (7)");
  const remoteTab = await createTab();
  await initialize(remoteTab);
  peerContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true, storageState: await apiContext.storageState() });
  const peer = await peerContext.newPage();
  peer.on("pageerror", (error) => pageErrors.push(error.message));
  await peer.goto(terminalURL(alpha));
  await expect(tab(remoteTab, peer)).toBeVisible();
  await closeTab(remoteTab, peer);
  await expect(tab(remoteTab)).toHaveCount(0);
  await peerContext.close();
  peerContext = undefined;
  await closeTab(second);

  progress("five themes and desktop controls");
  for (const [label, id] of [["Ark Dark", "ark-dark"], ["Graphite", "graphite"], ["Midnight", "midnight"], ["Snow", "snow"], ["Paper", "paper"]]) {
    await openSettings("Interface");
    const save = page.waitForResponse((item) => item.request().method() === "PUT" && item.url() === endpoint("api/ui"));
    await page.locator(".theme-options").getByRole("button", { name: label, exact: true }).click();
    assert.equal((await save).ok(), true);
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    await nav("Terminal").click();
    await selectTab(customTab);
    await assertGeometry();
    await terminalPage().getByRole("button", { name: "Fit terminal", exact: true }).click();
    if (id === "ark-dark" || id === "paper") await page.screenshot({ path: screenshot(id === "paper" ? "paper" : "dark"), fullPage: true });
  }

  progress("390px and 320px layout, horizontal tabs, and toolbar paste");
  for (let index = 0; index < 3; index++) await createTab();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await assertGeometry();
    const tabList = terminalPage().getByRole("tablist", { name: "Terminal tabs", exact: true });
    const overflow = await tabList.evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth, overflowX: getComputedStyle(element).overflowX }));
    assert.ok(overflow.content > overflow.width, JSON.stringify(overflow));
    assert.equal(overflow.overflowX, "auto");
    await selectTab(customTab);
    await connected();
    const mobileLine = mark(`M${width}`);
    const mobileCommand = nodeCommand(`console.log(${JSON.stringify(mobileLine)})`);
    await page.evaluate((text) => navigator.clipboard.writeText(text), mobileCommand);
    await terminalPage().getByRole("button", { name: "Paste into terminal", exact: true }).click();
    await expect.poll(() => observer.inputs.get(customTab.id) || "").toContain(mobileCommand);
    await pane(customTab).locator(".xterm-helper-textarea").press("Enter");
    await waitLine(customTab, mobileLine);
    await terminalPage().getByRole("button", { name: "Fit terminal", exact: true }).click();
    await assertGeometry();
    await page.screenshot({ path: screenshot(String(width)), fullPage: true });
  }

  progress("last close shows an empty state, New creates a fresh Tab, and Workspace close releases UI");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const remaining = await listTerminals(alpha);
  for (const info of remaining) { await selectTab(info); await closeTab(info); }
  await expect(terminalPage().getByTestId("terminal-empty").getByRole("heading", { name: "No terminal tabs", exact: true })).toBeVisible();
  assert.equal((await listTerminals(alpha)).length, 0);
  // Explicit refresh exercises the empty-list path rather than relying on a sleep to detect auto-creation.
  const postsBeforeEmptyRefresh = observer.requestCount("POST", terminalPath(alpha));
  const emptyRefresh = page.waitForResponse((item) => item.request().method() === "GET" && item.url() === endpoint(terminalPath(alpha)));
  await terminalPage().getByRole("button", { name: "Refresh tabs", exact: true }).click();
  assert.equal((await emptyRefresh).ok(), true);
  await expect(terminalPage().getByRole("tab")).toHaveCount(0);
  await expect(terminalPage().getByTestId("terminal-empty").getByRole("button", { name: "New terminal", exact: true })).toBeEnabled();
  assert.equal(observer.requestCount("POST", terminalPath(alpha)), postsBeforeEmptyRefresh);
  assert.equal((await listTerminals(alpha)).length, 0);
  const fresh = await createTab(page, alpha, true);
  assert.equal(remaining.some((info) => info.id === fresh.id), false);
  await initialize(fresh);
  await closeTab(fresh);
  await page.locator(".workspace-open").filter({ hasText: beta.name }).click();
  await nav("Terminal").click();
  await connected(page, beta);
  await waitLine(betaTab, betaLine, page, beta);
  await page.locator(".workspace-open").filter({ hasText: alpha.name }).click();
  await nav("Terminal").click();
  await expect(page.locator(`[data-terminal-workspace="${beta.id}"]`)).toHaveCount(1);
  await page.getByRole("button", { name: `Workspace actions for ${beta.name}`, exact: true }).click();
  await page.locator(".workspace-list-entry").filter({ hasText: beta.name }).getByRole("button", { name: "Close", exact: true }).click();
  const closeWorkspace = page.waitForResponse((item) => item.request().method() === "DELETE" && item.url() === endpoint(`api/workspaces/${encodeURIComponent(beta.id)}`));
  await page.getByRole("dialog", { name: "Close workspace?", exact: true }).getByRole("button", { name: "Close workspace", exact: true }).click();
  assert.equal((await closeWorkspace).ok(), true);
  beta.closed = true;
  await expect(page.locator(`[data-terminal-workspace="${beta.id}"]`)).toHaveCount(0);
  assert.equal((await api("api/workspaces")).workspaces.some((item) => item.id === beta.id), false);
  assert.deepEqual(pageErrors, [], "Unexpected browser page errors");
  console.log(`Terminal UI checks completed (${steps.length} stages). Screenshots: /tmp/pi-ark-terminal-dev33-*.png`);
} catch (error) {
  failure = new Error(`Terminal UI stage: ${stage}`, { cause: error });
  if (page && !page.isClosed()) await page.screenshot({ path: screenshot("failure"), fullPage: true }).catch((captureError) => console.error("Failure screenshot:", captureError));
} finally {
  // Browser pages close before API cleanup, so their list refreshes cannot create new fixture terminals.
  for (const stop of stopFiles) await writeFile(stop, "cleanup", { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") cleanupErrors.push(error); });
  if (peerContext) await peerContext.close().catch((error) => cleanupErrors.push(error));
  if (browser) await browser.close().catch((error) => cleanupErrors.push(error));
  if (apiContext) {
    for (const workspace of [...ownedWorkspaces].reverse()) {
      if (workspace.closed) continue;
      try {
        for (const info of await listTerminals(workspace)) await api(terminalPath(workspace, info.id), "DELETE");
      } catch (error) { cleanupErrors.push(error); }
      try { await api(`api/workspaces/${encodeURIComponent(workspace.id)}`, "DELETE"); } catch (error) { cleanupErrors.push(error); }
    }
    if (originalTerminalSettings) try { await api("api/settings/terminal", "PUT", originalTerminalSettings); } catch (error) { cleanupErrors.push(error); }
    if (originalUiSettings) try { await api("api/ui", "PUT", originalUiSettings); } catch (error) { cleanupErrors.push(error); }
    await apiContext.dispose().catch((error) => cleanupErrors.push(error));
  }
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
}
if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Terminal UI check/cleanup failed");
if (failure) throw failure;
