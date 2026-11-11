import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, parse, relative, resolve } from "node:path";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveFileLinks } from "../apps/server/src/file-links.ts";
import { WorkspaceService } from "../apps/server/src/workspaces.ts";

const temporaryRoot = fileURLToPath(new URL("../.tmp/", import.meta.url));
await mkdir(temporaryRoot, { recursive: true });
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temporaryRoot;
const directory = await fs.realpath(await mkdtemp(join(temporaryRoot, "file-links 中文 ")));
const workspace = { id: "file-links-check", name: "File links check", path: join(directory, "workspace 中文") };
const service = new WorkspaceService([workspace]);
const status = (expected: number) => (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === expected;
const resolveLinks = (paths: string[], basePath?: string) => resolveFileLinks(service, workspace.id, { paths, ...(basePath === undefined ? {} : { basePath }) });

try {
  await mkdir(join(workspace.path, "文档 with spaces"), { recursive: true });
  await mkdir(join(workspace.path, ".pi-ark"));
  const outside = join(directory, "workspace 中文 outside");
  await mkdir(outside);
  await writeFile(join(workspace.path, "note.md"), "# Note");
  await writeFile(join(workspace.path, "文档 with spaces", "说明 file.md"), "# 文档");
  await writeFile(join(workspace.path, "literal%20name.md"), "literal percent");
  await writeFile(join(workspace.path, "literal#L2.md"), "literal hash");
  await writeFile(join(workspace.path, ".pi-ark", "private.md"), "private state fixture");
  await writeFile(join(outside, "secret.md"), "outside fixture");

  const expected = { links: [
    { input: "note.md", path: "note.md", type: "file" },
    { input: "文档 with spaces/说明 file.md", path: "文档 with spaces/说明 file.md", type: "file" },
    { input: "文档 with spaces", path: "文档 with spaces", type: "directory" },
    { input: ".", path: "", type: "directory" },
  ] };
  const initial = ["note.md", "文档 with spaces/说明 file.md", "文档 with spaces", "."];
  assert.deepEqual(await resolveLinks(initial), expected);
  assert.deepEqual(await resolveLinks(initial), expected);
  assert.deepEqual(await resolveLinks(["说明 file.md", "../note.md"], "文档 with spaces"), { links: [
    { input: "说明 file.md", path: "文档 with spaces/说明 file.md", type: "file" },
    { input: "../note.md", path: "note.md", type: "file" },
  ] });
  const absolute = join(workspace.path, "note.md");
  assert.deepEqual(await resolveLinks([absolute], "文档 with spaces"), { links: [{ input: absolute, path: "note.md", type: "file" }] });
  assert.deepEqual(await resolveLinks(["literal%20name.md", "literal name.md", "literal#L2.md"]), { links: [
    { input: "literal%20name.md", path: "literal%20name.md", type: "file" },
    { input: "literal#L2.md", path: "literal#L2.md", type: "file" },
  ] });
  assert.deepEqual(await resolveLinks([]), { links: [] });
  assert.deepEqual(await resolveLinks(["new.md"]), { links: [] });
  await writeFile(join(workspace.path, "new.md"), "new file fixture");
  assert.deepEqual(await resolveLinks(["new.md"]), { links: [{ input: "new.md", path: "new.md", type: "file" }] });
  await rm(join(workspace.path, "new.md"));
  assert.deepEqual(await resolveLinks(["new.md"]), { links: [] });
  assert.deepEqual(await resolveLinks(["", "missing.md", "说明 file.md", "missing/note.md", ".pi-ark/private.md", ".pi-ark/../note.md", ".pi-ark\\private.md", "../workspace 中文 outside/secret.md", join(outside, "secret.md"), "https://example.com/note.md", "file:///note.md", "mailto:note.md", "pi-ark://workspace/other", "//server/share/note.md", "\\\\server\\share\\note.md"]), { links: [] });
  if (process.platform !== "win32") {
    await writeFile(join(workspace.path, "C:\\note.md"), "foreign drive path");
    assert.deepEqual(await resolveLinks(["C:\\note.md", "C:note.md", "C:/note.md"]), { links: [] });
  } else {
    const driveRelative = `${parse(workspace.path).root.slice(0, 2)}note.md`;
    assert.deepEqual(await resolveLinks([driveRelative]), { links: [{ input: driveRelative, path: "note.md", type: "file" }] });
    assert.deepEqual(await resolveLinks(["文档 with spaces\\说明 file.md"]), { links: [{ input: "文档 with spaces\\说明 file.md", path: "文档 with spaces/说明 file.md", type: "file" }] });
  }

  for (const input of [undefined, null, true, [], "note.md", {}, { paths: "note.md" }, { paths: [null] }, { paths: [123] }, { paths: ["note.md", false] }, { paths: Array(65).fill("note.md") }, { paths: ["a".repeat(2049)] }, { paths: ["bad\0path"] }, { paths: [], basePath: null }, { paths: [], basePath: 1 }, { paths: [], basePath: "a".repeat(2049) }, { paths: [], basePath: "bad\0path" }, { paths: [], basePath: absolute }, { paths: [], basePath: "https://example.com" }, { paths: [], basePath: "C:docs" }]) {
    await assert.rejects(() => resolveFileLinks(service, workspace.id, input), status(400));
  }
  await assert.rejects(() => resolveFileLinks(service, "unknown-workspace", { paths: [] }), status(404));
  for (const basePath of ["note.md", "missing"]) await assert.rejects(() => resolveLinks(["note.md"], basePath), status(400));
  for (const basePath of [".pi-ark", ".pi-ark/..", relative(workspace.path, outside)]) await assert.rejects(() => resolveLinks(["note.md"], basePath), status(403));
  if (process.platform === "win32" || process.platform === "darwin") {
    assert.deepEqual(await resolveLinks([".PI-ARK/private.md"]), { links: [] });
    await assert.rejects(() => resolveLinks([], ".PI-ARK"), status(403));
  }
  // Length boundaries are validated before path availability is considered.
  assert.deepEqual(await resolveLinks(["a".repeat(2048)]), { links: [] });
  const maximumBatch = Array.from({ length: 64 }, (_, index) => `${"./".repeat(index)}note.md`);
  assert.equal((await resolveLinks(maximumBatch)).links.length, 64);
  assert.deepEqual(await resolveLinks(Array(64).fill("note.md")), { links: [{ input: "note.md", path: "note.md", type: "file" }] });

  let symlinksAvailable = true;
  try {
    const type = process.platform === "win32" ? "junction" : "dir";
    await symlink(join(workspace.path, "文档 with spaces"), join(workspace.path, "internal-link"), type);
    await symlink(outside, join(workspace.path, "external-link"), type);
    await symlink(join(workspace.path, ".pi-ark"), join(workspace.path, "state-link"), type);
    await symlink(workspace.path, join(directory, "workspace-alias"), type);
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    symlinksAvailable = false;
    console.log("Skipping Windows symlink fixtures: permission unavailable");
  }
  if (symlinksAvailable) {
    assert.deepEqual(await resolveLinks(["internal-link", "internal-link/说明 file.md", "external-link/secret.md", "state-link/private.md"]), { links: [
      { input: "internal-link", path: "文档 with spaces", type: "directory" },
      { input: "internal-link/说明 file.md", path: "文档 with spaces/说明 file.md", type: "file" },
    ] });
    assert.deepEqual(await resolveLinks(["说明 file.md"], "internal-link"), { links: [{ input: "说明 file.md", path: "文档 with spaces/说明 file.md", type: "file" }] });
    for (const basePath of ["external-link", "state-link"]) await assert.rejects(() => resolveLinks(["note.md"], basePath), status(403));
    const aliasedWorkspace = { ...workspace, path: join(directory, "workspace-alias") };
    assert.deepEqual(await resolveFileLinks(new WorkspaceService([aliasedWorkspace]), workspace.id, { paths: ["note.md"] }), { links: [{ input: "note.md", path: "note.md", type: "file" }] });
  }
  const resolved = await resolveLinks(initial);
  for (const link of resolved.links) {
    const candidate = await service.safePath(workspace, link.input);
    assert.equal(resolve(workspace.path, link.path), candidate);
    if (link.type === "directory") assert.ok(Array.isArray(await service.listDirectory(workspace, link.path)));
    else assert.equal((await service.readFilePreview(workspace, link.path, 1024)).path, link.path);
  }

  const originalRealpath = fs.realpath;
  const originalLstat = fs.lstat;
  let active = 0;
  let peak = 0;
  async function track<T>(task: () => Promise<T>): Promise<T> {
    active++;
    peak = Math.max(peak, active);
    try { await setImmediate(); return await task(); }
    finally { active--; }
  }
  const realpathMock = mock.method(fs, "realpath", (...args: Parameters<typeof fs.realpath>) => track(() => originalRealpath(...args)));
  const lstatMock = mock.method(fs, "lstat", (...args: Parameters<typeof fs.lstat>) => track(() => originalLstat(...args)));
  const reads = ["readFile", "readdir", "open"] as const;
  const readMocks = reads.map((name) => mock.method(fs, name, () => { throw new Error(`Unexpected content read or directory scan: ${name}`); }));
  const originalSafePath = service.safePath.bind(service);
  let targetCalls = 0;
  const safePathMock = mock.method(service, "safePath", async (...args: Parameters<WorkspaceService["safePath"]>) => {
    if (args[1]?.endsWith("note.md")) targetCalls++;
    return originalSafePath(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await resolveLinks(maximumBatch)).links.length, 64);
    assert.equal(peak, 4);
    assert.equal(active, 0);
    assert.equal(targetCalls, 64);
    targetCalls = 0;
    assert.equal((await resolveLinks(Array(64).fill("note.md"))).links.length, 1);
    assert.equal(targetCalls, 1);
    assert.ok(readMocks.every((entry) => entry.mock.callCount() === 0));
  } finally {
    safePathMock.mock.restore();
    realpathMock.mock.restore();
    lstatMock.mock.restore();
    for (const entry of readMocks) entry.mock.restore();
    syncBuiltinESMExports();
  }

  const deniedDirectory = join(workspace.path, "文档 with spaces");
  const deniedRealpath = mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
    if (args[0] === deniedDirectory) throw Object.assign(new Error("Access denied"), { code: "EACCES" });
    return originalRealpath(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await resolveLinks(["文档 with spaces", "文档 with spaces/说明 file.md"]), { links: [{ input: "文档 with spaces/说明 file.md", path: "文档 with spaces/说明 file.md", type: "file" }] });
    await assert.rejects(() => resolveLinks(["note.md"], "文档 with spaces"), status(403));
  } finally { deniedRealpath.mock.restore(); syncBuiltinESMExports(); }
  const deniedLstat = mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === absolute) throw Object.assign(new Error("Access denied"), { code: "EPERM" });
    const stat = await originalLstat(...args);
    if (args[0] === join(workspace.path, "literal%20name.md")) return Object.assign(stat, { isFile: () => false, isDirectory: () => false });
    return stat;
  });
  syncBuiltinESMExports();
  try { assert.deepEqual(await resolveLinks(["note.md", "literal%20name.md"]), { links: [] }); }
  finally { deniedLstat.mock.restore(); syncBuiltinESMExports(); }

  console.log("file-link checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
