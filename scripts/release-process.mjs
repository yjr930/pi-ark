#!/usr/bin/env node
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_ARTIFACT_NAMES } from "./release-candidate.mjs";

const exec = promisify(execFile);
const packageFiles = ["package.json", "package-lock.json", "apps/server/package.json", "apps/web/package.json"];
const stablePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^[a-f0-9]{40,64}$/;
const defaultRepository = "yjr930/pi-ark";

export const help = `Pi-Ark 发布流程

用法：
  npm run release:prepare -- --version <stable semver> [--from-instance dev]
  npm run release:prepare -- --version <stable semver> --source <已确认的 Git ref>
  npm run release:prepare -- --version <stable semver> --source <新的已确认 Git ref> --refresh
  npm run release:status -- --version <stable semver> [--watch] [--interval 30]
  npm run release:publish -- --version <stable semver> [--watch] [--interval 30]

prepare 默认从 pi-ark-dev.service 的 MainPID 定位实际 Server 进程，并读取其 RELEASE.json 固定源码。
--prefix <目录>         实例安装目录（默认 /opt/pi-ark-dev）
--service-name <unit>   Linux service unit（默认 pi-ark-dev.service）
--source <Git ref>      发布负责人确认的已提交源码，与 --from-instance 互斥
--refresh              正式 tag 创建之前，用 --source 更新同一 version 的候选源码
--version <版本>        正式 SemVer，例如 0.1.6
--watch                查询至当前候选或正式发布流程完成
--interval <秒>        查询间隔（有 API token 时默认 30，匿名查询时默认 180）
--help                 显示帮助

工作区与状态：.tmp/release-process/<version>/source 和 state.json。
prepare 推送 release/<version> 候选分支；--refresh 追加 merge commit（第一 parent 为旧候选，第二 parent 为新来源），并以 fast-forward 推送。
普通 prepare 固定原来源，也可以继续已保存的候选更新；--refresh 要求明确的 --source。
publish 显式创建并推送 annotated v<version> tag。
status 自动识别已推送的正式 tag，并在正式 Release 的安装包完整交付后报告完成。
publish 可以重复确认已完整交付的同 commit 正式版本。
GitHub API 可选读取 GH_TOKEN 或 GITHUB_TOKEN；Git push 沿用现有 Git 配置。
`;

export function parseArgs(argv) {
  if (argv.includes("--help") || argv[0] === "help") return { help: true };
  const [command, ...args] = argv;
  if (!["prepare", "status", "publish"].includes(command)) throw new Error("请选择 prepare、status 或 publish；使用 --help 查看用法。");
  const options = { command, interval: process.env.GH_TOKEN || process.env.GITHUB_TOKEN ? 30 : 180 };
  const names = { "--version": "version", "--source": "source", "--from-instance": "fromInstance", "--prefix": "prefix", "--service-name": "serviceName", "--interval": "interval" };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i];
    if (seen.has(name)) throw new Error(`参数重复：${name}`);
    seen.add(name);
    if (name === "--watch" || name === "--refresh") { options[name.slice(2)] = true; continue; }
    if (!names[name]) throw new Error(`未知参数：${name}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${name} 需要参数值。`);
    options[names[name]] = value;
  }
  if (!stablePattern.test(options.version || "")) throw new Error("请通过 --version 指定正式 SemVer（例如 0.1.6）。");
  if (options.source && options.fromInstance) throw new Error("请选择 --source 或 --from-instance 作为源码来源。");
  if (options.fromInstance && options.fromInstance !== "dev") throw new Error("--from-instance 当前支持 dev；其他安装使用 --prefix 与 --service-name。");
  if (command !== "prepare" && ["source", "fromInstance", "prefix", "serviceName"].some((key) => options[key])) throw new Error("源码和实例参数用于 prepare。");
  if (command === "prepare" && options.watch) throw new Error("请使用 status --watch 跟踪候选构建。");
  if (options.refresh && (command !== "prepare" || !options.source)) throw new Error("--refresh 用于 prepare，并且需要 --source <新的已确认 Git ref>。");
  options.interval = Number(options.interval);
  if (!Number.isFinite(options.interval) || options.interval <= 0) throw new Error("--interval 必须是大于 0 的秒数。");
  return options;
}

export function verifyPublishedRelease(release, version, { repository = defaultRepository } = {}) {
  const url = release.html_url || `https://github.com/${repository}/releases/tag/v${version}`;
  const expected = RELEASE_ARTIFACT_NAMES.map((name) => `${name.replace("pi-ark-", `pi-ark-${version}-`)}.${name.includes("win32") ? "zip" : "tar.gz"}`).sort();
  const problems = [];
  if (release.draft !== false) problems.push("Release 的 draft 字段需要为 false");
  if (release.prerelease !== false) problems.push("Release 的 prerelease 字段需要为 false");
  if (release.tag_name !== `v${version}`) problems.push(`Release tag_name 为 ${release.tag_name}，预期为 v${version}`);
  const assets = release.assets;
  if (!Array.isArray(assets)) problems.push("Release 缺少 assets 清单");
  else {
    const actual = assets.map((asset) => asset.name).sort();
    if (!isDeepStrictEqual(actual, expected)) problems.push(`安装包清单需要恰好包含 ${expected.join(", ")}；当前清单为 ${actual.join(", ")}`);
    for (const asset of assets) if (!Number.isSafeInteger(asset.size) || asset.size <= 0) problems.push(`安装包 ${asset.name} 的 size 需要大于 0，当前为 ${asset.size}`);
  }
  if (problems.length) throw new Error(`正式 Release 的交付清单异常：${problems.join("；")}\n${url}`);
  return release;
}

function versionedJson(file, original, version) {
  const value = structuredClone(original);
  value.version = version;
  if (file === "package-lock.json") {
    for (const key of ["", "apps/server", "apps/web"]) {
      if (!value.packages?.[key]) throw new Error(`package-lock.json 缺少 workspace：${key || "项目 package"}`);
      value.packages[key].version = version;
    }
  }
  return value;
}

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

export async function readRunningSource({ prefix = "/opt/pi-ark-dev", serviceName = "pi-ark-dev.service", execute = exec, readJson = async (path) => JSON.parse(await readFile(path, "utf8")), readText = async (path) => readFile(path, "utf8"), resolvePath = realpath } = {}) {
  if (!/^[a-zA-Z0-9@_.:-]+\.service$/.test(serviceName) || serviceName.startsWith("-")) throw new Error("--service-name 需要有效的 Linux service unit。");
  const mainPid = Number((await execute("systemctl", ["show", serviceName, "--property=MainPID", "--value"], { encoding: "utf8" })).stdout.trim());
  if (!Number.isSafeInteger(mainPid) || mainPid <= 0) throw new Error(`${serviceName} 的 MainPID 尚未运行。请启动已确认的开发实例，或使用 --source <已确认的 Git ref>。`);
  const installation = await resolvePath(prefix);
  const children = (await readText(`/proc/${mainPid}/task/${mainPid}/children`)).trim().split(/\s+/).filter(Boolean).map(Number);
  const servers = [];
  for (const pid of [mainPid, ...children]) {
    let commandLine;
    try { commandLine = await readText(`/proc/${pid}/cmdline`); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const script = commandLine.split("\0").find((arg) => /(?:^|\/)apps\/server\/dist\/index\.js$/.test(arg));
    if (!script) continue;
    const absolute = isAbsolute(script) ? script : resolve(await resolvePath(`/proc/${pid}/cwd`), script);
    const directory = await resolvePath(resolve(dirname(absolute), "../../.."));
    if (directory.startsWith(`${installation}/releases/`)) servers.push({ pid, directory, commandLine });
  }
  if (servers.length !== 1) throw new Error(`${serviceName} 的实际 Server 进程尚待确认；请等待启动完成，或确认 --prefix 与 --service-name 后重新执行 prepare。`);
  const server = servers[0];
  const cwd = server.directory;
  const manifest = await readJson(join(cwd, "RELEASE.json"));
  const confirmedPid = Number((await execute("systemctl", ["show", serviceName, "--property=MainPID", "--value"], { encoding: "utf8" })).stdout.trim());
  if (confirmedPid !== mainPid || await readText(`/proc/${server.pid}/cmdline`) !== server.commandLine) throw new Error("开发实例在读取期间切换了进程；请重新执行 prepare。");
  if (manifest.sourceDirty === true) throw new Error(`运行版本 ${manifest.version} 包含构建时的未提交源码。请先提交源码并构建已提交源码的开发 artifact，再执行 prepare；也可以用 --source <已确认的 Git ref> 选择已提交源码。`);
  if (!commitPattern.test(manifest.sourceCommit || "")) throw new Error(`运行版本 ${manifest.version} 的 RELEASE.json 缺少 sourceCommit。请先确认该 artifact 的源码 commit（查阅原构建记录或由发布负责人确认），然后执行 npm run release:prepare -- --version <stable semver> --source <已确认的 commit>。`);
  if (manifest.sourceDirty !== false) throw new Error(`运行版本 ${manifest.version} 的 RELEASE.json 缺少 sourceDirty=false 的构建记录；请构建已提交源码的开发 artifact，或使用 --source <已确认的 commit>。`);
  return { type: "instance", instance: "dev", prefix: installation, serviceName, servicePid: mainPid, pid: server.pid, directory: cwd, runningVersion: manifest.version, sourceCommit: manifest.sourceCommit };
}

export function createReleaseProcess({ repo = resolve(dirname(fileURLToPath(import.meta.url)), ".."), repository = defaultRepository, env = process.env, fetchImpl = globalThis.fetch, helper, execute = exec, log = console.log, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), runningSource = readRunningSource } = {}) {
  repo = resolve(repo);
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const apiBase = `https://api.github.com/repos/${repository}`;
  const webBase = `https://github.com/${repository}`;
  let loadedHelper = helper;
  let operationTemporary;
  async function helpers() {
    loadedHelper ||= await import(new URL("./release-candidate.mjs", import.meta.url));
    return loadedHelper;
  }
  async function api(path) { return (await helpers()).githubJson(path.startsWith("https://") ? path : `${apiBase}${path}`, { repository, token, fetchImpl }); }
  async function git(args, cwd = repo, temporary = operationTemporary, overrides = {}) {
    const result = await execute("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: { ...env, ...(temporary ? { TMPDIR: temporary, TMP: temporary, TEMP: temporary } : {}), ...overrides } });
    return result.stdout.trimEnd();
  }
  async function localRef(ref) {
    try { return await git(["rev-parse", "--verify", `${ref}^{commit}`]); }
    catch (error) { if (error.code === 128 || error.code === 1) return undefined; throw error; }
  }
  async function remoteRef(ref) {
    const output = await git(["ls-remote", "origin", ref, `${ref}^{}`]);
    const refs = new Map(output.split("\n").filter(Boolean).map((line) => { const [sha, name] = line.split(/\s+/); return [name, sha]; }));
    return refs.get(`${ref}^{}`) || refs.get(ref);
  }
  function paths(version) {
    if (!stablePattern.test(version || "")) throw new Error("请指定正式 SemVer。");
    const directory = join(repo, ".tmp/release-process", version);
    operationTemporary = join(directory, "tmp");
    return { directory, workspace: join(directory, "source"), temporary: operationTemporary, statePath: join(directory, "state.json"), lock: join(directory, "command.lock") };
  }
  async function save(state, p) {
    await mkdir(p.directory, { recursive: true });
    const temporary = `${p.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporary, p.statePath);
  }
  async function withLock(p, action) {
    await mkdir(p.temporary, { recursive: true });
    let handle;
    try { handle = await open(p.lock, "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await readFile(p.lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`发布操作的锁需要检查：${p.lock}`);
      try { process.kill(pid, 0); throw new Error(`发布操作仍在运行（进程 ${pid}）。`); }
      catch (check) { if (check.code !== "ESRCH") throw check; }
      await rm(p.lock);
      handle = await open(p.lock, "wx");
    }
    try { await handle.writeFile(String(process.pid)); return await action(); }
    finally { await handle.close(); await rm(p.lock, { force: true }); }
  }
  async function jsonAt(commit, file) { return JSON.parse(await git(["show", `${commit}:${file}`])); }
  async function assertWorkflow(commit) {
    try {
      await git(["cat-file", "-e", `${commit}:scripts/release-candidate.mjs`]);
      const workflow = await git(["show", `${commit}:.github/workflows/release.yml`]);
      if (!workflow.includes("release-candidate.mjs") || !workflow.includes("release/**")) throw new Error("workflow");
    } catch {
      throw new Error(`源码 commit ${commit} 缺少当前候选发布流水线。请确认包含 scripts/release-candidate.mjs 和对应 release workflow 的源码，再通过 --source <已确认的 commit> 执行 prepare。`);
    }
  }
  async function assertVersions(commit, version) {
    for (const file of packageFiles) {
      const value = await jsonAt(commit, file);
      if (value.version !== version) throw new Error(`${file} 的版本 ${value.version} 与正式版本 ${version} 不一致。`);
      if (file === "package-lock.json") for (const name of ["", "apps/server", "apps/web"]) if (value.packages?.[name]?.version !== version) throw new Error(`Lock workspace ${name || "项目 package"} 的版本与 ${version} 不一致。`);
    }
  }
  async function assertCandidate(commit, sourceCommit, version) {
    await assertVersions(commit, version);
    if (commit === sourceCommit) return;
    const files = (await git(["diff", "--name-only", sourceCommit, commit, "--"])).split("\n").filter(Boolean);
    if (files.some((file) => !packageFiles.includes(file))) throw new Error(`release/${version} 的 tree 与已固定的来源不一致。请确认候选分支，或恢复已保存的 --refresh 更新。`);
    for (const file of packageFiles) if (!isDeepStrictEqual(await jsonAt(commit, file), versionedJson(file, await jsonAt(sourceCommit, file), version))) throw new Error(`${file} 含有版本更新之外的改动。`);
  }
  async function inferSource(commit, version) {
    await assertVersions(commit, version);
    const message = await git(["show", "-s", "--format=%B", commit]);
    const trailers = message.trimEnd().split(/\n\s*\n/).at(-1).split("\n").filter((line) => line.startsWith("Pi-Ark-Source:"));
    if (trailers.length) {
      const recorded = trailers.length === 1 && /^Pi-Ark-Source: ([a-f0-9]{40,64})$/.exec(trailers[0]);
      if (!recorded) throw new Error(`候选 commit 的 Pi-Ark-Source trailer 需要确认：${commit}`);
      await assertCandidate(commit, recorded[1], version);
      return recorded[1];
    }
    const subject = message.split("\n")[0];
    if (subject !== `Prepare release ${version}`) return commit;
    const parents = (await git(["show", "-s", "--format=%P", commit])).split(" ");
    if (parents.length !== 1) throw new Error(`候选分支的来源需要确认；请使用 prepare --source <已确认的 commit>。`);
    await assertCandidate(commit, parents[0], version);
    return parents[0];
  }
  async function resolveSource(ref) {
    if (ref.startsWith("-")) throw new Error("--source 需要有效的 Git ref。");
    const commit = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
    if (!commitPattern.test(commit)) throw new Error("源码 Git ref 需要指向 commit。");
    return commit;
  }
  async function load(version, p, { fetchBranch = true } = {}) {
    const state = await optionalJson(p.statePath);
    const branch = `release/${version}`;
    if (state) {
      if (state.version !== version || state.branch !== branch || state.workspace !== p.workspace || state.repository !== repository || !commitPattern.test(state.sourceCommit || "") || state.pendingSource && (!commitPattern.test(state.pendingSource.sourceCommit || "") || !commitPattern.test(state.pendingSource.baseCommit || "") || !commitPattern.test(state.pendingSource.tree || ""))) throw new Error(`发布状态需要确认：${p.statePath}`);
      return state;
    }
    let commit = await localRef(`refs/heads/${branch}`);
    const remote = fetchBranch ? await remoteRef(`refs/heads/${branch}`) : undefined;
    if (remote && commit && remote !== commit) {
      await git(["fetch", "--no-tags", "origin", `refs/heads/${branch}`]);
      if (!await isAncestor(remote, commit)) throw new Error(`${branch} 的本地分支与 origin 分支指向不同历史。请确认来源后恢复候选分支。`);
    }
    if (remote && !commit) {
      await git(["fetch", "--no-tags", "origin", `refs/heads/${branch}`]);
      commit = await localRef("FETCH_HEAD");
    }
    if (!commit) return undefined;
    const sourceCommit = await inferSource(commit, version);
    return { schemaVersion: 1, version, repository, branch, workspace: p.workspace, sourceCommit, source: { type: "recovered", sourceCommit }, releaseCommit: commit, phase: "prepared" };
  }
  async function isAncestor(ancestor, commit) {
    try { await git(["merge-base", "--is-ancestor", ancestor, commit]); return true; }
    catch (error) { if (error.code === 1) return false; throw error; }
  }
  async function ensureWorkspace(p, branch) {
    try {
      await stat(join(p.workspace, ".git"));
      if (await git(["symbolic-ref", "--short", "HEAD"], p.workspace) !== branch) throw new Error(`发布工作区需要位于 ${branch}：${p.workspace}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await git(["worktree", "add", p.workspace, branch]);
    }
  }
  function showPrepared(state) {
    log(`候选版本：${state.version}\n来源 commit：${state.sourceCommit}\n候选 commit：${state.releaseCommit}\n工作区：${state.workspace}\n分支：${webBase}/tree/${state.branch}\n继续查询：npm run release:status -- --version ${state.version} --watch`);
  }
  async function candidateTree(sourceCommit, version, p) {
    const index = join(p.temporary, "candidate.index");
    const overrides = { GIT_INDEX_FILE: index };
    const manifest = join(p.temporary, "candidate-package.json");
    await rm(index, { force: true });
    try {
      await git(["read-tree", sourceCommit], repo, p.temporary, overrides);
      for (const file of packageFiles) {
        const value = versionedJson(file, await jsonAt(sourceCommit, file), version);
        await writeFile(manifest, `${JSON.stringify(value, null, 2)}\n`);
        const blob = await git(["hash-object", "-w", `--path=${file}`, manifest]);
        const mode = (await git(["ls-tree", sourceCommit, "--", file])).split(" ")[0];
        await git(["update-index", "--cacheinfo", mode, blob, file], repo, p.temporary, overrides);
      }
      return await git(["write-tree"], repo, p.temporary, overrides);
    } finally {
      await rm(index, { force: true });
      await rm(manifest, { force: true });
    }
  }
  async function mergeStatePaths(p) {
    const result = {};
    for (const name of ["MERGE_HEAD", "MERGE_MODE", "MERGE_MSG"]) result[name] = resolve(p.workspace, await git(["rev-parse", "--git-path", name], p.workspace));
    return result;
  }
  async function optionalText(path) {
    try { return await readFile(path, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  }
  async function prepareRefreshMerge(p, pending, version) {
    const paths = await mergeStatePaths(p);
    const expected = { MERGE_MODE: "no-ff", MERGE_MSG: `Refresh release ${version}\n\nPi-Ark-Source: ${pending.sourceCommit}\n`, MERGE_HEAD: `${pending.sourceCommit}\n` };
    for (const name of Object.keys(expected)) {
      const current = await optionalText(paths[name]);
      if (current !== undefined && current !== expected[name]) throw new Error(`候选工作区的 ${name} 与已确认的更新不一致，请先处理现有 merge 状态：${p.workspace}`);
    }
    for (const name of Object.keys(expected)) await writeFile(paths[name], expected[name]);
  }
  async function continueRefresh(state, p) {
    const pending = state.pendingSource;
    await assertWorkflow(pending.sourceCommit);
    const local = await localRef(`refs/heads/${state.branch}`);
    if (!local) await git(["branch", state.branch, pending.releaseCommit || pending.baseCommit]);
    await ensureWorkspace(p, state.branch);
    let candidate = await git(["rev-parse", "HEAD"], p.workspace);
    if (candidate === pending.baseCommit) {
      const dirty = await git(["status", "--porcelain", "--untracked-files=all"], p.workspace);
      if (dirty) {
        const stagedTree = await git(["write-tree"], p.workspace);
        const unstaged = await git(["diff", "--name-only"], p.workspace);
        const untracked = await git(["ls-files", "--others", "--exclude-standard"], p.workspace);
        if (stagedTree !== pending.tree || unstaged || untracked) throw new Error(`候选更新的工作区包含事务之外的改动，请先处理已有改动再恢复：${p.workspace}`);
      } else await git(["read-tree", "--reset", "-u", pending.tree], p.workspace);
      await prepareRefreshMerge(p, pending, state.version);
      await git(["commit", "--allow-empty", "-m", `Refresh release ${state.version}`, "-m", `Pi-Ark-Source: ${pending.sourceCommit}`], p.workspace);
      candidate = await git(["rev-parse", "HEAD"], p.workspace);
    }
    if (pending.releaseCommit && candidate !== pending.releaseCommit) throw new Error("候选更新的 commit 与待完成状态不一致。");
    const parents = (await git(["show", "-s", "--format=%P", candidate])).split(" ");
    const sourceParent = parents[1] === pending.sourceCommit || parents.length === 1 && pending.sourceCommit === pending.baseCommit;
    if (parents[0] !== pending.baseCommit || !sourceParent || parents.length > 2 || !await isAncestor(pending.sourceCommit, candidate) || await git(["rev-parse", `${candidate}^{tree}`]) !== pending.tree || await inferSource(candidate, state.version) !== pending.sourceCommit) throw new Error("候选更新的历史、tree 或来源与已确认的事务不一致。");
    if (await git(["status", "--porcelain", "--untracked-files=all"], p.workspace)) throw new Error(`候选更新的工作区包含后续改动：${p.workspace}`);
    pending.releaseCommit = candidate;
    await save(state, p);
    const remote = await remoteRef(`refs/heads/${state.branch}`);
    if (remote && remote !== pending.baseCommit && remote !== candidate) throw new Error(`${state.branch} 的远端候选已变化，请确认后继续更新。`);
    await git(["push", "--set-upstream", "origin", `refs/heads/${state.branch}:refs/heads/${state.branch}`], p.workspace);
    const completed = { ...state, sourceCommit: pending.sourceCommit, source: pending.source, releaseCommit: candidate, previous: pending.previous, phase: "prepared", pushedAt: new Date().toISOString() };
    delete completed.pendingSource;
    delete completed.candidateRunId;
    delete completed.publishedAt;
    await save(completed, p);
    showPrepared(completed);
    return completed;
  }
  async function prepare(options) {
    const { version } = options;
    if (options.refresh && !options.source) throw new Error("--refresh 需要 --source <新的已确认 Git ref>。");
    const p = paths(version);
    return withLock(p, async () => {
      let state = await load(version, p);
      const remoteTag = await remoteRef(`refs/tags/v${version}`);
      const localTag = await localRef(`refs/tags/v${version}`);
      if ((options.refresh || state?.pendingSource) && (remoteTag || localTag)) throw new Error(`正式 tag v${version} 已存在，候选源码更新已停止。请确认现有正式发布。`);
      if (options.refresh && !state?.releaseCommit) throw new Error("--refresh 需要已准备的候选版本，请先执行普通 prepare。");
      let source;
      if (options.source) source = { type: "ref", ref: options.source, sourceCommit: await resolveSource(options.source) };
      else if (!state) source = await runningSource({ prefix: options.prefix, serviceName: options.serviceName, execute: (file, args, options) => execute(file, args, { ...options, env: { ...env, TMPDIR: p.temporary, TMP: p.temporary, TEMP: p.temporary } }) });
      if (state?.pendingSource) {
        if (source && source.sourceCommit !== state.pendingSource.sourceCommit) throw new Error(`候选更新已固定新的来源 ${state.pendingSource.sourceCommit}，请先恢复当前更新。`);
        return continueRefresh(state, p);
      }
      if (options.refresh && (source.sourceCommit !== state.sourceCommit || !await isAncestor(source.sourceCommit, state.releaseCommit))) {
        await assertWorkflow(source.sourceCommit);
        await assertCandidate(state.releaseCommit, state.sourceCommit, version);
        await ensureWorkspace(p, state.branch);
        if (await git(["rev-parse", "HEAD"], p.workspace) !== state.releaseCommit || await git(["status", "--porcelain", "--untracked-files=all"], p.workspace)) throw new Error(`候选工作区需要保持在已固定的 commit，并先处理已有改动：${p.workspace}`);
        for (const path of Object.values(await mergeStatePaths(p))) if (await optionalText(path) !== undefined) throw new Error(`候选工作区存在尚待处理的 merge 状态，请先处理现有操作：${p.workspace}`);
        const remote = await remoteRef(`refs/heads/${state.branch}`);
        if (remote && remote !== state.releaseCommit) throw new Error(`${state.branch} 的远端候选与已固定的 commit 不一致。`);
        const tree = await candidateTree(source.sourceCommit, version, p);
        state.pendingSource = { sourceCommit: source.sourceCommit, source, baseCommit: state.releaseCommit, tree, previous: { sourceCommit: state.sourceCommit, source: state.source, releaseCommit: state.releaseCommit, pushedAt: state.pushedAt }, createdAt: new Date().toISOString() };
        await save(state, p);
        return continueRefresh(state, p);
      }
      if (state && source && state.sourceCommit !== source.sourceCommit) throw new Error(`正式版本 ${version} 已固定来源 ${state.sourceCommit}；本次 --source 指向 ${source.sourceCommit}。请使用原来源恢复，或在正式 tag 创建前显式使用 --refresh --source。`);
      const sourceCommit = state?.sourceCommit || source.sourceCommit;
      await resolveSource(sourceCommit);
      const recordedSource = source || state?.source;
      if (recordedSource?.type === "instance") {
        const sourceVersion = (await jsonAt(sourceCommit, "package.json")).version;
        if (sourceVersion !== recordedSource.runningVersion) throw new Error(`实际运行版本 ${recordedSource.runningVersion} 与来源 commit 的 package.json.version ${sourceVersion} 不一致。请确认构建来源，或使用 --source <负责人已确认的 commit>。`);
      }
      await assertWorkflow(sourceCommit);
      const branch = `release/${version}`;
      if ((remoteTag || localTag) && (!state?.releaseCommit || [remoteTag, localTag].some((commit) => commit && commit !== state.releaseCommit))) throw new Error(`正式版本 v${version} 已有 tag；请确认现有发布或指定新的正式版本。`);
      state ||= { schemaVersion: 1, version, repository, branch, workspace: p.workspace, sourceCommit, source, phase: "preparing", createdAt: new Date().toISOString() };
      await save(state, p);
      const local = await localRef(`refs/heads/${branch}`);
      const remote = await remoteRef(`refs/heads/${branch}`);
      const target = local || state.releaseCommit || remote || sourceCommit;
      if (target !== sourceCommit) await assertCandidate(target, sourceCommit, version);
      if (state.releaseCommit && target !== state.releaseCommit) throw new Error(`${branch} 已离开状态中固定的候选 commit。`);
      if (remote && remote !== target) {
        await git(["fetch", "--no-tags", "origin", `refs/heads/${branch}`]);
        if (!await isAncestor(remote, target)) throw new Error(`${branch} 的本地与远端 commit 冲突；请确认现有候选分支。`);
      }
      if (!local) await git(["branch", branch, target]);
      await ensureWorkspace(p, branch);
      let candidate = await git(["rev-parse", "HEAD"], p.workspace);
      if (candidate === sourceCommit && !state.releaseCommit) {
        const changed = (await git(["status", "--porcelain", "--untracked-files=all"], p.workspace)).split("\n").filter(Boolean);
        if (changed.some((line) => !packageFiles.includes(line.slice(3)))) throw new Error(`发布工作区含有版本文件之外的改动：${p.workspace}`);
        for (const file of packageFiles) {
          const original = await jsonAt(sourceCommit, file);
          const current = JSON.parse(await readFile(join(p.workspace, file), "utf8"));
          if (!isDeepStrictEqual(current, original) && !isDeepStrictEqual(current, versionedJson(file, original, version))) throw new Error(`发布工作区的 ${file} 含有版本更新之外的改动。`);
          await writeFile(join(p.workspace, file), `${JSON.stringify(versionedJson(file, original, version), null, 2)}\n`);
        }
        await git(["add", "--", ...packageFiles], p.workspace);
        if (await git(["diff", "--cached", "--name-only"], p.workspace)) await git(["commit", "-m", `Prepare release ${version}`, "-m", `Pi-Ark-Source: ${sourceCommit}`], p.workspace);
        candidate = await git(["rev-parse", "HEAD"], p.workspace);
      } else if (await git(["status", "--porcelain"], p.workspace)) throw new Error(`已固定的候选工作区包含后续改动：${p.workspace}`);
      await assertCandidate(candidate, sourceCommit, version);
      if (state.releaseCommit && state.releaseCommit !== candidate) throw new Error("候选 commit 与已保存的发布状态不一致。");
      state.releaseCommit = candidate;
      state.phase = remoteTag ? "published" : "prepared";
      await save(state, p);
      await git(["push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`], p.workspace);
      state.pushedAt ||= new Date().toISOString();
      await save(state, p);
      showPrepared(state);
      return state;
    });
  }
  async function pages(path, key) {
    const output = [];
    for (let page = 1; ; page += 1) {
      const data = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const items = key ? data[key] : data;
      if (!Array.isArray(items)) throw new Error(`GitHub API 返回格式异常：${path}`);
      output.push(...items);
      if (items.length < 100) return output;
    }
  }
  async function failureDetails(jobs) {
    for (const job of jobs.filter((item) => item.conclusion && !["success", "skipped"].includes(item.conclusion))) {
      log(`失败 job：${job.name} ${job.html_url || ""}`);
      if (!job.check_run_url) continue;
      try {
        const check = await api(job.check_run_url);
        const annotations = await pages(`${job.check_run_url}/annotations`);
        const native = annotations.filter((item) => item.title === "Native CI command failed");
        for (const item of native.length ? native : annotations.filter((item) => item.annotation_level === "failure")) log(`${item.title || "CI error"}\n${item.message || item.raw_details || ""}`);
        if (!annotations.length && check.output) log([check.output.title, check.output.summary, check.output.text].filter(Boolean).join("\n"));
      } catch (error) { log(`读取失败摘要时发生错误：${error.message}`); }
    }
  }
  async function publication(version) {
    try { return await api(`/releases/tags/v${version}`); }
    catch (error) { if (error.status === 404 || error.status === undefined && /GitHub(?: API)? HTTP 404\b/.test(error.message)) return undefined; throw error; }
  }
  async function inspectPublication(state, context = {}) {
    const release = await publication(state.version);
    const url = `${webBase}/releases/tag/v${state.version}`;
    if (!release) {
      log(`正式 Release 尚待生成，继续等待安装包交付：${url}`);
      return { ...context, done: false, formal: true };
    }
    try { verifyPublishedRelease(release, state.version, { repository }); }
    catch (error) {
      log(error.message);
      return { ...context, done: true, success: false, formal: true, release, error: error.message };
    }
    log(`正式发布已完成，安装包已交付：${release.html_url || url}`);
    return { ...context, done: true, success: true, formal: true, release };
  }
  async function inspect(state) {
    const tag = await remoteRef(`refs/tags/v${state.version}`);
    if (tag && tag !== state.releaseCommit) throw new Error(`远端 tag v${state.version} 指向 ${tag}，候选 commit 为 ${state.releaseCommit}。请确认现有发布。`);
    const formal = Boolean(tag);
    const runs = (await pages(`/actions/workflows/release.yml/runs?head_sha=${state.releaseCommit}`, "workflow_runs"))
      .filter((run) => run.head_sha === state.releaseCommit && run.event === "push" && run.head_branch === (formal ? `v${state.version}` : state.branch))
      .sort((a, b) => Number(b.id) - Number(a.id));
    const run = runs[0];
    const link = `${webBase}/actions/workflows/release.yml`;
    if (!run) {
      if (formal) return inspectPublication(state);
      log(`等待候选构建 workflow：${link}`);
      return { done: false, formal };
    }
    log(`${formal ? "正式发布" : "候选构建"}：${run.status}${run.conclusion ? ` / ${run.conclusion}` : ""}\n${run.html_url}`);
    const jobs = await pages(`/actions/runs/${run.id}/jobs`, "jobs");
    for (const job of jobs) {
      log(`  ${job.name}: ${job.status}${job.conclusion ? ` / ${job.conclusion}` : ""}`);
      for (const step of job.steps || []) log(`    ${step.name}: ${step.status}${step.conclusion ? ` / ${step.conclusion}` : ""}`);
    }
    if (run.status !== "completed") return { done: false, formal, run, jobs };
    if (run.conclusion !== "success") {
      await failureDetails(jobs);
      return { done: true, success: false, formal, run, jobs };
    }
    if (formal) return inspectPublication(state, { run, jobs });
    const verified = await (await helpers()).findVerifiedCandidate({ repository, commit: state.releaseCommit, version: state.version, token, fetchImpl });
    log(`候选版本已验证：${verified.url}\n正式发布：npm run release:publish -- --version ${state.version}`);
    return { done: true, success: true, formal, run, jobs };
  }
  async function status(options) {
    const p = paths(options.version);
    await mkdir(p.temporary, { recursive: true });
    const state = await load(options.version, p);
    if (!state?.releaseCommit) throw new Error(`版本 ${options.version} 的候选 commit 尚待准备。请执行 release:prepare。`);
    if (state.pendingSource) throw new Error(`候选源码更新尚待完成，请执行 npm run release:prepare -- --version ${options.version} 恢复。`);
    await assertCandidate(state.releaseCommit, state.sourceCommit, state.version);
    for (;;) {
      const result = await inspect(state);
      if (!options.watch || result.done) return result;
      await sleep((options.interval || (token ? 30 : 180)) * 1000);
    }
  }
  async function publish(options) {
    const p = paths(options.version);
    const state = await withLock(p, async () => {
      const current = await load(options.version, p);
      if (!current?.releaseCommit) throw new Error(`请先为 ${options.version} 执行 release:prepare。`);
      if (current.pendingSource) throw new Error(`候选源码更新尚待完成，请执行 npm run release:prepare -- --version ${options.version} 恢复。`);
      const tag = `v${current.version}`;
      const remote = await remoteRef(`refs/tags/${tag}`);
      const local = await localRef(`refs/tags/${tag}`);
      for (const [place, commit] of [["origin", remote], ["本地", local]]) if (commit && commit !== current.releaseCommit) throw new Error(`${place} tag ${tag} 指向 ${commit}，候选 commit 为 ${current.releaseCommit}。请确认现有发布。`);
      if (remote) {
        const release = await publication(current.version);
        if (release) {
          let complete = false;
          try { verifyPublishedRelease(release, current.version, { repository }); complete = true; }
          catch (error) { log(error.message); }
          if (complete) {
            current.phase = "published";
            current.publishedAt ||= release.published_at || new Date().toISOString();
            await save(current, p);
            log(`现有正式发布的安装包已完整交付：${release.html_url || `${webBase}/releases/tag/${tag}`}`);
            return { ...current, done: true, success: true, formal: true, release };
          }
        }
      }
      await assertWorkflow(current.sourceCommit);
      await assertCandidate(current.releaseCommit, current.sourceCommit, current.version);
      const remoteBranch = await remoteRef(`refs/heads/${current.branch}`);
      if (remoteBranch !== current.releaseCommit) throw new Error(`远端候选分支 ${current.branch} 与固定的候选 commit 不一致；请确认后继续。`);
      const candidate = await (await helpers()).findVerifiedCandidate({ repository, commit: current.releaseCommit, version: current.version, token, fetchImpl });
      if (candidate.commit !== current.releaseCommit || candidate.version !== current.version || candidate.artifacts?.length !== 5) throw new Error("候选构建需要与 commit 和版本一致，并包含 5 个平台 artifact。");
      if (!local && remote) await git(["fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`], repo, p.temporary);
      else if (!local) await git(["tag", "-a", tag, current.releaseCommit, "-m", `Release ${current.version}`], repo, p.temporary);
      if (!remote) await git(["push", "origin", `refs/tags/${tag}:refs/tags/${tag}`], repo, p.temporary);
      current.phase = "published";
      current.candidateRunId = candidate.runId;
      current.publishedAt ||= new Date().toISOString();
      await save(current, p);
      log(`正式 tag：${webBase}/tree/${tag}\n正式 workflow：${webBase}/actions/workflows/release.yml\n正式 Release：${webBase}/releases/tag/${tag}\n继续查询：npm run release:status -- --version ${current.version} --watch`);
      return current;
    });
    return options.watch && !state.done ? status(options) : state;
  }
  return { prepare, status, publish };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) { (dependencies.log || console.log)(help); return; }
  const result = await createReleaseProcess(dependencies)[options.command](options);
  if (result?.done && result.success === false) process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`发布流程：${error.message}`); process.exitCode = 1; });
}
