import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-files-check-"));
const arkHome = join(directory, "home");
const workspace = { id: "files-check", name: "Files check", path: join(directory, "workspace") };
process.env.PI_ARK_HOME = arkHome;

try {
  await mkdir(join(workspace.path, ".pi-ark"), { recursive: true });
  await mkdir(arkHome, { recursive: true });
  await writeFile(join(workspace.path, ".pi-ark", "config.json"), JSON.stringify({ version: 4, workspaceId: workspace.id, agent: { tools: ["read"], systemPrompt: { append: "" } }, files: { showHiddenFiles: false } }));
  await writeFile(join(workspace.path, "note.md"), "# Preview\n");
  await writeFile(join(workspace.path, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await writeFile(join(workspace.path, "large.bin"), Buffer.alloc(2048, 1));
  await writeFile(join(workspace.path, "binary.dat"), Buffer.from([1, 0, 2]));

  const config = await import("../apps/server/src/config.ts");
  const { WorkspaceService } = await import("../apps/server/src/workspaces.ts");
  const defaults = await config.loadWorkspaceSettings(workspace);
  assert.equal(defaults.version, 5);
  assert.deepEqual(defaults.files, { showHiddenFiles: false, maxPreviewSizeMb: 10 });
  const saved = await config.saveWorkspaceSettings(workspace, { agent: defaults.agent, files: { showHiddenFiles: true, maxPreviewSizeMb: 24 } });
  assert.equal(saved.version, 5);
  assert.equal(saved.files.maxPreviewSizeMb, 24);
  assert.equal(JSON.parse(await readFile(join(workspace.path, ".pi-ark", "config.json"), "utf8")).version, 5);
  await assert.rejects(() => config.saveWorkspaceSettings(workspace, { agent: defaults.agent, files: { showHiddenFiles: true, maxPreviewSizeMb: 0 } }), /1 to 100 MB/);

  const service = new WorkspaceService([workspace]);
  const text = await service.readFilePreview(workspace, "note.md", 1024);
  assert.equal(text.kind, "text");
  if (text.kind === "text") assert.equal(text.markdown, true);
  const image = await service.readFilePreview(workspace, "pixel.png", 1024);
  assert.deepEqual(image, { kind: "image", name: "pixel.png", path: "pixel.png", size: 68, mimeType: "image/png" });
  assert.equal((await service.readImage(workspace, "pixel.png", 1024)).mimeType, "image/png");
  await assert.rejects(() => service.readFilePreview(workspace, "large.bin", 1024), (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 413);
  await assert.rejects(() => service.readFilePreview(workspace, "binary.dat", 1024), (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 415);
  const download = await service.downloadFile(workspace, "large.bin");
  assert.equal(download.size, 2048);
  assert.equal(download.name, "large.bin");
  console.log("file checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
