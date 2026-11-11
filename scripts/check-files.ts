import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, parse, relative } from "node:path";
import { mock } from "node:test";

const nativePlatform = process.platform;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const directory = await mkdtemp(join(tmpdir(), "pi-ark files 中文 "));
const arkHome = join(directory, "home");
const workspace = { id: "files-check", name: "Files check", path: join(directory, "workspace 中文") };
process.env.PI_ARK_HOME = arkHome;

try {
  await mkdir(join(workspace.path, ".pi-ark"), { recursive: true });
  await mkdir(arkHome, { recursive: true });
  await writeFile(join(arkHome, "config.json"), JSON.stringify({ tls: { keyPath: "/tmp/key", certPath: "/tmp/cert" }, auth: { username: "check", passwordHash: "check" }, workspaces: [workspace] }));
  await writeFile(join(workspace.path, ".pi-ark", "config.json"), JSON.stringify({ version: 4, workspaceId: workspace.id, agent: { tools: ["read"], systemPrompt: { append: "" } }, files: { showHiddenFiles: false } }));
  await writeFile(join(workspace.path, "note.md"), "# Preview\n");
  await writeFile(join(workspace.path, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await writeFile(join(workspace.path, "large.bin"), Buffer.alloc(2048, 1));
  await writeFile(join(workspace.path, "binary.dat"), Buffer.from([1, 0, 2]));

  const config = await import("../apps/server/src/config.ts");
  const { WorkspaceService } = await import("../apps/server/src/workspaces.ts");
  const defaults = await config.loadGlobalPreferences();
  assert.deepEqual(defaults.files, { showHiddenFiles: true, maxPreviewSizeMb: 10 });
  const saved = await config.saveGlobalPreferences({ files: { showHiddenFiles: true, maxPreviewSizeMb: 24 } });
  assert.equal(saved.files.maxPreviewSizeMb, 24);
  assert.equal(JSON.parse(await readFile(join(workspace.path, ".pi-ark", "config.json"), "utf8")).version, 4);
  await assert.rejects(() => config.saveGlobalPreferences({ files: { showHiddenFiles: true, maxPreviewSizeMb: 0 } }), /1 to 100 MB/);

  const service = new WorkspaceService([workspace]);
  const text = await service.readFilePreview(workspace, "note.md", 1024);
  assert.equal(text.kind, "text");
  if (text.kind === "text") assert.equal(text.markdown, true);
  const image = await service.readFilePreview(workspace, "pixel.png", 1024);
  assert.deepEqual(image, { kind: "image", name: "pixel.png", path: "pixel.png", size: 68, mimeType: "image/png" });
  const imageDownload = await service.readImage(workspace, "pixel.png", 1024);
  assert.equal(imageDownload.mimeType, "image/png");
  for await (const _chunk of imageDownload.content) { /* Consume and close the file descriptor. */ }
  await assert.rejects(() => service.readFilePreview(workspace, "large.bin", 1024), (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 413);
  await assert.rejects(() => service.readFilePreview(workspace, "binary.dat", 1024), (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 415);
  const download = await service.downloadFile(workspace, "large.bin");
  assert.equal(download.size, 2048);
  assert.equal(download.name, "large.bin");
  for await (const _chunk of download.content) { /* Consume and close the file descriptor. */ }

  const outside = join(directory, "workspace 中文 outside");
  const documents = join(workspace.path, "文档 with spaces");
  await mkdir(outside);
  await mkdir(documents);
  await writeFile(join(outside, "secret.md"), "outside secret");
  await writeFile(join(documents, "note.md"), "inside document");
  const linkType = nativePlatform === "win32" ? "junction" : "dir";
  await symlink(documents, join(workspace.path, "internal-link"), linkType);
  await symlink(outside, join(workspace.path, "external-link"), linkType);
  await symlink(join(workspace.path, ".pi-ark"), join(workspace.path, "state-link"), linkType);
  const forbidden = (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 403;

  async function checkPaths() {
    const nested = await service.readFilePreview(workspace, "文档 with spaces/note.md", 1024);
    assert.equal(nested.path, "文档 with spaces/note.md");
    assert.ok(nested.kind === "text" && nested.content === "inside document");
    const linked = await service.readFilePreview(workspace, "internal-link/note.md", 1024);
    assert.ok(linked.kind === "text" && linked.content === "inside document");
    for (const requested of [relative(workspace.path, join(outside, "secret.md")), join(outside, "secret.md"), "external-link/secret.md", ".pi-ark/config.json", "state-link/config.json"]) {
      await assert.rejects(() => service.readFilePreview(workspace, requested, 1024), forbidden);
    }
    await assert.rejects(() => service.readFilePreview(workspace, "文档 with spaces", 1024), (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 400);
    const volumeWorkspace = { ...workspace, path: parse(workspace.path).root };
    assert.equal(await service.safePath(volumeWorkspace, join(workspace.path, "note.md")), await fs.realpath(join(workspace.path, "note.md")));
    assert.ok((await service.listDirectory(workspace)).every((entry) => entry.name !== ".pi-ark"));
    if (process.platform === "win32" || process.platform === "darwin") await assert.rejects(() => service.safePath(workspace, ".PI-ARK/config.json"), forbidden);
  }

  async function checkReplacedParent(restoreBeforeCheck: boolean) {
    const parent = join(workspace.path, "changing-parent");
    const parked = join(workspace.path, "parked-parent");
    await mkdir(parent);
    await writeFile(join(parent, "secret.md"), "inside original");
    const originalOpen = fs.open;
    let intercepted = false;
    const replacement = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] !== join(parent, "secret.md")) return originalOpen(...args);
      intercepted = true;
      await rename(parent, parked);
      await symlink(outside, parent, linkType);
      const handle = await originalOpen(...args);
      if (restoreBeforeCheck) {
        await rm(parent, { recursive: true, force: true });
        await rename(parked, parent);
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => service.readFilePreview(workspace, "changing-parent/secret.md", 1024), forbidden);
      assert.equal(intercepted, true);
    } finally {
      replacement.mock.restore();
      syncBuiltinESMExports();
      await rm(parent, { recursive: true, force: true });
      await rm(parked, { recursive: true, force: true });
    }
  }

  await checkPaths();
  await checkReplacedParent(false);
  await checkReplacedParent(true);
  if (nativePlatform === "linux") {
    // Exercise the procfs-free branches with real files and directory substitutions.
    for (const platform of ["darwin", "win32"]) {
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
      await checkPaths();
      await checkReplacedParent(false);
      await checkReplacedParent(true);
    }
    Object.defineProperty(process, "platform", platformDescriptor);
  }
  console.log("file checks passed");
} finally {
  Object.defineProperty(process, "platform", platformDescriptor);
  await rm(directory, { recursive: true, force: true });
}
