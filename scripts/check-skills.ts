import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const temporaryRoot = join(process.cwd(), ".tmp");
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(join(temporaryRoot, "pi-ark-skills-"));
const arkHome = join(directory, "home");
const agentDir = join(arkHome, "pi-agent");
const workspace = { id: "skills-check", name: "Skills check", path: join(directory, "workspace") };
process.env.PI_ARK_HOME = arkHome;
process.env.PI_ARK_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

function skillFile(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse this skill for ${name}.\n`;
}

try {
  const { SkillService } = await import("../apps/server/src/skills.ts");
  const { createResourceLoader, builtinSkillDir, globalSkillDir, workspaceSkillDir } = await import("../apps/server/src/resource-loader.ts");
  const { createGlobalSettingsManager } = await import("../apps/server/src/settings.ts");
  const { loadSkillSelection } = await import("../apps/server/src/config.ts");

  const workspaceSkills = workspaceSkillDir(workspace);
  const globalConflictFile = join(globalSkillDir, "conflict-check", "SKILL.md");
  const workspaceConflictFile = join(workspaceSkills, "conflict-check", "SKILL.md");
  await mkdir(agentDir, { recursive: true });
  await Promise.all([
    mkdir(join(globalSkillDir, "global-check"), { recursive: true }),
    mkdir(join(globalSkillDir, "conflict-check"), { recursive: true }),
    mkdir(join(workspaceSkills, "workspace-check"), { recursive: true }),
    mkdir(join(workspaceSkills, "conflict-check"), { recursive: true }),
  ]);
  await writeFile(join(arkHome, "config.json"), JSON.stringify({ tls: { keyPath: join(directory, "key"), certPath: join(directory, "cert") }, auth: { username: "check", passwordHash: "check" }, workspaces: [workspace], preferences: {} }));
  await Promise.all([
    writeFile(join(globalSkillDir, "global-check", "SKILL.md"), skillFile("global-check", "Global skill used by the behavior check.")),
    writeFile(globalConflictFile, skillFile("conflict-check", "Global winner for the duplicate skill name check.")),
    writeFile(join(workspaceSkills, "workspace-check", "SKILL.md"), skillFile("workspace-check", "Workspace skill used by the behavior check.")),
    writeFile(workspaceConflictFile, skillFile("conflict-check", "Workspace duplicate that must be ignored.")),
  ]);

  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { playwright: { enabled: true } } }));
  const service = new SkillService({ list: () => [workspace] });
  const initial = await service.list(workspace);
  const builtinBrowser = initial.builtin.find((skill) => skill.name === "browser");
  assert.ok(builtinBrowser, "the built-in browser skill must be listed");
  assert.equal(builtinBrowser.scope, "builtin");
  assert.equal(builtinBrowser.source, "built-in");
  assert.equal(builtinBrowser.location, join(builtinSkillDir, "browser"));
  assert.equal(builtinBrowser.enabled, true);

  const globalSkill = initial.global.find((skill) => skill.name === "global-check");
  assert.ok(globalSkill, "the global skill must be listed");
  assert.equal(globalSkill.scope, "global");
  assert.equal(globalSkill.source, "managed");
  assert.equal(globalSkill.location, join(globalSkillDir, "global-check"));
  assert.equal(globalSkill.enabled, true);

  const workspaceSkill = initial.workspace.find((skill) => skill.name === "workspace-check");
  assert.ok(workspaceSkill, "the workspace skill must be listed");
  assert.equal(workspaceSkill.scope, "workspace");
  assert.equal(workspaceSkill.source, "managed");
  assert.equal(workspaceSkill.location, join(workspaceSkills, "workspace-check"));
  assert.equal(workspaceSkill.enabled, true);

  assert.equal(initial.global.some((skill) => skill.name === "conflict-check"), true);
  assert.equal(initial.workspace.some((skill) => skill.name === "conflict-check"), false);
  const conflictDiagnostic = initial.diagnostics.find((diagnostic) => diagnostic.message.includes('Skill name "conflict-check" is already defined'));
  assert.ok(conflictDiagnostic, "the duplicate skill name must produce a diagnostic");
  assert.equal(conflictDiagnostic.path, workspaceConflictFile);
  assert.match(conflictDiagnostic.message, new RegExp(globalConflictFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  async function renderSystemPrompt(): Promise<string> {
    const settingsManager = createGlobalSettingsManager(workspace.path);
    const resourceLoader = await createResourceLoader({ workspace, globalAppend: "", settingsManager });
    const { session } = await createAgentSession({ cwd: workspace.path, settingsManager, sessionManager: SessionManager.inMemory(), tools: ["read"], resourceLoader });
    try {
      return session.systemPrompt;
    } finally {
      session.dispose();
    }
  }

  const enabledPrompt = await renderSystemPrompt();
  for (const name of ["browser", "global-check", "workspace-check", "conflict-check"]) assert.match(enabledPrompt, new RegExp(`<name>${name}</name>`));

  const selection = {
    disabledBuiltin: [],
    disabledGlobal: ["global-check"],
    disabledWorkspace: { [workspace.id]: ["workspace-check"] },
  };
  const saved = await service.saveSelection(selection);
  assert.deepEqual(saved, { selection, reloaded: 0 });

  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { playwright: { enabled: false } } }));
  const disabled = await service.list(workspace);
  assert.equal(disabled.builtin.find((skill) => skill.name === "browser")?.enabled, false);
  assert.equal(disabled.global.find((skill) => skill.name === "global-check")?.enabled, false);
  assert.equal(disabled.workspace.find((skill) => skill.name === "workspace-check")?.enabled, false);
  assert.equal(disabled.global.find((skill) => skill.name === "conflict-check")?.enabled, true);

  const disabledPrompt = await renderSystemPrompt();
  for (const name of ["browser", "global-check", "workspace-check"]) assert.equal(disabledPrompt.includes(`<name>${name}</name>`), false);
  assert.match(disabledPrompt, /<name>conflict-check<\/name>/);

  const normalized = await service.saveSelection({
    disabledBuiltin: ["browser", "browser", "removed-builtin"],
    disabledGlobal: ["global-check", "removed-global", "global-check"],
    disabledWorkspace: { [workspace.id]: ["workspace-check", "removed-workspace", "workspace-check"] },
  });
  assert.deepEqual(normalized, { selection, reloaded: 0 });
  assert.deepEqual(await loadSkillSelection(), selection);
  console.log("skill checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
