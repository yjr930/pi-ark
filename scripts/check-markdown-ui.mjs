import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const url = process.env.PI_ARK_CHECK_URL;
const workspace = process.env.PI_ARK_CHECK_WORKSPACE;
if (!url || !workspace) throw new Error("Set PI_ARK_CHECK_URL and PI_ARK_CHECK_WORKSPACE for an isolated service");
const screenshots = process.env.PI_ARK_CHECK_SCREENSHOT_DIR || join(import.meta.dirname, "..", ".tmp", "screenshots", "markdown");
await mkdir(screenshots, { recursive: true });
const filename = "pi-ark-line-breaks.md";
const filePath = join(workspace, filename);
const source = "First line\nSecond line\n\nNext paragraph\n\n```text\ncode line one\ncode line two\n```\n\n- First item\n- Second item\n\n| Label | Value |\n| --- | --- |\n| One | Two |\n";
await writeFile(filePath, source, { flag: "wx" });
const sessions = join(workspace, ".pi-ark", "sessions");
await mkdir(sessions, { recursive: true });
const fixture = SessionManager.create(workspace, sessions);
fixture.appendSessionInfo("Markdown line-break fixture");
fixture.appendMessage({ role: "user", content: source, timestamp: Date.now() - 2000 });
fixture.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: source }, { type: "text", text: source }], api: "openai-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() - 1000 });
const sessionPath = fixture.getSessionFile();
assert.ok(sessionPath);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
const navigate = (name) => page.locator(".sidebar-navigation").getByRole("button", { name, exact: true }).click();
const lineBreakSwitch = () => page.getByRole("switch", { name: "Keep line breaks", exact: true });
const uiSettings = () => page.evaluate(async () => fetch(new URL("api/ui", document.baseURI)).then((response) => response.json()));

async function openInterface() {
  await navigate("Settings");
  await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Interface", exact: true }).click();
  await expect(lineBreakSwitch()).toBeVisible();
}

async function checkMarkdown(article, enabled) {
  await expect(article).toBeVisible();
  const firstParagraph = article.locator(":scope > p").first();
  await expect(firstParagraph).toHaveText(/First line\s*Second line/);
  assert.equal(await firstParagraph.locator("br").count(), enabled ? 1 : 0);
  const linePositions = await firstParagraph.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const positions = [];
    while (walker.nextNode()) {
      const text = walker.currentNode;
      for (const phrase of ["First line", "Second line"]) {
        const start = text.textContent.indexOf(phrase);
        if (start < 0) continue;
        const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + phrase.length);
        positions.push(range.getBoundingClientRect().top);
      }
    }
    return positions;
  });
  assert.equal(linePositions.length, 2);
  assert.equal(linePositions[1] > linePositions[0] + 1, enabled);
  await expect(article.locator(":scope > p").nth(1)).toHaveText("Next paragraph");
  await expect(article.locator("pre code")).toHaveText("code line one\ncode line two\n");
  assert.equal(await article.locator("pre br").count(), 0);
  assert.equal(await article.locator("ul > li").count(), 2);
  assert.equal(await article.locator("table tbody > tr").count(), 1);
}

async function checkConversation(enabled) {
  await navigate("Agent");
  const user = page.locator('.feed-source-message[data-message-role="user"] .feed-text-block');
  const assistant = page.locator('.feed-source-message[data-message-role="assistant"] .feed-text-block.markdown-body');
  await checkMarkdown(user, enabled);
  await checkMarkdown(assistant, enabled);
  const reasoning = page.locator(".thinking");
  await reasoning.waitFor();
  if (await reasoning.getAttribute("open") === null) await reasoning.locator("summary").click();
  await checkMarkdown(reasoning.locator(".markdown-body"), enabled);
}

async function checkFile(enabled) {
  await navigate("Files");
  await page.locator(`.file-row-shell[data-entry-path="${filename}"] .file-row`).click();
  await checkMarkdown(page.locator(".file-viewer > .markdown-body"), enabled);
}

async function setLineBreaks(enabled) {
  await openInterface();
  const response = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/api/ui"));
  await lineBreakSwitch().click();
  const saved = await response;
  assert.equal(saved.ok(), true);
  assert.equal((await saved.json()).markdownLineBreaks, enabled);
  await expect(lineBreakSwitch()).toHaveAttribute("aria-checked", String(enabled));
  assert.equal((await uiSettings()).markdownLineBreaks, enabled);
}

try {
  await page.goto(url);
  await page.getByLabel("Username").fill(process.env.PI_ARK_CHECK_USERNAME || "check");
  await page.getByLabel("Password").fill(process.env.PI_ARK_CHECK_PASSWORD || "check-password");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator(".session-list-item").filter({ hasText: "Markdown line-break fixture" }).locator(".session-open").click();
  assert.equal((await uiSettings()).markdownLineBreaks, true);
  await checkConversation(true);
  const originalSession = await readFile(sessionPath, "utf8");
  await checkFile(true);
  await openInterface();
  await expect(lineBreakSwitch()).toHaveAttribute("aria-checked", "true");
  await setLineBreaks(false);
  await checkConversation(false);
  await checkFile(false);
  await page.reload();
  await checkFile(false);
  await openInterface();
  await expect(lineBreakSwitch()).toHaveAttribute("aria-checked", "false");
  const themeResponse = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/api/ui"));
  await page.locator(".theme-options").getByRole("button", { name: "Paper", exact: true }).click();
  assert.equal((await themeResponse).ok(), true);
  assert.equal((await uiSettings()).markdownLineBreaks, false);
  await expect(lineBreakSwitch()).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: join(screenshots, "markdown-settings-desktop.png"), fullPage: true });
  await setLineBreaks(true);
  await checkConversation(true);
  await checkFile(true);
  assert.equal(await readFile(filePath, "utf8"), source);
  assert.equal(await readFile(sessionPath, "utf8"), originalSession);
  await openInterface();
  await page.setViewportSize({ width: 390, height: 844 });
  const closeSidebar = page.getByRole("button", { name: "Close sidebar", exact: true });
  if (await closeSidebar.isVisible()) await closeSidebar.click();
  await expect.poll(async () => page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
  await expect(lineBreakSwitch()).toBeVisible();
  await lineBreakSwitch().scrollIntoViewIfNeeded();
  const pageSize = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(pageSize.content <= pageSize.width);
  await page.screenshot({ path: join(screenshots, "markdown-settings-mobile.png"), fullPage: true });
  console.log("Markdown line-break UI checks passed");
} catch (error) {
  await page.screenshot({ path: join(screenshots, "markdown-check-failure.png"), fullPage: true });
  throw error;
} finally {
  await browser.close();
  await rm(filePath, { force: true });
  await rm(sessionPath, { force: true });
}
