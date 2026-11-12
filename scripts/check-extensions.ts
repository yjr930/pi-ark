import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const temporaryRoot = join(process.cwd(), ".tmp");
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(join(temporaryRoot, "pi-ark-extensions-"));
const arkHome = join(directory, "home");
const agentDir = join(arkHome, "pi-agent");
const extensionDir = join(agentDir, "extensions");
const workspace = { id: "extensions-check", name: "Extensions check", path: join(directory, "workspace") };
process.env.PI_ARK_HOME = arkHome;
process.env.PI_ARK_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

function extensionSource(tools: Array<{ name: string; defaultActive?: boolean; exposure?: string }>, command?: string): string {
  const registrations = tools.map((tool) => `  pi.registerTool({\n    name: ${JSON.stringify(tool.name)},\n    label: ${JSON.stringify(tool.name)},\n    description: "Tool registered by the extension check.",\n    parameters: Type.Object({}),\n${tool.defaultActive === false ? "    defaultActive: false,\n" : ""}${tool.exposure ? `    exposure: ${JSON.stringify(tool.exposure)},\n` : ""}    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },\n  });`).join("\n");
  const commandRegistration = command ? `\n  pi.registerCommand(${JSON.stringify(command)}, { description: "Command registered by the extension check.", handler: async () => {} });` : "";
  return `import { Type } from "typebox";\n\nexport default function (pi: any) {\n${registrations}${commandRegistration}\n}\n`;
}

try {
  const { scanExtensionEntries, extensionToolNames, ExtensionService, userExtensionDir } = await import("../apps/server/src/extensions.ts");

  assert.equal(userExtensionDir, extensionDir);
  await mkdir(workspace.path, { recursive: true });
  await Promise.all([
    mkdir(join(extensionDir, "folder"), { recursive: true }),
    mkdir(join(extensionDir, "package-extension"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(extensionDir, "single.ts"), extensionSource([{ name: "check_single" }])),
    writeFile(join(extensionDir, "folder", "index.ts"), extensionSource([{ name: "check_folder", defaultActive: false }, { name: "check_hidden", exposure: "codemode" }], "check-command")),
    writeFile(join(extensionDir, "broken.ts"), "export default function () { throw new Error(\"check failure\"); }\n"),
    writeFile(join(extensionDir, "package-extension", "package.json"), JSON.stringify({ name: "check-package", pi: { extensions: ["./main.ts"] } })),
    writeFile(join(extensionDir, "package-extension", "main.ts"), extensionSource([{ name: "check_package" }])),
    writeFile(join(extensionDir, "notes.md"), "not an extension\n"),
  ]);

  const entries = scanExtensionEntries();
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ["broken", "folder", "package-extension", "single"]);
  assert.equal(entries.find((entry) => entry.name === "folder")?.entries.length, 1);
  assert.equal(entries.find((entry) => entry.name === "package-extension")?.entries[0], join(extensionDir, "package-extension", "main.ts"));

  const loader = new DefaultResourceLoader({ cwd: workspace.path, agentDir });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0]?.error ?? "", /check failure/);

  const toolNames = extensionToolNames(loader);
  assert.ok(toolNames.includes("check_single"));
  assert.ok(toolNames.includes("check_package"));
  assert.equal(toolNames.includes("check_folder"), false);
  assert.equal(toolNames.includes("check_hidden"), false);

  const service = new ExtensionService({ list: () => [workspace] }, async () => loader);
  const response = await service.list(workspace);
  assert.equal(response.directory, extensionDir);
  assert.equal(response.extensions.length, 4);
  assert.equal(response.extensions.find((extension) => extension.name === "single")?.status, "loaded");
  assert.deepEqual(response.extensions.find((extension) => extension.name === "single")?.tools, [{ name: "check_single", active: true }]);
  const folder = response.extensions.find((extension) => extension.name === "folder");
  assert.equal(folder?.status, "loaded");
  assert.deepEqual(folder?.commands, [{ name: "check-command", description: "Command registered by the extension check." }]);
  assert.deepEqual(folder?.tools.find((tool) => tool.name === "check_folder"), { name: "check_folder", active: false });
  assert.deepEqual(folder?.tools.find((tool) => tool.name === "check_hidden"), { name: "check_hidden", active: false });
  const broken = response.extensions.find((extension) => extension.name === "broken");
  assert.equal(broken?.status, "failed");
  assert.match(broken?.diagnostics.join(" ") ?? "", /check failure/);

  const emptyService = new ExtensionService({ list: () => [] }, async () => loader);
  const empty = await emptyService.list();
  assert.deepEqual(empty.extensions, []);
  assert.match(empty.diagnostics[0]?.message ?? "", /Open a workspace/);

  console.log("extension checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
