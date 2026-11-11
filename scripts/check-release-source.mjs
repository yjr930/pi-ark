import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readBuildSource, verifyBuildSource } from "./release-source.mjs";

const exec = promisify(execFile);
const base = resolve(import.meta.dirname, "../.tmp/release-source-check");
await mkdir(base, { recursive: true });
const directory = await mkdtemp(join(base, "source with spaces-"));
const env = { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory };
const git = async (...args) => (await exec("git", args, { cwd: directory, env, encoding: "utf8" })).stdout.trim();
try {
  await assert.rejects(readBuildSource(directory), /committed Git checkout/);
  await git("init", "-b", "main");
  await git("config", "user.name", "Release source fixture");
  await git("config", "user.email", "release-source@example.invalid");
  await writeFile(join(directory, "package.json"), '{"version":"0.1.6-dev.1"}\n');
  await writeFile(join(directory, ".gitignore"), "ignored/\n");
  await git("add", ".");
  await git("commit", "-m", "Create release source fixture");
  const clean = await readBuildSource(directory);
  assert.equal(clean.sourceCommit, await git("rev-parse", "HEAD"));
  assert.equal(clean.sourceDirty, false);
  await mkdir(join(directory, "ignored"));
  await writeFile(join(directory, "ignored/build.log"), "fixture\n");
  assert.deepEqual(await readBuildSource(directory), clean);
  await writeFile(join(directory, "uncommitted.txt"), "uncommitted source\n");
  const untracked = await readBuildSource(directory);
  assert.equal(untracked.sourceDirty, true);
  assert.deepEqual(verifyBuildSource(clean, untracked, "0.1.6-dev.1"), untracked);
  assert.throws(() => verifyBuildSource(clean, untracked, "0.1.6"), /committed source/);
  await git("add", "uncommitted.txt");
  assert.equal((await readBuildSource(directory)).sourceDirty, true);
  await git("commit", "-m", "Commit release source fixture");
  const next = await readBuildSource(directory);
  assert.equal(next.sourceDirty, false);
  assert.throws(() => verifyBuildSource(clean, next, "0.1.6-dev.1"), /changed during the build/);
  assert.deepEqual(verifyBuildSource(next, next, "0.1.6"), next);
  await writeFile(join(directory, "package.json"), '{"version":"0.1.6-dev.2"}\n');
  assert.equal((await readBuildSource(directory)).sourceDirty, true);
  await mkdir(join(directory, "nested"));
  await assert.rejects(readBuildSource(join(directory, "nested")), /Git checkout directory/);
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log("Release source checks passed");
