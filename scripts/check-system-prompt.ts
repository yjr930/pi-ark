import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-system-prompt-"));
const arkHome = join(directory, "pi-ark-home");
const agentDir = join(arkHome, "pi-agent");
const legacyAgentDir = join(directory, "development-agent");
const workspace = { id: "prompt-check", name: "Prompt check", path: join(directory, "workspace") };
process.env.PI_ARK_HOME = arkHome;
process.env.PI_ARK_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = legacyAgentDir;

try {
  await Promise.all([mkdir(arkHome, { recursive: true }), mkdir(legacyAgentDir, { recursive: true }), mkdir(workspace.path, { recursive: true })]);
  await writeFile(join(legacyAgentDir, "auth.json"), JSON.stringify({ provider: "development-copy" }));
  await writeFile(join(legacyAgentDir, "settings.json"), JSON.stringify({ defaultProvider: "check" }));
  await writeFile(join(arkHome, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 1 }, tls: { keyPath: "/tmp/key", certPath: "/tmp/cert" }, auth: { username: "check", passwordHash: "check" }, workspaces: [workspace], ui: { theme: "ark-dark" } }));

  const config = await import("../apps/server/src/config.ts");
  const { AgentService } = await import("../apps/server/src/agents.ts");
  const { PiCoreService } = await import("../apps/server/src/pi-core.ts");
  await config.ensurePiArkAgentState(legacyAgentDir);
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")), { provider: "development-copy" });
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), { defaultProvider: "check" });
  const coreInfo = await new PiCoreService().info(false);
  assert.equal(coreInfo.agentDir, agentDir);
  assert.match(coreInfo.corePath, /@earendil-works\/pi-coding-agent$/);
  assert.match(coreInfo.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(await config.loadUiSettings(), { theme: "ark-dark", hideReasoning: false });
  await Promise.all([config.saveGlobalArkSettings({ theme: "graphite", hideReasoning: true }), config.saveWorkspaceDefinitions([{ ...workspace, name: "Queued workspace" }])]);
  const queuedGlobal = await config.loadConfig();
  assert.deepEqual(queuedGlobal.ui, { theme: "graphite", hideReasoning: true });
  assert.equal(queuedGlobal.workspaces[0].name, "Queued workspace");

  await writeFile(join(agentDir, "SYSTEM.md"), "Global replacement");
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "Global append");

  const defaults = await config.loadWorkspaceSettings(workspace);
  assert.equal(defaults.version, 5);
  assert.deepEqual(defaults.agent.systemPrompt, { append: "" });
  assert.deepEqual(defaults.files, { showHiddenFiles: true, maxPreviewSizeMb: 10 });

  await Promise.all([
    config.saveWorkspaceSystemPrompt(workspace, { append: "Workspace append" }),
    config.saveWorkspacePreferences(workspace, { agent: { tools: ["read"] }, files: { showHiddenFiles: false, maxPreviewSizeMb: 20 } }),
  ]);
  const queuedWorkspace = await config.loadWorkspaceSettings(workspace);
  assert.deepEqual(queuedWorkspace.agent.systemPrompt, { append: "Workspace append" });
  assert.deepEqual(queuedWorkspace.agent.tools, ["read"]);
  assert.deepEqual(queuedWorkspace.files, { showHiddenFiles: false, maxPreviewSizeMb: 20 });
  await config.saveWorkspaceSystemPrompt(workspace, { append: "" });
  assert.deepEqual((await config.loadWorkspaceSettings(workspace)).agent.systemPrompt, { append: "" });

  const service = new AgentService({} as never) as unknown as { createResourceLoader(workspace: typeof workspace, append: string): Promise<{ getSystemPrompt(): string | undefined; getAppendSystemPrompt(): string[] }> };
  const loader = await service.createResourceLoader(workspace, "Workspace append");
  assert.equal(loader.getSystemPrompt(), "Global replacement");
  assert.deepEqual(loader.getAppendSystemPrompt(), ["Global append", "Workspace append"]);
  const emptyLoader = await service.createResourceLoader(workspace, "");
  assert.deepEqual(emptyLoader.getAppendSystemPrompt(), ["Global append"]);
  console.log("system prompt checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
