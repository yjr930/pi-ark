import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const temporaryRoot = join(process.cwd(), ".tmp");
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(join(temporaryRoot, "pi-ark-mcp-"));
const arkHome = join(directory, "home");
const agentDir = join(arkHome, "pi-agent");
const workspace = { id: "mcp-check", name: "MCP check", path: join(directory, "workspace") };
process.env.PI_ARK_HOME = arkHome;
process.env.PI_ARK_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
  const { McpService } = await import("../apps/server/src/mcp.ts");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspace.path, { recursive: true });
  const service = new McpService();
  await service.ensureConfig();

  const configPath = join(agentDir, "mcp.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
  const playwrightConfig = config.mcpServers.playwright;
  assert.ok(playwrightConfig, "ensureConfig must write the default playwright entry");
  assert.equal(playwrightConfig.enabled, false);
  assert.equal(playwrightConfig.exposure, "codemode");
  assert.equal(playwrightConfig.command, "npx");
  assert.deepEqual(playwrightConfig.args, ["@playwright/mcp@0.0.85"]);

  const listed = await service.list(workspace);
  assert.deepEqual(listed.errors, []);
  const playwright = listed.servers.find((server) => server.name === "playwright");
  assert.ok(playwright, "list must return the default playwright server");
  assert.equal(playwright.source, "built-in");
  assert.equal(playwright.enabled, false);
  assert.equal(playwright.exposure, "codemode");
  assert.equal(playwright.state, "disabled");

  await service.setEnabled("playwright", true);
  const updated = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
  assert.equal(updated.mcpServers.playwright.enabled, true);
  assert.equal(updated.mcpServers.playwright.exposure, "codemode");

  const browser = await service.browserStatus();
  assert.equal(browser.directory, join(homedir(), ".cache", "ms-playwright"));
  assert.equal(["not-installed", "installing", "installed", "failed"].includes(browser.state), true);
  console.log("MCP checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
