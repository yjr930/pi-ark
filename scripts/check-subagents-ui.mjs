import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, scryptSync } from "node:crypto";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSessionDisplayMessages } from "../apps/server/dist/session-display.js";
import { internalMessageLink, internalSessionLink, pinnedPiArkLink } from "../apps/server/dist/internal-links.js";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-subagent-ui-"));
const home = join(directory, "home");
const workspace = { id: "subagent-ui", name: "Subagent UI", path: join(directory, "workspace") };
const sessionDir = join(workspace.path, ".pi-ark", "sessions");
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = (text) => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "openai", model: "fixture", usage, stopReason: "stop", timestamp: Date.now() });
const time = (seconds) => new Date(Date.UTC(2030, 0, 1, 12, 0, seconds)).toISOString();
const longAnswer = (title) => `${title}\n\n${Array.from({ length: 48 }, (_, index) => `Paragraph ${index + 1}: fixture content preserves enough conversation space to exercise the sticky role header.`).join("\n\n")}`;
let server;
let browser;
let serverLog = "";
let phase = "fixture setup";
const browserErrors = [];

function appendCalls(manager, calls) {
  const message = answer("");
  message.content = calls.map(({ name = "read", label }) => ({ type: "toolCall", id: randomUUID(), name, arguments: name === "subagent" ? { tasks: [{ title: label, task: "Inspect delegated fixture", expectedResult: "Report fixture result" }] } : { path: label } }));
  message.stopReason = "toolUse";
  manager.appendMessage(message);
  for (const call of message.content) manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: `Fixture result for ${call.name}` }], isError: false, timestamp: Date.now() });
  return message.content.map((call) => call.id);
}
const normalCalls = (prefix, count = 5) => Array.from({ length: count }, (_, index) => ({ label: `${prefix}-${index + 1}.md` }));

try {
  await mkdir(home); await mkdir(sessionDir, { recursive: true });
  const key = join(home, "key.pem"); const cert = join(home, "cert.pem");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { timeout: 30000 });
  const portServer = createServer(); portServer.listen(0, "127.0.0.1"); await once(portServer, "listening");
  const port = portServer.address().port; await new Promise((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
  const salt = "subagent-ui-fixture";
  await writeFile(join(home, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port }, tls: { keyPath: key, certPath: cert }, auth: { username: "check", passwordHash: `scrypt$${salt}$${scryptSync("check-password", salt, 64).toString("hex")}` }, workspaces: [workspace] }));

  const ordinary = SessionManager.create(workspace.path, sessionDir);
  ordinary.appendSessionInfo("Ordinary fixture");
  ordinary.appendMessage({ role: "user", content: "Ordinary user request", timestamp: Date.now() });
  ordinary.appendMessage(answer(longAnswer("Ordinary AI response")));
  const archived = SessionManager.create(workspace.path, sessionDir);
  archived.appendSessionInfo("Archived ordinary fixture");
  archived.appendMessage({ role: "user", content: "Archived ordinary request", timestamp: Date.now() });
  archived.appendMessage(answer("Archived ordinary response"));
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
    child.branch(userEntry); child.appendMessage(answer(longAnswer(`Later active branch ${index + 1}`)));
    const updatedAt = time([1, 3, 2][index]);
    tasks.push({ title: `Child task ${index + 1}`, task: "Inspect the parent request", expectedResult: "A concise report", references: [], sessionId: child.getSessionId(), sessionLink: internalSessionLink(workspace.id, child.getSessionId()), state: "completed", startedAt: time(0), updatedAt, finishedAt: updatedAt, result: `Completed child result ${index + 1}`, resultEntryId: result.entryId, resultLeafEntryId: leaf, resultLink: pinnedPiArkLink(internalMessageLink(workspace.id, child.getSessionId(), result.messageId), leaf), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 } });
  }
  appendCalls(parent, normalCalls("before"));
  const standaloneCallIds = appendCalls(parent, [{ name: "subagent", label: "Standalone delegation" }]);
  appendCalls(parent, normalCalls("between"));
  appendCalls(parent, [...normalCalls("mixed-before"), { name: "subagent", label: "Mixed message delegation" }, ...normalCalls("mixed-after")]);
  appendCalls(parent, normalCalls("after"));
  parent.appendMessage(answer(`[Read delegated result](${tasks[0].resultLink})`));
  const run = { version: 1, id: randomUUID(), parentSessionId: parent.getSessionId(), parentLink: pinnedPiArkLink(internalMessageLink(workspace.id, parent.getSessionId(), parentSource.messageId), parentLeaf), parentLeafEntryId: parentLeaf, toolCallId: standaloneCallIds[0], createdAt: time(0), revision: 1, model: { provider: "openai", id: "fixture" }, thinkingLevel: "off", tools: ["read", "read_pi_ark_link"], systemPromptAppend: "", tasks };
  const runDir = join(workspace.path, ".pi-ark", "subagent-runs"); await mkdir(runDir); await writeFile(join(runDir, `${run.id}.json`), JSON.stringify(run));
  const metadata = (groups = [], archived = false) => ({ pinned: false, archived, groups, updatedAt: time(0) });
  await writeFile(join(workspace.path, ".pi-ark", "sessions-meta.json"), JSON.stringify({ version: 2, groups: [{ id: "fixture-group", name: "Fixture group" }], sessions: { [parent.getSessionId()]: metadata(["fixture-group"]), [tasks[0].sessionId]: metadata(["fixture-group"]), [tasks[1].sessionId]: metadata(["fixture-group"], true), [tasks[2].sessionId]: metadata(), [archived.getSessionId()]: metadata([], true) } }));

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
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error" && !/401 \(Unauthorized\)/.test(message.text())) browserErrors.push(`console: ${message.text()}`); });
  page.on("response", (response) => { if (response.status() >= 500) browserErrors.push(`HTTP ${response.status()}: ${response.url()}`); });
  const sockets = new Map();
  await page.routeWebSocket(/\/ws\/agent\//, (socket) => {
    const upstream = socket.connectToServer();
    const url = new URL(socket.url());
    const sessionId = url.pathname.split("/").at(-1);
    if (!url.searchParams.has("leafEntryId")) sockets.set(sessionId, socket);
    upstream.onMessage((message) => socket.send(message));
  });
  let parentRuntime = { id: parent.getSessionId(), state: "running", statusRevision: 100, updateRevision: 0 };
  await page.route(`**/api/workspaces/${workspace.id}/session-statuses`, (route) => route.fulfill({ json: { statuses: [parentRuntime] } }));
  const currentUrl = (sessionId) => `${base}/?page=agent&workspace=${workspace.id}&session=${sessionId}`;
  const badge = page.locator(".subagent-badge");
  const list = page.locator(".subagent-list");
  const completed = page.locator(".completed-agents");
  const activeRows = page.locator(".subagent-list > .agent-list-row");
  const completedRows = page.locator(".completed-agents .agent-list-row");
  const rowTitles = (rows) => rows.locator("strong").allTextContents();
  const emitState = (sessionId, state) => {
    assert.ok(sockets.has(sessionId), `Active socket for ${sessionId}`);
    sockets.get(sessionId).send(JSON.stringify({ type: "subagent-state", subagents: state }));
  };
  async function expectBadge(running, complete, total) {
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveAttribute("aria-label", `Subagents: ${running} running, ${complete} complete, ${total} total`);
    await expect(badge).toHaveText(`${running}/${complete}/${total}`);
    assert.equal(await badge.locator("svg").count(), 1);
  }
  async function openList() {
    if (await badge.getAttribute("aria-expanded") !== "true") await badge.click();
    await expect(list).toBeVisible();
  }
  async function expectNoComposer() { await expect(page.locator(".composer")).toHaveCount(0); }
  async function expectRoles(userRole, assistantRole) {
    await expect(page.locator(".feed-user-label").first()).toContainText(userRole);
    await expect(page.locator(".ai-turn-label").first()).toHaveText(assistantRole);
    await page.getByRole("button", { name: new RegExp(`^Show information for ${assistantRole} message`) }).last().click();
    await expect(page.locator(".feed-text-meta .message-source-link code").last()).toContainText(`${assistantRole} `);
    await page.locator(".conversation").evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
    await expect(page.locator(".sticky-user-label")).toContainText(userRole);
    await expect(page.locator(".conversation-sticky-user > button")).toHaveAttribute("aria-label", new RegExp(`^Go to ${userRole} message`));
  }
  async function expectBadgeBeforeStatus(container) {
    const position = await page.locator(container).evaluate((element) => {
      const badge = element.querySelector(".subagent-badge").getBoundingClientRect();
      const status = element.querySelector(".status-dot").getBoundingClientRect();
      return { badgeRight: badge.right, statusLeft: status.left };
    });
    assert.ok(position.badgeRight <= position.statusLeft, JSON.stringify(position));
  }

  phase = "ordinary roles and sidebar filtering";
  await page.goto(currentUrl(ordinary.getSessionId()));
  await page.getByLabel("Username").fill("check"); await page.getByLabel("Password").fill("check-password"); await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Ordinary fixture", exact: true }).waitFor();
  await page.locator(".composer textarea").waitFor();
  await expect(badge).toHaveCount(0);
  await expect(page.locator(".parent-agent-bar")).toHaveCount(0);
  await expectRoles("User", "AI");
  await page.getByRole("button", { name: "Show archived sessions", exact: true }).click();
  await expect(page.locator(".archived-sessions .session-open")).toHaveText(["Archived ordinary fixture"]);
  await expect(page.locator(".session-group-heading").getByText("Fixture group", { exact: true })).toBeVisible();
  for (const task of tasks) await expect(page.locator(".sidebar .session-open").filter({ hasText: task.title })).toHaveCount(0);
  assert.deepEqual((await page.locator(".sidebar .session-open strong").allTextContents()).sort(), ["Archived ordinary fixture", "Ordinary fixture", "Parent subagent fixture"].sort());

  phase = "completed list and tool rows";
  await page.locator(".sidebar .session-open").filter({ hasText: "Parent subagent fixture" }).click();
  await page.locator(".composer textarea").waitFor();
  await expectBadge(0, 3, 3); await expectBadgeBeforeStatus(".chat-title");
  await expect(list).toHaveCount(0);
  await openList();
  await expect(activeRows).toHaveCount(0);
  await expect(completedRows).toHaveCount(3);
  await expect(completed).not.toHaveAttribute("open");
  assert.equal(await page.locator(".subagent-run, .subagent-task-card").count(), 0);
  await completed.locator("summary").click();
  await expect(completed).toHaveAttribute("open", "");
  assert.deepEqual(await rowTitles(completedRows), ["Child task 2", "Child task 3", "Child task 1"]);
  for (const row of await completedRows.all()) {
    await expect(row).toBeVisible();
    const geometry = await row.evaluate((element) => ({ height: element.getBoundingClientRect().height, tag: element.tagName, childCenters: [...element.children].map((child) => { const box = child.getBoundingClientRect(); return box.y + box.height / 2; }), timestamp: element.querySelector("time").dateTime, href: element.getAttribute("href") }));
    assert.equal(geometry.tag, "A"); assert.ok(geometry.height <= 40, JSON.stringify(geometry));
    assert.ok(Math.max(...geometry.childCenters) - Math.min(...geometry.childCenters) <= 2, JSON.stringify(geometry));
    assert.ok(tasks.some((task) => task.updatedAt === geometry.timestamp));
    assert.ok(geometry.href.includes("session="));
  }
  await badge.click();
  await page.locator(".run-collapse > summary").click();
  const subagentTools = page.locator(".is-subagent-tool");
  await expect(subagentTools).toHaveCount(2);
  const toggles = page.getByRole("button", { name: /^show more tool calls/ });
  await expect(toggles).toHaveCount(3);
  for (const tool of await subagentTools.all()) {
    await expect(tool.locator("summary")).toBeVisible();
    assert.equal(await tool.evaluate((element) => Boolean(element.closest(".feed-tool-sequence"))), false);
    assert.equal(await tool.getAttribute("open"), null);
  }
  const sizes = await page.evaluate(() => ({ normal: [...document.querySelectorAll(".feed-tool-details:not(.is-subagent-tool) > summary")].map((element) => element.getBoundingClientRect().height).find((height) => height > 0), subagents: [...document.querySelectorAll(".is-subagent-tool > summary")].map((element) => element.getBoundingClientRect().height) }));
  assert.ok(sizes.normal > 0, JSON.stringify(sizes));
  for (const height of sizes.subagents) assert.ok(Math.abs(height - sizes.normal * 2) <= 1, JSON.stringify(sizes));
  const splitRow = subagentTools.first();
  assert.equal(await splitRow.locator(".feed-tool-divider").count(), 1);
  const jump = splitRow.locator(".feed-tool-jump");
  assert.equal(await jump.evaluate((element) => element.tagName), "A");
  assert.match(await jump.getAttribute("href"), /session=/);
  assert.match((await jump.textContent()) || "", /subagent/);
  assert.ok(((await splitRow.locator(".feed-tool-title").textContent()) || "").trim().length > 0);
  await splitRow.locator(".feed-tool-title").click();
  await expect(splitRow).toHaveAttribute("open", "");
  for (const prefix of ["before", "between", "after"]) {
    await expect(page.locator(".feed-tool-details > summary code").filter({ hasText: new RegExp(`^${prefix}-1\\.md$`) })).not.toBeVisible();
    await expect(page.locator(".feed-tool-details > summary code").filter({ hasText: new RegExp(`^${prefix}-5\\.md$`) })).toBeVisible();
  }
  for (const prefix of ["mixed-before", "mixed-after"]) await expect(page.locator(".feed-tool-details > summary code").filter({ hasText: new RegExp(`^${prefix}-1\\.md$`) })).toBeVisible();
  for (let index = 0; index < 3; index += 1) await toggles.first().click();
  await expect(page.getByRole("button", { name: "show fewer tool calls", exact: true })).toHaveCount(3);
  await expect(subagentTools.locator("summary")).toHaveCount(2);
  for (let index = 0; index < 3; index += 1) await page.getByRole("button", { name: "show fewer tool calls", exact: true }).first().click();
  for (const tool of await subagentTools.all()) await expect(tool.locator("summary")).toBeVisible();

  phase = "child navigation and permanent composer removal";
  await openList(); await completed.locator("summary").click();
  await completedRows.filter({ hasText: "Child task 1" }).click();
  await page.getByRole("heading", { name: "Child task 1", exact: true }).waitFor();
  await page.getByText("Later active branch 1", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("session"), tasks[0].sessionId);
  assert.equal(new URL(page.url()).searchParams.has("leafEntryId"), false);
  await expectNoComposer();
  const parentBar = page.locator(".parent-agent-bar");
  await expect(parentBar.locator(".parent-agent-title")).toHaveText("Parent subagent fixture");
  await expect(parentBar.locator(".status-dot > span")).toHaveText("running");
  await expectBadge(0, 3, 3); await expectBadgeBeforeStatus(".parent-agent-bar");
  await expect(page.locator(".chat-title .subagent-badge")).toHaveCount(0);
  await expectRoles("Parent Agent", "SubAgent");
  parentRuntime = { ...parentRuntime, state: "ready", statusRevision: 101, updateRevision: 1 };
  await expect(parentBar.locator(".status-dot > span")).toHaveText("ready", { timeout: 5000 });
  parentRuntime = { ...parentRuntime, state: "error", statusRevision: 102, errorMessage: "Parent fixture error" };
  await expect(parentBar.locator(".status-dot")).toHaveClass(/error/, { timeout: 5000 });
  await expect(parentBar.locator(".status-dot")).toHaveAttribute("title", "Parent fixture error");
  parentRuntime = { ...parentRuntime, state: "running", statusRevision: 103 };
  delete parentRuntime.errorMessage;

  const childStateResponse = await context.request.get(`${base}/api/workspaces/${workspace.id}/sessions/${tasks[0].sessionId}/subagents`);
  assert.equal(childStateResponse.ok(), true);
  const childState = await childStateResponse.json();
  assert.equal(childState.origin.state, "completed"); assert.equal(childState.managed, false); assert.equal(childState.parentRuns[0].tasks.length, 3);
  const live = structuredClone(run); live.revision += 1;
  live.tasks[0] = { ...live.tasks[0], state: "running", updatedAt: time(6), currentTool: "read" };
  live.tasks[1] = { ...live.tasks[1], state: "queued", updatedAt: time(7) };
  const childLive = { ...childState, parentRuns: [live], origin: { ...childState.origin, state: "running" }, managed: true };
  emitState(tasks[0].sessionId, childLive);
  await expectBadge(1, 1, 3); await expectNoComposer();
  await page.getByText("The parent is managing this task.", { exact: true }).waitFor();
  await openList();
  assert.deepEqual(await rowTitles(activeRows), ["Child task 2", "Child task 1"]);
  await expect(completedRows).toHaveCount(1);
  const childRepeated = { ...structuredClone(run), id: randomUUID(), createdAt: time(10), revision: 1, toolCallId: "fixture-child-redelegation", tasks: [{ ...tasks[2], title: "Child task 3 redelegated", state: "running", updatedAt: time(20) }] };
  emitState(tasks[0].sessionId, { ...childLive, parentRuns: [childRepeated, live] });
  await expectBadge(2, 0, 3); await expectNoComposer();
  await expect(activeRows).toHaveCount(3);
  assert.deepEqual(await rowTitles(activeRows), ["Child task 3 redelegated", "Child task 2", "Child task 1"]);
  assert.equal(await list.locator(`a[href*="session=${tasks[2].sessionId}"]`).count(), 1);
  await expect(completed).toHaveCount(0);
  const childEnded = { ...childState, parentRuns: [run], origin: { ...childState.origin, state: "completed" }, managed: false };
  emitState(tasks[0].sessionId, childEnded);
  await expectBadge(0, 3, 3); await expectNoComposer();
  await expect(page.locator(".subagent-managed-notice")).toHaveCount(0);
  await expect(activeRows).toHaveCount(0);

  phase = "historical links and command refusal";
  await parentBar.getByRole("link", { name: "Open parent request", exact: true }).click();
  await page.getByText("Historical conversation branch", { exact: true }).waitFor();
  await page.getByText("Parent request for delegated work", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("session"), parent.getSessionId());
  assert.equal(new URL(page.url()).searchParams.get("leafEntryId"), parentLeaf);
  await page.getByRole("link", { name: "Open current conversation", exact: true }).click();
  await page.locator(".composer textarea").waitFor();
  await page.getByRole("link", { name: "Read delegated result", exact: true }).click();
  await page.getByText("Historical conversation branch", { exact: true }).waitFor();
  await page.locator(".feed-message-content").getByText("Completed child result 1", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("session"), tasks[0].sessionId);
  assert.equal(new URL(page.url()).searchParams.get("leafEntryId"), tasks[0].resultLeafEntryId);
  await expectNoComposer();
  assert.equal(await page.getByTitle("Rename session", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Fork session", exact: true }).count(), 0);
  await expect(page.locator(".feed-user-label")).toContainText("Parent Agent");
  await expect(page.locator(".ai-turn-label")).toHaveText("SubAgent");
  const historicalCommand = await page.evaluate(async ({ workspaceId, sessionId, leafEntryId }) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://${location.host}/ws/agent/${workspaceId}/${sessionId}?leafEntryId=${leafEntryId}`);
    const timer = setTimeout(() => { socket.close(); reject(new Error("Historical command timed out")); }, 10000);
    socket.onmessage = (event) => { const message = JSON.parse(event.data); if (message.type === "snapshot") socket.send(JSON.stringify({ type: "prompt", text: "Historical command fixture" })); if (message.type === "error") { clearTimeout(timer); socket.close(); resolve(message.message); } };
  }), { workspaceId: workspace.id, sessionId: tasks[0].sessionId, leafEntryId: tasks[0].resultLeafEntryId });
  assert.match(historicalCommand, /Open the current conversation/);
  await page.getByRole("link", { name: "Open current conversation", exact: true }).click();
  await page.getByText("Later active branch 1", { exact: true }).waitFor();
  await expectNoComposer();
  await page.locator(".parent-agent-title").click();
  await page.locator(".composer textarea").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("session"), parent.getSessionId());
  assert.equal(new URL(page.url()).searchParams.has("leafEntryId"), false);

  phase = "live parent updates and repeated delegation";
  await expect(page.locator(".chat-title .status-dot > span")).toHaveText("Ready");
  emitState(parent.getSessionId(), { runs: [live], managed: false });
  await expectBadge(1, 1, 3); await openList();
  assert.deepEqual(await rowTitles(activeRows), ["Child task 2", "Child task 1"]);
  await expect(activeRows.locator(".agent-list-state")).toHaveText(["queued", "running"]);
  await completed.locator("summary").click();
  const repeated = { ...structuredClone(run), id: randomUUID(), createdAt: time(10), revision: 1, toolCallId: "fixture-redelegation", tasks: [{ ...tasks[2], title: "Child task 3 redelegated", state: "running", updatedAt: time(20), startedAt: time(10) }] };
  emitState(parent.getSessionId(), { runs: [repeated, live], managed: false });
  await expectBadge(2, 0, 3);
  await expect(activeRows).toHaveCount(3);
  assert.deepEqual(await rowTitles(activeRows), ["Child task 3 redelegated", "Child task 2", "Child task 1"]);
  await expect(completed).toHaveCount(0);
  assert.equal(await list.locator(`a[href*="session=${tasks[2].sessionId}"]`).count(), 1);
  assert.deepEqual(await activeRows.locator("time").evaluateAll((elements) => elements.map((element) => element.dateTime)), [time(20), time(7), time(6)]);

  const terminalRun = structuredClone(live); terminalRun.revision += 1;
  terminalRun.tasks[0] = { ...terminalRun.tasks[0], state: "failed", error: "Fixture failure", updatedAt: time(21), finishedAt: time(21) };
  terminalRun.tasks[1] = { ...terminalRun.tasks[1], state: "cancelled", updatedAt: time(22), finishedAt: time(22) };
  const completedAgain = { ...structuredClone(repeated), revision: 2, tasks: [{ ...repeated.tasks[0], state: "completed", updatedAt: time(23), finishedAt: time(23) }] };
  const interruptedTask = { ...tasks[0], sessionId: randomUUID(), title: "Interrupted agent", state: "interrupted", updatedAt: time(24) };
  interruptedTask.sessionLink = internalSessionLink(workspace.id, interruptedTask.sessionId);
  const extraRun = { ...structuredClone(repeated), id: randomUUID(), createdAt: time(11), toolCallId: "fixture-terminal-states", tasks: [interruptedTask] };
  emitState(parent.getSessionId(), { runs: [completedAgain, extraRun, terminalRun], managed: false });
  await expectBadge(0, 1, 4); await expect(activeRows).toHaveCount(0);
  await expect(completed).not.toHaveAttribute("open");
  await completed.locator("summary").click();
  await expect(completedRows.locator(".agent-list-state")).toHaveText(["interrupted", "completed", "cancelled", "failed"]);
  assert.deepEqual(await rowTitles(completedRows), ["Interrupted agent", "Child task 3 redelegated", "Child task 2", "Child task 1"]);
  await expect(completedRows.last()).toHaveAttribute("title", "Fixture failure");
  assert.equal(await list.locator(":scope > :last-child").evaluate((element) => element.classList.contains("completed-agents")), true);

  const additionalTask = { ...interruptedTask, sessionId: randomUUID(), title: "Newly completed agent", state: "completed", updatedAt: time(25) };
  additionalTask.sessionLink = internalSessionLink(workspace.id, additionalTask.sessionId);
  const addedCompletion = { ...structuredClone(extraRun), revision: 2, tasks: [interruptedTask, additionalTask] };
  emitState(parent.getSessionId(), { runs: [terminalRun, completedAgain, addedCompletion], managed: false });
  await expectBadge(0, 2, 5); await expect(completedRows).toHaveCount(5);
  await expect(completed).not.toHaveAttribute("open");
  await completed.locator("summary").click();
  await expect(completedRows.first().locator("strong")).toHaveText("Newly completed agent");
  const stillRunning = { ...additionalTask, sessionId: randomUUID(), title: "Running before completion", state: "running", updatedAt: time(26) };
  stillRunning.sessionLink = internalSessionLink(workspace.id, stillRunning.sessionId);
  const transitionRun = { ...structuredClone(extraRun), id: randomUUID(), createdAt: time(12), tasks: [stillRunning] };
  emitState(parent.getSessionId(), { runs: [terminalRun, completedAgain, addedCompletion, transitionRun], managed: false });
  await expectBadge(1, 2, 6); await expect(completed).toHaveAttribute("open", "");
  transitionRun.revision += 1; transitionRun.tasks[0] = { ...stillRunning, state: "completed", updatedAt: time(27) };
  emitState(parent.getSessionId(), { runs: [terminalRun, completedAgain, addedCompletion, transitionRun], managed: false });
  await expectBadge(0, 3, 6); await expect(completed).not.toHaveAttribute("open");

  phase = "large list and responsive layout";
  const layoutFailures = [];
  const manyTasks = Array.from({ length: 48 }, (_, index) => {
    const sessionId = randomUUID();
    return { ...tasks[0], sessionId, sessionLink: internalSessionLink(workspace.id, sessionId), title: `Long delegated agent title ${index + 1} ${"fixture ".repeat(20)}`, state: index % 2 ? "running" : "queued", updatedAt: time(60 + index) };
  });
  const manyRun = { ...structuredClone(extraRun), id: randomUUID(), createdAt: time(30), tasks: manyTasks };
  emitState(parent.getSessionId(), { runs: [run, manyRun], managed: false });
  await expectBadge(24, 3, 51); await expect(activeRows).toHaveCount(48);
  async function checkLayout(hasComposer) {
    const layout = await page.evaluate(() => {
      const list = document.querySelector(".subagent-list");
      const conversation = document.querySelector(".conversation");
      const composer = document.querySelector(".composer");
      const bounds = (element) => element && { left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, bottom: element.getBoundingClientRect().bottom };
      return { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, height: innerHeight, conversation: conversation.getBoundingClientRect().height, listHeight: list.clientHeight, listScroll: list.scrollHeight, listMax: getComputedStyle(list).maxHeight, overflowY: getComputedStyle(list).overflowY, composer: bounds(composer), bounds: [bounds(document.querySelector(".chat-header")), bounds(list), bounds(conversation), bounds(document.querySelector(".parent-agent-bar"))].filter(Boolean) };
    });
    assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
    assert.ok(layout.conversation > 100, JSON.stringify(layout));
    assert.notEqual(layout.listMax, "none", JSON.stringify(layout));
    assert.equal(layout.overflowY, "auto"); assert.ok(layout.listScroll > layout.listHeight, JSON.stringify(layout));
    assert.ok(layout.listHeight <= Math.min(layout.height * 0.32, 320) + 1, JSON.stringify(layout));
    const overflowingBounds = [...layout.bounds, ...(layout.composer ? [layout.composer] : [])].filter((bounds) => bounds.left < -1 || bounds.right > layout.width + 1);
    if (overflowingBounds.length) layoutFailures.push({ page: hasComposer ? "parent" : "child", viewport: `${layout.width}x${layout.height}`, ...layout });
    if (hasComposer) assert.ok(layout.composer.bottom <= layout.height + 1, JSON.stringify(layout));
    else assert.equal(layout.composer, null);
    const scrolled = await list.evaluate((element) => { element.scrollTop = element.scrollHeight; return element.scrollTop; });
    assert.ok(scrolled > 0);
  }
  await checkLayout(true);
  await page.setViewportSize({ width: 390, height: 844 }); await checkLayout(true);
  await page.setViewportSize({ width: 320, height: 700 }); await checkLayout(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(currentUrl(tasks[0].sessionId));
  await page.getByText("Later active branch 1", { exact: true }).waitFor(); await expectNoComposer();
  await expect(page.locator(".chat-title .status-dot > span")).toHaveText("Ready");
  emitState(tasks[0].sessionId, { ...childState, parentRuns: [run, manyRun] });
  await expectBadge(24, 3, 51); await openList(); await checkLayout(false);
  await expect(page.locator(".parent-agent-title")).toHaveText("Parent subagent fixture");
  await expect(page.locator(".parent-agent-bar .status-dot > span")).toHaveText("running");
  await page.setViewportSize({ width: 320, height: 700 }); await checkLayout(false);

  const parentState = await context.request.get(`${base}/api/workspaces/${workspace.id}/sessions/${parent.getSessionId()}/subagents`);
  assert.equal((await parentState.json()).runs[0].tasks[0].state, "completed");
  await expect(page.locator(".global-error")).toHaveCount(0);
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(layoutFailures, [], "Subagent UI elements exceed the mobile viewport");
  console.log("subagent UI checks passed");
  if (process.env.PI_ARK_CHECK_FULL_UI === "1") {
    phase = "general UI checks";
    const result = await promisify(execFile)(process.execPath, ["scripts/check-ui.mjs"], { env: { ...process.env, PI_ARK_CHECK_URL: base, PI_ARK_CHECK_WORKSPACE: workspace.path, PI_ARK_CHECK_USERNAME: "check", PI_ARK_CHECK_PASSWORD: "check-password", PI_ARK_CHECK_LEGACY_SESSION: "" }, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  }
} catch (error) {
  console.error(`Subagent UI phase: ${phase}`);
  if (browserErrors.length) console.error(browserErrors.join("\n"));
  const errors = serverLog.split("\n").filter((line) => /"level":(?:50|60)/.test(line)); if (errors.length) console.error(errors.slice(-10).join("\n"));
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { const exited = once(server, "exit"); server.kill("SIGTERM"); const timer = setTimeout(() => server.kill("SIGKILL"), 5000); await exited; clearTimeout(timer); }
  await rm(directory, { recursive: true, force: true });
}
