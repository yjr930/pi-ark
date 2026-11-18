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

async function withNarrowViewportAndLargeText(check) {
  await resize(narrowMobile);
  const fontScale = await page.evaluate(() => {
    const style = document.documentElement.style;
    const previous = style.getPropertyValue("--fs-scale");
    style.setProperty("--fs-scale", "1.3");
    return previous;
  });
  try {
    await check();
  } finally {
    await page.evaluate((previous) => document.documentElement.style.setProperty("--fs-scale", previous), fontScale);
    await resize(desktop);
  }
}

async function openSelect(trigger, options) {
  await expect(trigger).toHaveClass(/\bark-select-trigger\b/);
  await expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  const selected = await trigger.innerText();
  await trigger.click();
  const menu = trigger.locator("..").getByRole("listbox");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveClass(/\bark-select-menu\b/);
  await expect(menu).toHaveAttribute("id", /\S/);
  await expect(trigger).toHaveAttribute("aria-controls", await menu.getAttribute("id"));
  await expect(menu.getByRole("option")).toHaveText(options);
  await expect(menu.getByRole("option", { selected: true })).toHaveText(selected);
  return menu;
}

async function chooseOption(trigger, options, label) {
  const menu = await openSelect(trigger, options);
  await menu.getByRole("option", { name: label, exact: true }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveText(label);
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
  const workspaceSelect = overridesRegion.getByRole("button", { name: "Workspace", exact: true });
  const workspaceOptions = [workspace.name, inherited.name];
  const overrideLabels = { inherit: "Use global default", on: "On", off: "Off" };
  const fields = { enabled: "Enable Memory", autoIndex: "Include short index", reviewEntries: "Use entries needing review", proactive: "Proactive suggestions" };
  const defaultSwitch = (key) => defaultsRegion.getByRole("switch", { name: fields[key], exact: true });
  const workspaceChoice = (key) => overridesRegion.getByRole("button", { name: fields[key], exact: true });
  const allOff = { enabled: false, autoIndex: false, proactive: false, reviewEntries: false };
  const allOn = { enabled: true, autoIndex: true, proactive: true, reviewEntries: true };
  const defaultsOff = { ...allOff, reviewEntries: true };
  const onOff = (value) => value ? "On" : "Off";

  async function readJson(url) {
    const response = await context.request.get(url);
    assert.ok(response.ok(), `GET ${url}: ${response.status()}`);
    return response.json();
  }
  async function expectWorkspaceSettings(target, defaults, overrides, effective) {
    await expect(workspaceSelect).toHaveText(target.name);
    await expect.poll(() => readJson(`${memoryApi(target.id)}/settings`)).toEqual({ defaults, overrides, effective });
    for (const key of Object.keys(fields)) {
      const control = workspaceChoice(key);
      await expect(control).toBeEnabled();
      await expect(control).toHaveText(Object.hasOwn(overrides, key) ? onOff(overrides[key]) : overrideLabels.inherit);
      await expect(control).toHaveAccessibleDescription(`Global default: ${onOff(defaults[key])} · Effective: ${onOff(effective[key])}`);
    }
  }
  async function setOverride(key, choice, overrides, effective) {
    await chooseOption(workspaceChoice(key), Object.values(overrideLabels), overrideLabels[choice]);
    await expectWorkspaceSettings(inherited, allOn, overrides, effective);
  }

  async function expectFullOverrideLabel(trigger) {
    await expect(trigger).toHaveText(overrideLabels.on);
    const closedWidth = (await trigger.boundingBox()).width;
    const menu = await openSelect(trigger, Object.values(overrideLabels));
    const label = menu.getByRole("option", { name: overrideLabels.inherit, exact: true }).locator(".ark-select-copy > strong");
    await expect(label).toBeVisible();
    const { clientWidth, scrollWidth } = await label.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    const triggerBox = await trigger.boundingBox();
    const menuBox = await menu.boundingBox();
    const rightOffset = menuBox.x + menuBox.width - triggerBox.x - triggerBox.width;
    const { width } = page.viewportSize();
    const context = `Memory override menu at ${width}px with On selected`;
    const tolerance = 1; // CSS pixel rounding between clientWidth and scrollWidth.
    assert.ok(clientWidth > 0 && scrollWidth <= clientWidth + tolerance, `${context}: ${overrideLabels.inherit} needs ${scrollWidth}px but has ${clientWidth}px`);
    assert.ok(Math.abs(triggerBox.width - closedWidth) <= tolerance, `${context}: trigger width changed from ${closedWidth}px to ${triggerBox.width}px`);
    assert.ok(menuBox.width + tolerance >= triggerBox.width, `${context}: popup is narrower than the trigger`);
    assert.ok(Math.abs(rightOffset) <= tolerance, `${context}: popup right edge differs from the trigger by ${rightOffset}px`);
    await expectNoHorizontalOverflow(settingsContent, context);
    await expectNoHorizontalOverflow(menu, context);
    await menu.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
    await expect(menu).toBeInViewport({ ratio: 0.99 });
    await menu.screenshot({ path: join(screenshots, `settings-override-menu-${width}.png`) });
    await trigger.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toHaveCount(0);
    console.log(`${context}: ${overrideLabels.inherit} text ${scrollWidth}px / ${clientWidth}px available; popup ${menuBox.width.toFixed(1)}px, trigger ${triggerBox.width.toFixed(1)}px; right-edge offset ${rightOffset.toFixed(1)}px.`);
  }

  function measureSettingsRows() {
    return settingsContent.evaluate((panel) => {
      const contentTop = panel.getBoundingClientRect().top - panel.scrollTop;
      const boxes = (selector) => Array.from(panel.querySelectorAll(`.memory-settings ${selector}`), (element) => {
        const { top, height } = element.getBoundingClientRect();
        return [Math.round((top - contentTop) * 100) / 100, Math.round(height * 100) / 100];
      });
      return { scrollTop: panel.scrollTop, switches: boxes('[role="switch"]'), workspacePicker: boxes(".memory-settings-workspace .ark-select-trigger"), workspaceRows: boxes(".memory-settings-override") };
    });
  }

  async function expectStableDefaultChange(key, expectedDefaults) {
    const button = defaultSwitch(key);
    const checked = expectedDefaults[key];
    const workspaceApi = `${memoryApi(inherited.id)}/settings`;
    const patchRequest = (request) => request.url() === defaultsApi && request.method() === "PATCH";
    const workspaceRefresh = (request) => request.url() === workspaceApi && request.method() === "GET";
    const targets = (url) => url.href === defaultsApi || url.href === workspaceApi;
    const patch = Promise.withResolvers();
    const refresh = Promise.withResolvers();
    const holdRequests = async (route, request) => {
      if (patchRequest(request)) await patch.promise;
      if (workspaceRefresh(request)) await refresh.promise;
      await route.continue();
    };
    await page.route(targets, holdRequests);
    try {
      await expect(button).toHaveAttribute("aria-checked", String(!checked));
      // Bring the switch into view before taking either content or scroll measurements.
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport({ ratio: 1 });
      const before = await measureSettingsRows();
      assert.equal(before.switches.length, Object.keys(fields).length);
      assert.equal(before.workspaceRows.length, Object.keys(fields).length);
      assert.equal(before.workspacePicker.length, 1);

      const [request] = await Promise.all([page.waitForRequest(patchRequest), button.click()]);
      assert.deepEqual(request.postDataJSON(), { [key]: checked });
      await expect(defaultsRegion.getByRole("status")).toHaveText("Saving changes…");
      await expect(button).toHaveAttribute("aria-checked", String(!checked));
      const saving = await measureSettingsRows();

      const refreshing = page.waitForRequest(workspaceRefresh);
      patch.resolve();
      await refreshing;
      await expect(button).toHaveAttribute("aria-checked", String(checked));
      await expect(workspaceChoice("enabled")).toBeDisabled();
      const reloading = await measureSettingsRows();

      refresh.resolve();
      await expectWorkspaceSettings(inherited, expectedDefaults, {}, expectedDefaults.enabled ? expectedDefaults : allOff);
      const saved = await measureSettingsRows();
      const width = page.viewportSize().width;
      for (const [phase, layout] of Object.entries({ saving, reloading, saved })) {
        assert.deepEqual(layout, before, `Memory settings moved at ${width}px while ${phase}`);
      }
    } finally {
      patch.resolve();
      refresh.resolve();
      await page.unroute(targets, holdRequests);
    }
  }

  await expect(settingsTab).toHaveAttribute("aria-current", "page");
  for (const key of Object.keys(fields)) await expect(defaultSwitch(key)).toHaveAttribute("aria-checked", String(defaultsOff[key]));
  await expectWorkspaceSettings(workspace, defaultsOff, legacyChoices, { ...legacyChoices, proactive: false, reviewEntries: true });
  await expect(settings.locator("select")).toHaveCount(0);
  await chooseOption(workspaceSelect, workspaceOptions, inherited.name);
  await expectWorkspaceSettings(inherited, defaultsOff, {}, allOff);
  await expectStableDefaultChange("enabled", { ...defaultsOff, enabled: true });
  for (const key of ["autoIndex", "proactive"]) {
    await defaultSwitch(key).click();
    await expect(defaultSwitch(key)).toHaveAttribute("aria-checked", "true");
  }
  await expectWorkspaceSettings(inherited, allOn, {}, allOn);
  await withNarrowViewportAndLargeText(async () => {
    await expectStableDefaultChange("enabled", { ...allOn, enabled: false });
    await expectStableDefaultChange("enabled", allOn);
    await expectNoHorizontalOverflow(settingsContent, "Memory settings at maximum text size");
  });
  const { defaults, prompt } = await readJson(defaultsApi);
  assert.deepEqual(defaults, allOn);
  assert.match(prompt, /use memory_propose in this turn/);
  await expectWorkspaceSettings(inherited, allOn, {}, allOn);
  await expect(promptRegion.getByRole("status")).toHaveText(`Included for ${inherited.name} on the next turn in the main Session.`);
  await setOverride("enabled", "off", { enabled: false }, allOff);
  await expect(promptRegion.getByRole("status")).toHaveText(`Not included for ${inherited.name}: Memory is off.`);
  await setOverride("autoIndex", "on", { enabled: false, autoIndex: true }, allOff);
  await setOverride("enabled", "on", { enabled: true, autoIndex: true }, allOn);
  await expectFullOverrideLabel(workspaceChoice("enabled"));
  await withNarrowViewportAndLargeText(() => expectFullOverrideLabel(workspaceChoice("enabled")));
  await setOverride("autoIndex", "off", { enabled: true, autoIndex: false }, { ...allOn, autoIndex: false });
  await setOverride("enabled", "inherit", { autoIndex: false }, { ...allOn, autoIndex: false });
  await setOverride("proactive", "off", { autoIndex: false, proactive: false }, { ...allOn, autoIndex: false, proactive: false });
  await setOverride("reviewEntries", "off", { autoIndex: false, proactive: false, reviewEntries: false }, { ...allOn, autoIndex: false, proactive: false, reviewEntries: false });
  await setOverride("reviewEntries", "inherit", { autoIndex: false, proactive: false }, { ...allOn, autoIndex: false, proactive: false });
  await expect(promptRegion.getByRole("status")).toHaveText(`Not included for ${inherited.name}: proactive suggestions are off.`);

  await page.reload();
  await expect(page).toHaveURL(settingsUrl);
  await expect(settingsTab).toHaveAttribute("aria-current", "page");
  for (const key of Object.keys(fields)) await expect(defaultSwitch(key)).toHaveAttribute("aria-checked", "true");
  await expectWorkspaceSettings(workspace, allOn, legacyChoices, { ...legacyChoices, proactive: true, reviewEntries: true });
  assert.equal(await readFile(memoryPath, "utf8"), legacyFile);
  await chooseOption(workspaceSelect, workspaceOptions, inherited.name);
  await expectWorkspaceSettings(inherited, allOn, { autoIndex: false, proactive: false }, { ...allOn, autoIndex: false, proactive: false });
  for (const viewport of [desktop, mobile, narrowMobile]) {
    await resize(viewport);
    await expectNoHorizontalOverflow(settingsContent, "Memory settings");
    await expect(settingsTab).toBeInViewport({ ratio: 0.99 });
    await settingsContent.evaluate((panel) => { panel.scrollTop = 0; });
    if (viewport !== narrowMobile) {
      await page.screenshot({ path: join(screenshots, `settings-${viewport.width}.png`) });
      const menu = await openSelect(workspaceSelect, workspaceOptions);
      await menu.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
      await expect(workspaceSelect).toBeInViewport({ ratio: 0.99 });
      await expect(menu).toBeInViewport({ ratio: 0.99 });
      await page.screenshot({ path: join(screenshots, `settings-workspace-menu-${viewport.width}.png`) });
      await workspaceSelect.press("Escape");
      await expect(workspaceSelect).toHaveAttribute("aria-expanded", "false");
      await expect(menu).toHaveCount(0);
    }
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
  const reviewDate = editor.getByLabel("Review after", { exact: true });
  await expect(reviewDate).toHaveAttribute("placeholder", "yyyy/mm/dd");
  await expect(reviewDate).toHaveValue("");
  await expect(editor.getByText("After this date the entry shows Needs review and stays in Memory.", { exact: false })).toBeVisible();
  await expectNoHorizontalOverflow(editor, "Memory editor");
  await page.screenshot({ path: join(screenshots, "memory-editor-1280.png") });
  await withNarrowViewportAndLargeText(async () => {
    await expectNoHorizontalOverflow(editor, "Memory editor at maximum text size");
    await page.screenshot({ path: join(screenshots, "memory-editor-320.png") });
  });
  await reviewDate.fill("2026/13/40");
  await editor.getByLabel("Title", { exact: true }).fill("Changelog style");
  await editor.getByLabel("Summary", { exact: true }).fill("Keep changelog notes brief");
  await editor.getByRole("button", { name: "Save to Memory", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText("Enter the review date as yyyy/mm/dd.");
  await reviewDate.fill("2027/01/31");
  await editor.getByRole("button", { name: "Save to Memory", exact: true }).click();
  const note = savedEntries.locator(".memory-entry").filter({ hasText: "Changelog style" });
  await expect(note).toBeVisible();
  await expect(note.locator(".memory-source")).toContainText("Review after 2027/01/31");
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
  console.log(`Memory settings, shared Select, switch layout, Workspace inheritance, navigation, selected shortcuts, review, and Notebook passed. Screenshots: ${screenshots}`);
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
