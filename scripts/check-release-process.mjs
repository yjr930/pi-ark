import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createReleaseProcess, main, parseArgs, readRunningSource, verifyPublishedRelease } from "./release-process.mjs";
import * as candidateHelper from "./release-candidate.mjs";

const exec = promisify(execFile);
const project = resolve(import.meta.dirname, "..");
const base = join(project, ".tmp/release-process-check");
await mkdir(base, { recursive: true });
const temporary = await mkdtemp(join(base, "fixture-"));
const repo = join(temporary, "repository with spaces");
const remote = join(temporary, "origin.git");
const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, GIT_CONFIG_NOSYSTEM: "1" };
for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT)$/.test(key)) delete env[key];
const git = async (...args) => (await exec("git", args, { cwd: repo, env, encoding: "utf8" })).stdout.trimEnd();
const files = ["package.json", "package-lock.json", "apps/server/package.json", "apps/web/package.json"];
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const output = [];
let mode = "success";
let selectedVersion = "0.1.6";
let selectedCommit;
let sleeps = 0;
let candidateCalls = 0;
let publishedRelease;
let omitRuns = false;
function completeRelease() {
  return { tag_name: `v${selectedVersion}`, draft: false, prerelease: false, html_url: `https://github.com/fixture/repository/releases/tag/v${selectedVersion}`, published_at: "2026-01-01T00:00:00Z", assets: candidateHelper.RELEASE_ARTIFACT_NAMES.map((name) => ({ name: `${name.replace("pi-ark-", `pi-ark-${selectedVersion}-`)}.${name.includes("win32") ? "zip" : "tar.gz"}`, size: 1024 })) };
}
const annotations = [{ title: "Native CI command failed", annotation_level: "failure", message: "npm ci\nError: native fixture compiler failed\nExit: 1" }];
const artifacts = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"].map((name, i) => ({ id: i + 1, name: `pi-ark-${name}` }));
const apiCalls = [];
async function fixtureGithubJson(url) {
  apiCalls.push(url);
  const path = new URL(url).pathname;
  if (path.endsWith("/actions/workflows/release.yml/runs")) return { workflow_runs: mode === "missing" || omitRuns ? [] : [{ id: mode === "formal" ? 102 : 101, event: "push", head_sha: selectedCommit, head_branch: mode === "formal" ? `v${selectedVersion}` : `release/${selectedVersion}`, status: mode === "queued" ? "in_progress" : "completed", conclusion: mode === "queued" ? null : mode === "failed" ? "failure" : "success", html_url: "https://github.com/fixture/repository/actions/runs/101" }] };
  if (/\/actions\/runs\/\d+\/jobs$/.test(path)) return { jobs: [{ id: 201, name: "build (linux-x64)", status: mode === "queued" ? "in_progress" : "completed", conclusion: mode === "failed" ? "failure" : "success", check_run_url: "https://api.github.com/repos/fixture/repository/check-runs/201", steps: [{ name: "npm ci", status: "completed", conclusion: mode === "failed" ? "failure" : "success" }] }] };
  if (path.endsWith("/check-runs/201")) return { output: { title: "Native CI command failed" } };
  if (path.endsWith("/check-runs/201/annotations")) return annotations;
  if (path.includes("/releases/tags/")) {
    if (publishedRelease) return structuredClone(publishedRelease);
    const error = new Error("GitHub HTTP 404"); error.status = 404; throw error;
  }
  throw new Error(`Unexpected fixture API: ${url}`);
}
const helper = {
  githubJson: fixtureGithubJson,
  async findVerifiedCandidate({ repository, commit, version, token }) {
    candidateCalls += 1;
    assert.equal(repository, "fixture/repository");
    assert.equal(token, "fixture-token");
    assert.equal(commit, selectedCommit);
    assert.equal(version, selectedVersion);
    if (mode === "unverified") throw new Error("Candidate is not verified");
    return { runId: 101, url: "https://github.com/fixture/repository/actions/runs/101", commit, version, artifacts: mode === "artifacts-missing" ? artifacts.slice(1) : artifacts };
  },
};
function processFor(extra = {}) {
  return createReleaseProcess({ repo, repository: "fixture/repository", env: { ...env, GH_TOKEN: "fixture-token" }, helper, log: (value) => output.push(value), execute: async (file, args, options) => {
    assert.ok(options.env.TMPDIR.startsWith(join(repo, ".tmp/release-process")));
    assert.equal(options.env.TMP, options.env.TMPDIR);
    assert.equal(options.env.TEMP, options.env.TMPDIR);
    if (file === "git" && args[0] === "push") assert.ok(args.every((arg) => !arg.startsWith("--force") && !arg.startsWith("+")));
    return exec(file, args, options);
  }, sleep: async () => { sleeps += 1; mode = "success"; }, ...extra });
}
async function select(version) {
  selectedVersion = version;
  const state = await readJson(join(repo, ".tmp/release-process", version, "state.json"));
  selectedCommit = state.releaseCommit;
  return state;
}
async function snapshotMain() {
  return { branch: await git("branch", "--show-current"), commit: await git("rev-parse", "HEAD"), status: await git("status", "--porcelain"), cached: await git("diff", "--cached"), unstaged: await git("diff"), packages: await Promise.all(files.map((file) => readFile(join(repo, file), "utf8"))) };
}

try {
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.equal(parseArgs(["prepare", "--version", "0.1.6"]).interval, globalThis.process.env.GH_TOKEN || globalThis.process.env.GITHUB_TOKEN ? 30 : 180);
  assert.equal(parseArgs(["prepare", "--version", "0.1.5", "--source", "confirmed-fix", "--refresh"]).refresh, true);
  for (const args of [["prepare", "--version", "0.1.5", "--refresh"], ["status", "--version", "0.1.5", "--refresh"], ["publish", "--version", "0.1.5", "--refresh"]]) assert.throws(() => parseArgs(args), /--refresh/);
  for (const args of [["prepare"], ["prepare", "--version", "v0.1.6"], ["prepare", "--version", "01.1.6"], ["prepare", "--version", "0.1.6-dev.1"], ["status", "--version", "0.1.6", "--interval", "0"], ["prepare", "--version", "0.1.6", "--source", "main", "--from-instance", "dev"], ["status", "--version", "0.1.6", "--source", "main"], ["publish", "--version", "0.1.6", "--watch", "--watch"]]) assert.throws(() => parseArgs(args));
  const helpOutput = [];
  await main(["status", "--help"], { log: (text) => helpOutput.push(text) });
  assert.match(helpOutput[0], /--source/);

  let manifest = { version: "0.1.6-dev.2", sourceCommit: "a".repeat(40), sourceDirty: false };
  const runtimeRequests = [];
  const runtimeOptions = {
    prefix: "/custom/pi-ark", serviceName: "custom-dev.service",
    execute: async (command, args) => { assert.equal(command, "systemctl"); assert.ok(args.includes("custom-dev.service")); return { stdout: "54321\n" }; },
    readJson: async (path) => { runtimeRequests.push(path); return manifest; },
    readText: async (path) => path.endsWith("/children") ? "" : "node\0/custom/pi-ark/releases/actual-running/apps/server/dist/index.js\0",
    resolvePath: async (path) => path === "/custom/pi-ark" ? path : "/custom/pi-ark/releases/actual-running",
  };
  const runtime = await readRunningSource(runtimeOptions);
  assert.equal(runtime.runningVersion, "0.1.6-dev.2");
  assert.equal(runtime.sourceCommit, manifest.sourceCommit);
  assert.deepEqual(runtimeRequests, [join("/custom/pi-ark/releases/actual-running", "RELEASE.json")]);
  const switchedServer = await readRunningSource({ ...runtimeOptions, readText: async (path) => path.endsWith("/children") ? "54322" : path === "/proc/54321/cmdline" ? "node\0/custom/pi-ark/releases/old/scripts/pi-ark.mjs\0serve\0" : "node\0/custom/pi-ark/releases/actual-running/apps/server/dist/index.js\0" });
  assert.equal(switchedServer.servicePid, 54321);
  assert.equal(switchedServer.pid, 54322);
  assert.equal(switchedServer.directory, "/custom/pi-ark/releases/actual-running");
  await assert.rejects(readRunningSource({ ...runtimeOptions, readText: async (path) => path.endsWith("/children") ? "" : "node\0/custom/pi-ark/scripts/pi-ark.mjs\0serve\0" }), /实际 Server 进程尚待确认/);
  manifest = { version: "0.1.5" };
  await assert.rejects(readRunningSource(runtimeOptions), /--source <已确认的 commit>/);
  manifest = { version: "0.1.6-dev.2", sourceCommit: "a".repeat(40), sourceDirty: true };
  await assert.rejects(readRunningSource(runtimeOptions), /构建已提交源码/);
  manifest.sourceDirty = undefined;
  await assert.rejects(readRunningSource(runtimeOptions), /sourceDirty=false/);
  await assert.rejects(readRunningSource({ ...runtimeOptions, execute: async () => ({ stdout: "0" }) }), /MainPID/);
  let reads = 0;
  await assert.rejects(readRunningSource({ ...runtimeOptions, execute: async () => ({ stdout: String(++reads === 1 ? 54321 : 54322) }) }), /切换了进程/);

  await mkdir(repo, { recursive: true });
  await exec("git", ["init", "--bare", remote], { env });
  await exec("git", ["init", "-b", "main", repo], { env });
  await git("config", "user.name", "Release process fixture");
  await git("config", "user.email", "release-fixture@example.invalid");
  await git("remote", "add", "origin", remote);
  await mkdir(join(repo, "apps/server"), { recursive: true });
  await mkdir(join(repo, "apps/web"), { recursive: true });
  await mkdir(join(repo, "scripts"), { recursive: true });
  await mkdir(join(repo, ".github/workflows"), { recursive: true });
  await writeFile(join(repo, ".gitignore"), "dist/\n.tmp/\n");
  const version = "0.1.6-dev.0";
  await writeJson(join(repo, "package.json"), { name: "fixture", version, workspaces: ["apps/*"], dependencies: { retained: "^1.0.0" }, custom: { retained: true } });
  for (const app of ["server", "web"]) await writeJson(join(repo, `apps/${app}/package.json`), { name: `@fixture/${app}`, version, dependencies: { retained: "^2.0.0" } });
  await writeJson(join(repo, "package-lock.json"), { name: "fixture", version, lockfileVersion: 3, requires: true, packages: { "": { name: "fixture", version, dependencies: { retained: "^1.0.0" } }, "apps/server": { name: "@fixture/server", version }, "apps/web": { name: "@fixture/web", version }, "node_modules/retained": { version: "1.2.3", resolved: "https://example.invalid/retained.tgz", custom: true } } });
  await writeFile(join(repo, "scripts/release-candidate.mjs"), "// Fixture candidate helper\n");
  await writeFile(join(repo, ".github/workflows/release.yml"), 'name: Release\n# release/**\n# node scripts/release-candidate.mjs\n');
  await git("add", ".");
  await git("commit", "-m", "Create committed release source");
  const sourceCommit = await git("rev-parse", "HEAD");
  await git("push", "-u", "origin", "main");
  await writeFile(join(repo, "later-business.txt"), "A later main change\n");
  await git("add", "later-business.txt");
  await git("commit", "-m", "Advance main after confirmed source");
  const laterCommit = await git("rev-parse", "HEAD");
  const mainPackage = await readJson(join(repo, "package.json"));
  mainPackage.custom.concurrent = true;
  await writeJson(join(repo, "package.json"), mainPackage);
  await writeFile(join(repo, "concurrent.txt"), "Concurrent staged source\n");
  await git("add", "concurrent.txt");
  const before = await snapshotMain();

  const process = processFor();
  let state = await process.prepare({ version: "0.1.6", source: sourceCommit });
  assert.equal(state.sourceCommit, sourceCommit);
  assert.equal(state.workspace, join(repo, ".tmp/release-process/0.1.6/source"));
  assert.equal(await git("rev-parse", `${state.releaseCommit}^`), sourceCommit);
  assert.equal(await git("ls-remote", "--heads", "origin", "refs/heads/release/0.1.6"), `${state.releaseCommit}\trefs/heads/release/0.1.6`);
  assert.equal(await git("ls-tree", "--name-only", state.releaseCommit, "later-business.txt"), "");
  for (const file of files) {
    const value = await readJson(join(state.workspace, file));
    assert.equal(value.version, "0.1.6");
    if (file === "package-lock.json") {
      for (const key of ["", "apps/server", "apps/web"]) assert.equal(value.packages[key].version, "0.1.6");
      assert.equal(value.packages["node_modules/retained"].version, "1.2.3");
      assert.equal(value.packages["node_modules/retained"].custom, true);
    } else assert.ok(value.dependencies.retained);
  }
  assert.deepEqual(await snapshotMain(), before);
  const releaseCommit = state.releaseCommit;
  await process.prepare({ version: "0.1.6" });
  assert.equal((await select("0.1.6")).releaseCommit, releaseCommit);
  await assert.rejects(process.prepare({ version: "0.1.6", source: laterCommit }), /已固定来源/);
  await rm(join(repo, ".tmp/release-process/0.1.6/state.json"));
  state = await process.prepare({ version: "0.1.6", source: sourceCommit });
  assert.equal(state.sourceCommit, sourceCommit);
  assert.equal(state.releaseCommit, releaseCommit);
  assert.deepEqual(await snapshotMain(), before);

  await select("0.1.6");
  mode = "failed";
  let result = await process.status({ version: selectedVersion, watch: true, interval: 0.001 });
  assert.equal(result.done, true);
  assert.equal(result.success, false);
  assert.equal(sleeps, 0);
  assert.match(output.join("\n"), /Native CI command failed\nnpm ci\nError: native fixture compiler failed/);
  assert.match(output.join("\n"), /actions\/runs\/101/);
  assert.ok(apiCalls.some((path) => path.endsWith("/check-runs/201")));
  assert.ok(apiCalls.some((path) => path.includes("/check-runs/201/annotations")));
  mode = "queued";
  result = await process.status({ version: selectedVersion, watch: true, interval: 0.001 });
  assert.equal(result.success, true);
  assert.equal(sleeps, 1);
  await process.status({ version: selectedVersion, watch: true });
  assert.equal(sleeps, 1);

  // Use the shared production helper with a fake HTTP transport as well as the injected fixture helper.
  const integrated = processFor({ helper: candidateHelper, fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    const path = new URL(url).pathname;
    let body;
    if (path.endsWith("/contents/package.json")) body = { encoding: "base64", content: Buffer.from(JSON.stringify({ version: selectedVersion })).toString("base64") };
    else if (path.endsWith("/artifacts")) body = { total_count: 5, artifacts: artifacts.map((artifact) => ({ ...artifact, expired: false })) };
    else body = await fixtureGithubJson(url);
    return { ok: true, status: 200, json: async () => body };
  } });
  assert.equal((await integrated.status({ version: selectedVersion })).success, true);

  mode = "artifacts-missing";
  await assert.rejects(process.publish({ version: selectedVersion }), /5 个平台 artifact/);
  assert.equal(await git("tag", "--list", "v0.1.6"), "");
  mode = "unverified";
  await assert.rejects(process.publish({ version: selectedVersion }), /not verified/);
  mode = "success";
  await git("tag", "-a", "v0.1.6", laterCommit, "-m", "Conflicting local fixture tag");
  await assert.rejects(process.publish({ version: selectedVersion }), /本地 tag.*候选 commit/);
  await git("tag", "-d", "v0.1.6");
  state = await integrated.publish({ version: selectedVersion });
  assert.equal(state.phase, "published");
  assert.equal(await git("cat-file", "-t", "v0.1.6"), "tag");
  assert.equal(await git("rev-parse", "v0.1.6^{commit}"), releaseCommit);
  await process.publish({ version: selectedVersion });
  assert.equal(await git("rev-parse", "v0.1.6^{commit}"), releaseCommit);
  assert.equal((await process.prepare({ version: selectedVersion })).phase, "published");
  mode = "formal";
  result = await process.status({ version: selectedVersion });
  assert.equal(result.formal, true);
  assert.equal(result.done, false);
  assert.equal(result.success, undefined);
  assert.match(output.join("\n"), /正式 Release 尚待生成/);
  let formalSleeps = 0;
  const waitingForRelease = processFor({ sleep: async () => { formalSleeps += 1; publishedRelease = completeRelease(); } });
  result = await waitingForRelease.status({ version: selectedVersion, watch: true, interval: 0.001 });
  assert.equal(result.success, true);
  assert.equal(formalSleeps, 1);
  assert.equal(sleeps, 1);

  const validRelease = completeRelease();
  assert.equal(verifyPublishedRelease(validRelease, selectedVersion), validRelease);
  const invalidReleases = [
    { ...validRelease, draft: true },
    { ...validRelease, prerelease: true },
    { ...validRelease, tag_name: "v9.9.9" },
    { ...validRelease, assets: validRelease.assets.slice(1) },
    { ...validRelease, assets: [...validRelease.assets, { name: "unexpected.tar.gz", size: 1024 }] },
    { ...validRelease, assets: validRelease.assets.map((asset, index) => index ? asset : { ...asset, name: "pi-ark-9.9.9-linux-x64.tar.gz" }) },
    { ...validRelease, assets: validRelease.assets.map((asset, index) => index ? asset : validRelease.assets[1]) },
    { ...validRelease, assets: validRelease.assets.map((asset, index) => index ? asset : { ...asset, size: 0 }) },
  ];
  for (const missingRun of [false, true]) {
    omitRuns = missingRun;
    for (const invalid of invalidReleases) {
      publishedRelease = invalid;
      assert.throws(() => verifyPublishedRelease(invalid, selectedVersion), /正式 Release 的交付清单异常/);
      result = await process.status({ version: selectedVersion, watch: true });
      assert.equal(result.done, true);
      assert.equal(result.success, false);
      assert.match(result.error, /https:\/\/github.com\/fixture\/repository\/releases\/tag\/v0\.1\.6/);
    }
    publishedRelease = completeRelease();
    result = await process.status({ version: selectedVersion, watch: true });
    assert.equal(result.success, true);
    assert.equal(result.release.assets.length, 5);
  }
  omitRuns = false;
  const releaseApiError = (error) => processFor({ helper: { ...helper, githubJson: async (url) => {
    if (new URL(url).pathname.includes("/releases/tags/")) throw error;
    return fixtureGithubJson(url);
  } } });
  result = await releaseApiError(new Error("GitHub API HTTP 404 Not Found")).status({ version: selectedVersion });
  assert.equal(result.done, false);
  const forbidden = new Error("GitHub API HTTP 403 Forbidden: fixture request 404");
  forbidden.status = 403;
  await assert.rejects(releaseApiError(forbidden).status({ version: selectedVersion }), /HTTP 403 Forbidden/);

  // A complete formal release survives candidate expiry and a removed candidate branch.
  mode = "unverified";
  const callsBeforePublished = candidateCalls;
  await exec("git", ["--git-dir", remote, "update-ref", "-d", "refs/heads/release/0.1.6"], { env });
  result = await process.publish({ version: selectedVersion, watch: true });
  assert.equal(result.success, true);
  assert.equal(result.release.tag_name, "v0.1.6");
  assert.equal(candidateCalls, callsBeforePublished);
  await exec("git", ["--git-dir", remote, "update-ref", "refs/heads/release/0.1.6", releaseCommit], { env });
  publishedRelease = undefined;
  await assert.rejects(process.publish({ version: selectedVersion }), /not verified/);
  assert.equal(candidateCalls, callsBeforePublished + 1);
  publishedRelease = completeRelease();
  await git("tag", "-d", "v0.1.6");
  await git("tag", "-a", "v0.1.6", laterCommit, "-m", "Conflict despite complete fixture release");
  await assert.rejects(process.publish({ version: selectedVersion }), /本地 tag.*候选 commit/);
  await git("tag", "-d", "v0.1.6");
  await git("fetch", "origin", "refs/tags/v0.1.6:refs/tags/v0.1.6");
  publishedRelease = undefined;
  assert.deepEqual(await snapshotMain(), before);

  // A failed push retains the exact release commit for the next prepare invocation.
  let rejectPush = true;
  const interrupted = processFor({ execute: async (command, args, options) => {
    if (command === "git" && args[0] === "push" && rejectPush) { rejectPush = false; throw new Error("Fixture push interrupted"); }
    return exec(command, args, options);
  } });
  await assert.rejects(interrupted.prepare({ version: "0.1.7", source: sourceCommit }), /Fixture push interrupted/);
  state = await select("0.1.7");
  const interruptedCommit = state.releaseCommit;
  state = await interrupted.prepare({ version: "0.1.7" });
  assert.equal(state.releaseCommit, interruptedCommit);

  // An interrupted version commit resumes from staged package-only changes.
  let rejectCommit = true;
  const interruptedVersion = processFor({ execute: async (command, args, options) => {
    if (command === "git" && args[0] === "commit" && rejectCommit) { rejectCommit = false; throw new Error("Fixture commit interrupted"); }
    return exec(command, args, options);
  } });
  await assert.rejects(interruptedVersion.prepare({ version: "0.1.8", source: sourceCommit }), /Fixture commit interrupted/);
  state = await interruptedVersion.prepare({ version: "0.1.8" });
  assert.equal(state.sourceCommit, sourceCommit);
  assert.equal(await git("rev-parse", `${state.releaseCommit}^`), sourceCommit);

  // Runtime manifests must agree with the committed package version; explicit source remains an owner-confirmed input.
  const mismatchedRuntime = processFor({ runningSource: async () => ({ type: "instance", sourceCommit, runningVersion: "0.1.6-dev.99" }) });
  await assert.rejects(mismatchedRuntime.prepare({ version: "0.1.10" }), /实际运行版本 0\.1\.6-dev\.99.*package\.json\.version 0\.1\.6-dev\.0 不一致/);
  assert.equal(await git("branch", "--list", "release/0.1.10"), "");
  state = await mismatchedRuntime.prepare({ version: "0.1.10", source: sourceCommit });
  assert.equal(state.source.type, "ref");
  assert.equal(state.sourceCommit, sourceCommit);

  // Runtime-based preparation is pinned once; a later dev update leaves its source fixed.
  let runtimeCalls = 0;
  const runtimeProcess = processFor({ runningSource: async (options) => {
    runtimeCalls += 1;
    assert.equal(options.prefix, "/fixture/instance");
    assert.equal(options.serviceName, "fixture.service");
    await options.execute("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
    return { type: "instance", sourceCommit, runningVersion: "0.1.6-dev.0" };
  } });
  state = await runtimeProcess.prepare({ version: "0.1.9", prefix: "/fixture/instance", serviceName: "fixture.service" });
  await runtimeProcess.prepare({ version: "0.1.9" });
  assert.equal(runtimeCalls, 1);
  assert.equal(state.sourceCommit, sourceCommit);

  // Remote-only branch recovery reconstructs the source without changing main.
  mode = "success";
  state = await select("0.1.7");
  await git("worktree", "remove", state.workspace);
  await git("branch", "-D", state.branch);
  await rm(join(repo, ".tmp/release-process/0.1.7/state.json"));
  result = await process.status({ version: "0.1.7" });
  assert.equal(result.success, true);
  state = await process.prepare({ version: "0.1.7", source: sourceCommit });
  assert.equal(state.releaseCommit, interruptedCommit);

  // Existing branch and stable-version tag collisions retain their original history.
  await git("branch", "release/0.2.0", laterCommit);
  await assert.rejects(process.prepare({ version: "0.2.0", source: sourceCommit }), /版本.*不一致/);
  assert.equal(await git("rev-parse", "release/0.2.0"), laterCommit);
  await git("tag", "-a", "v0.2.1", laterCommit, "-m", "Existing remote fixture release");
  await git("push", "origin", "refs/tags/v0.2.1");
  await assert.rejects(process.prepare({ version: "0.2.1", source: sourceCommit }), /已有 tag/);
  assert.equal(await git("tag", "--list", "v0.2.1"), "v0.2.1");

  // An older source reports the required confirmed-source upgrade explicitly.
  await git("worktree", "add", "--detach", join(temporary, "old-source"), sourceCommit);
  await rm(join(temporary, "old-source/scripts/release-candidate.mjs"));
  await exec("git", ["add", "-u"], { cwd: join(temporary, "old-source"), env });
  await exec("git", ["commit", "-m", "Fixture source before candidate workflow"], { cwd: join(temporary, "old-source"), env });
  const old = (await exec("git", ["rev-parse", "HEAD"], { cwd: join(temporary, "old-source"), env, encoding: "utf8" })).stdout.trim();
  await assert.rejects(process.prepare({ version: "0.2.2", source: old }), /缺少当前候选发布流水线.*--source/);
  assert.deepEqual(await snapshotMain(), before);

  // State identity, remote branch, and remote tag conflicts each stop before changing candidate history.
  state = await select("0.1.8");
  const statePath = join(repo, ".tmp/release-process/0.1.8/state.json");
  await writeJson(statePath, { ...state, workspace: join(temporary, "wrong-workspace") });
  await assert.rejects(process.status({ version: selectedVersion }), /发布状态需要确认/);
  await writeJson(statePath, state);
  await exec("git", ["--git-dir", remote, "update-ref", `refs/heads/${state.branch}`, laterCommit], { env });
  await assert.rejects(process.publish({ version: selectedVersion }), /远端候选分支.*不一致/);
  await exec("git", ["--git-dir", remote, "update-ref", `refs/heads/${state.branch}`, state.releaseCommit], { env });
  state = await select("0.1.9");
  await git("tag", "-a", "v0.1.9", laterCommit, "-m", "Conflicting remote fixture tag");
  await git("push", "origin", "refs/tags/v0.1.9");
  await git("tag", "-d", "v0.1.9");
  await assert.rejects(process.publish({ version: selectedVersion }), /origin tag.*候选 commit/);
  assert.deepEqual(await snapshotMain(), before);
  assert.ok(candidateCalls >= 6);

  // Correct the native CI source repeatedly while retaining the same formal version and main changes.
  const refreshVersion = "0.1.5";
  const fixedWorkspace = join(temporary, "confirmed CI fixes");
  await git("worktree", "add", "--detach", fixedWorkspace, laterCommit);
  const sourceGit = async (...args) => (await exec("git", args, { cwd: fixedWorkspace, env, encoding: "utf8" })).stdout.trimEnd();
  let revision = 0;
  async function confirmedFix() {
    revision += 1;
    await writeFile(join(fixedWorkspace, "business.txt"), `Confirmed native CI source fix ${revision}\n`);
    await writeFile(join(fixedWorkspace, "binary.dat"), Buffer.from([0, 255, revision, 128]));
    if (revision > 1) await rm(join(fixedWorkspace, "later-business.txt"), { force: true });
    for (const file of files) {
      const value = await readJson(join(fixedWorkspace, file));
      value.version = `0.1.6-dev.${revision}`;
      if (file === "package-lock.json") {
        for (const key of ["", "apps/server", "apps/web"]) value.packages[key].version = value.version;
        value.packages["node_modules/retained"].version = `${revision + 2}.0.1`;
      } else value.dependencies.retained = `^${revision + 2}.0.0`;
      await writeJson(join(fixedWorkspace, file), value);
    }
    await sourceGit("add", ".");
    await sourceGit("commit", "-m", `Fix native CI candidate source ${revision}`);
    return sourceGit("rev-parse", "HEAD");
  }
  async function assertRefreshed(current, confirmedSource, parent) {
    assert.equal(current.version, refreshVersion);
    assert.equal(current.sourceCommit, confirmedSource);
    assert.equal(current.pendingSource, undefined);
    assert.deepEqual((await git("show", "-s", "--format=%P", current.releaseCommit)).split(" "), [parent, confirmedSource]);
    await git("merge-base", "--is-ancestor", parent, current.releaseCommit);
    await git("merge-base", "--is-ancestor", confirmedSource, current.releaseCommit);
    assert.match(await git("show", "-s", "--format=%B", current.releaseCommit), new RegExp(`Pi-Ark-Source: ${confirmedSource}`));
    const differences = (await git("diff", "--name-only", confirmedSource, current.releaseCommit)).split("\n").filter(Boolean);
    assert.ok(differences.every((file) => files.includes(file)));
    for (const file of files) {
      const expected = JSON.parse(await git("show", `${confirmedSource}:${file}`));
      expected.version = refreshVersion;
      if (file === "package-lock.json") for (const key of ["", "apps/server", "apps/web"]) expected.packages[key].version = refreshVersion;
      assert.equal(await git("show", `${current.releaseCommit}:${file}`), JSON.stringify(expected, null, 2));
    }
    assert.equal((await git("ls-remote", "--heads", "origin", `refs/heads/${current.branch}`)).split(/\s+/)[0], current.releaseCommit);
    assert.deepEqual(await snapshotMain(), before);
  }
  await assert.rejects(process.prepare({ version: refreshVersion, source: sourceCommit, refresh: true }), /需要已准备的候选版本/);
  state = await process.prepare({ version: refreshVersion, source: sourceCommit });
  const firstCandidate = state.releaseCommit;
  const firstFix = await confirmedFix();
  await assert.rejects(process.prepare({ version: refreshVersion, source: firstFix }), /已固定来源/);
  await writeFile(join(state.workspace, "operator-notes.txt"), "Candidate workspace user notes\n");
  await assert.rejects(process.prepare({ version: refreshVersion, source: firstFix, refresh: true }), /先处理已有改动/);
  assert.equal(await readFile(join(state.workspace, "operator-notes.txt"), "utf8"), "Candidate workspace user notes\n");
  await rm(join(state.workspace, "operator-notes.txt"));
  const candidatePackage = await readJson(join(state.workspace, "package.json"));
  candidatePackage.operatorChange = true;
  await writeJson(join(state.workspace, "package.json"), candidatePackage);
  await exec("git", ["add", "package.json"], { cwd: state.workspace, env });
  await writeFile(join(state.workspace, "package.json"), `${JSON.stringify(candidatePackage, null, 2)}\n\n`);
  const candidateDirty = await readFile(join(state.workspace, "package.json"), "utf8");
  const candidateIndex = (await exec("git", ["diff", "--cached"], { cwd: state.workspace, env, encoding: "utf8" })).stdout;
  await assert.rejects(process.prepare({ version: refreshVersion, source: firstFix, refresh: true }), /先处理已有改动/);
  assert.equal(await readFile(join(state.workspace, "package.json"), "utf8"), candidateDirty);
  assert.equal((await exec("git", ["diff", "--cached"], { cwd: state.workspace, env, encoding: "utf8" })).stdout, candidateIndex);
  await exec("git", ["restore", "--staged", "--worktree", "package.json"], { cwd: state.workspace, env });

  const existingMergePath = resolve(state.workspace, (await exec("git", ["rev-parse", "--git-path", "MERGE_HEAD"], { cwd: state.workspace, env, encoding: "utf8" })).stdout.trim());
  await writeFile(existingMergePath, `${firstFix}\n`);
  await assert.rejects(process.prepare({ version: refreshVersion, source: firstFix, refresh: true }), /尚待处理的 merge 状态/);
  assert.equal(await readFile(existingMergePath, "utf8"), `${firstFix}\n`);
  await rm(existingMergePath);
  await git("branch", "confirmed-ci-fix", firstFix);
  assert.equal(await git("ls-remote", "--heads", "origin", "refs/heads/confirmed-ci-fix"), "");
  await assert.rejects(exec("git", ["--git-dir", remote, "cat-file", "-e", `${firstFix}^{commit}`], { env }));
  state = await process.prepare({ version: refreshVersion, source: "confirmed-ci-fix", refresh: true });
  await assertRefreshed(state, firstFix, firstCandidate);

  // Fetch only the candidate into a new clone; its unpublished local source must travel with the candidate.
  const candidateClone = join(temporary, "candidate-only clone");
  await exec("git", ["clone", "--no-local", "--no-tags", "--single-branch", "--branch", state.branch, remote, candidateClone], { env });
  const cloneGit = async (...args) => (await exec("git", args, { cwd: candidateClone, env, encoding: "utf8" })).stdout.trimEnd();
  assert.equal(await cloneGit("config", "--get", "remote.origin.fetch"), `+refs/heads/${state.branch}:refs/remotes/origin/${state.branch}`);
  assert.equal(await cloneGit("for-each-ref", "--format=%(refname)", "refs/remotes/origin/main", "refs/remotes/origin/confirmed-ci-fix"), "");
  assert.equal(await cloneGit("cat-file", "-t", firstFix), "commit");
  await cloneGit("merge-base", "--is-ancestor", firstFix, state.releaseCommit);
  await cloneGit("checkout", "--detach");
  const previousApiSelection = { mode, selectedVersion, selectedCommit };
  selectedVersion = refreshVersion;
  selectedCommit = state.releaseCommit;
  mode = "success";
  try {
    const recoveredFlow = createReleaseProcess({ repo: candidateClone, repository: "fixture/repository", env: { ...env, GH_TOKEN: "fixture-token" }, helper, log: (text) => output.push(text) });
    assert.equal((await recoveredFlow.status({ version: refreshVersion })).success, true);
    const recovered = await recoveredFlow.prepare({ version: refreshVersion });
    assert.equal(recovered.sourceCommit, firstFix);
    assert.equal(recovered.releaseCommit, state.releaseCommit);
  } finally {
    ({ mode, selectedVersion, selectedCommit } = previousApiSelection);
  }
  assert.deepEqual(await snapshotMain(), before);
  assert.equal(state.previous.sourceCommit, sourceCommit);
  assert.equal(state.previous.releaseCommit, firstCandidate);
  let refreshedCandidate = state.releaseCommit;
  assert.equal((await process.prepare({ version: refreshVersion, source: firstFix, refresh: true })).releaseCommit, refreshedCandidate);
  assert.equal((await process.prepare({ version: refreshVersion })).releaseCommit, refreshedCandidate);
  await assert.rejects(process.prepare({ version: refreshVersion, source: sourceCommit }), /已固定来源/);
  await rm(join(repo, `.tmp/release-process/${refreshVersion}/state.json`));
  state = await process.prepare({ version: refreshVersion });
  assert.equal(state.sourceCommit, firstFix);
  assert.equal(state.releaseCommit, refreshedCandidate);

  // Commit interruption preserves the old record and the exact staged target for an explicit refresh retry.
  const secondFix = await confirmedFix();
  await git("update-ref", "refs/heads/confirmed-ci-fix", secondFix);
  assert.equal((await process.prepare({ version: refreshVersion })).sourceCommit, firstFix);
  await assert.rejects(process.prepare({ version: refreshVersion, source: "confirmed-ci-fix" }), /已固定来源/);
  let stopRefreshCommit = true;
  const commitInterrupted = processFor({ execute: async (file, args, options) => {
    if (file === "git" && args[0] === "commit" && stopRefreshCommit) { stopRefreshCommit = false; throw new Error("Refresh fixture commit interrupted"); }
    return exec(file, args, options);
  } });
  await assert.rejects(commitInterrupted.prepare({ version: refreshVersion, source: secondFix, refresh: true }), /Refresh fixture commit interrupted/);
  state = await select(refreshVersion);
  assert.equal(state.sourceCommit, firstFix);
  assert.equal(state.releaseCommit, refreshedCandidate);
  assert.equal(state.pendingSource.sourceCommit, secondFix);
  assert.equal(state.pendingSource.baseCommit, refreshedCandidate);
  const interruptedMergeHead = (await exec("git", ["rev-parse", "--git-path", "MERGE_HEAD"], { cwd: state.workspace, env, encoding: "utf8" })).stdout.trim();
  assert.equal((await readFile(resolve(state.workspace, interruptedMergeHead), "utf8")).trim(), secondFix);
  await git("tag", "-a", "v0.1.5", refreshedCandidate, "-m", "Formal fixture tag during pending refresh");
  await assert.rejects(process.prepare({ version: refreshVersion }), /正式 tag v0\.1\.5 已存在/);
  await git("tag", "-d", "v0.1.5");
  await assert.rejects(process.status({ version: refreshVersion }), /更新尚待完成/);
  await assert.rejects(process.publish({ version: refreshVersion }), /更新尚待完成/);
  await assert.rejects(process.prepare({ version: refreshVersion, source: firstFix, refresh: true }), /候选更新已固定新的来源/);
  const stagedBusiness = await readFile(join(state.workspace, "business.txt"), "utf8");
  await writeFile(join(state.workspace, "business.txt"), `${stagedBusiness}Operator change after interruption\n`);
  await assert.rejects(process.prepare({ version: refreshVersion }), /事务之外的改动/);
  assert.match(await readFile(join(state.workspace, "business.txt"), "utf8"), /Operator change after interruption/);
  await writeFile(join(state.workspace, "business.txt"), stagedBusiness);
  state = await commitInterrupted.prepare({ version: refreshVersion, source: secondFix, refresh: true });
  await assertRefreshed(state, secondFix, refreshedCandidate);
  assert.equal(await git("ls-tree", "--name-only", state.releaseCommit, "later-business.txt"), "");
  refreshedCandidate = state.releaseCommit;

  // A commit that finished before the caller was interrupted is recovered without an additional commit.
  const thirdFix = await confirmedFix();
  let stopAfterCommit = true;
  const committedInterrupted = processFor({ execute: async (file, args, options) => {
    const result = await exec(file, args, options);
    if (file === "git" && args[0] === "commit" && stopAfterCommit) { stopAfterCommit = false; throw new Error("Refresh fixture interrupted after commit"); }
    return result;
  } });
  await assert.rejects(committedInterrupted.prepare({ version: refreshVersion, source: thirdFix, refresh: true }), /interrupted after commit/);
  state = await select(refreshVersion);
  const completedCommit = await git("rev-parse", state.branch);
  assert.equal(state.pendingSource.releaseCommit, undefined);
  state = await process.prepare({ version: refreshVersion });
  assert.equal(state.releaseCommit, completedCommit);
  await assertRefreshed(state, thirdFix, refreshedCandidate);
  refreshedCandidate = state.releaseCommit;

  // Push interruptions recover using ordinary prepare, both before and after the remote accepts the commit.
  for (const afterPush of [false, true]) {
    const fix = await confirmedFix();
    let stopPush = true;
    const refreshPushInterrupted = processFor({ execute: async (file, args, options) => {
      if (file === "git" && args[0] === "push" && stopPush && !afterPush) { stopPush = false; throw new Error("Refresh fixture push interrupted"); }
      const result = await exec(file, args, options);
      if (file === "git" && args[0] === "push" && stopPush) { stopPush = false; throw new Error("Refresh fixture push interrupted after remote accepted"); }
      return result;
    } });
    await assert.rejects(refreshPushInterrupted.prepare({ version: refreshVersion, source: fix, refresh: true }), /Refresh fixture push interrupted/);
    state = await select(refreshVersion);
    const pendingCommit = state.pendingSource.releaseCommit;
    assert.equal(state.releaseCommit, refreshedCandidate);
    assert.equal(await git("rev-parse", state.branch), pendingCommit);
    state = await process.prepare({ version: refreshVersion });
    assert.equal(state.releaseCommit, pendingCommit);
    await assertRefreshed(state, fix, refreshedCandidate);
    refreshedCandidate = state.releaseCommit;
  }

  // Lost state can recover an unpushed fast-forward commit from its validated source trailer.
  let lastFix = await confirmedFix();
  const stateLostPush = processFor({ execute: async (file, args, options) => {
    if (file === "git" && args[0] === "push") throw new Error("Refresh fixture state lost before push");
    return exec(file, args, options);
  } });
  await assert.rejects(stateLostPush.prepare({ version: refreshVersion, source: lastFix, refresh: true }), /state lost before push/);
  state = await select(refreshVersion);
  const unpushedRefresh = state.pendingSource.releaseCommit;
  await rm(join(repo, `.tmp/release-process/${refreshVersion}/state.json`));
  state = await process.prepare({ version: refreshVersion });
  assert.equal(state.releaseCommit, unpushedRefresh);
  await assertRefreshed(state, lastFix, refreshedCandidate);
  refreshedCandidate = state.releaseCommit;

  // Distinct confirmed source commits with the same tree still record their new provenance in one FF commit.
  await sourceGit("commit", "--allow-empty", "-m", "Confirm identical native CI source tree");
  lastFix = await sourceGit("rev-parse", "HEAD");
  state = await process.prepare({ version: refreshVersion, source: lastFix, refresh: true });
  await assertRefreshed(state, lastFix, refreshedCandidate);
  assert.equal(await git("rev-parse", `${state.releaseCommit}^{tree}`), await git("rev-parse", `${refreshedCandidate}^{tree}`));
  refreshedCandidate = state.releaseCommit;

  // Explicitly retain an ancestor source as the second parent when revisiting confirmed source trees.
  for (const ancestorSource of [sourceCommit, lastFix]) {
    state = await process.prepare({ version: refreshVersion, source: ancestorSource, refresh: true });
    await assertRefreshed(state, ancestorSource, refreshedCandidate);
    refreshedCandidate = state.releaseCommit;
  }

  // Legacy release commits without source trailers retain their original recovery path.
  const legacyWorkspace = join(temporary, "legacy candidate");
  await git("worktree", "add", "--detach", legacyWorkspace, sourceCommit);
  for (const file of files) {
    const value = await readJson(join(legacyWorkspace, file));
    value.version = "0.3.0";
    if (file === "package-lock.json") for (const key of ["", "apps/server", "apps/web"]) value.packages[key].version = value.version;
    await writeJson(join(legacyWorkspace, file), value);
  }
  await exec("git", ["add", "--", ...files], { cwd: legacyWorkspace, env });
  await exec("git", ["commit", "-m", "Prepare release 0.3.0"], { cwd: legacyWorkspace, env });
  const legacyCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: legacyWorkspace, env, encoding: "utf8" })).stdout.trim();
  await git("branch", "release/0.3.0", legacyCommit);
  const legacy = await process.prepare({ version: "0.3.0" });
  assert.equal(legacy.sourceCommit, sourceCommit);
  assert.equal(legacy.releaseCommit, legacyCommit);

  // Refresh also repairs a same-source candidate created by the earlier tree-and-trailer-only implementation.
  const repairVersion = "0.4.0";
  const oldPrepared = await process.prepare({ version: repairVersion, source: sourceCommit });
  const repairWorkspace = join(temporary, "legacy source reachability");
  await git("worktree", "add", "--detach", repairWorkspace, firstFix);
  for (const file of files) {
    const value = await readJson(join(repairWorkspace, file));
    value.version = repairVersion;
    if (file === "package-lock.json") for (const key of ["", "apps/server", "apps/web"]) value.packages[key].version = repairVersion;
    await writeJson(join(repairWorkspace, file), value);
  }
  await exec("git", ["add", "--", ...files], { cwd: repairWorkspace, env });
  const oldTree = (await exec("git", ["write-tree"], { cwd: repairWorkspace, env, encoding: "utf8" })).stdout.trim();
  const oldRefresh = await git("commit-tree", oldTree, "-p", oldPrepared.releaseCommit, "-m", `Refresh release ${repairVersion}`, "-m", `Pi-Ark-Source: ${firstFix}`);
  await exec("git", ["reset", "--hard", oldRefresh], { cwd: oldPrepared.workspace, env });
  await git("push", "origin", `refs/heads/${oldPrepared.branch}`);
  await rm(join(repo, `.tmp/release-process/${repairVersion}/state.json`));
  await assert.rejects(git("merge-base", "--is-ancestor", firstFix, oldRefresh));
  const repaired = await process.prepare({ version: repairVersion, source: firstFix, refresh: true });
  assert.deepEqual((await git("show", "-s", "--format=%P", repaired.releaseCommit)).split(" "), [oldRefresh, firstFix]);
  await git("merge-base", "--is-ancestor", firstFix, repaired.releaseCommit);
  assert.equal(await git("rev-parse", `${repaired.releaseCommit}^{tree}`), oldTree);
  assert.deepEqual(await snapshotMain(), before);

  // Any local or remote formal tag stops refresh, including a same-source refresh request.
  await git("tag", "-a", "v0.1.5", refreshedCandidate, "-m", "Local formal fixture permission");
  await assert.rejects(process.prepare({ version: refreshVersion, source: lastFix, refresh: true }), /正式 tag v0\.1\.5 已存在/);
  assert.equal(await git("rev-parse", "release/0.1.5"), refreshedCandidate);
  await git("push", "origin", "refs/tags/v0.1.5");
  await git("tag", "-d", "v0.1.5");
  await assert.rejects(process.prepare({ version: refreshVersion, source: firstFix, refresh: true }), /正式 tag v0\.1\.5 已存在/);
  state = await process.prepare({ version: refreshVersion });
  assert.equal(state.sourceCommit, lastFix);
  assert.equal(state.releaseCommit, refreshedCandidate);
  await select(refreshVersion);
  mode = "formal";
  publishedRelease = completeRelease();
  assert.equal((await process.status({ version: refreshVersion })).success, true);
  assert.equal((await process.publish({ version: refreshVersion })).success, true);
  assert.deepEqual(await snapshotMain(), before);
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log("Release process checks passed");
