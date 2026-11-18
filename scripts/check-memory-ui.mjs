import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID, scryptSync } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { memoryMessageSource } from "../apps/server/dist/agent-tools/memory.js";
import { WorkspaceMemory } from "../apps/server/dist/workspace-memory.js";

const temporary = resolve(".tmp");
await mkdir(temporary, { recursive: true });
const dir = await mkdtemp(join(temporary, "memory-ui-"));
const home = join(dir, "home");
const workspace = { id: "memory-ui", name: "Memory workspace", path: join(dir, "workspace"), memoryStoreId: randomUUID() };
const sessionDir = join(workspace.path, ".pi-ark", "sessions");
const notebook = "Research task draft\nKeep changelog entries short.\nPersonal scratch text.";
const selection = "Keep changelog entries short.";
const routeBase = "/";
let processServer;
let browser;
let log = "";

try {
  await mkdir(home);
  await mkdir(sessionDir, { recursive: true });
  const [key, cert] = [join(home, "key.pem"), join(home, "cert.pem")];
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { timeout: 15000 });
  const portProbe = createServer().listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const { port } = portProbe.address();
  await new Promise((done, fail) => portProbe.close((error) => error ? fail(error) : done()));
  const salt = "ui-fixture";
  await writeFile(join(home, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port }, tls: { keyPath: key, certPath: cert }, auth: { username: "check", passwordHash: `scrypt$${salt}$${scryptSync("check-password", salt, 64).toString("hex")}` }, workspaces: [workspace] }));
  await writeFile(join(workspace.path, ".pi-ark", "notebook.md"), notebook);
  const manager = SessionManager.create(workspace.path, sessionDir);
  manager.appendSessionInfo("Memory source conversation");
  manager.appendMessage({ role: "user", content: "We reconcile invoices on settlement day.", timestamp: Date.now() });
  const call = { type: "toolCall", name: "memory_propose", id: randomUUID(), arguments: { type: "project", title: "Settlement reporting day", summary: "Report invoices by their settlement date", body: "Use settlement dates to reconcile invoices.", tags: ["invoices"], pinned: false } };
  const assistant = (content, stopReason) => ({ role: "assistant", content, provider: "openai", model: "fixture", api: "openai-completions", stopReason, timestamp: Date.now(), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.appendMessage(assistant([call], "toolUse"));
  const memory = new WorkspaceMemory(join(home, "memory"));
  await memory.setSettings(workspace.memoryStoreId, { enabled: true, autoIndex: false });
  const proposal = await memory.propose(workspace.memoryStoreId, call.arguments, memoryMessageSource(workspace, manager), call.id);
  manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: JSON.stringify({ proposalId: proposal.id, status: "pending", source: proposal.source.link }) }], isError: false, timestamp: Date.now() });
  manager.appendMessage(assistant([{ type: "text", text: "The suggestion is ready to review." }], "stop"));

  processServer = spawn(process.execPath, [resolve("apps/server/dist/index.js")], { env: { ...process.env, PI_ARK_HOME: home, PI_ARK_AGENT_DIR: join(home, "pi-agent"), PI_CODING_AGENT_DIR: join(home, "pi-agent"), PI_ARK_MIGRATE_AGENT_DIR: join(home, "pi-agent"), PI_ARK_INSTANCE: "memory-check", PI_ARK_BASE_PATH: routeBase }, stdio: ["ignore", "pipe", "pipe"] });
  processServer.stdout.on("data", (chunk) => { log += chunk; });
  processServer.stderr.on("data", (chunk) => { log += chunk; });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 880 } });
  const origin = `https://127.0.0.1:${port}`;
  let health = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processServer.exitCode !== null) break;
    try { health = (await context.request.get(`${origin}/api/health`, { timeout: 1000 })).ok(); } catch { /* Wait for startup. */ }
    if (health) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(health, log);
  const api = `${origin}/api/workspaces/${workspace.id}/memory`;
  assert.equal((await context.request.get(api)).status(), 401);
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?page=agent&workspace=${workspace.id}&session=${manager.getSessionId()}`);
  await page.getByLabel("Username").fill("check");
  await page.getByLabel("Password", { exact: true }).fill("check-password");
  await page.getByRole("button", { name: "Continue" }).click();
  const review = page.getByRole("button", { name: "Review memory", exact: true });
  await review.click();
  await expect(page.getByRole("heading", { name: "Review memory suggestion" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open source message" })).toHaveAttribute("href", /leafEntryId=/);
  await page.getByLabel("Save suggestion as").selectOption("new");
  await page.getByRole("button", { name: "Create entry", exact: true }).click();
  await expect(page.getByText("This suggestion has been saved to Memory.")).toBeVisible();
  await page.getByRole("button", { name: "Back to entries" }).click();
  const entry = page.locator(".memory-entry").filter({ hasText: "Settlement reporting day" });
  await expect(entry).toBeVisible();
  const indexToggle = page.getByRole("checkbox", { name: /Include short index/ });
  await indexToggle.click();
  await expect(indexToggle).toBeChecked();
  await expect.poll(async () => (await (await context.request.get(api)).json()).autoIndex).toBe(true);
  await entry.getByRole("link", { name: "Open source message" }).click();
  await expect(page.getByText("We reconcile invoices on settlement day.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Workspace notebook" });
  await expect(input).toHaveValue(notebook);
  await input.press("ControlOrMeta+Home");
  await input.press("ArrowDown");
  await input.press("Shift+End");
  await page.getByRole("button", { name: "Save to Memory", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Save selection to Memory" })).toBeVisible();
  await expect(page.getByLabel("Body (Markdown)")).toHaveValue(selection);
  await page.getByLabel("Title", { exact: true }).fill("Changelog style");
  await page.getByLabel("Summary", { exact: true }).fill("Keep changelog notes brief");
  await page.getByRole("button", { name: "Save to Memory", exact: true }).click();
  const note = page.locator(".memory-entry").filter({ hasText: "Changelog style" });
  await expect(note).toBeVisible();
  await note.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(note.locator(".status-archived")).toBeVisible();
  await note.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(note.locator(".status-active")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export Markdown" }).click()]);
  assert.equal(download.suggestedFilename(), "MEMORY.md");
  const markdown = await readFile(await download.path(), "utf8");
  assert.match(markdown, /Settlement reporting day/);
  assert.match(markdown, /Changelog style/);
  await note.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog", { name: "Delete memory entry?" }).getByRole("button", { name: "Delete entry" }).click();
  await expect(note).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Memory overflows the mobile viewport");
  assert.deepEqual(errors, []);
  assert.equal(await readFile(join(workspace.path, ".pi-ark", "notebook.md"), "utf8"), notebook);
  console.log("Memory browser flow supports chat review, source navigation, Notebook selection, active/archived states, export, and deletion.");
} catch (error) {
  console.error(log.split("\n").slice(-12).join("\n"));
  throw error;
} finally {
  await browser?.close();
  if (processServer && processServer.exitCode === null && processServer.signalCode === null) {
    processServer.kill();
    await once(processServer, "exit");
  }
  await rm(dir, { recursive: true, force: true });
}
