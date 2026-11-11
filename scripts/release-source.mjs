import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function readBuildSource(root, { execute = exec } = {}) {
  const git = async (...args) => (await execute("git", args, { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  try {
    const top = await git("rev-parse", "--show-toplevel");
    if (relative(await realpath(root), await realpath(top))) throw new Error("Build from the Pi-Ark Git checkout directory");
    const sourceCommit = await git("rev-parse", "--verify", "HEAD^{commit}");
    if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) throw new Error("HEAD must identify a committed source revision");
    const sourceDirty = Boolean(await git("status", "--porcelain=v1", "--untracked-files=normal"));
    return { sourceCommit, sourceDirty };
  } catch (error) {
    throw new Error(`Release builds require a committed Git checkout: ${error.message}`, { cause: error });
  }
}

export function verifyBuildSource(initial, current, version) {
  if (initial.sourceCommit !== current.sourceCommit) throw new Error("Source commit changed during the build; build again from the fixed release worktree");
  const source = { sourceCommit: initial.sourceCommit, sourceDirty: initial.sourceDirty || current.sourceDirty };
  if (/^\d+\.\d+\.\d+$/.test(version) && source.sourceDirty) throw new Error("Formal release builds require committed source; commit the changes and build from the fixed release worktree");
  return source;
}
