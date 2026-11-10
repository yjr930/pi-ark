import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, scryptSync } from "node:crypto";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSessionDisplayMessages } from "../apps/server/dist/session-display.js";
import { internalMessageLink, internalSessionLink, pinnedPiArkLink } from "../apps/server/dist/internal-links.js";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-subagent-ui-"));
const home = join(directory, "home");
const workspace = { id: "subagent-ui", name: "Subagent UI", path: join(directory, "workspace") };
const sessionDir = join(workspace.path, ".pi-ark", "sessions");
let server;
let browser;
let serverLog = "";
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = (text) => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "openai", model: "fixture", usage, stopReason: "stop", timestamp: Date.now() });
try {
  await mkdir(home); await mkdir(sessionDir, { recursive: true });
  const key = join(home, "key.pem"); const cert = join(home, "cert.pem");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { timeout: 30000 });
  const portServer = createServer(); portServer.listen(0, "127.0.0.1"); await once(portServer, "listening");
  const port = portServer.address().port; await new Promise((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
  const salt = "subagent-ui-fixture";
  await writeFile(join(home, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port }, tls: { keyPath: key, certPath: cert }, auth: { username: "check", passwordHash: `scrypt$${salt}$${scryptSync("check-password", salt, 64).toString("hex")}` }, workspaces: [workspace] }));
  const parent = SessionManager.create(workspace.path, sessionDir);
  parent.appendSessionInfo("Parent subagent fixture");
  parent.appendMessage({ role: "user", content: "Parent request for delegated work", timestamp: Date.now() });
  const parentSource = buildSessionDisplayMessages(parent).at(-1);
  const parentLeaf = parent.getLeafId();
  const tasks = [];
  for (let index = 0; index < 3; index += 1) {
    const child = SessionManager.create(workspace.path, sessionDir); child.appendSessionInfo(`Child task ${index + 1}`);
    const userEntry = child.appendMessage({ role: "user", content: `Delegated task ${index + 1}`, timestamp: Date.now() });
    child.appendMessage(answer(`Completed child result ${index + 1}`));
    const result = buildSessionDisplayMessages(child).at(-1); const leaf = child.getLeafId();
    child.branch(userEntry); child.appendMessage(answer(`Later active branch ${index + 1}`));
    tasks.push({ title: `Child task ${index + 1}`, task: "Inspect the parent request", expectedResult: "A concise report", references: [], sessionId: child.getSessionId(), sessionLink: internalSessionLink(workspace.id, child.getSessionId()), state: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), result: `Completed child result ${index + 1}`, resultEntryId: result.entryId, resultLeafEntryId: leaf, resultLink: pinnedPiArkLink(internalMessageLink(workspace.id, child.getSessionId(), result.messageId), leaf), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 } });
  }
  parent.appendMessage(answer(`[Read delegated result](${tasks[0].resultLink})`));
  const run = { version: 1, id: randomUUID(), parentSessionId: parent.getSessionId(), parentLink: pinnedPiArkLink(internalMessageLink(workspace.id, parent.getSessionId(), parentSource.messageId), parentLeaf), parentLeafEntryId: parentLeaf, toolCallId: "fixture-delegation", createdAt: new Date().toISOString(), revision: 1, model: { provider: "openai", id: "fixture" }, thinkingLevel: "off", tools: ["read", "read_pi_ark_link"], systemPromptAppend: "", tasks };
  const runDir = join(workspace.path, ".pi-ark", "subagent-runs"); await mkdir(runDir); await writeFile(join(runDir, `${run.id}.json`), JSON.stringify(run));
  server = spawn(process.execPath, [resolve("apps/server/dist/index.js")], { cwd: process.cwd(), env: { ...process.env, PI_ARK_HOME: home, PI_ARK_AGENT_DIR: join(home, "pi-agent"), PI_CODING_AGENT_DIR: join(home, "pi-agent"), PI_ARK_MIGRATE_AGENT_DIR: join(home, "pi-agent"), PI_ARK_INSTANCE: "subagent-check", PI_ARK_BASE_PATH: "/" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (chunk) => { serverLog += chunk; }); server.stderr.on("data", (chunk) => { serverLog += chunk; });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const base = `https://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try { healthy = (await context.request.get(`${base}/api/health`, { timeout: 1000 })).ok(); } catch {}
    if (healthy) break; await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, serverLog);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  let parentSocket;
  let childSocket;
  await page.routeWebSocket(/\/ws\/agent\//, (socket) => {
    const upstream = socket.connectToServer();
    if (new URL(socket.url()).pathname.endsWith(`/${parent.getSessionId()}`) && !new URL(socket.url()).searchParams.has("leafEntryId")) parentSocket = socket;
    if (new URL(socket.url()).pathname.endsWith(`/${tasks[0].sessionId}`) && !new URL(socket.url()).searchParams.has("leafEntryId")) childSocket = socket;
    upstream.onMessage((message) => socket.send(message));
  });
  await page.goto(`${base}/?page=agent&workspace=${workspace.id}&session=${parent.getSessionId()}`);
  await page.getByLabel("Username").fill("check"); await page.getByLabel("Password").fill("check-password"); await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Parent subagent fixture" }).waitFor();
  await page.getByLabel("Subagent tasks").waitFor();
  await page.locator(".subagent-run > summary").click();
  await page.getByText("Completed child result 1", { exact: true }).waitFor();
  assert.equal(await page.locator(".session-subagent-icon").count(), 3);
  await page.getByRole("link", { name: "Open result", exact: true }).first().click();
  await page.getByText("Historical conversation branch", { exact: true }).waitFor();
  await page.locator(".feed-message-content").getByText("Completed child result 1", { exact: true }).waitFor();
  assert.equal(await page.locator(".composer").count(), 0);
  assert.equal(await page.getByTitle("Rename session", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Fork session", exact: true }).count(), 0);
  assert.equal(new URL(page.url()).searchParams.get("leafEntryId"), tasks[0].resultLeafEntryId);
  const historicalCommand = await page.evaluate(async ({ workspaceId, sessionId, leafEntryId }) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://${location.host}/ws/agent/${workspaceId}/${sessionId}?leafEntryId=${leafEntryId}`);
    const timer = setTimeout(() => { socket.close(); reject(new Error("Historical command timed out")); }, 10000);
    socket.onmessage = (event) => { const message = JSON.parse(event.data); if (message.type === "snapshot") socket.send(JSON.stringify({ type: "prompt", text: "Historical command fixture" })); if (message.type === "error") { clearTimeout(timer); socket.close(); resolve(message.message); } };
  }), { workspaceId: workspace.id, sessionId: tasks[0].sessionId, leafEntryId: tasks[0].resultLeafEntryId });
  assert.match(historicalCommand, /Open the current conversation/);
  await page.getByRole("link", { name: "Open parent request", exact: true }).click();
  await page.getByText("Parent request for delegated work", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("session"), parent.getSessionId());
  assert.equal(new URL(page.url()).searchParams.get("leafEntryId"), parentLeaf);
  await page.getByRole("link", { name: "Open current conversation", exact: true }).click();
  await page.locator(".composer textarea").waitFor();
  await page.getByRole("link", { name: "Read delegated result", exact: true }).click();
  await page.getByText("Historical conversation branch", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("session"), tasks[0].sessionId);
  await page.getByRole("link", { name: "Open current conversation", exact: true }).click();
  await page.locator(".feed-message-content").getByText("Later active branch 1", { exact: true }).waitFor();
  await page.locator(".composer textarea").waitFor();
  await page.locator(".chat-title .status-dot").getByText("Ready", { exact: true }).waitFor();
  const childStateResponse = await context.request.get(`${base}/api/workspaces/${workspace.id}/sessions/${tasks[0].sessionId}/subagents`);
  const childState = await childStateResponse.json(); childState.managed = true; childState.origin.state = "running";
  childSocket.send(JSON.stringify({ type: "subagent-state", subagents: childState }));
  await page.getByText("The parent is managing this task.", { exact: true }).waitFor();
  assert.equal(await page.locator(".composer").count(), 0);
  childState.managed = false; childState.origin.state = "completed";
  childSocket.send(JSON.stringify({ type: "subagent-state", subagents: childState }));
  await page.locator(".composer textarea").waitFor();
  await page.getByRole("link", { name: "Open parent request", exact: true }).click();
  await page.getByRole("link", { name: "Open current conversation", exact: true }).click();
  await page.locator(".composer textarea").waitFor();
  await page.locator(".chat-title .status-dot").getByText("Ready", { exact: true }).waitFor();
  const live = structuredClone(run); live.revision += 1; live.tasks[0].state = "running"; live.tasks[0].currentTool = "read"; live.tasks[1].state = "queued";
  parentSocket.send(JSON.stringify({ type: "subagent-state", subagents: { runs: [live], managed: false } }));
  await page.getByText("running · read", { exact: true }).waitFor();
  await page.getByText("queued", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Stop task", exact: true }).count(), 2);
  const stopRequest = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith(`/sessions/${tasks[0].sessionId}/abort`));
  await page.getByRole("button", { name: "Stop task", exact: true }).first().click(); await stopRequest;
  const ended = structuredClone(live); ended.revision += 1; ended.tasks[0].state = "cancelled"; delete ended.tasks[0].currentTool; ended.tasks[1].state = "failed"; ended.tasks[1].error = "Fixture failure";
  parentSocket.send(JSON.stringify({ type: "subagent-state", subagents: { runs: [ended], managed: false } }));
  await page.getByText("cancelled", { exact: true }).waitFor({ state: "attached" });
  if (!await page.locator(".subagent-run").getAttribute("open").then((value) => value !== null)) await page.locator(".subagent-run > summary").click();
  await page.getByText("cancelled", { exact: true }).waitFor(); await page.getByText("Fixture failure", { exact: true }).waitFor();
  const parentState = await context.request.get(`${base}/api/workspaces/${workspace.id}/sessions/${parent.getSessionId()}/subagents`);
  assert.equal((await parentState.json()).runs[0].tasks[0].state, "completed");
  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, conversation: document.querySelector(".conversation").getBoundingClientRect().height, composerBottom: document.querySelector(".composer").getBoundingClientRect().bottom, height: innerHeight }));
  assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout)); assert.ok(layout.conversation > 100, JSON.stringify(layout)); assert.ok(layout.composerBottom <= layout.height + 1, JSON.stringify(layout));
  assert.deepEqual(errors, []);
  console.log("subagent UI checks passed");
  if (process.env.PI_ARK_CHECK_FULL_UI === "1") {
    const result = await promisify(execFile)(process.execPath, ["scripts/check-ui.mjs"], { env: { ...process.env, PI_ARK_CHECK_URL: base, PI_ARK_CHECK_WORKSPACE: workspace.path, PI_ARK_CHECK_USERNAME: "check", PI_ARK_CHECK_PASSWORD: "check-password", PI_ARK_CHECK_LEGACY_SESSION: "" }, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  }
} catch (error) { const errors = serverLog.split("\n").filter((line) => /"level":(?:50|60)/.test(line)); if (errors.length) console.error(errors.slice(-10).join("\n")); throw error; }
finally {
  await browser?.close();
  if (server && server.exitCode === null) { const exited = once(server, "exit"); server.kill("SIGTERM"); const timer = setTimeout(() => server.kill("SIGKILL"), 5000); await exited; clearTimeout(timer); }
  await rm(directory, { recursive: true, force: true });
}
