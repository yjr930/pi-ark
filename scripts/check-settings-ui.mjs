import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const url = process.env.PI_ARK_CHECK_URL;
if (!url) throw new Error("Set PI_ARK_CHECK_URL for an isolated Pi-Ark service");
const screenshots = process.env.PI_ARK_CHECK_SCREENSHOT_DIR || join(import.meta.dirname, "..", ".tmp", "screenshots", "settings");
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
const requests = new Map();
page.on("request", (request) => {
  if (request.method() !== "GET") return;
  const path = new URL(request.url()).pathname;
  requests.set(path, (requests.get(path) || 0) + 1);
});
const navigation = () => page.getByRole("navigation", { name: "Settings categories" });
const select = (name) => navigation().getByRole("button", { name, exact: true }).click();
const appPage = (name) => page.locator(".sidebar-navigation").getByRole("button", { name, exact: true }).click();
const snapshot = () => Object.fromEntries([...requests].filter(([path]) => path.startsWith("/api/settings/")));
const modelWrites = [];
let modelPreferences = {
  models: [
    { provider: "openai-codex", providerName: "OpenAI Codex (legacy)", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true, contextWindow: 200000, thinkingLevels: ["low", "medium", "high"], enabled: true },
    { provider: "openai", providerName: "OpenAI", id: "gpt-6", name: "GPT-6", reasoning: true, contextWindow: 200000, thinkingLevels: ["medium", "high"], enabled: true },
    { provider: "openai", providerName: "OpenAI", id: "chat", name: "Chat", reasoning: false, contextWindow: 128000, thinkingLevels: ["off"], enabled: true },
  ],
  defaultProvider: "openai-codex", defaultModel: "gpt-5.6-sol", thinkingLevel: "high",
};
await page.route("**/api/settings/model-preferences", async (route) => {
  if (route.request().method() === "PUT") {
    const input = route.request().postDataJSON();
    modelWrites.push(input);
    const selectedDefault = modelPreferences.models.find((model) => model.provider === input.defaultProvider && model.id === input.defaultModel);
    const error = !input.enabledModels.length ? "Select at least one model" : !selectedDefault || !input.enabledModels.includes(`${input.defaultProvider}/${input.defaultModel}`) ? "Default model must be enabled" : !selectedDefault.thinkingLevels.includes(input.thinkingLevel) ? "Thinking level is not supported by the default model" : undefined;
    if (error) return route.fulfill({ status: 400, json: { error } });
    modelPreferences = { ...modelPreferences, defaultProvider: input.defaultProvider, defaultModel: input.defaultModel, thinkingLevel: input.thinkingLevel, models: modelPreferences.models.map((model) => ({ ...model, enabled: input.enabledModels.includes(`${model.provider}/${model.id}`) })) };
  }
  await route.fulfill({ json: modelPreferences });
});
const modelCheckbox = (name) => page.getByRole("checkbox", { name: new RegExp(`^(Hide|Show) ${name} in model menus$`) });
async function toggleModel(name, expectedDefault, expectedThinking) {
  const checkbox = modelCheckbox(name);
  const wasEnabled = await checkbox.getAttribute("aria-checked") === "true";
  const response = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings/model-preferences");
  await checkbox.click();
  assert.equal((await response).status(), 200);
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).toHaveAttribute("aria-checked", String(!wasEnabled));
  assert.equal(`${modelWrites.at(-1).defaultProvider}/${modelWrites.at(-1).defaultModel}`, expectedDefault);
  assert.equal(modelWrites.at(-1).thinkingLevel, expectedThinking);
}
const filesWrites = [];
await page.route("**/api/settings/preferences", async (route) => {
  if (route.request().method() === "PUT") {
    const input = route.request().postDataJSON();
    assert.deepEqual(Object.keys(input), ["files"]);
    filesWrites.push(input);
  }
  await route.continue();
});

try {
  await page.goto(url);
  await page.getByLabel("Username").fill(process.env.PI_ARK_CHECK_USERNAME || "check");
  await page.getByLabel("Password").fill(process.env.PI_ARK_CHECK_PASSWORD || "check-password");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator(".workspace-list-item").first().waitFor();
  await appPage("Settings");
  await navigation().waitFor();
  assert.deepEqual(await navigation().locator("button").allTextContents(), ["Interface", "Models & providers", "Agent behavior", "Skills", "MCP", "Files", "Terminal", "Maintenance", "Account"]);
  assert.equal(requests.get("/api/settings/system-prompt") || 0, 0);
  assert.equal(requests.get("/api/settings/release") || 0, 0);
  assert.equal(await page.getByText("Workspace configuration", { exact: true }).count(), 0);
  assert.equal(await page.locator(".theme-options > button").count(), 5);
  const themeGeometry = await page.locator(".theme-options > button").evaluateAll((elements) => elements.map((element) => ({ height: element.getBoundingClientRect().height, width: element.getBoundingClientRect().width })));
  assert.ok(themeGeometry.every((item) => item.height >= 40 && item.height <= 48 && item.width < 200));
  const themeSave = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/ui");
  await page.locator(".theme-options").getByRole("button", { name: "Paper", exact: true }).click();
  assert.equal((await themeSave).ok(), true);
  await page.locator('html[data-theme="paper"]').waitFor();
  await select("Interface");
  await page.screenshot({ path: join(screenshots, "settings-paper-desktop.png") });

  await select("Models & providers");
  await expect(modelCheckbox("GPT-6")).toHaveAttribute("aria-checked", "true");
  assert.equal(await page.locator(".model-visibility > *").count(), 0);
  assert.equal((await page.locator(".model-visibility").allTextContents()).join(""), "");
  await toggleModel("GPT-6", "openai-codex/gpt-5.6-sol", "high");
  await toggleModel("GPT-6", "openai-codex/gpt-5.6-sol", "high");
  await toggleModel("Chat", "openai-codex/gpt-5.6-sol", "high");
  await toggleModel("Chat", "openai-codex/gpt-5.6-sol", "high");
  await toggleModel("GPT-5.6 Sol", "openai/gpt-6", "high");
  await expect(page.getByRole("button", { name: "GPT-6 is the default model", exact: true })).toHaveAttribute("aria-pressed", "true");
  await toggleModel("GPT-6", "openai/chat", "off");
  const writesBeforeLastModel = modelWrites.length;
  await modelCheckbox("Chat").click();
  await expect(page.getByText("Select at least one model.", { exact: true })).toBeVisible();
  await expect(modelCheckbox("Chat")).toHaveAttribute("aria-checked", "true");
  assert.equal(modelWrites.length, writesBeforeLastModel);
  const defaultResponse = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings/model-preferences");
  await page.getByRole("button", { name: "Use GPT-5.6 Sol as default", exact: true }).click();
  assert.equal((await defaultResponse).status(), 200);
  await expect(modelCheckbox("GPT-5.6 Sol")).toBeEnabled();
  await expect(modelCheckbox("GPT-5.6 Sol")).toHaveAttribute("aria-checked", "true");
  assert.equal(modelPreferences.defaultModel, "gpt-5.6-sol");
  assert.equal(modelPreferences.thinkingLevel, "low");
  await page.reload();
  await navigation().waitFor();
  await select("Models & providers");
  await expect(modelCheckbox("GPT-6")).toHaveAttribute("aria-checked", "false");
  await expect(modelCheckbox("GPT-5.6 Sol")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: "GPT-5.6 Sol is the default model", exact: true })).toHaveAttribute("aria-pressed", "true");

  await select("Agent behavior");
  assert.equal(await page.getByRole("heading", { name: "Agent tools", exact: true }).count(), 0);
  assert.equal(await page.locator(".tool-options").count(), 0);
  const append = page.getByLabel("Global append content");
  await append.fill("Keep responses clear and practical. Explain important changes before editing files.");
  const content = await append.inputValue();
  await select("Files");
  await select("Agent behavior");
  assert.equal(await append.inputValue(), content);
  let releasePrompt;
  let promptStarted;
  const promptHeld = new Promise((resolve) => { releasePrompt = resolve; });
  const promptPending = new Promise((resolve) => { promptStarted = resolve; });
  const holdPrompt = async (route) => {
    if (route.request().method() === "PUT") { promptStarted(); await promptHeld; }
    await route.continue();
  };
  await page.route("**/api/settings/system-prompt", holdPrompt);
  const promptSaved = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings/system-prompt");
  await page.getByRole("button", { name: "Save system prompt", exact: true }).click();
  await promptPending;
  await select("Files");
  const concurrentHidden = page.locator(".settings-row").filter({ hasText: "Show hidden files" }).getByRole("switch");
  const concurrentHiddenBefore = await concurrentHidden.getAttribute("aria-checked");
  const concurrentFilesSaved = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings/preferences");
  await concurrentHidden.click();
  assert.equal(filesWrites.length, 0);
  releasePrompt();
  assert.equal((await promptSaved).ok(), true);
  assert.equal((await concurrentFilesSaved).ok(), true);
  await page.unroute("**/api/settings/system-prompt", holdPrompt);
  const saved = await page.evaluate(async () => fetch("./api/settings/preferences").then((response) => response.json()));
  assert.deepEqual(saved.agent, { systemPrompt: { append: content } });
  assert.equal(saved.files.showHiddenFiles, concurrentHiddenBefore !== "true");
  await select("Agent behavior");
  assert.equal(await append.inputValue(), content);
  await page.locator(".settings-content").evaluate((element) => { element.scrollTop = 200; });
  await page.waitForTimeout(80);
  const scrollBefore = await page.locator(".settings-content").evaluate((element) => element.scrollTop);
  const before = snapshot();
  await appPage("Files");
  await page.locator(".file-browser").waitFor();
  await appPage("Settings");
  await append.waitFor({ timeout: 500 });
  assert.equal(await append.inputValue(), content);
  assert.equal(await page.locator(".page-loading").filter({ hasText: "Loading settings" }).count(), 0);
  assert.equal(await page.locator(".settings-content").evaluate((element) => element.scrollTop), scrollBefore);
  assert.deepEqual(snapshot(), before);
  await page.locator(".settings-content").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: join(screenshots, "settings-agent-desktop.png") });
  await page.getByText("Preview effective prompt", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".system-prompt-view > pre")?.textContent.includes("Keep responses clear and practical"));
  assert.equal(requests.get("/api/settings/system-prompt"), 1);
  await select("Interface");
  await select("Agent behavior");
  assert.equal(requests.get("/api/settings/system-prompt"), 1);
  await select("Maintenance");
  await page.locator(".pi-core-section").waitFor();
  assert.equal(requests.get("/api/settings/release"), 1);
  await select("Files");
  await select("Maintenance");
  assert.equal(requests.get("/api/settings/release"), 1);
  await select("Files");
  const hidden = page.locator(".settings-row").filter({ hasText: "Show hidden files" }).getByRole("switch");
  const hiddenBefore = await hidden.getAttribute("aria-checked");
  const saveFiles = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings/preferences");
  await hidden.click();
  assert.equal((await saveFiles).ok(), true);
  const files = await page.evaluate(async () => fetch("./api/settings/preferences").then((response) => response.json()));
  assert.equal(files.files.showHiddenFiles, hiddenBefore !== "true");
  assert.equal(files.agent.systemPrompt.append, content);
  let releaseFiles;
  let filesStarted;
  let heldFiles = false;
  const filesHeld = new Promise((resolve) => { releaseFiles = resolve; });
  const filesPending = new Promise((resolve) => { filesStarted = resolve; });
  const holdFiles = async (route) => {
    if (route.request().method() !== "PUT" || heldFiles) return route.fallback();
    heldFiles = true;
    const input = route.request().postDataJSON();
    assert.deepEqual(Object.keys(input), ["files"]);
    const response = await route.fetch();
    filesStarted();
    await filesHeld;
    await route.fulfill({ response });
  };
  await page.route("**/api/settings/preferences", holdFiles);
  const latestHidden = await hidden.getAttribute("aria-checked");
  await hidden.click();
  await filesPending;
  await hidden.click();
  const previewSize = page.getByLabel("Maximum preview size");
  await previewSize.fill("23");
  await previewSize.press("Tab");
  releaseFiles();
  await page.getByText("Preview size saved.", { exact: true }).waitFor();
  await page.unroute("**/api/settings/preferences", holdFiles);
  const latestFiles = await page.evaluate(async () => fetch("./api/settings/preferences").then((response) => response.json()));
  assert.equal(latestFiles.files.showHiddenFiles, latestHidden === "true");
  assert.equal(latestFiles.files.maxPreviewSizeMb, 23);
  assert.equal(await hidden.getAttribute("aria-checked"), latestHidden);
  assert.equal(await previewSize.inputValue(), "23");
  assert.deepEqual(latestFiles.agent, { systemPrompt: { append: content } });
  await select("Interface");
  for (const theme of ["Ark Dark", "Graphite", "Midnight", "Snow", "Paper"]) {
    const response = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/ui");
    await page.locator(".theme-options").getByRole("button", { name: theme, exact: true }).click();
    await response;
    const geometry = await page.locator(".settings-layout").evaluate((element) => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, viewport: window.innerWidth }; });
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport + 1);
    await select("Models & providers");
    const checkedColor = await modelCheckbox("GPT-5.6 Sol").evaluate((element) => getComputedStyle(element).backgroundColor);
    const uncheckedColor = await modelCheckbox("GPT-6").evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.notEqual(checkedColor, uncheckedColor);
    assert.equal(await page.locator(".model-visibility > *").count(), 0);
    if (theme === "Ark Dark" || theme === "Paper") await page.screenshot({ path: join(screenshots, `settings-models-${theme === "Paper" ? "paper" : "dark"}.png`) });
    await select("Interface");
    if (theme === "Ark Dark") await page.screenshot({ path: join(screenshots, "settings-dark-desktop.png") });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const closeSidebar = page.getByRole("button", { name: "Close sidebar", exact: true });
  if (await closeSidebar.isVisible()) await closeSidebar.click();
  await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().right <= 0);
  const mobile = await page.locator(".settings-page").evaluate((element) => { const box = element.getBoundingClientRect(); return { right: box.right, viewport: window.innerWidth, overflow: document.documentElement.scrollWidth > window.innerWidth }; });
  assert.ok(mobile.right <= mobile.viewport + 1 && !mobile.overflow);
  const chrome = await page.evaluate(() => { const bar = getComputedStyle(document.querySelector(".mobile-bar")); return { text: bar.color, background: bar.backgroundColor, sidebarShadow: getComputedStyle(document.querySelector(".sidebar")).boxShadow }; });
  assert.notEqual(chrome.text, chrome.background);
  assert.equal(chrome.sidebarShadow, "none");
  await page.screenshot({ path: join(screenshots, "settings-paper-mobile.png") });
  await select("Models & providers");
  await toggleModel("GPT-6", "openai-codex/gpt-5.6-sol", "low");
  await toggleModel("GPT-6", "openai-codex/gpt-5.6-sol", "low");
  await page.screenshot({ path: join(screenshots, "settings-models-mobile.png") });
  await select("Agent behavior");
  await append.waitFor();
  assert.equal(await append.inputValue(), content);
  await page.screenshot({ path: join(screenshots, "settings-agent-mobile.png") });
  assert.equal([...requests.keys()].some((path) => /^\/api\/workspaces\/[^/]+\/(settings|system-prompt)$/.test(path)), false);
  console.log(`Settings UI checks passed; screenshots: ${screenshots}`);
} catch (error) {
  await page.screenshot({ path: join(screenshots, "failure.png"), fullPage: true });
  throw error;
} finally { await browser.close(); }
