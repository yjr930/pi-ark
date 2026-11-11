import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// 运行：PI_ARK_CHECK_URL=https://127.0.0.1:31416/pi-ark/ PI_ARK_CHECK_WORKSPACE="$PWD/.tmp/file-links-workspace" node scripts/check-file-links-ui.mjs
// URL 应指向父进程启动的隔离服务，Workspace 应指向该服务已注册的临时目录。
// 可选环境变量：PI_ARK_CHECK_WORKSPACE_ID、PI_ARK_CHECK_USERNAME、PI_ARK_CHECK_PASSWORD、PI_ARK_CHECK_SCREENSHOT_DIR。
const url = process.env.PI_ARK_CHECK_URL;
const workspaceInput = process.env.PI_ARK_CHECK_WORKSPACE;
if (!url || !workspaceInput) throw new Error("Set PI_ARK_CHECK_URL and PI_ARK_CHECK_WORKSPACE for an isolated service");
const workspace = await realpath(resolve(workspaceInput));
const screenshots = resolve(process.env.PI_ARK_CHECK_SCREENSHOT_DIR || join(import.meta.dirname, "..", ".tmp", "screenshots", "file-links"));
const prefix = `pi-ark-file-links-${randomUUID()}`;
const fixtureDirectory = join(workspace, prefix);
const temporaryDirectory = join(import.meta.dirname, "..", ".tmp", "file-links-ui", prefix);
const sessions = [];
const sourceFiles = new Map();
const contexts = [];
const monitors = [];
const report = {};
let browser;
let authContext;
let page;
let apiBase;
let workspaceId;
let failure;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const gate = () => {
  let release;
  const promise = new Promise((done) => { release = done; });
  return { promise, release };
};

async function createFile(path, content) {
  const absolute = join(workspace, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, { flag: "wx" });
  sourceFiles.set(absolute, content);
}

function createSession(label, makeSource) {
  const manager = SessionManager.create(workspace, join(workspace, ".pi-ark", "sessions"));
  const fixture = { id: manager.getSessionId(), path: manager.getSessionFile(), source: "" };
  sessions.push(fixture);
  manager.appendSessionInfo(`${prefix} ${label}`);
  manager.appendMessage({ role: "user", content: `${label} fixture ready`, timestamp: Date.now() - 2000 });
  fixture.source = makeSource(fixture.id);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: fixture.source }], api: "openai-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() - 1000 });
  fixture.path = manager.getSessionFile();
  assert.ok(fixture.path);
  return fixture;
}

function targetUrl(target) {
  const targetUrl = new URL(url);
  targetUrl.search = "";
  targetUrl.hash = "";
  for (const [key, value] of Object.entries({ workspace: workspaceId, ...target })) targetUrl.searchParams.set(key, value);
  return targetUrl.toString();
}

const assistant = (target = page) => target.locator('.feed-source-message[data-message-role="assistant"]');
const article = (target = page) => assistant(target).locator(".feed-text-block.markdown-body");
const fileArticle = (target = page) => target.locator(".file-viewer > .markdown-body");
const enhanced = (container) => container.locator('a[data-pi-ark-file-link="true"]');
const navigate = (name, target = page) => target.locator(".sidebar-navigation").getByRole("button", { name, exact: true }).click();
const fileRow = (path) => page.locator(`.file-row-shell[data-entry-path=${JSON.stringify(path)}] .file-row`);

function assertFilesUrl(href, path, kind = "file", currentUrl = page.url()) {
  const actual = new URL(href, currentUrl);
  const expected = new URL(url);
  assert.equal(actual.origin, expected.origin);
  assert.equal(actual.pathname, new URL(currentUrl).pathname, "File links retain the public base path");
  assert.equal(actual.searchParams.get("page"), "files");
  assert.equal(actual.searchParams.get("workspace"), workspaceId);
  assert.equal(actual.searchParams.get("path"), path);
  assert.equal(actual.searchParams.get("kind"), kind);
}

async function expectFile(path, text, target = page) {
  await expect(target.locator(".viewer-title > div > span")).toHaveText(path);
  await expect(fileArticle(target)).toContainText(text);
  assertFilesUrl(target.url(), path, "file", target.url());
}

async function newCase(marker, hold = () => undefined) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, ignoreHTTPSErrors: true, permissions: ["clipboard-read", "clipboard-write"], storageState: await authContext.storageState() });
  contexts.push(context);
  // 浏览器记录首次原文提交与 fetch 的顺序，避免 Node 的轮询时机影响首显断言。
  await context.addInitScript((marker) => {
    window.__fileLinkCheck = { first: null, fetches: [] };
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || String(args[0]);
      if (/\/file-links\/resolve(?:\?|$)/.test(requestUrl)) window.__fileLinkCheck.fetches.push(performance.now());
      return Reflect.apply(originalFetch, this, args);
    };
    new MutationObserver(() => {
      if (window.__fileLinkCheck.first) return;
      const element = [...document.querySelectorAll('.feed-source-message[data-message-role="assistant"] .feed-text-block.markdown-body')].find((element) => element.textContent.includes(marker));
      if (element) window.__fileLinkCheck.first = { at: performance.now(), requests: window.__fileLinkCheck.fetches.length, links: element.querySelectorAll('a[data-pi-ark-file-link="true"]').length, text: element.textContent };
    }).observe(document, { childList: true, subtree: true });
  }, marker);
  const monitor = { requests: [], errors: [], active: 0, maxActive: 0, closed: false };
  monitors.push(monitor);
  await context.route("**/api/workspaces/*/file-links/resolve", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    const record = { ...body, workspaceId: decodeURIComponent(new URL(request.url()).pathname.split("/").at(-3)), startedAt: Date.now() };
    monitor.requests.push(record);
    monitor.active += 1;
    monitor.maxActive = Math.max(monitor.maxActive, monitor.active);
    let counted = true;
    try {
      assert.equal(request.method(), "POST");
      assert.ok(Array.isArray(body.paths) && body.paths.length > 0 && body.paths.length <= 64);
      assert.equal(new Set(body.paths).size, body.paths.length, "A resolve batch contains distinct paths");
      const response = await route.fetch();
      assert.ok(response.ok(), `Resolve returned ${response.status()}`);
      record.links = (await response.json()).links;
      await hold(record);
      monitor.active -= 1;
      counted = false;
      await route.fulfill({ response });
      record.completedAt = Date.now();
    } catch (error) {
      if (!monitor.closed) monitor.errors.push(String(error));
      await route.abort().catch(() => {});
    } finally {
      if (counted) monitor.active -= 1;
    }
  });
  page = await context.newPage();
  return { context, monitor };
}

function assertDistinctRequests(monitor) {
  const keys = monitor.requests.flatMap((request) => request.paths.map((input) => JSON.stringify([request.workspaceId, request.basePath || "", input])));
  assert.equal(new Set(keys).size, keys.length, "Repeated text shares one path confirmation within the fixture");
  assert.ok(monitor.maxActive <= 2, `Observed ${monitor.maxActive} concurrent resolve requests`);
  assert.deepEqual(monitor.errors, []);
}

async function assertFirstDisplay(marker, tail) {
  await expect(article()).toContainText(marker);
  await expect(article()).toContainText(tail);
  const first = await page.evaluate(() => window.__fileLinkCheck.first);
  assert.ok(first, "The browser observed the original source before enhancement");
  assert.equal(first.requests, 0, "Original source appears before any path API request");
  assert.equal(first.links, 0, "Original source appears before enhanced links");
  assert.ok(first.text.includes(tail), "The entire source is committed before path work");
  return first;
}

async function checkInputAndButton() {
  const composer = page.getByPlaceholder("Send message here", { exact: true });
  await composer.fill("Responsive composer 中文", { timeout: 8000 });
  await expect(composer).toHaveValue("Responsive composer 中文");
  const information = assistant().getByRole("button", { name: /^Show information for / });
  await information.click({ timeout: 8000 });
  await expect(assistant().getByRole("button", { name: /^Hide information for / })).toHaveAttribute("aria-expanded", "true");
  await assistant().getByRole("button", { name: /^Hide information for / }).click();
  await composer.fill("");
}

try {
  await mkdir(temporaryDirectory, { recursive: true });
  for (const variable of ["TMPDIR", "TMP", "TEMP"]) process.env[variable] = resolve(temporaryDirectory);
  await mkdir(screenshots, { recursive: true });
  await mkdir(fixtureDirectory, { recursive: false });
  await mkdir(join(workspace, ".pi-ark", "sessions"), { recursive: true });
  const baseSource = "# Base directory fixture\n\n[Local relative](relative.md)\n\n`relative.md`\n";
  await createFile(`${prefix}/root.md`, baseSource);
  await createFile(`${prefix}/relative.md`, "# Root relative preview\n");
  await createFile(`${prefix}/docs/second.md`, baseSource);
  await createFile(`${prefix}/docs/relative.md`, "# Docs relative preview\n\n[Second document](second.md)\n\n[Root document](../root.md)\n");
  await createFile(`${prefix}/docs/含 空格.md`, "# 中文空格 preview\n");
  await createFile(`${prefix}/code-only.md`, "# Code-only preview\n");
  await mkdir(join(fixtureDirectory, "empty-directory"));
  const coreMarker = `${prefix} core source`;
  const coreTail = "Core source complete";
  const longPaths = Array.from({ length: 160 }, (_, index) => `${prefix}/many/path-${String(index).padStart(3, "0")}.md`);
  for (const path of longPaths) await createFile(path, `# Long target ${path}\n`);
  const longMarker = `${prefix} long source`;
  const longTail = "Long source complete";
  const long = createSession("long", () => `# ${longMarker}\n\n${"Readable original content 中文输入 remains available. ".repeat(1000)}\n\n${longPaths.flatMap((path) => [path, path]).join(" ")}\n\n${longTail}\n`);

  browser = await chromium.launch({ headless: true });
  authContext = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await authContext.newPage();
  const loginUrl = new URL(url);
  loginUrl.search = "?page=settings";
  await page.goto(loginUrl.toString());
  await page.getByLabel("Username").fill(process.env.PI_ARK_CHECK_USERNAME || "check");
  await page.getByLabel("Password").fill(process.env.PI_ARK_CHECK_PASSWORD || "check-password");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".sidebar-navigation")).toBeVisible();
  apiBase = await page.evaluate(() => new URL("api/", document.baseURI).toString());
  const registryResponse = await authContext.request.get(new URL("workspaces", apiBase).toString());
  assert.ok(registryResponse.ok());
  const registry = (await registryResponse.json()).workspaces;
  const selected = registry.find((item) => process.env.PI_ARK_CHECK_WORKSPACE_ID ? item.id === process.env.PI_ARK_CHECK_WORKSPACE_ID : resolve(item.path) === workspace);
  assert.ok(selected, "The isolated Workspace is already registered in the check service");
  assert.equal(await realpath(selected.path), workspace, "Workspace ID points to the supplied isolated directory");
  workspaceId = selected.id;

  const fixture = createSession("core", (id) => `# ${coreMarker}\n\n[Standard root](${prefix}/root.md) · [Directory](${prefix}/docs/) · [Empty directory](${prefix}/empty-directory/)\n\nInline relative: \`${prefix}/docs/relative.md\`\n\nBare path: ${prefix}/root.md\n\nAbsolute path: ${join(fixtureDirectory, "docs", "relative.md")}\n\nSpace and Chinese: \`${prefix}/docs/含 空格.md\`\n\nMissing bare: ${prefix}/missing.md\n\n[Missing standard](${prefix}/missing.md) · [External](https://example.com/file.md) · [Internal session](pi-ark://workspace/${encodeURIComponent(workspaceId)}/session/${id})\n\n\`\`\`text\n${prefix}/code-only.md\n\`\`\`\n\n${coreTail}\n`);
  const responseGate = gate();
  const coreCase = await newCase(coreMarker, () => responseGate.promise);
  try {
    await page.goto(targetUrl({ page: "agent", session: fixture.id }));
    const first = await assertFirstDisplay(coreMarker, coreTail);
    await expect.poll(() => coreCase.monitor.requests.length, { timeout: 15000 }).toBeGreaterThan(0);
    const fetchTimes = await page.evaluate(() => window.__fileLinkCheck.fetches);
    assert.ok(fetchTimes[0] - first.at >= 1000, "Path work starts after the initial display delay");
    assert.equal(await enhanced(article()).count(), 0, "Held API responses do not block original content");
    const heldAt = Date.now();
    await checkInputAndButton();
    await sleep(Math.max(0, 2000 - (Date.now() - heldAt)));
    assert.equal(coreCase.monitor.requests.filter((record) => record.completedAt).length, 0);
    await page.screenshot({ path: join(screenshots, "file-links-original-held.png"), fullPage: true });
    responseGate.release();
    await expect(enhanced(article())).toHaveCount(7, { timeout: 20000 });
    await expect.poll(() => coreCase.monitor.requests.some((request) => request.paths.includes(`${prefix}/missing.md`)), { timeout: 15000 }).toBe(true);
    await expect.poll(() => coreCase.monitor.active, { timeout: 15000 }).toBe(0);
    assertDistinctRequests(coreCase.monitor);
    const inputs = coreCase.monitor.requests.flatMap((request) => request.paths);
    assert.ok(inputs.includes(`${prefix}/missing.md`));
    assert.ok(!inputs.includes(`${prefix}/code-only.md`), "Fenced code is excluded from path confirmation");
    assert.ok(!inputs.includes("https://example.com/file.md"), "External URLs retain their original interaction");
    assert.equal(await article().locator("pre a").count(), 0);
    assert.equal(await article().locator("p").filter({ hasText: "Missing bare:" }).locator("a").count(), 0);
    await expect(article().getByRole("link", { name: "Missing standard", exact: true })).not.toHaveAttribute("data-pi-ark-file-link", "true");
    const external = article().getByRole("link", { name: "External", exact: true });
    await expect(external).toHaveAttribute("href", "https://example.com/file.md");
    await expect(external).toHaveAttribute("target", "_blank");
    await expect(external).not.toHaveAttribute("data-pi-ark-file-link", "true");
    await expect(article().getByRole("link", { name: "Internal session", exact: true })).toHaveAttribute("data-pi-ark-link", /^pi-ark:\/\//);
    await expect(article().getByRole("link", { name: "Internal session", exact: true })).not.toHaveAttribute("data-pi-ark-file-link", "true");
    await assistant().getByRole("button", { name: "Copy Markdown", exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fixture.source, "Copy Markdown preserves the complete original source");
    const savedSession = await readFile(fixture.path, "utf8");
    await page.screenshot({ path: join(screenshots, "file-links-enhanced.png"), fullPage: true });
    report.core = { delayMs: Math.round(fetchTimes[0] - first.at), requests: coreCase.monitor.requests.length, paths: inputs.length, maxConcurrent: coreCase.monitor.maxActive };

    assertFilesUrl(await article().getByRole("link", { name: `${prefix}/docs/relative.md`, exact: true }).getAttribute("href"), `${prefix}/docs/relative.md`);
    assertFilesUrl(await article().getByRole("link", { name: join(fixtureDirectory, "docs", "relative.md"), exact: true }).getAttribute("href"), `${prefix}/docs/relative.md`);
    const bare = article().getByRole("link", { name: `${prefix}/root.md`, exact: true });
    assertFilesUrl(await bare.getAttribute("href"), `${prefix}/root.md`);
    await bare.click();
    await expectFile(`${prefix}/root.md`, "Base directory fixture");
    await page.reload();
    await expectFile(`${prefix}/root.md`, "Base directory fixture");
    await expect(fileArticle().getByRole("link", { name: "Local relative", exact: true })).toHaveAttribute("data-pi-ark-file-link", "true", { timeout: 15000 });
    assertFilesUrl(await fileArticle().getByRole("link", { name: "Local relative", exact: true }).getAttribute("href"), `${prefix}/relative.md`);
    await navigate("Agent");
    await expect(article().getByRole("link", { name: "Standard root", exact: true })).toHaveAttribute("data-pi-ark-file-link", "true", { timeout: 15000 });
    await article().getByRole("link", { name: "Standard root", exact: true }).click();
    await expectFile(`${prefix}/root.md`, "Base directory fixture");
    await navigate("Agent");
    const directory = article().getByRole("link", { name: "Directory", exact: true });
    await expect(directory).toHaveAttribute("data-pi-ark-file-link", "true", { timeout: 15000 });
    assertFilesUrl(await directory.getAttribute("href"), `${prefix}/docs`, "directory");
    await directory.click();
    assertFilesUrl(page.url(), `${prefix}/docs`, "directory");
    await expect(fileRow(`${prefix}/docs/relative.md`)).toBeVisible();
    await fileRow(`${prefix}/docs/relative.md`).click();
    await expectFile(`${prefix}/docs/relative.md`, "Docs relative preview");
    const second = fileArticle().getByRole("link", { name: "Second document", exact: true });
    await expect(second).toHaveAttribute("data-pi-ark-file-link", "true", { timeout: 15000 });
    assertFilesUrl(await second.getAttribute("href"), `${prefix}/docs/second.md`);
    await second.click();
    await expectFile(`${prefix}/docs/second.md`, "Base directory fixture");
    const local = fileArticle().getByRole("link", { name: "Local relative", exact: true });
    await expect(local).toHaveAttribute("data-pi-ark-file-link", "true", { timeout: 15000 });
    assertFilesUrl(await local.getAttribute("href"), `${prefix}/docs/relative.md`);
    await local.click();
    await expectFile(`${prefix}/docs/relative.md`, "Docs relative preview");
    await navigate("Agent");
    const space = article().getByRole("link", { name: `${prefix}/docs/含 空格.md`, exact: true });
    await expect(space).toHaveAttribute("data-pi-ark-file-link", "true", { timeout: 15000 });
    assertFilesUrl(await space.getAttribute("href"), `${prefix}/docs/含 空格.md`);
    const previousUrl = page.url();
    const newTab = coreCase.context.waitForEvent("page");
    await space.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    const popup = await newTab;
    await popup.waitForLoadState("domcontentloaded");
    await expectFile(`${prefix}/docs/含 空格.md`, "中文空格 preview", popup);
    assert.equal(page.url(), previousUrl, "Modifier-click preserves the source conversation");
    await popup.reload();
    await expectFile(`${prefix}/docs/含 空格.md`, "中文空格 preview", popup);
    await popup.close();
    await coreCase.context.route("https://example.com/file.md", (route) => route.fulfill({ contentType: "text/html", body: "<p>External file-link fixture</p>" }));
    const externalTab = coreCase.context.waitForEvent("page");
    await external.click();
    const externalPopup = await externalTab;
    await expect(externalPopup.locator("p")).toHaveText("External file-link fixture");
    assert.equal(externalPopup.url(), "https://example.com/file.md");
    assert.equal(page.url(), previousUrl);
    await externalPopup.close();
    await article().getByRole("link", { name: "Internal session", exact: true }).click();
    await expect(article()).toContainText(coreMarker);
    assert.equal(new URL(page.url()).searchParams.get("session"), fixture.id);
    assert.equal(await readFile(fixture.path, "utf8"), savedSession, "Path confirmation and navigation preserve the Session source");
    assert.deepEqual(coreCase.monitor.errors, []);
  } catch (error) {
    await page.screenshot({ path: join(screenshots, "file-links-core-failure.png") }).catch(() => {});
    throw error;
  } finally {
    responseGate.release();
    coreCase.monitor.closed = true;
    await coreCase.context.close();
  }

  const oldGate = gate();
  const currentGate = gate();
  const staleCase = await newCase(coreMarker, (record) => record.basePath === prefix ? oldGate.promise : record.basePath === `${prefix}/docs` ? currentGate.promise : undefined);
  try {
    await page.goto(targetUrl({ page: "files", path: `${prefix}/root.md`, kind: "file" }));
    await expectFile(`${prefix}/root.md`, "Base directory fixture");
    await expect.poll(() => staleCase.monitor.requests.filter((request) => request.basePath === prefix).length, { timeout: 15000 }).toBeGreaterThan(0);
    await navigate("Settings");
    await navigate("Files");
    await fileRow(`${prefix}/docs`).click();
    await fileRow(`${prefix}/docs/second.md`).click();
    await expectFile(`${prefix}/docs/second.md`, "Base directory fixture");
    await expect.poll(() => staleCase.monitor.requests.filter((request) => request.basePath === `${prefix}/docs`).length, { timeout: 15000 }).toBeGreaterThan(0);
    oldGate.release();
    await expect.poll(() => staleCase.monitor.requests.filter((request) => request.basePath === prefix && request.completedAt).length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    assert.equal(await enhanced(fileArticle()).count(), 0, "Old confirmations cannot enhance the identical source in a different base directory");
    currentGate.release();
    await expect(enhanced(fileArticle())).toHaveCount(2, { timeout: 15000 });
    for (const href of await enhanced(fileArticle()).evaluateAll((links) => links.map((link) => link.getAttribute("href")))) assertFilesUrl(href, `${prefix}/docs/relative.md`);
    await page.screenshot({ path: join(screenshots, "file-links-current-base.png"), fullPage: true });
    assert.deepEqual(staleCase.monitor.errors, []);
    report.staleResults = { oldBasePath: prefix, currentBasePath: `${prefix}/docs`, requests: staleCase.monitor.requests.length };
  } catch (error) {
    await page.screenshot({ path: join(screenshots, "file-links-stale-failure.png") }).catch(() => {});
    throw error;
  } finally {
    oldGate.release();
    currentGate.release();
    staleCase.monitor.closed = true;
    await staleCase.context.close();
  }

  const longGate = gate();
  const longCase = await newCase(longMarker, () => longGate.promise);
  try {
    await page.goto(targetUrl({ page: "agent", session: long.id }));
    const first = await assertFirstDisplay(longMarker, longTail);
    const inputStartedAt = Date.now();
    await checkInputAndButton();
    const inputInteractionMs = Date.now() - inputStartedAt;
    await expect.poll(() => longCase.monitor.requests.length, { timeout: 15000 }).toBeGreaterThan(0);
    assert.equal(longCase.monitor.requests.filter((request) => request.completedAt).length, 0);
    assert.equal(await enhanced(article()).count(), 0);
    await page.screenshot({ path: join(screenshots, "file-links-long-original.png") });
    longGate.release();
    await expect(enhanced(article())).toHaveCount(longPaths.length * 2, { timeout: 60000 });
    await expect.poll(() => longCase.monitor.active, { timeout: 15000 }).toBe(0);
    assertDistinctRequests(longCase.monitor);
    const requested = longCase.monitor.requests.flatMap((request) => request.paths);
    assert.deepEqual([...requested].sort(), [...longPaths].sort());
    assert.ok(longCase.monitor.requests.some((request) => request.paths.length > 1), "Long text uses batched confirmation");
    assert.ok(longCase.monitor.requests.length <= Math.ceil(longPaths.length / 16) + 2, "Resolve request count scales with batches rather than individual paths");
    const fetchTimes = await page.evaluate(() => window.__fileLinkCheck.fetches);
    assert.ok(fetchTimes[0] - first.at >= 1000);
    report.longText = { characters: long.source.length, distinctPaths: longPaths.length, requests: longCase.monitor.requests.length, maxBatch: Math.max(...longCase.monitor.requests.map((request) => request.paths.length)), maxConcurrent: longCase.monitor.maxActive, inputInteractionMs, delayMs: Math.round(fetchTimes[0] - first.at) };
  } catch (error) {
    await page.screenshot({ path: join(screenshots, "file-links-long-failure.png") }).catch(() => {});
    throw error;
  } finally {
    longGate.release();
    longCase.monitor.closed = true;
    await longCase.context.close();
  }

  for (const [path, source] of sourceFiles) assert.equal(await readFile(path, "utf8"), source, "UI checks preserve fixture file contents");
  await writeFile(join(screenshots, "file-links-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`File-link UI checks passed: ${JSON.stringify(report)}`);
} catch (error) {
  failure = error;
  await page?.screenshot({ path: join(screenshots, "file-links-failure.png") }).catch(() => {});
} finally {
  for (const monitor of monitors) monitor.closed = true;
  for (const context of contexts) await context.close().catch(() => {});
  for (const session of sessions) {
    if (apiBase && workspaceId && authContext) {
      const response = await authContext.request.delete(new URL(`workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(session.id)}`, apiBase).toString()).catch(() => undefined);
      if (!response?.ok()) {
        const message = `Fixture Session cleanup returned ${response?.status() || "a network error"}: ${session.id}`;
        console.error(message);
        failure ||= new Error(message);
      }
    }
    if (session.path) await rm(session.path, { force: true });
  }
  await browser?.close();
  await rm(fixtureDirectory, { recursive: true, force: true });
  await rm(temporaryDirectory, { recursive: true, force: true });
}
if (failure) throw failure;
