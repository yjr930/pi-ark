import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

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
  const { McpService, encodingForCodePage, playwrightBrowsersDirectory, processLaunchPlan } = await import("../apps/server/src/mcp.ts");
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
  assert.deepEqual(playwrightConfig.args, ["@playwright/mcp@0.0.85", "--browser=chromium", "--headless", "--caps=config,network,storage,devtools,vision"]);

  const exaConfig = config.mcpServers.exa;
  assert.ok(exaConfig, "ensureConfig must write the default exa entry");
  assert.equal(exaConfig.url, "https://mcp.exa.ai/mcp");
  assert.equal(exaConfig.enabled, true);
  assert.equal(exaConfig.exposure, "codemode");
  assert.match(String(exaConfig.description), /objective/);

  const configured = await service.listConfigured();
  const exaEntry = configured.find((server) => server.name === "exa");
  assert.ok(exaEntry, "listConfigured must return the default exa server");
  assert.equal(exaEntry.source, "built-in");
  assert.equal(exaEntry.enabled, true);
  await service.setEnabled("exa", false);

  const listed = await service.list(workspace);
  assert.deepEqual(listed.errors, []);
  const playwright = listed.servers.find((server) => server.name === "playwright");
  assert.ok(playwright, "list must return the default playwright server");
  assert.equal(playwright.source, "built-in");
  assert.equal(playwright.enabled, false);
  assert.equal(playwright.exposure, "codemode");
  assert.equal(playwright.state, "disabled");
  assert.equal(playwright.advanced, true);

  await service.setEnabled("playwright", true);
  const updated = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
  assert.equal(updated.mcpServers.playwright.enabled, true);
  assert.equal(updated.mcpServers.playwright.exposure, "codemode");

  await service.setAdvanced("playwright", false);
  const basic = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
  assert.deepEqual(basic.mcpServers.playwright.args, ["@playwright/mcp@0.0.85", "--browser=chromium", "--headless"]);
  const basicListed = await service.list(workspace);
  assert.equal(basicListed.servers.find((server) => server.name === "playwright")?.advanced, false);
  await service.setAdvanced("playwright", true);
  const advanced = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
  assert.deepEqual(advanced.mcpServers.playwright.args, ["@playwright/mcp@0.0.85", "--browser=chromium", "--headless", "--caps=config,network,storage,devtools,vision"]);

  const legacy = { mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@0.0.85"], enabled: false } } };
  await (await import("node:fs/promises")).writeFile(configPath, JSON.stringify(legacy));
  const migrated = new McpService();
  await migrated.ensureConfig();
  const migratedConfig = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
  assert.deepEqual(migratedConfig.mcpServers.playwright.args, ["@playwright/mcp@0.0.85", "--browser=chromium", "--headless"]);
  assert.ok(migratedConfig.mcpServers.exa, "ensureConfig must add the exa entry to an existing config");

  assert.equal(playwrightBrowsersDirectory({ platform: "linux", home: "/home/ark", env: {} }), posix.join("/home/ark", ".cache", "ms-playwright"));
  assert.equal(playwrightBrowsersDirectory({ platform: "linux", home: "/home/ark", env: { XDG_CACHE_HOME: "/var/cache/ark" } }), posix.join("/var/cache/ark", "ms-playwright"));
  assert.equal(playwrightBrowsersDirectory({ platform: "darwin", home: "/Users/ark", env: {} }), posix.join("/Users/ark", "Library", "Caches", "ms-playwright"));
  assert.equal(playwrightBrowsersDirectory({ platform: "win32", home: "C:\\Users\\ark", env: { LOCALAPPDATA: "C:\\Users\\ark\\AppData\\Local" } }), win32.join("C:\\Users\\ark\\AppData\\Local", "ms-playwright"));
  assert.equal(playwrightBrowsersDirectory({ platform: "linux", home: "/home/ark", env: { PLAYWRIGHT_BROWSERS_PATH: "/srv/browsers" } }), resolve("/srv/browsers"));

  const expectedBrowserDirectory = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0"
    ? resolve(process.env.PLAYWRIGHT_BROWSERS_PATH)
    : process.platform === "win32"
      ? win32.join(process.env.LOCALAPPDATA || win32.join(homedir(), "AppData", "Local"), "ms-playwright")
      : process.platform === "darwin"
        ? posix.join(homedir(), "Library", "Caches", "ms-playwright")
        : posix.join(process.env.XDG_CACHE_HOME || posix.join(homedir(), ".cache"), "ms-playwright");
  assert.deepEqual(processLaunchPlan("C:\\Program Files\\nodejs\\node.exe", ["cli.js", "mcp", "list"], "win32"), { command: "C:\\Program Files\\nodejs\\node.exe", args: ["cli.js", "mcp", "list"], shell: false });
  assert.equal(processLaunchPlan("npx.cmd", ["@playwright/mcp", "--headless"], "win32").shell, true);
  assert.equal(processLaunchPlan("C:\\Program Files\\Git\\bin\\bash.EXE", [], "win32").shell, false);
  assert.equal(processLaunchPlan("/usr/bin/node", [], "linux").shell, false);
  assert.equal(processLaunchPlan(process.execPath, [], process.platform).shell, process.platform === "win32" && !/\.(exe|com)$/i.test(process.execPath));
  assert.equal(encodingForCodePage(65001), "utf-8");
  assert.equal(encodingForCodePage(936), "gbk");
  assert.equal(encodingForCodePage(1252), undefined);

  const browser = await service.browserStatus();
  assert.equal(browser.directory, expectedBrowserDirectory);
  assert.equal(["not-installed", "installing", "installed", "failed"].includes(browser.state), true);
  console.log("MCP checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
