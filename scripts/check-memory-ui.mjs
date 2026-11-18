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
const screenshots = join(temporary, "screenshots", "memory");
await mkdir(screenshots, { recursive: true });
const dir = await mkdtemp(join(temporary, "memory-ui-"));
const home = join(dir, "home");
const workspace = { id: "memory-ui", name: "Memory workspace", path: join(dir, "workspace"), memoryStoreId: randomUUID() };
const inherited = { id: "memory-inherited", name: "Inherited workspace", path: join(dir, "inherited") };
const memoryPath = join(home, "memory", `${workspace.memoryStoreId}.json`);
const legacyChoices = { enabled: true, autoIndex: false };
const sessionTitle = "Memory source conversation";
const sessionDir = join(workspace.path, ".pi-ark", "sessions");
const notebook = "Research task draft\nKeep changelog entries short.\nPersonal scratch text.";
const selection = "Keep changelog entries short.";
const routeBase = "/";
const desktop = { width: 1280, height: 880 };
const mobile = { width: 390, height: 844 };
const narrowMobile = { ...mobile, width: 320 };
let processServer;
let browser;
let page;
let log = "";

async function expectNoHorizontalOverflow(panel, label) {
  await expect(panel).toBeVisible();
  const { viewport, documentWidth, width, scrollWidth } = await panel.evaluate((element) => ({
    viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth, width: element.clientWidth, scrollWidth: element.scrollWidth,
  }));
  assert.ok(documentWidth <= viewport, `${label} at ${viewport}px overflows the viewport (${documentWidth}px)`);
  assert.ok(scrollWidth <= width, `${label} at ${viewport}px overflows its panel (${scrollWidth}px > ${width}px)`);
}

async function expectSelectedShortcut(button) {
  await expect(button).toHaveAttribute("aria-current", "page");
  await expect(button).toHaveCSS("border-left-style", "dashed");
  await expect(button).toHaveCSS("box-shadow", "none");
}

async function resize(viewport) {
  await page.setViewportSize(viewport);
  // Switching from desktop starts the mobile drawer's closing transition.
  if (viewport !== desktop) await expect(page.locator(".sidebar")).not.toBeInViewport({ ratio: 0.001 });
}

try {
  await mkdir(home);
  await mkdir(sessionDir, { recursive: true });
  await mkdir(inherited.path);
  const [key, cert] = [join(home, "key.pem"), join(home, "cert.pem")];
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { timeout: 15000 });
  const portProbe = createServer().listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const { port } = portProbe.address();
  await new Promise((done, fail) => portProbe.close((error) => error ? fail(error) : done()));
  const salt = "ui-fixture";
  await writeFile(join(home, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port }, tls: { keyPath: key, certPath: cert }, auth: { username: "check", passwordHash: `scrypt$${salt}$${scryptSync("check-password", salt, 64).toString("hex")}` }, workspaces: [workspace, inherited] }));
  await writeFile(join(workspace.path, ".pi-ark", "notebook.md"), notebook);
  const manager = SessionManager.create(workspace.path, sessionDir);
  manager.appendSessionInfo(sessionTitle);
  manager.appendMessage({ role: "user", content: "We reconcile invoices on settlement day.", timestamp: Date.now() });
  const call = { type: "toolCall", name: "memory_propose", id: randomUUID(), arguments: { type: "project", title: "Settlement reporting day", summary: "Report invoices by their settlement date", body: "Use settlement dates to reconcile invoices.", tags: ["invoices"], pinned: false } };
  const assistant = (content, stopReason) => ({ role: "assistant", content, provider: "openai", model: "fixture", api: "openai-completions", stopReason, timestamp: Date.now(), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.appendMessage(assistant([call], "toolUse"));
  const memory = new WorkspaceMemory(join(home, "memory"));
  await memory.setSettings(workspace.memoryStoreId, legacyChoices);
  await memory.create(workspace.memoryStoreId, { type: "feedback", title: "Summarize release changes", summary: "Group related changes and note any steps users need to take.", body: "Use the public release notes to record migration steps.", tags: ["releases", "documentation"], pinned: true });
  const proposal = await memory.propose(workspace.memoryStoreId, call.arguments, memoryMessageSource(workspace, manager), call.id);
  // Keep the seeded entry and suggestion in the original v1 format without an overrides field.
  const { entries, proposals } = JSON.parse(await readFile(memoryPath, "utf8"));
  const legacyFile = JSON.stringify({ version: 1, ...legacyChoices, entries, proposals });
  await writeFile(memoryPath, legacyFile);
  manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: JSON.stringify({ proposalId: proposal.id, status: "pending", source: proposal.source.link }) }], isError: false, timestamp: Date.now() });
  manager.appendMessage(assistant([{ type: "text", text: "The suggestion is ready to review." }], "stop"));

  processServer = spawn(process.execPath, [resolve("apps/server/dist/index.js")], { env: { ...process.env, HOME: home, PI_ARK_HOME: home, PI_ARK_AGENT_DIR: join(home, "pi-agent"), PI_CODING_AGENT_DIR: join(home, "pi-agent"), PI_ARK_MIGRATE_AGENT_DIR: join(home, "pi-agent"), PI_ARK_INSTANCE: "memory-check", PI_ARK_BASE_PATH: routeBase }, stdio: ["ignore", "pipe", "pipe"] });
  processServer.stdout.on("data", (chunk) => { log += chunk; });
  processServer.stderr.on("data", (chunk) => { log += chunk; });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: desktop });
  const origin = `https://127.0.0.1:${port}`;
  let health = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processServer.exitCode !== null) break;
    try { health = (await context.request.get(`${origin}/api/health`, { timeout: 1000 })).ok(); } catch { /* Wait for startup. */ }
    if (health) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(health, log);
  const memoryApi = (id) => `${origin}/api/workspaces/${id}/memory`;
  const defaultsApi = `${origin}/api/settings/memory`;
  assert.equal((await context.request.get(memoryApi(workspace.id))).status(), 401);
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?page=agent&workspace=${workspace.id}&session=${manager.getSessionId()}`);
  await page.getByLabel("Username").fill("check");
  await page.getByLabel("Password", { exact: true }).fill("check-password");
  await page.getByRole("button", { name: "Continue" }).click();
  const sessionRow = page.locator(".session-list-item").filter({ hasText: sessionTitle });
  await expect(sessionRow).toHaveClass(/\bactive\b/);
  await expect(sessionRow).toHaveCSS("box-shadow", / 2px 0px 0px 0px inset$/);
  const sessionShadow = await sessionRow.evaluate((row) => getComputedStyle(row).boxShadow);
  const shortcuts = page.locator(".session-notebook-entry");
  const memoryShortcut = shortcuts.getByRole("button", { name: "Memory", exact: true });
  const notebookShortcut = shortcuts.getByRole("button", { name: "Notebook", exact: true });
  await memoryShortcut.click();
  await expectSelectedShortcut(memoryShortcut);

  const memoryPage = page.locator(".memory-page");
  const memoryHeader = memoryPage.locator(".memory-header");
  const openSettings = memoryHeader.getByRole("button", { name: "Memory settings", exact: true });
  const pending = memoryPage.getByRole("region", { name: "Pending suggestions", exact: true });
  const savedEntries = memoryPage.getByRole("region", { name: "Entries", exact: true });
  const fixtureEntry = savedEntries.locator(".memory-entry").filter({ hasText: "Summarize release changes" });
  await expect(openSettings).toBeVisible();
  await expect(pending.getByRole("button", { name: "Review memory", exact: true })).toBeVisible();
  await expect(fixtureEntry).toBeVisible();
  const memoryUrl = page.url();
  for (const viewport of [desktop, mobile, narrowMobile]) {
    await resize(viewport);
    await expectNoHorizontalOverflow(memoryHeader, "Memory header");
    await expectNoHorizontalOverflow(memoryPage.locator(".memory-scroll"), "Memory entries and suggestions");
    await expect(openSettings).toBeInViewport({ ratio: 1 });
    await openSettings.click({ trial: true });
    if (viewport !== narrowMobile) await page.screenshot({ path: join(screenshots, `memory-${viewport.width}.png`) });
  }
  await resize(desktop);
  await openSettings.click();
  await expect(page).toHaveURL((url) => url.searchParams.get("page") === "settings" && url.searchParams.get("category") === "memory" && url.searchParams.get("workspace") === workspace.id);
  const settingsUrl = page.url();
  const settingsPage = page.locator(".settings-page-host");
  const settingsContent = settingsPage.locator(".settings-content");
  const settings = settingsContent.locator(".memory-settings");
  const settingsTab = settingsPage.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Memory", exact: true });
  const defaultsRegion = settings.getByRole("region", { name: "Global defaults", exact: true });
  const overridesRegion = settings.getByRole("region", { name: "Workspace overrides", exact: true });
  const promptRegion = settings.getByRole("region", { name: "Proactive suggestion prompt preview", exact: true });
  const workspaceSelect = overridesRegion.getByRole("combobox", { name: "Workspace", exact: true });
  const fields = { enabled: "Enable Memory", autoIndex: "Include short index", proactive: "Proactive suggestions" };
  const defaultSwitch = (key) => defaultsRegion.getByRole("switch", { name: fields[key], exact: true });
  const workspaceChoice = (key) => overridesRegion.getByRole("combobox", { name: fields[key], exact: true });
  const allOff = { enabled: false, autoIndex: false, proactive: false };
  const allOn = { enabled: true, autoIndex: true, proactive: true };
  const onOff = (value) => value ? "On" : "Off";

  async function readJson(url) {
    const response = await context.request.get(url);
    assert.ok(response.ok(), `GET ${url}: ${response.status()}`);
    return response.json();
  }
  async function expectWorkspaceSettings(target, defaults, overrides, effective) {
    await expect(workspaceSelect).toHaveValue(target.id);
    await expect.poll(() => readJson(`${memoryApi(target.id)}/settings`)).toEqual({ defaults, overrides, effective });
    for (const key of Object.keys(fields)) {
      const control = workspaceChoice(key);
      await expect(control).toHaveValue(Object.hasOwn(overrides, key) ? onOff(overrides[key]).toLowerCase() : "inherit");
      await expect(control).toHaveAccessibleDescription(`Global default: ${onOff(defaults[key])} · Effective: ${onOff(effective[key])}${key !== "enabled" && !effective.enabled ? " (Memory is off)" : ""}`);
    }
  }
  async function setOverride(key, choice, overrides, effective) {
    await workspaceChoice(key).selectOption(choice);
    await expectWorkspaceSettings(inherited, allOn, overrides, effective);
  }

  await expect(settingsTab).toHaveAttribute("aria-current", "page");
  for (const key of Object.keys(fields)) await expect(defaultSwitch(key)).toHaveAttribute("aria-checked", "false");
  await expectWorkspaceSettings(workspace, allOff, legacyChoices, { ...legacyChoices, proactive: false });
  await workspaceSelect.selectOption(inherited.id);
  await expectWorkspaceSettings(inherited, allOff, {}, allOff);
  for (const key of Object.keys(fields)) {
    await defaultSwitch(key).click();
    await expect(defaultSwitch(key)).toHaveAttribute("aria-checked", "true");
  }
  const { defaults, prompt } = await readJson(defaultsApi);
  assert.deepEqual(defaults, allOn);
  assert.match(prompt, /use memory_propose in this turn/);
  await expectWorkspaceSettings(inherited, allOn, {}, allOn);
  await expect(promptRegion.getByRole("status")).toHaveText(`Included for ${inherited.name} on the next turn in the main Session.`);
  await setOverride("enabled", "off", { enabled: false }, allOff);
  await expect(promptRegion.getByRole("status")).toHaveText(`Not included for ${inherited.name}: Memory is off.`);
  await setOverride("autoIndex", "on", { enabled: false, autoIndex: true }, allOff);
  await setOverride("enabled", "on", { enabled: true, autoIndex: true }, allOn);
  await setOverride("autoIndex", "off", { enabled: true, autoIndex: false }, { ...allOn, autoIndex: false });
  await setOverride("enabled", "inherit", { autoIndex: false }, { ...allOn, autoIndex: false });
  await setOverride("proactive", "off", { autoIndex: false, proactive: false }, { ...allOn, autoIndex: false, proactive: false });
  await expect(promptRegion.getByRole("status")).toHaveText(`Not included for ${inherited.name}: proactive suggestions are off.`);

  await page.reload();
  await expect(page).toHaveURL(settingsUrl);
  await expect(settingsTab).toHaveAttribute("aria-current", "page");
  for (const key of Object.keys(fields)) await expect(defaultSwitch(key)).toHaveAttribute("aria-checked", "true");
  await expectWorkspaceSettings(workspace, allOn, legacyChoices, { ...legacyChoices, proactive: true });
  assert.equal(await readFile(memoryPath, "utf8"), legacyFile);
  await workspaceSelect.selectOption(inherited.id);
  await expectWorkspaceSettings(inherited, allOn, { autoIndex: false, proactive: false }, { ...allOn, autoIndex: false, proactive: false });
  for (const viewport of [desktop, mobile, narrowMobile]) {
    await resize(viewport);
    await expectNoHorizontalOverflow(settingsContent, "Memory settings");
    await expect(settingsTab).toBeInViewport({ ratio: 0.99 });
    await settingsContent.evaluate((panel) => { panel.scrollTop = 0; });
    if (viewport !== narrowMobile) await page.screenshot({ path: join(screenshots, `settings-${viewport.width}.png`) });
  }
  await resize(mobile);
  await overridesRegion.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, "settings-overrides-390.png") });
  await promptRegion.getByText("Proactive suggestion prompt", { exact: true }).click();
  const preview = promptRegion.locator("pre");
  await expect(preview).toBeVisible();
  assert.equal(await preview.textContent(), prompt);
  for (const viewport of [mobile, narrowMobile, desktop]) {
    await resize(viewport);
    await expectNoHorizontalOverflow(settingsContent, "Memory settings with prompt expanded");
    await promptRegion.scrollIntoViewIfNeeded();
    if (viewport !== narrowMobile) await page.screenshot({ path: join(screenshots, `settings-prompt-${viewport.width}.png`) });
  }
  await page.goBack();
  await expect(page).toHaveURL(memoryUrl);
  await expect(fixtureEntry).toBeVisible();
  await expectSelectedShortcut(memoryShortcut);

  await sessionRow.locator(".session-open").click();
  await expect(sessionRow).toHaveClass(/\bactive\b/);
  await expect(sessionRow).toHaveCSS("box-shadow", sessionShadow);
  await page.locator(".feed-memory-action").getByRole("button", { name: "Review memory", exact: true }).click();
  const review = memoryPage.locator(".memory-editor");
  await expect(review.getByRole("heading", { name: "Review memory suggestion" })).toBeVisible();
  await expect(review.getByRole("link", { name: "Open source message" })).toHaveAttribute("href", /leafEntryId=/);
  await review.getByLabel("Save suggestion as").selectOption("new");
  await review.getByRole("button", { name: "Create entry", exact: true }).click();
  await expect(review.getByText("This suggestion has been saved to Memory.")).toBeVisible();
  await review.getByRole("button", { name: "Back to entries" }).click();
  await expect(pending.getByText("No suggestions waiting for review.", { exact: true })).toBeVisible();
  const entry = savedEntries.locator(".memory-entry").filter({ hasText: "Settlement reporting day" });
  await expect(entry).toBeVisible();
  await entry.getByRole("link", { name: "Open source message" }).click();
  await expect(page.getByText("We reconcile invoices on settlement day.", { exact: true })).toBeVisible();

  await notebookShortcut.click();
  await expectSelectedShortcut(notebookShortcut);
  const input = page.getByRole("textbox", { name: "Workspace notebook" });
  await expect(input).toHaveValue(notebook);
  await input.press("ControlOrMeta+Home");
  await input.press("ArrowDown");
  await input.press("Shift+End");
  await page.getByRole("button", { name: "Save to Memory", exact: true }).click();
  const editor = memoryPage.locator(".memory-editor");
  await expect(editor.getByRole("heading", { name: "Save selection to Memory" })).toBeVisible();
  await expect(editor.getByLabel("Body (Markdown)")).toHaveValue(selection);
  await resize(mobile);
  await openSettings.click();
  await expect(settingsTab).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(editor.getByRole("heading", { name: "Save selection to Memory" })).toBeVisible();
  await expect(editor.getByLabel("Body (Markdown)")).toHaveValue(selection);
  await resize(desktop);
  await editor.getByLabel("Title", { exact: true }).fill("Changelog style");
  await editor.getByLabel("Summary", { exact: true }).fill("Keep changelog notes brief");
  await editor.getByRole("button", { name: "Save to Memory", exact: true }).click();
  const note = savedEntries.locator(".memory-entry").filter({ hasText: "Changelog style" });
  await expect(note).toBeVisible();
  await note.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(note.locator(".status-archived")).toBeVisible();
  await note.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(note.locator(".status-active")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), memoryHeader.getByRole("link", { name: "Export Markdown" }).click()]);
  assert.equal(download.suggestedFilename(), "MEMORY.md");
  const markdown = await readFile(await download.path(), "utf8");
  assert.match(markdown, /Settlement reporting day/);
  assert.match(markdown, /Changelog style/);
  await note.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog", { name: "Delete memory entry?" }).getByRole("button", { name: "Delete entry" }).click();
  await expect(note).toHaveCount(0);
  await expect(fixtureEntry).toBeVisible();
  assert.deepEqual(errors, []);
  assert.equal(await readFile(join(workspace.path, ".pi-ark", "notebook.md"), "utf8"), notebook);
  console.log(`Memory settings, Workspace inheritance, navigation, selected shortcuts, review, Notebook, and layouts passed. Screenshots: ${screenshots}`);
} catch (error) {
  await page?.screenshot({ path: join(screenshots, "memory-check-failure.png"), timeout: 2500 }).catch(() => {});
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
