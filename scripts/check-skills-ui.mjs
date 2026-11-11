import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const url = process.env.PI_ARK_CHECK_URL;
if (!url) throw new Error("Set PI_ARK_CHECK_URL");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
try {
  await page.goto(url);
  await page.getByLabel("Username").fill(process.env.PI_ARK_CHECK_USERNAME || "check");
  await page.getByLabel("Password").fill(process.env.PI_ARK_CHECK_PASSWORD || "check-password");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator(".workspace-list-item").first().waitFor();
  await page.locator(".sidebar-navigation").getByRole("button", { name: "Settings", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Settings categories" });
  await nav.getByRole("button", { name: "Skills", exact: true }).click();
  await page.getByText("Built-in skills").waitFor();
  const checkbox = page.getByRole("checkbox", { name: /browser/ }).first();
  if (await checkbox.isChecked()) {
    await checkbox.click();
    await page.getByText("Skill selection saved").last().waitFor({ timeout: 30000 });
  }
  assert.equal(await checkbox.isChecked(), false);
  await checkbox.click();
  const dialog = page.getByRole("dialog", { name: "Enable playwright for browser?" });
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await checkbox.isChecked(), false);
  await checkbox.click();
  await dialog.getByRole("button", { name: "Enable both" }).click();
  await page.getByText("Skill selection saved").last().waitFor({ timeout: 120000 });
  assert.equal(await checkbox.isChecked(), true);
  assert.equal(await page.getByText("Requires playwright").count(), 0);
  console.log("browser dependency check passed");
} finally {
  await browser.close();
}
