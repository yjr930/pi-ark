import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceDefinition } from "./config.js";

type ImageContent = { type: "image"; data: string; mimeType: string };

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface IncomingAttachment { name: string; mimeType: string; data: string }
export interface SavedAttachment { name: string; mimeType: string; path: string; size: number; image?: ImageContent }

function cleanName(input: string): string {
  const name = basename(input || "attachment").replace(/[^a-zA-Z0-9._ -]+/g, "-").replace(/^\.+/, "").slice(0, 120);
  return name || "attachment";
}

export async function saveAttachments(workspace: WorkspaceDefinition, sessionId: string, incoming: IncomingAttachment[]): Promise<SavedAttachment[]> {
  if (incoming.length > MAX_ATTACHMENTS) throw Object.assign(new Error(`Attach no more than ${MAX_ATTACHMENTS} files at once`), { statusCode: 413 });
  const directory = join(workspace.path, ".pi-ark", "attachments", sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let total = 0;
  const saved: SavedAttachment[] = [];
  for (const attachment of incoming) {
    if (!attachment || typeof attachment.data !== "string" || typeof attachment.name !== "string" || typeof attachment.mimeType !== "string") throw Object.assign(new Error("Invalid attachment"), { statusCode: 400 });
    const buffer = Buffer.from(attachment.data, "base64");
    if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error("Each attachment must be between 1 byte and 10 MB"), { statusCode: 413 });
    total += buffer.length;
    if (total > MAX_TOTAL_BYTES) throw Object.assign(new Error("Attachments exceed the 20 MB message limit"), { statusCode: 413 });
    const name = cleanName(attachment.name);
    const path = join(directory, `${randomUUID()}-${name}`);
    await writeFile(path, buffer, { mode: 0o600 });
    saved.push({ name, mimeType: attachment.mimeType || "application/octet-stream", path, size: buffer.length, image: IMAGE_TYPES.has(attachment.mimeType) ? { type: "image", data: attachment.data, mimeType: attachment.mimeType } : undefined });
  }
  return saved;
}
