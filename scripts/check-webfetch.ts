import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWebfetchTool } from "../apps/server/src/agent-tools/webfetch.ts";

const page = `<!doctype html><html><head><title>Check page</title>
<style>.hidden { color: red }</style>
<script>window.SCRIPT_MARKER = "SCRIPT_SHOULD_NOT_APPEAR";</script>
</head><body><h1>Pi-Ark check page</h1>
<p>First paragraph with a <a href="https://example.com/docs">documentation link</a>.</p>
<ul><li>Alpha</li><li>Beta</li></ul></body></html>`;

const server = createServer((request, response) => {
  if (request.url === "/page") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }
  if (request.url === "/data.json") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ items: [1, 2, 3] }));
    return;
  }
  if (request.url === "/redirect") {
    response.writeHead(302, { location: "/page" });
    response.end();
    return;
  }
  if (request.url === "/slow") {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("late");
    }, 3000);
    return;
  }
  if (request.url === "/binary") {
    response.writeHead(200, { "content-type": "application/pdf" });
    response.end("%PDF-1.4");
    return;
  }
  response.writeHead(404, { "content-type": "text/html" });
  response.end("<p>Not found</p>");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const tool = createWebfetchTool();
const detailsOf = (result: { details?: unknown }): Record<string, unknown> => result.details as Record<string, unknown>;
const textOf = (result: { content: Array<{ type: string; text?: string }> }): string => result.content.map((block) => block.text ?? "").join("\n");

try {
  const page = await tool.execute("check-page", { url: `${origin}/page` }, undefined, undefined, {} as never);
  const markdown = textOf(page);
  assert.match(markdown, /# Pi-Ark check page/, "heading should become a Markdown heading");
  assert.match(markdown, /\[documentation link\]\(https:\/\/example\.com\/docs\)/, "links should be preserved");
  assert.match(markdown, /Alpha/);
  assert.doesNotMatch(markdown, /SCRIPT_SHOULD_NOT_APPEAR/, "script contents should be dropped");
  assert.doesNotMatch(markdown, /color: red/, "style contents should be dropped");
  assert.equal(detailsOf(page).contentType, "text/html; charset=utf-8");
  assert.equal(detailsOf(page).truncated, false);

  const raw = await tool.execute("check-raw", { url: `${origin}/page`, format: "raw" }, undefined, undefined, {} as never);
  assert.match(textOf(raw), /<h1>Pi-Ark check page<\/h1>/, "raw format should return the original HTML");

  const json = await tool.execute("check-json", { url: `${origin}/data.json` }, undefined, undefined, {} as never);
  assert.equal(textOf(json).trim(), JSON.stringify({ items: [1, 2, 3] }), "JSON should pass through unchanged");

  const redirected = await tool.execute("check-redirect", { url: `${origin}/redirect` }, undefined, undefined, {} as never);
  assert.equal(detailsOf(redirected).url, `${origin}/page`, "details should report the final URL after redirects");

  await assert.rejects(() => tool.execute("check-404", { url: `${origin}/missing` }, undefined, undefined, {} as never), /HTTP 404/);
  await assert.rejects(() => tool.execute("check-binary", { url: `${origin}/binary` }, undefined, undefined, {} as never), /Unsupported content type/);
  await assert.rejects(() => tool.execute("check-scheme", { url: "file:///etc/passwd" }, undefined, undefined, {} as never), /Unsupported URL scheme/);
  await assert.rejects(() => tool.execute("check-timeout", { url: `${origin}/slow`, timeout: 1 }, undefined, undefined, {} as never), /Timed out|aborted/i);

  console.log("webfetch checks passed");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
