import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const url = process.env.PI_ARK_CHECK_URL;
if (!url) throw new Error("Set PI_ARK_CHECK_URL for an isolated service");
const screenshots = process.env.PI_ARK_CHECK_SCREENSHOT_DIR || join(import.meta.dirname, "..", ".tmp", "screenshots", "typography");
await mkdir(screenshots, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
const navigation = () => page.getByRole("navigation", { name: "Settings categories" });
const slider = () => page.getByLabel("Text scale");
const levelRows = () => page.locator(".text-size-level");
const appearance = () => page.evaluate(() => JSON.parse(localStorage.getItem("pi-ark-appearance") || "null"));
const computedSize = (selector) => page.locator(selector).first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
async function expectSize(selector, expected) {
  const actual = await computedSize(selector);
  assert.ok(Math.abs(actual - expected) < 0.02, `${selector}: expected ${expected}px, received ${actual}px`);
}

async function openAppearance() {
  await page.locator(".sidebar-navigation").getByRole("button", { name: "Settings", exact: true }).click();
  await navigation().getByRole("button", { name: "Appearance", exact: true }).click();
  await slider().waitFor();
}

async function setScale(percent) {
  await slider().fill(String(percent));
  await page.waitForFunction((value) => document.documentElement.style.getPropertyValue("--fs-scale") === value, String(percent / 100));
}

try {
  await page.goto(url);
  await page.getByLabel("Username").fill(process.env.PI_ARK_CHECK_USERNAME || "check");
  await page.getByLabel("Password").fill(process.env.PI_ARK_CHECK_PASSWORD || "check-password");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await openAppearance();

  assert.deepEqual(await levelRows().locator("> strong").allTextContents(), ["Micro", "Caption", "Dense", "Interface", "Reading", "Section title", "Page title"]);
  assert.deepEqual(await levelRows().locator("> small").allTextContents(), ["9 px", "10 px", "11 px", "13 px", "14 px", "20 px", "26 px"]);
  assert.equal(await slider().inputValue(), "100");
  assert.equal(await page.locator(".text-size-value").textContent(), "100%");
  await expectSize(".settings-section-title h3", 14);
  await expectSize(".settings-row strong", 13);
  await expectSize(".settings-field small", 10);
  await expectSize(".text-size-level > small", 10);

  await setScale(115);
  assert.equal(await page.locator(".text-size-value").textContent(), "115%");
  assert.deepEqual(await levelRows().locator("> small").allTextContents(), ["10.35 px", "11.5 px", "12.65 px", "14.95 px", "16.1 px", "23 px", "29.9 px"]);
  await expectSize(".settings-section-title h3", 16.1);
  await expectSize(".settings-row strong", 14.95);
  await expectSize(".settings-field small", 11.5);
  assert.deepEqual(await appearance(), { theme: "ark-dark", hideReasoning: false, markdownLineBreaks: true, fontScale: 1.15, showWorkingCount: true });
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--fs-scale")), "1.15");

  await page.reload();
  await openAppearance();
  assert.equal(await slider().inputValue(), "115");
  await expectSize(".settings-section-title h3", 16.1);
  await page.screenshot({ path: join(screenshots, "appearance-115.png"), fullPage: true });

  await setScale(90);
  await expectSize(".settings-section-title h3", 12.6);
  await expectSize(".settings-field small", 9);
  await setScale(130);
  await expectSize(".settings-section-title h3", 18.2);
  assert.equal(await page.locator(".settings-tabs button span").first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)), 16.9);
  await page.screenshot({ path: join(screenshots, "appearance-130.png"), fullPage: true });

  await setScale(115);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  assert.equal(await slider().inputValue(), "100");
  await expectSize(".settings-section-title h3", 14);
  assert.equal(await page.getByRole("button", { name: "Reset", exact: true }).isDisabled(), true);

  const otherContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
  const otherPage = await otherContext.newPage();
  await setScale(120);
  await otherPage.goto(url);
  await otherPage.getByLabel("Username").fill(process.env.PI_ARK_CHECK_USERNAME || "check");
  await otherPage.getByLabel("Password").fill(process.env.PI_ARK_CHECK_PASSWORD || "check-password");
  await otherPage.getByRole("button", { name: "Continue", exact: true }).click();
  await otherPage.locator(".sidebar-navigation").getByRole("button", { name: "Settings", exact: true }).click();
  await otherPage.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(otherPage.getByLabel("Text scale")).toHaveValue("100");
  assert.equal(await otherPage.locator(".settings-section-title h3").first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)), 14);
  await otherContext.close();

  await page.setViewportSize({ width: 390, height: 844 });
  const closeSidebar = page.getByRole("button", { name: "Close sidebar", exact: true });
  if (await closeSidebar.isVisible()) await closeSidebar.click();
  await expect.poll(async () => page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
  assert.equal(await levelRows().first().locator("> span:not(.text-size-sample)").isVisible(), false);
  const overflow = await page.locator(".settings-page").evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth);
  assert.equal(overflow, true);
  await page.screenshot({ path: join(screenshots, "appearance-mobile.png"), fullPage: true });
} finally {
  await context.close();
  await browser.close();
}

console.log("Typography scale, persistence, per-browser isolation, and mobile layout check passed.");
