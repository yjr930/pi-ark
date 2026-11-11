import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const base = resolve(import.meta.dirname, "../.tmp/ci-command-check");
await mkdir(base, { recursive: true });
const temporary = await mkdtemp(join(base, "fixture-"));
const wrapper = resolve(import.meta.dirname, "check-ci-command.mjs");
const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, PI_ARK_CI_COMMAND_TIMEOUT_MS: "30000" };
const run = (program, overrides = {}) => exec(process.execPath, [wrapper, "node", "--eval", program], { cwd: temporary, env: { ...env, ...overrides }, encoding: "utf8", timeout: 15000 });
try {
  const success = await run("console.log('fixture completed')");
  assert.match(success.stdout, /fixture completed/);
  assert.doesNotMatch(success.stdout, /::error/);
  await assert.rejects(run("console.error('fixture failure'); process.exitCode=7"), (error) => error.code === 7 && error.stdout.includes("Native CI command failed") && error.stdout.includes("fixture failure"));
  await assert.rejects(run("console.log('fixture pending'); setInterval(()=>{},1000)", { PI_ARK_CI_COMMAND_TIMEOUT_MS: "2000" }), (error) => error.code === 1 && error.stdout.includes("Native CI command failed") && error.stdout.includes("fixture pending") && error.stdout.includes("Command timed out after 2000 ms"));
  await assert.rejects(run("console.log('unreached')", { PI_ARK_CI_COMMAND_TIMEOUT_MS: "invalid" }), /must be a positive integer/);
  const logs = await readdir(join(temporary, "dist/native-ci"));
  assert.equal(logs.length, 3);
  const records = await Promise.all(logs.map((name) => readFile(join(temporary, "dist/native-ci", name), "utf8")));
  assert.ok(records.some((text) => text.includes("fixture pending") && text.includes("Command timed out after 2000 ms")));
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log("CI command diagnostics checks passed");
