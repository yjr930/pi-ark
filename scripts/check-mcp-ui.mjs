import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const url = process.env.PI_ARK_CHECK_URL;
if (!url) throw new Error("Set PI_ARK_CHECK_URL for an isolated Pi-Ark service");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
const page = await context.newPage();
let enabled = false;
let advanced = true;
let polls = 0;
const advancedWrites = [];
const server = (tools) => ({ name: "playwright", source: "built-in", advanced, enabled, exposure: "codemode", transport: "npx @playwright/mcp@0.0.85", state: !enabled ? "disabled" : polls >= 2 ? "connected" : "starting", tools, diagnostics: [] });
await page.route("**/api/mcp**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/api/mcp/browser") return route.fulfill({ json: { state: "installed", version: "Chromium 158", directory: "/root/.cache/ms-playwright" } });
  if (path.endsWith("/advanced")) { advancedWrites.push(route.request().postDataJSON()); advanced = route.request().postDataJSON()?.enabled === true; polls = 0; return route.fulfill({ json: { ok: true } }); }
  if (path.endsWith("/state")) { enabled = route.request().postDataJSON()?.enabled === true; polls = 0; return route.fulfill({ json: { ok: true } }); }
  if (path === "/api/mcp") {
    if (!enabled) return route.fulfill({ json: { servers: [server([])], errors: [] } });
    polls += 1;
    return route.fulfill({ json: { servers: [server(polls >= 2 ? ["browser_click", "browser_snapshot"] : [])], errors: [] } });
  }
  return route.continue();
});
try {
  await page.goto(url);
  await page.getByLabel("Username").fill(process.env.PI_ARK_CHECK_USERNAME || "check");
  await page.getByLabel("Password").fill(process.env.PI_ARK_CHECK_PASSWORD || "check-password");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator(".workspace-list-item").first().waitFor();
  await page.locator(".sidebar-navigation").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "MCP", exact: true }).click();
  await page.getByText("Registered actions").waitFor();
  const advancedToggle = page.getByRole("switch", { name: "Disable advanced capabilities" });
  assert.equal(await advancedToggle.getAttribute("aria-checked"), "true");
  await advancedToggle.click();
  await page.getByText(/advanced capabilities disabled/).waitFor();
  assert.deepEqual(advancedWrites.at(-1), { enabled: false });
  await page.getByRole("switch", { name: "Enable playwright" }).click();
  await page.getByText(/connected with 2 tools/).waitFor({ timeout: 30000 });
  await page.getByRole("switch", { name: "Disable playwright" }).click();
  await page.getByText(/playwright disabled/).waitFor({ timeout: 30000 });
  console.log("MCP UI checks passed");
} finally {
  await browser.close();
}
