import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const url = process.env.PI_ARK_CHECK_URL;
if (!url) throw new Error("Set PI_ARK_CHECK_URL for an isolated Pi-Ark service");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
let playwrightEnabled = false;
const skills = () => ({
  builtin: [{ name: "browser", description: "Browser automation.", scope: "builtin", source: "built-in", location: "/opt/pi-ark/skills/browser", enabled: playwrightEnabled, explicitOnly: false }],
  global: [],
  workspace: [],
  diagnostics: [],
});
await page.route("**/api/skills**", async (route) => route.fulfill({ json: skills() }));
await page.route("**/api/mcp**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path !== "/api/mcp") return route.fulfill({ json: { state: "installed", version: "Chromium 158", directory: "/root/.cache/ms-playwright" } });
  return route.fulfill({ json: { servers: [{ name: "playwright", source: "built-in", advanced: true, enabled: playwrightEnabled, exposure: "codemode", transport: "npx @playwright/mcp@0.0.85", state: playwrightEnabled ? "connected" : "disabled", tools: [], diagnostics: [] }], errors: [] } });
});
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
  const browserRow = page.locator(".agent-resource-row").filter({ hasText: "browser" }).first();
  await browserRow.waitFor();
  assert.equal(await browserRow.locator('input[type="checkbox"]').count(), 0);
  assert.equal(await browserRow.getByText("Disabled", { exact: true }).count(), 1);
  assert.equal(await browserRow.getByText("Enable playwright in MCP to use this skill.").count(), 1);
  assert.equal(await page.getByText("Requires playwright").count(), 0);
  playwrightEnabled = true;
  await page.locator(".agent-resource-overview").getByRole("button", { name: "Refresh" }).click();
  await browserRow.getByText("Enabled", { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await browserRow.getByText("Enable playwright in MCP to use this skill.").count(), 0);
  assert.equal(await browserRow.locator('input[type="checkbox"]').count(), 0);
  console.log("skills browser linkage check passed");
} finally {
  await browser.close();
}
