import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-system-prompt-"));
const arkHome = join(directory, "home");
const agentDir = join(arkHome, "pi-agent");
const legacyAgentDir = join(directory, "development-agent");
const workspace = { id: "prompt-check", name: "Prompt check", path: join(directory, "workspace") };
const otherWorkspace = { id: "other", name: "Other", path: join(directory, "other") };
process.env.PI_ARK_HOME = arkHome;
process.env.PI_ARK_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = legacyAgentDir;

try {
  await Promise.all([mkdir(arkHome, { recursive: true }), mkdir(legacyAgentDir, { recursive: true }), mkdir(join(workspace.path, ".pi"), { recursive: true }), mkdir(otherWorkspace.path)]);
  await writeFile(join(legacyAgentDir, "auth.json"), JSON.stringify({ provider: "development-copy" }));
  await writeFile(join(legacyAgentDir, "settings.json"), JSON.stringify({ defaultProvider: "check", steeringMode: "one-at-a-time" }));
  await writeFile(join(arkHome, "config.json"), JSON.stringify({ tls: { keyPath: "/tmp/key", certPath: "/tmp/cert" }, auth: { username: "check", passwordHash: "check" }, workspaces: [workspace, otherWorkspace], ui: { theme: "ark-dark" }, preferences: { agent: { tools: ["read"], systemPrompt: { append: "" } } } }));
  await writeFile(join(workspace.path, ".pi", "settings.json"), JSON.stringify({ steeringMode: "all" }));
  await writeFile(join(workspace.path, ".pi", "SYSTEM.md"), "Project replacement");
  await writeFile(join(workspace.path, ".pi", "APPEND_SYSTEM.md"), "Project append");

  const config = await import("../apps/server/src/config.ts");
  const { AgentService } = await import("../apps/server/src/agents.ts");
  const { createGlobalSettingsManager } = await import("../apps/server/src/settings.ts");
  const { WorkspaceService } = await import("../apps/server/src/workspaces.ts");
  const { PiCoreService } = await import("../apps/server/src/pi-core.ts");
  await config.ensurePiArkAgentState(legacyAgentDir);
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")), { provider: "development-copy" });
  const coreInfo = await new PiCoreService().info(false);
  assert.equal(coreInfo.agentDir, agentDir);
  assert.equal(coreInfo.corePath.endsWith(join("@earendil-works", "pi-coding-agent")), true);
  assert.deepEqual(await config.loadUiSettings(), { theme: "ark-dark", hideReasoning: false, markdownLineBreaks: true });
  assert.deepEqual(await config.saveGlobalArkSettings({ theme: "ark-dark", hideReasoning: false }), { theme: "ark-dark", hideReasoning: false, markdownLineBreaks: true });
  for (const markdownLineBreaks of [false, true, false]) {
    const expected = { theme: "ark-dark" as const, hideReasoning: false, markdownLineBreaks };
    assert.deepEqual(await config.saveGlobalArkSettings(expected), expected);
    assert.deepEqual(await config.loadUiSettings(), expected);
    assert.deepEqual(JSON.parse(await readFile(config.configPath, "utf8")).ui, expected);
  }
  assert.deepEqual(await config.saveGlobalArkSettings({ theme: "ark-dark", hideReasoning: false }), { theme: "ark-dark", hideReasoning: false, markdownLineBreaks: false });
  assert.equal((await config.loadUiSettings()).markdownLineBreaks, false);
  for (const markdownLineBreaks of ["false", 0, null, {}]) {
    await assert.rejects(config.saveGlobalArkSettings({ theme: "ark-dark", hideReasoning: false, markdownLineBreaks: markdownLineBreaks as unknown as boolean }), { statusCode: 400 });
  }
  assert.equal((await config.loadUiSettings()).markdownLineBreaks, false);
  assert.equal(createGlobalSettingsManager(workspace.path).getSteeringMode(), "one-at-a-time");
  assert.equal(createGlobalSettingsManager(otherWorkspace.path).getSteeringMode(), "one-at-a-time");
  await config.ensureWorkspaceState(otherWorkspace);
  assert.deepEqual(await readdir(join(otherWorkspace.path, ".pi-ark")), ["sessions"]);
  const defaults = await config.loadGlobalPreferences();
  assert.deepEqual(defaults.agent, { systemPrompt: { append: "" } });
  assert.deepEqual(defaults.files, { showHiddenFiles: true, maxPreviewSizeMb: 10 });
  await config.saveGlobalArkSettings({ theme: "ark-dark", hideReasoning: false, markdownLineBreaks: true });
  await Promise.all([
    config.saveGlobalArkSettings({ theme: "paper", hideReasoning: false, markdownLineBreaks: false }),
    config.saveGlobalArkSettings({ theme: "graphite", hideReasoning: true }),
    config.saveWorkspaceDefinitions([{ ...workspace, name: "Queued workspace" }, otherWorkspace]),
    config.saveGlobalSystemPrompt({ append: "Shared instructions" }),
    config.saveGlobalPreferences({ files: { showHiddenFiles: false, maxPreviewSizeMb: 20 } }),
  ]);
  const saved = await config.loadConfig();
  assert.deepEqual(saved.ui, { theme: "graphite", hideReasoning: true, markdownLineBreaks: false });
  assert.deepEqual(saved.auth, { username: "check", passwordHash: "check" });
  assert.deepEqual(saved.tls, { keyPath: "/tmp/key", certPath: "/tmp/cert" });
  assert.deepEqual(JSON.parse(await readFile(config.configPath, "utf8")).ui, saved.ui);
  assert.equal(saved.workspaces[0].name, "Queued workspace");
  assert.deepEqual(saved.preferences, { agent: { systemPrompt: { append: "Shared instructions" } }, files: { showHiddenFiles: false, maxPreviewSizeMb: 20 }, terminal: { shell: "auto", executable: "", args: [], env: {} }, skills: { disabledBuiltin: [], disabledGlobal: [], disabledWorkspace: {} } });
  assert.deepEqual(JSON.parse(await readFile(config.configPath, "utf8")).preferences, saved.preferences);
  await Promise.all([
    config.saveGlobalPreferences({ files: { showHiddenFiles: true, maxPreviewSizeMb: 24 } }),
    config.saveGlobalSystemPrompt({ append: "Latest shared instructions" }),
  ]);
  assert.deepEqual(await config.loadGlobalPreferences(), { agent: { systemPrompt: { append: "Latest shared instructions" } }, files: { showHiddenFiles: true, maxPreviewSizeMb: 24 }, terminal: { shell: "auto", executable: "", args: [], env: {} }, skills: { disabledBuiltin: [], disabledGlobal: [], disabledWorkspace: {} } });
  await config.saveGlobalSystemPrompt({ append: "Shared instructions" });
  const legacyInput = { agent: { tools: [], systemPrompt: { append: "Stale client append" } }, files: { showHiddenFiles: false, maxPreviewSizeMb: 30 } };
  assert.deepEqual(await config.saveGlobalPreferences(legacyInput), { agent: { systemPrompt: { append: "Shared instructions" } }, files: legacyInput.files, terminal: { shell: "auto", executable: "", args: [], env: {} }, skills: { disabledBuiltin: [], disabledGlobal: [], disabledWorkspace: {} } });
  await assert.rejects(config.saveGlobalSystemPrompt({ append: "x".repeat(100001) }), /100000 characters/);
  const service = new AgentService({} as never, new WorkspaceService([workspace, otherWorkspace]));
  for (const tools of [["read"], [], ["obsolete-tool"]]) {
    const current = JSON.parse(await readFile(config.configPath, "utf8"));
    current.preferences.agent.tools = tools;
    await writeFile(config.configPath, JSON.stringify(current));
    assert.deepEqual((await config.loadGlobalPreferences()).agent, { systemPrompt: { append: "Shared instructions" } });
    for (const target of [workspace, otherWorkspace]) {
      const preview = await service.getGlobalSystemPrompt(target);
      for (const tool of ["read", "bash", "edit", "write", "read_pi_ark_link", "subagent"]) assert.match(preview.content, new RegExp(`\\b${tool}\\b`));
      assert.match(preview.content, /Shared instructions/);
    }
  }
  await writeFile(join(agentDir, "SYSTEM.md"), "Global replacement");
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "Global append");
  const internal = service as unknown as { createResourceLoader(workspace: typeof workspace, append: string): Promise<{ getSystemPrompt(): string | undefined; getAppendSystemPrompt(): string[] }> };
  for (const target of [workspace, otherWorkspace]) {
    const loader = await internal.createResourceLoader(target, saved.preferences.agent.systemPrompt.append);
    assert.equal(loader.getSystemPrompt(), "Global replacement");
    assert.deepEqual(loader.getAppendSystemPrompt(), ["Global append", "Shared instructions"]);
    const preview = await service.getGlobalSystemPrompt(target);
    assert.match(preview.content, /Shared instructions/);
    assert.equal(preview.content.includes("Project append"), false);
    assert.equal(preview.content.includes("Project replacement"), false);
  }
  await config.saveGlobalSystemPrompt({ append: "" });
  assert.deepEqual((await config.loadGlobalPreferences()).agent.systemPrompt, { append: "" });
  console.log("global configuration and system prompt checks passed");
} finally { await rm(directory, { recursive: true, force: true }); }
