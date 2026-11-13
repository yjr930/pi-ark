#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const repository = "yjr930/pi-ark";
const stableTag = /^v(\d+)\.(\d+)\.(\d+)$/;

function parseTag(tag) {
  const match = stableTag.exec(tag);
  if (!match) return undefined;
  return match.slice(1).map(Number);
}

function compareTags(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function previousReleaseTag(tags, version) {
  const current = parseTag(`v${version}`);
  if (!current) throw new Error(`正式版本需要稳定的 SemVer：${version}`);
  return tags
    .filter((tag) => parseTag(tag))
    .map((tag) => ({ tag, parts: parseTag(tag) }))
    .filter(({ parts }) => compareTags(parts, current) < 0)
    .sort((left, right) => compareTags(left.parts, right.parts))
    .at(-1)?.tag;
}

export function buildReleaseNotes({ version, previousTag, commits, date }) {
  const lines = [`# Pi-Ark ${version}`, "", `发布日期：${date}`, "", "## 主要变更", ""];
  for (const commit of commits) lines.push(`- ${commit.subject}（${commit.short}）`);
  if (!commits.length) lines.push("- 本版本没有代码变更");
  lines.push("", "## 完整变更", "");
  lines.push(previousTag ? `https://github.com/${repository}/compare/${previousTag}...v${version}` : `https://github.com/${repository}/releases/tag/v${version}`);
  return `${lines.join("\n")}\n`;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trimEnd();
}

function main() {
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  if (!parseTag(`v${version}`)) throw new Error(`正式版本需要稳定的 SemVer：${version}`);
  const previousTag = previousReleaseTag(git("tag", "--list", "v*").split("\n").filter(Boolean), version);
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const commits = git("log", "--format=%h%x09%s", range).split("\n").filter(Boolean).map((line) => {
    const [short, ...subject] = line.split("\t");
    return { short, subject: subject.join("\t") };
  }).filter(({ subject }) => !/^(?:Prepare|Refresh) (?:development version|release) /.test(subject));
  const date = new Date().toISOString().slice(0, 10);
  process.stdout.write(buildReleaseNotes({ version, previousTag, commits, date }));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
