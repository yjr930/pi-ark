import { defineTool } from "@earendil-works/pi-coding-agent";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { Type } from "typebox";

export const WEBFETCH = "webfetch";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const ERROR_SNIPPET_BYTES = 2000;
const HTML_BODY_SCRIPTS = /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi;

export type WebfetchDetails = {
  url: string;
  status: number;
  contentType: string;
  format: "markdown" | "raw";
  bytes: number;
  truncated: boolean;
};

function charsetOf(contentType: string): string {
  const match = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
  return match?.[1]?.trim().toLowerCase() || "utf-8";
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function isHtml(contentType: string): boolean {
  return contentType.includes("text/html") || contentType.includes("application/xhtml");
}

function isTextual(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return value.startsWith("text/") || value.includes("json") || value.includes("xml") || value.includes("yaml") || value.includes("javascript") || value.includes("csv");
}

function toMarkdown(html: string): string {
  const cleaned = html.replace(HTML_BODY_SCRIPTS, " ");
  return NodeHtmlMarkdown.translate(cleaned).replace(/\n{3,}/g, "\n\n").trim();
}

async function readBody(response: Response): Promise<{ bytes: Uint8Array; truncated: boolean; total: number }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false, total: 0 };
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    const room = MAX_BODY_BYTES - kept;
    if (room <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    const slice = value.byteLength > room ? value.subarray(0, room) : value;
    chunks.push(slice);
    kept += slice.byteLength;
    if (slice.byteLength < value.byteLength) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated, total };
}

function errorSnippet(bytes: Uint8Array, contentType: string): string {
  const text = decodeBody(bytes.subarray(0, ERROR_SNIPPET_BYTES), contentType).replace(/\s+/g, " ").trim();
  return text ? `: ${text.slice(0, 300)}` : "";
}

export function createWebfetchTool() {
  return defineTool({
    name: WEBFETCH,
    label: "Web fetch",
    description: "Fetch an HTTP or HTTPS URL and return its content. HTML pages are converted to Markdown with links preserved; JSON, XML and plain text are returned unchanged. The response body is capped at 5 MB, the default timeout is 30 seconds and the maximum is 120 seconds. Redirects are followed. Read-only: the page runs no JavaScript, so use the browser tools for pages that need rendering, login or clicks.",
    promptSnippet: "Fetch a web page and return its content as Markdown",
    promptGuidelines: [
      "Use webfetch to read a page whose URL the user gave or a search result returned, and prefer it over the browser tools for documentation, articles and API responses.",
      "Use the browser tools instead of webfetch when the page needs JavaScript rendering, login, clicks, form input or a screenshot.",
      "webfetch returns at most 5 MB of the response body and reports truncated in its details; when a page is truncated, fetch a narrower page instead of repeating the same call.",
    ],
    parameters: Type.Object({
      url: Type.String({ minLength: 1, description: "The HTTP or HTTPS URL to fetch" }),
      format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("raw")], { description: "markdown converts HTML to Markdown; raw returns the response body unchanged. Defaults to markdown" })),
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: `Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS}; maximum ${MAX_TIMEOUT_SECONDS}` })),
    }),
    outputSchema: Type.Object({
      url: Type.String(),
      status: Type.Integer(),
      contentType: Type.String(),
      format: Type.Union([Type.Literal("markdown"), Type.Literal("raw")]),
      bytes: Type.Integer(),
      truncated: Type.Boolean(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    executionMode: "parallel",
    async execute(_toolCallId, input, signal) {
      let target: URL;
      try {
        target = new URL(input.url);
      } catch {
        throw new Error(`Invalid URL: ${input.url}`);
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error(`Unsupported URL scheme: ${target.protocol}`);
      const format = input.format ?? "markdown";
      const timeoutSeconds = input.timeout ?? DEFAULT_TIMEOUT_SECONDS;
      const controller = new AbortController();
      const forwardAbort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener("abort", forwardAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutSeconds} seconds`)), timeoutSeconds * 1000);
      try {
        const response = await fetch(target, {
          redirect: "follow",
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Pi-Ark webfetch)",
            Accept: format === "markdown" ? "text/markdown;q=1.0, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.7, */*;q=0.1" : "*/*",
            "Accept-Language": "en-US,en;q=0.9, zh-CN;q=0.8",
          },
        });
        const contentType = response.headers.get("content-type") ?? "";
        const body = await readBody(response);
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${response.url}${errorSnippet(body.bytes, contentType)}`);
        if (!isHtml(contentType) && !isTextual(contentType)) throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
        const raw = decodeBody(body.bytes, contentType);
        const text = format === "markdown" && isHtml(contentType) ? toMarkdown(raw) : raw;
        const details: WebfetchDetails = {
          url: response.url,
          status: response.status,
          contentType,
          format,
          bytes: body.total,
          truncated: body.truncated,
        };
        const suffix = body.truncated ? `\n\n[truncated: the response body is larger than ${MAX_BODY_BYTES} bytes]` : "";
        const output = text.trim() || "[empty response body]";
        return { content: [{ type: "text", text: `${output}${suffix}` }], details, structuredContent: details };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", forwardAbort);
      }
    },
  });
}
