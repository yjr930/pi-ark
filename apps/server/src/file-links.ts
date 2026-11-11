import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkspaceService } from "./workspaces.js";

type FileLink = { input: string; path: string; type: "file" | "directory" };

function invalidInput(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function isNetworkOrUri(path: string): boolean {
  if (path.startsWith("//") || path.startsWith("\\\\")) return true;
  if (/^[a-z]:/i.test(path)) return process.platform !== "win32";
  return /^[a-z][a-z\d+.-]*:/i.test(path);
}

export async function resolveFileLinks(workspaces: WorkspaceService, workspaceId: string, input: unknown): Promise<{ links: Array<{ input: string; path: string; type: "file" | "directory" }> }> {
  const workspace = workspaces.get(workspaceId);
  if (!input || typeof input !== "object" || Array.isArray(input)) invalidInput("File link input must be an object");
  const { paths, basePath = "" } = input as Record<string, unknown>;
  if (!Array.isArray(paths) || paths.length > 64 || paths.some((path) => typeof path !== "string" || path.length > 2048 || path.includes("\0"))) invalidInput("paths must contain at most 64 strings of at most 2048 characters");
  if (typeof basePath !== "string" || basePath.length > 2048 || basePath.includes("\0") || isAbsolute(basePath) || isNetworkOrUri(basePath) || /^[a-z]:/i.test(basePath)) invalidInput("basePath must be a Workspace-relative directory path of at most 2048 characters");

  let workspaceDirectory: string;
  let baseDirectory: string;
  try {
    baseDirectory = await workspaces.safePath(workspace, basePath);
    if (!(await lstat(baseDirectory)).isDirectory()) invalidInput("basePath must point to a directory");
    workspaceDirectory = basePath === "" ? baseDirectory : await workspaces.safePath(workspace);
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw Object.assign(new Error("basePath does not exist or is not accessible"), { statusCode: code === "EACCES" || code === "EPERM" ? 403 : 400 });
  }

  // Preserve the supplied spelling until safePath checks private path segments.
  const candidates = [...new Set<string>(paths)];
  const results: Array<FileLink | undefined> = new Array(candidates.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < candidates.length) {
      const index = cursor++;
      const requested = candidates[index]!;
      if (!requested || isNetworkOrUri(requested)) continue;
      try {
        const driveRelative = process.platform === "win32" && /^[a-z]:/i.test(requested) && !isAbsolute(requested);
        const requestedPath = isAbsolute(requested) ? requested : driveRelative ? `${resolve(baseDirectory, requested.slice(0, 2))}${sep}${requested.slice(2)}` : `${baseDirectory}${sep}${requested}`;
        const candidate = await workspaces.safePath(workspace, requestedPath);
        const stat = await lstat(candidate);
        const type = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined;
        if (type) results[index] = { input: requested, path: relative(workspaceDirectory, candidate).split(sep).join("/"), type };
      } catch {
        // Unavailable targets remain ordinary message text.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => worker()));
  return { links: results.filter((link): link is FileLink => link !== undefined) };
}
