#!/usr/bin/env node
// PDF 双通道阅读的辅助脚本：文字通道用 pdftotext，图片通道用 pdftoppm。
// 依赖 poppler 的四个命令：pdfinfo、pdftotext、pdfimages、pdftoppm。脚本只用 Node 标准库。

import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 512 * 1024 * 1024;
const DEFAULT_DPI = 150;
const MAX_DPI = 300;
const TABLE_PREVIEW_PAGES = 40;
const TABLE_ROW_MIN_SEGMENTS = 3;
const LARGE_IMAGE_MIN_EDGE = 200;
const BATCH_NOTE_THRESHOLD = 20;

const USAGE = `用法：
  node pdf.mjs probe <file.pdf>
      输出页数、每页文字量、表格状行数、大图数量与建议通道。

  node pdf.mjs text <file.pdf> [--pages 1-5,8] [--layout] [--out <file>]
      抽取文字通道。--layout 保留原始横向排版，适合表格页；默认按阅读顺序输出。
      --out 把结果写入文件，再用 read 工具分段读取。

  node pdf.mjs pages <file.pdf> (--pages 3,7-9 | --all) [--dpi 150] [--format jpeg|png] [--out <dir>]
      渲染页面图片通道，每个页面生成一个文件，并打印文件路径。

页范围写法：3、1-5、2-4,9,12-。`;

function fail(message, exitCode = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

async function run(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: MAX_BUFFER, encoding: "utf8" });
    return stdout;
  } catch (error) {
    if (error?.code === "ENOENT") {
      const install = process.platform === "darwin" ? "brew install poppler" : "apt-get install -y poppler-utils";
      fail(`缺少命令 ${command}。先安装 poppler（Linux: ${install}；macOS: brew install poppler），再重新运行。`, 4);
    }
    const detail = String(error?.stderr || error?.message || error).trim();
    fail(`${command} 执行失败：${detail}`, 3);
  }
}

function parseArgs(argv) {
  const options = { pages: null, layout: false, out: null, dpi: DEFAULT_DPI, format: "jpeg", all: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--pages") options.pages = argv[++index] ?? fail("--pages 需要一个页范围");
    else if (token === "--layout") options.layout = true;
    else if (token === "--out") options.out = argv[++index] ?? fail("--out 需要一个路径");
    else if (token === "--dpi") options.dpi = Number(argv[++index]);
    else if (token === "--format") options.format = String(argv[++index] ?? "").toLowerCase();
    else if (token === "--all") options.all = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else if (token.startsWith("--")) fail(`未知选项 ${token}`);
    else positional.push(token);
  }
  return { options, positional };
}

function parsePageRange(spec, pageCount) {
  const pages = new Set();
  for (const part of spec.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) fail(`页范围写法无法解析：${token}`);
    const first = Number(match[1]);
    const last = match[2] ? Number(match[2]) : first;
    if (first < 1 || last < first) fail(`页范围写法无法解析：${token}`);
    if (last > pageCount) fail(`第 ${last} 页超出文档范围，这份文档有 ${pageCount} 页。`);
    for (let page = first; page <= last; page += 1) pages.add(page);
  }
  if (pages.size === 0) fail("页范围为空");
  return [...pages].sort((left, right) => left - right);
}

function compressPages(pages) {
  if (pages.length === 0) return "none";
  const parts = [];
  let first = pages[0];
  let previous = pages[0];
  for (const page of pages.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    parts.push(first === previous ? `${first}` : `${first}-${previous}`);
    first = page;
    previous = page;
  }
  parts.push(first === previous ? `${first}` : `${first}-${previous}`);
  return parts.join(", ");
}

function groupRanges(pages) {
  const ranges = [];
  let first = pages[0];
  let previous = pages[0];
  for (const page of pages.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    ranges.push([first, previous]);
    first = page;
    previous = page;
  }
  ranges.push([first, previous]);
  return ranges;
}

async function readInfo(file) {
  const output = await run("pdfinfo", [file]);
  const fields = new Map();
  for (const line of output.split("\n")) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const pages = Number.parseInt(fields.get("Pages") ?? "", 10);
  if (!Number.isFinite(pages) || pages < 1) fail(`无法从 pdfinfo 读取页数：${file}`, 3);
  return { pages, pageSize: fields.get("Page size") ?? "unknown", encrypted: fields.get("Encrypted") === "yes" };
}

async function extractRange(file, first, last, layout) {
  const args = ["-f", String(first), "-l", String(last), ...(layout ? ["-layout"] : []), file, "-"];
  const output = await run("pdftotext", args);
  const pages = output.split("\f");
  if (pages.length > 0 && pages[pages.length - 1].trim() === "") pages.pop();
  return pages;
}

// 按 \f 切分会与页面一一对应。遇到页数不一致的文档时逐页抽取，保证文字与页码对齐。
async function extractPages(file, first, last, layout) {
  const pages = await extractRange(file, first, last, layout);
  const expected = last - first + 1;
  if (pages.length === expected) return pages;
  const result = [];
  for (let page = first; page <= last; page += 1) {
    const single = await extractRange(file, page, page, layout);
    result.push(single[0] ?? "");
  }
  return result;
}

async function readLargeImages(file) {
  const output = await run("pdfimages", ["-list", file]);
  const counts = new Map();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+\d+\s+(\w+)\s+(\d+)\s+(\d+)\s/.exec(line);
    if (!match) continue;
    const page = Number(match[1]);
    const type = match[2];
    const width = Number(match[3]);
    const height = Number(match[4]);
    if (type !== "image" || width < LARGE_IMAGE_MIN_EDGE || height < LARGE_IMAGE_MIN_EDGE) continue;
    counts.set(page, (counts.get(page) ?? 0) + 1);
  }
  return counts;
}

function tableRowCount(text) {
  let rows = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length < 8) continue;
    if (trimmed.split(/\s{2,}/).length >= TABLE_ROW_MIN_SEGMENTS) rows += 1;
  }
  return rows;
}

function charCount(text) {
  return text.replace(/\s/g, "").length;
}

function lineCount(text) {
  return text.split("\n").filter((line) => line.trim()).length;
}

function hintFor(page) {
  if (page.chars < 50) return "render-required";
  if (page.images > 0 || page.rows >= 5) return "render-recommended";
  return "text-only";
}

async function probe(file) {
  const info = await readInfo(file);
  const texts = await extractPages(file, 1, info.pages, true);
  const imageCounts = await readLargeImages(file);
  const pages = texts.map((text, index) => {
    const page = { page: index + 1, chars: charCount(text), lines: lineCount(text), rows: tableRowCount(text), images: imageCounts.get(index + 1) ?? 0 };
    return { ...page, hint: hintFor(page) };
  });

  const byHint = (hint) => pages.filter((page) => page.hint === hint).map((page) => page.page);
  const lines = [
    `file: ${file}`,
    `pages: ${info.pages}`,
    `page-size: ${info.pageSize}`,
    `encrypted: ${info.encrypted ? "yes" : "no"}`,
    `chars: ${pages.reduce((sum, page) => sum + page.chars, 0)} total in the text layer`,
    `summary: text-only ${byHint("text-only").length} | render-recommended ${byHint("render-recommended").length} | render-required ${byHint("render-required").length}`,
    `render-required: ${compressPages(byHint("render-required"))}`,
    `render-recommended: ${compressPages(byHint("render-recommended"))}`,
  ];

  if (info.pages <= TABLE_PREVIEW_PAGES) {
    lines.push("", "page  chars  lines  rows  images  hint");
    for (const page of pages) {
      lines.push(`${String(page.page).padStart(4, " ")}  ${String(page.chars).padStart(5, " ")}  ${String(page.lines).padStart(5, " ")}  ${String(page.rows).padStart(4, " ")}  ${String(page.images).padStart(6, " ")}  ${page.hint}`);
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function textCommand(file, options) {
  const info = await readInfo(file);
  const requested = options.pages ? parsePageRange(options.pages, info.pages) : Array.from({ length: info.pages }, (_, index) => index + 1);
  const texts = new Map();
  for (const [first, last] of groupRanges(requested)) {
    const extracted = await extractPages(file, first, last, options.layout);
    extracted.forEach((text, index) => texts.set(first + index, text));
  }

  const blocks = [`file: ${file}`, `total-pages: ${info.pages}`, `pages: ${compressPages(requested)}`, `mode: ${options.layout ? "layout" : "reading-order"}`];
  for (const page of requested) {
    const text = (texts.get(page) ?? "").replace(/\s+$/, "");
    blocks.push("", `===== Page ${page} =====`, text.trim() ? text : "(no text layer on this page)");
  }
  const output = `${blocks.join("\n")}\n`;

  if (options.out) {
    const target = resolve(options.out);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, output, "utf8");
    const bytes = Buffer.byteLength(output);
    process.stdout.write(`wrote: ${target}\n`);
    process.stdout.write(`pages: ${compressPages(requested)} of ${info.pages}\n`);
    process.stdout.write(`size: ${Math.ceil(bytes / 1024)} KB\n`);
    process.stdout.write(`next: read ${target} with offset/limit to page through the text\n`);
    return;
  }
  process.stdout.write(output);
}

async function pagesCommand(file, options) {
  const info = await readInfo(file);
  if (!options.pages && !options.all) fail("渲染页面图片需要 --pages，例如 --pages 3,7-9；整份文档用 --all");
  const requested = options.all ? Array.from({ length: info.pages }, (_, index) => index + 1) : parsePageRange(options.pages, info.pages);
  if (!Number.isFinite(options.dpi) || options.dpi < 50 || options.dpi > MAX_DPI) fail(`--dpi 取值在 50 到 ${MAX_DPI} 之间`);
  if (options.format !== "jpeg" && options.format !== "png") fail("--format 取值是 jpeg 或 png");

  const stem = basename(file, extname(file));
  const directory = resolve(options.out ?? join(".tmp", "pdf", `${stem}-${options.dpi}dpi`));
  await mkdir(directory, { recursive: true });

  const extension = options.format === "jpeg" ? "jpg" : "png";
  const filter = options.format === "jpeg" ? ["-jpeg", "-jpegopt", "quality=85"] : ["-png"];
  const rendered = [];
  for (const page of requested) {
    const target = join(directory, `page-${String(page).padStart(3, "0")}`);
    await run("pdftoppm", [...filter, "-r", String(options.dpi), "-f", String(page), "-l", String(page), "-singlefile", file, target]);
    const path = `${target}.${extension}`;
    const { size } = await stat(path);
    rendered.push({ page, path, kilobytes: Math.ceil(size / 1024) });
  }

  const lines = [`out: ${directory}`, `rendered: ${rendered.length} page(s) at ${options.dpi} dpi (${options.format})`];
  for (const item of rendered) lines.push(`page ${item.page} -> ${item.path} (${item.kilobytes} KB)`);
  if (rendered.length > BATCH_NOTE_THRESHOLD) lines.push(`note: read the images in batches of ${BATCH_NOTE_THRESHOLD} or fewer, highest information pages first`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { options, positional } = parseArgs(rest);
  if (!command || command === "--help" || command === "-h" || options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!["probe", "text", "pages"].includes(command)) fail(`未知子命令 ${command}\n\n${USAGE}`);
  const target = positional[0] ?? fail(`${command} 需要 PDF 文件路径`);
  const file = resolve(target);

  try {
    const info = await stat(file);
    if (!info.isFile()) fail(`不是文件：${file}`);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`文件不存在：${file}`);
    throw error;
  }

  if (command === "probe") await probe(file);
  else if (command === "text") await textCommand(file, options);
  else await pagesCommand(file, options);
}

await main();
