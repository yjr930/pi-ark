import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-workspace-order-"));
const arkHome = join(directory, "home");
process.env.PI_ARK_HOME = arkHome;
process.env.PI_ARK_AGENT_DIR = join(arkHome, "pi-agent");
const alpha = { id: "alpha", name: "Alpha", path: join(directory, "alpha") };
const beta = { id: "beta", name: "Beta", path: join(directory, "beta") };
const gamma = { id: "gamma", name: "Gamma", path: join(directory, "gamma") };

try {
  await Promise.all([mkdir(arkHome), mkdir(alpha.path), mkdir(beta.path), mkdir(gamma.path)]);
  await writeFile(join(arkHome, "config.json"), JSON.stringify({ tls: { keyPath: "/tmp/key", certPath: "/tmp/cert" }, auth: { username: "check", passwordHash: "check" }, workspaces: [alpha, beta, gamma] }));

  const { WorkspaceService } = await import("../apps/server/src/workspaces.ts");
  const config = await import("../apps/server/src/config.ts");
  const workspaces = new WorkspaceService([alpha, beta, gamma]);
  const ids = () => workspaces.list().map((workspace) => workspace.id);

  assert.deepEqual(ids(), ["alpha", "beta", "gamma"]);
  assert.deepEqual(workspaces.move("beta", "up").map((workspace) => workspace.id), ["beta", "alpha", "gamma"]);
  assert.deepEqual(ids(), ["beta", "alpha", "gamma"]);
  assert.deepEqual(workspaces.move("beta", "up").map((workspace) => workspace.id), ["beta", "alpha", "gamma"]);
  assert.deepEqual(workspaces.move("gamma", "down").map((workspace) => workspace.id), ["beta", "alpha", "gamma"]);
  assert.deepEqual(workspaces.move("alpha", "down").map((workspace) => workspace.id), ["beta", "gamma", "alpha"]);
  assert.deepEqual(workspaces.move("beta", "down").map((workspace) => workspace.id), ["gamma", "beta", "alpha"]);
  assert.throws(() => workspaces.move("missing", "up"), { statusCode: 404 });

  await config.saveWorkspaceDefinitions(workspaces.list());
  assert.deepEqual((await config.loadConfig()).workspaces.map((workspace) => workspace.id), ["gamma", "beta", "alpha"]);
  assert.deepEqual(JSON.parse(await readFile(config.configPath, "utf8")).workspaces.map((workspace) => workspace.id), ["gamma", "beta", "alpha"]);

  const previous = workspaces.list();
  workspaces.replaceOrder([previous[2], previous[0], previous[1]]);
  assert.deepEqual(ids(), ["alpha", "gamma", "beta"]);
  workspaces.replaceOrder(previous);
  assert.deepEqual(ids(), ["gamma", "beta", "alpha"]);
  assert.equal(workspaces.get("beta").name, "Beta");
  assert.throws(() => new WorkspaceService([]).move("unknown", "down"), { statusCode: 404 });

  console.log("Workspace order checks passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
