import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSearchIndex } from "../apps/server/src/file-search.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-file-search-"));

try {
  await mkdir(join(directory, "apps", "server", "src"), { recursive: true });
  await mkdir(join(directory, "docs"), { recursive: true });
  await mkdir(join(directory, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(directory, "README.md"), "# readme");
  await writeFile(join(directory, "apps", "server", "src", "file-search.ts"), "");
  await writeFile(join(directory, "apps", "server", "src", "webfetch.ts"), "");
  await writeFile(join(directory, "docs", "architecture.md"), "");
  await writeFile(join(directory, "node_modules", "pkg", "index.js"), "");

  const index = new FileSearchIndex();
  const first = await index.search(directory, "webfetch");
  assert.equal(first.entries[0]?.path, "apps/server/src/webfetch.ts", "exact basename match ranks first");
  assert.equal(first.cached, false, "the first search builds the list");

  const second = await index.search(directory, "webfetch");
  assert.equal(second.cached, true, "the second search reuses the list");
  assert.equal(second.builtAt, first.builtAt);

  const readme = await index.search(directory, "readme");
  assert.equal(readme.entries[0]?.path, "README.md", "case-insensitive match works");

  const subsequence = await index.search(directory, "fsrch");
  assert.ok(subsequence.entries.some((entry) => entry.path === "apps/server/src/file-search.ts"), "subsequence matching works");

  const none = await index.search(directory, "zzzz-nothing");
  assert.equal(none.entries.length, 0, "an unmatched query returns nothing");

  const empty = await index.search(directory, "");
  assert.equal(empty.entries[0]?.path, "README.md", "an empty query lists shallow paths first");

  const limited = await index.search(directory, "s", { limit: 1 });
  assert.equal(limited.entries.length, 1, "limit caps the result count");

  await writeFile(join(directory, "new-file.ts"), "");
  const refreshed = await index.search(directory, "new-file", { refresh: true });
  assert.equal(refreshed.entries[0]?.path, "new-file.ts", "refresh rebuilds the list");
  assert.equal(refreshed.cached, true);

  console.log("file search checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
