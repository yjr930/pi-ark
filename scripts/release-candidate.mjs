import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_ARTIFACT_NAMES = ["pi-ark-linux-x64", "pi-ark-linux-arm64", "pi-ark-darwin-x64", "pi-ark-darwin-arm64", "pi-ark-win32-x64"];

// Relative paths start after /repos/<repository>; absolute URLs use the public GitHub API.
export async function githubJson(path, { repository = "yjr930/pi-ark", token, fetchImpl = fetch } = {}) {
  const url = new URL(path.startsWith("/") ? `https://api.github.com/repos/${repository}${path}` : path);
  if (url.origin !== "https://api.github.com") throw new Error(`Expected a GitHub API URL, received ${url.href}`);
  token ??= process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  let response;
  try {
    response = await fetchImpl(url.href, { signal: AbortSignal.timeout(30000), headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "pi-ark-release-candidate", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  } catch (error) {
    throw new Error(`GitHub API request failed: ${url.href}: ${error.message}`, { cause: error });
  }
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`GitHub API HTTP ${response.status} ${response.statusText || ""}: ${url.href}: ${detail}`);
    error.status = response.status;
    throw error;
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Invalid GitHub API JSON: ${url.href}: ${error.message}`, { cause: error });
  }
}

async function listPages(path, key, options) {
  const items = [];
  for (let page = 1; ; page++) {
    const result = await githubJson(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, options);
    if (!Array.isArray(result[key])) throw new Error(`GitHub API response is missing ${key}: ${path}`);
    items.push(...result[key]);
    if (result[key].length === 0 || items.length >= result.total_count || result[key].length < 100) return items;
  }
}

export async function findVerifiedCandidate({ repository = "yjr930/pi-ark", commit, version, token, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{40}$/i.test(commit || "")) throw new Error(`Expected a full commit SHA, received ${commit}`);
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error(`Expected a formal release version (for example 0.1.6), received ${version}`);
  const options = { repository, token, fetchImpl };
  const branch = `release/${version}`;
  const sourceUrl = `https://github.com/${repository}/blob/${commit}/package.json`;
  const source = await githubJson(`/contents/package.json?ref=${encodeURIComponent(commit)}`, options);
  let sourceVersion;
  try {
    if (source.encoding !== "base64" || typeof source.content !== "string") throw new Error("Expected base64 package.json content");
    sourceVersion = JSON.parse(Buffer.from(source.content, "base64").toString("utf8")).version;
  } catch (error) {
    throw new Error(`Cannot read candidate package.json: ${sourceUrl}: ${error.message}`, { cause: error });
  }
  if (sourceVersion !== version) throw new Error(`Candidate version mismatch: expected ${version}, package.json contains ${sourceVersion}: ${sourceUrl}`);
  const runs = await listPages(`/actions/workflows/release.yml/runs?event=push&branch=${encodeURIComponent(branch)}&head_sha=${encodeURIComponent(commit)}`, "workflow_runs", options);
  const workflowUrl = `https://github.com/${repository}/actions/workflows/release.yml?query=${encodeURIComponent(`branch:${branch}`)}`;
  const reasons = [];
  for (const run of runs) {
    const url = run.html_url || `https://github.com/${repository}/actions/runs/${run.id}`;
    if (run.event !== "push" || run.head_sha !== commit || run.head_branch !== branch) {
      reasons.push(`Run source mismatch: event=${run.event}, branch=${run.head_branch}, commit=${run.head_sha}: ${url}`);
      continue;
    }
    if (run.status !== "completed" || run.conclusion !== "success") {
      reasons.push(`Candidate status=${run.status}, conclusion=${run.conclusion ?? "pending"}: ${url}`);
      continue;
    }
    const artifacts = await listPages(`/actions/runs/${run.id}/artifacts`, "artifacts", options);
    const selected = [];
    const problems = [];
    for (const name of RELEASE_ARTIFACT_NAMES) {
      const matches = artifacts.filter((artifact) => artifact.name === name);
      if (matches.length !== 1) problems.push(`${name}: expected one artifact, received ${matches.length}`);
      else if (matches[0].expired || (matches[0].expires_at && Date.parse(matches[0].expires_at) <= Date.now())) problems.push(`${name}: expired (${matches[0].expires_at || "expired=true"})`);
      else if (!Number.isSafeInteger(matches[0].id) || matches[0].id <= 0) problems.push(`${name}: invalid artifact id=${matches[0].id}`);
      else selected.push({ id: matches[0].id, name });
    }
    if (problems.length) {
      reasons.push(`Candidate artifacts incomplete: ${problems.join("; ")}: ${url}`);
      continue;
    }
    return { runId: run.id, url, commit, version, artifacts: selected };
  }
  throw new Error(`No verified release candidate for ${branch} at ${commit}: ${workflowUrl}${reasons.length ? `\n${reasons.join("\n")}` : "\nNo push run for this branch and commit; push the release branch and wait for its Release workflow."}`);
}

async function main() {
  const args = process.argv.slice(2);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!["--commit", "--version", "--repository"].includes(key) || !args[index + 1] || args[index + 1].startsWith("--") || values[key]) throw new Error("Usage: node scripts/release-candidate.mjs --commit <sha> --version <version> [--repository <owner/repo>]");
    values[key] = args[index + 1];
  }
  const version = values["--version"];
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  if (manifest.version !== version) throw new Error(`Release version mismatch: requested ${version}, local package.json contains ${manifest.version}`);
  if (process.env.GITHUB_REF?.startsWith("refs/tags/") && process.env.GITHUB_REF !== `refs/tags/v${version}`) throw new Error(`Release tag mismatch: expected refs/tags/v${version}, received ${process.env.GITHUB_REF}`);
  const candidate = await findVerifiedCandidate({ repository: values["--repository"], commit: values["--commit"], version });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run-id=${candidate.runId}\nartifact-ids=${candidate.artifacts.map((artifact) => artifact.id).join(",")}\nversion=${candidate.version}\ncandidate-url=${candidate.url}\n`);
  console.log(JSON.stringify(candidate, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
