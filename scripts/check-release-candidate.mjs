import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findVerifiedCandidate, githubJson, RELEASE_ARTIFACT_NAMES } from "./release-candidate.mjs";

const commit = "a".repeat(40);
const version = "0.1.6";
const repository = "example/pi-ark";
const url = `https://github.com/${repository}/actions/runs/123`;
const run = { id: 123, html_url: url, event: "push", head_sha: commit, head_branch: `release/${version}`, status: "completed", conclusion: "success" };
const artifacts = RELEASE_ARTIFACT_NAMES.map((name, index) => ({ id: index + 1, name, expired: false, expires_at: "2999-01-01T00:00:00Z" }));
const packageContent = (value) => ({ encoding: "base64", content: Buffer.from(JSON.stringify({ version: value })).toString("base64") });
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, statusText: status === 200 ? "OK" : "Forbidden", json: async () => value, text: async () => JSON.stringify(value) });
function fixture({ runs = [run], files = artifacts, sourceVersion = version } = {}) {
  const calls = [];
  const fetchImpl = async (address, options) => {
    const request = new URL(address);
    calls.push({ request, options });
    assert.equal(request.origin, "https://api.github.com");
    assert.ok(request.pathname.startsWith(`/repos/${repository}/`));
    if (request.pathname.endsWith("/contents/package.json")) {
      assert.equal(request.searchParams.get("ref"), commit);
      return response(packageContent(sourceVersion));
    }
    if (request.pathname.endsWith("/actions/workflows/release.yml/runs")) {
      assert.equal(request.searchParams.get("event"), "push");
      assert.equal(request.searchParams.get("branch"), `release/${version}`);
      assert.equal(request.searchParams.get("head_sha"), commit);
      return response({ total_count: runs.length, workflow_runs: runs });
    }
    if (/\/actions\/runs\/\d+\/artifacts$/.test(request.pathname)) return response({ total_count: files.length, artifacts: files });
    throw new Error(`Unexpected API request: ${address}`);
  };
  return { fetchImpl, calls };
}
const find = (settings = {}) => findVerifiedCandidate({ repository, commit, version, token: "", ...settings });
const verified = fixture();
assert.deepEqual(await find(verified), { runId: run.id, url, commit, version, artifacts: artifacts.map(({ id, name }) => ({ id, name })) });
assert.equal(verified.calls.length, 3);
assert.ok(verified.calls.every((call) => !("Authorization" in call.options.headers)));
const authenticated = fixture();
await find({ ...authenticated, token: "supplied-token" });
assert.ok(authenticated.calls.every((call) => call.options.headers.Authorization === "Bearer supplied-token"));
const originalTokens = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
try {
  process.env.GH_TOKEN = "gh-environment-token";
  process.env.GITHUB_TOKEN = "github-environment-token";
  for (const expected of ["gh-environment-token", "github-environment-token"]) {
    const environment = fixture();
    await find({ ...environment, token: undefined });
    assert.ok(environment.calls.every((call) => call.options.headers.Authorization === `Bearer ${expected}`));
    delete process.env.GH_TOKEN;
  }
} finally {
  for (const [key, value] of Object.entries(originalTokens)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

for (const source of [{ event: "workflow_dispatch" }, { head_branch: "main" }, { head_sha: "b".repeat(40) }]) {
  await assert.rejects(find(fixture({ runs: [{ ...run, ...source }] })), (error) => error.message.includes("Run source mismatch") && error.message.includes(url));
}
await assert.rejects(find(fixture({ sourceVersion: "0.1.6-dev.0" })), /Candidate version mismatch: expected 0\.1\.6, package\.json contains 0\.1\.6-dev\.0: https:\/\/github.com\/example\/pi-ark\/blob\//);
for (const state of [{ status: "queued", conclusion: null }, { status: "in_progress", conclusion: null }, { status: "completed", conclusion: "failure" }, { status: "completed", conclusion: "cancelled" }]) {
  await assert.rejects(find(fixture({ runs: [{ ...run, ...state }] })), (error) => error.message.includes(`status=${state.status}, conclusion=${state.conclusion ?? "pending"}`) && error.message.includes(url));
}
await assert.rejects(find(fixture({ runs: [] })), /No push run for this branch and commit; push the release branch/);
for (const name of RELEASE_ARTIFACT_NAMES) {
  await assert.rejects(find(fixture({ files: artifacts.filter((artifact) => artifact.name !== name) })), (error) => error.message.includes(`${name}: expected one artifact, received 0`) && error.message.includes(url));
  await assert.rejects(find(fixture({ files: artifacts.map((artifact) => artifact.name === name ? { ...artifact, expired: true } : artifact) })), (error) => error.message.includes(`${name}: expired`) && error.message.includes(url));
}
await assert.rejects(find(fixture({ files: [...artifacts, artifacts[0]] })), /pi-ark-linux-x64: expected one artifact, received 2/);
await assert.rejects(find(fixture({ files: artifacts.map((artifact, index) => index ? artifact : { ...artifact, expires_at: "2000-01-01T00:00:00Z" }) })), /pi-ark-linux-x64: expired/);
await assert.rejects(find(fixture({ files: artifacts.map((artifact, index) => index ? artifact : { ...artifact, id: 0 }) })), /pi-ark-linux-x64: invalid artifact id=0/);
assert.equal((await find(fixture({ files: [...artifacts, { id: 99, name: "diagnostics-linux-x64", expired: false }] }))).artifacts.length, 5);
assert.equal((await find(fixture({ runs: [{ ...run, id: 124, status: "in_progress", conclusion: null }, run] }))).runId, 123);
await assert.rejects(find({ ...fixture(), commit: "short" }), /Expected a full commit SHA/);
await assert.rejects(find({ ...fixture(), version: "0.1.6-dev.0" }), /Expected a formal release version/);

// Exercise pagination even when the release artifacts appear after diagnostic artifacts.
const paged = fixture();
const baseFetch = paged.fetchImpl;
paged.fetchImpl = async (address, options) => {
  const request = new URL(address);
  if (request.pathname.endsWith("/artifacts")) {
    const diagnostics = Array.from({ length: 100 }, (_, index) => ({ id: index + 100, name: `diagnostics-${index}`, expired: false }));
    return response({ total_count: 105, artifacts: request.searchParams.get("page") === "1" ? diagnostics : artifacts });
  }
  return baseFetch(address, options);
};
assert.equal((await find(paged)).artifacts.length, 5);
const manyRuns = Array.from({ length: 100 }, (_, index) => ({ ...run, id: index + 1000, status: "completed", conclusion: "failure" }));
const runPages = fixture();
const baseRunFetch = runPages.fetchImpl;
runPages.fetchImpl = async (address, options) => {
  const request = new URL(address);
  if (request.pathname.endsWith("/release.yml/runs")) return response({ total_count: 101, workflow_runs: request.searchParams.get("page") === "1" ? manyRuns : [run] });
  return baseRunFetch(address, options);
};
assert.equal((await find(runPages)).runId, 123);

const fullApi = `https://api.github.com/repos/${repository}/actions/runs/123`;
assert.deepEqual(await githubJson(fullApi, { token: "", fetchImpl: async (address) => { assert.equal(address, fullApi); return response({ id: 123 }); } }), { id: 123 });
await assert.rejects(githubJson("/actions/runs", { repository, token: "", fetchImpl: async () => response({ message: "API rate limit exceeded" }, 403) }), (error) => error.status === 403 && /HTTP 403 Forbidden: https:\/\/api.github.com\/repos\/example\/pi-ark\/actions\/runs: .*API rate limit exceeded/.test(error.message));
await assert.rejects(githubJson("/actions/runs", { repository, token: "", fetchImpl: async () => { throw new Error("network unavailable"); } }), /GitHub API request failed: https:.*network unavailable/);
await assert.rejects(githubJson("https://example.com/credentials", { token: "secret" }), /Expected a GitHub API URL/);
await assert.rejects(find({ fetchImpl: async () => response({ encoding: "base64", content: "invalid" }) }), /Cannot read candidate package.json: https:\/\/github.com\//);

const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
assert.ok(workflow.includes("if: ${{ !startsWith(github.ref, 'refs/tags/') }}"));
assert.ok(workflow.includes("if: success() && steps.release_build.outcome == 'success' && steps.release_smoke.outcome == 'success'"));
const publish = workflow.slice(workflow.indexOf("  publish:"));
assert.ok(!publish.includes("needs: build"));
assert.ok(publish.includes("actions: read"));
assert.ok(publish.includes("run-id: ${{ steps.candidate.outputs.run-id }}"));
assert.ok(publish.includes("artifact-ids: ${{ steps.candidate.outputs.artifact-ids }}"));
const archiveScript = publish.split("          node --input-type=module <<'NODE'\n")[1].split("          NODE")[0].replace(/^          /gm, "").replace("'./scripts/release-candidate.mjs'", JSON.stringify(new URL("./release-candidate.mjs", import.meta.url).href));
const base = resolve(import.meta.dirname, "../.tmp/release-candidate-check");
await mkdir(base, { recursive: true });
const temporary = await mkdtemp(join(base, "fixture-"));
try {
  const archiveDirectory = join(temporary, "artifacts");
  await mkdir(archiveDirectory);
  const names = RELEASE_ARTIFACT_NAMES.map((name) => `${name.replace("pi-ark-", `pi-ark-${version}-`)}.${name.includes("win32") ? "zip" : "tar.gz"}`);
  for (const name of names) await writeFile(join(archiveDirectory, name), "fixture");
  const checkArchives = () => execFileSync(process.execPath, ["--input-type=module", "--eval", archiveScript], { cwd: temporary, env: { ...process.env, RELEASE_VERSION: version }, encoding: "utf8", stdio: "pipe" });
  assert.match(checkArchives(), /Verified release archives/);
  await writeFile(join(archiveDirectory, "pi-ark-wrong-version-linux-x64.tar.gz"), "fixture");
  assert.throws(checkArchives, /Candidate archive filename list must match/);
  await rm(join(archiveDirectory, "pi-ark-wrong-version-linux-x64.tar.gz"));
  await rm(join(archiveDirectory, names[0]));
  assert.throws(checkArchives, /Candidate archive filename list must match/);
  await mkdir(join(archiveDirectory, names[0]));
  assert.throws(checkArchives, /Candidate artifacts must contain archive files/);

  await writeFile(join(temporary, "package.json"), JSON.stringify({ version }));
  const script = resolve("scripts/release-candidate.mjs");
  const output = join(temporary, "github-output");
  // The CLI receives the same fixture API without a network connection.
  const cliMock = `const commit=${JSON.stringify(commit)},version=${JSON.stringify(version)},repository=${JSON.stringify(repository)},run=${JSON.stringify(run)},artifacts=${JSON.stringify(artifacts)}; const packageContent=${packageContent.toString()}; const response=${response.toString()}; const assert=(await import('node:assert/strict')).default; const fixture=${fixture.toString()}; globalThis.fetch=fixture().fetchImpl; process.argv=[process.execPath,${JSON.stringify(script)},'--commit',commit,'--version',version,'--repository',repository]; await import(${JSON.stringify(pathToFileURL(script).href)});`;
  execFileSync(process.execPath, ["--input-type=module", "--eval", cliMock], { cwd: temporary, env: { ...process.env, GITHUB_REF: `refs/tags/v${version}`, GITHUB_OUTPUT: output, GH_TOKEN: "", GITHUB_TOKEN: "" }, stdio: "pipe" });
  assert.match(await readFile(output, "utf8"), /run-id=123\nartifact-ids=1,2,3,4,5\nversion=0\.1\.6\n/);
  assert.throws(() => execFileSync(process.execPath, [script, "--commit", commit, "--version", "0.1.7"], { cwd: temporary, stdio: "pipe" }), /Release version mismatch/);
  assert.throws(() => execFileSync(process.execPath, [script, "--commit", commit, "--version", version], { cwd: temporary, env: { ...process.env, GITHUB_REF: "refs/tags/v0.1.7" }, stdio: "pipe" }), /Release tag mismatch/);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log("Release candidate checks passed");
