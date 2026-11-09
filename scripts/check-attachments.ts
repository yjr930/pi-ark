import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAttachments } from "../apps/server/src/attachments.ts";

const workspacePath = await mkdtemp(join(tmpdir(), "pi-ark-attachments-"));
try {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const text = Buffer.from("attachment text").toString("base64");
  const saved = await saveAttachments({ id: "check", name: "Check", path: workspacePath }, "session-check", [
    { name: "pixel.png", mimeType: "image/png", data: png },
    { name: "notes.txt", mimeType: "text/plain", data: text },
  ]);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].image?.mimeType, "image/png");
  assert.equal(saved[1].image, undefined);
  assert.equal((await readFile(saved[1].path, "utf8")), "attachment text");
  assert.ok(saved.every((attachment) => attachment.path.startsWith(join(workspacePath, ".pi-ark", "attachments", "session-check"))));
  console.log("attachment checks passed");
} finally {
  await rm(workspacePath, { recursive: true, force: true });
}
