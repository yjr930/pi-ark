import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { internalMessageLink, internalSessionLink, internalWorkspaceLink, parseInternalSessionLink, parsePiArkLink } from "../apps/server/src/internal-links.ts";
import { parseInternalSessionLink as parseWebSessionLink } from "../apps/web/src/permalinks.ts";
import { buildSessionDisplayMessages } from "../apps/server/src/session-display.ts";
import { MAX_LINK_RESULT_BYTES, serializeLinkResult, SessionReader } from "../apps/server/src/session-reader.ts";
import { createReadPiArkLinkTool, READ_PI_ARK_LINK } from "../apps/server/src/agent-tools/read-pi-ark-link.ts";
import { WorkspaceService } from "../apps/server/src/workspaces.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-link-reader-"));
process.env.PI_ARK_HOME = join(directory, "home");
process.env.PI_ARK_AGENT_DIR = join(directory, "home", "pi-agent");
process.env.PI_CODING_AGENT_DIR = process.env.PI_ARK_AGENT_DIR;
const workspace = { id: "links", name: "Link reader", path: join(directory, "workspace") };
const otherWorkspace = { id: "other", name: "Other", path: join(directory, "other") };
const registry = new WorkspaceService([workspace, otherWorkspace]);
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; name: string; id: string; arguments: Record<string, unknown> }>) => ({ role: "assistant" as const, content, api: "openai-responses" as const, provider: "openai-codex", model: "gpt-5.6-sol", usage, stopReason: "stop" as const, timestamp: 200 });

try {
  await Promise.all([mkdir(workspace.path), mkdir(otherWorkspace.path)]);
  const reader = new SessionReader(registry);
  assert.deepEqual(parsePiArkLink(internalWorkspaceLink(workspace.id)), { workspaceId: workspace.id });
  assert.equal(parseInternalSessionLink(internalWorkspaceLink(workspace.id)), undefined);
  const encoded = internalMessageLink("a b", "session name", "m04k9z2");
  assert.deepEqual(parsePiArkLink(encoded), { workspaceId: "a b", sessionId: "session name", messageId: "m04k9z2" });
  assert.deepEqual(parseWebSessionLink(encoded), parseInternalSessionLink(encoded));
  for (const link of ["https://example.com/", "pi-ark://workspace/links/", "pi-ark://workspace/links/session/s/extra", "pi-ark://workspace/links/session/s/message/0", "pi-ark://workspace/links/session/s/message/-1", "pi-ark://workspace/links/session/s/message/m123", "pi-ark://workspace/links/session/s/message/M04k9z2", "pi-ark://workspace/links/session/s?query=1", "pi-ark://workspace/links/session/s#fragment", "pi-ark://workspace/%FF/session/s", "pi-ark://workspace/links/session/%2Ftmp", "pi-ark://workspace/links/session/%00", "pi-ark://workspace/links/session/.."] ) {
    assert.equal(parsePiArkLink(link), undefined, link);
    assert.equal(parseWebSessionLink(link), undefined, link);
    await assert.rejects(reader.read({ link }), /INVALID_LINK/);
  }
  const empty = await reader.read({ link: internalWorkspaceLink(otherWorkspace.id) });
  assert.deepEqual(empty.sessions, []);
  assert.equal(empty.pagination.total, 0);
  assert.deepEqual(await readdir(otherWorkspace.path), []);
  await assert.rejects(reader.read({ link: internalWorkspaceLink("missing") }), /UNKNOWN_WORKSPACE/);
  await assert.rejects(reader.read({ link: internalSessionLink(workspace.id, "missing") }), /UNKNOWN_SESSION/);

  const sessionDirectory = join(workspace.path, ".pi-ark", "sessions");
  const manager = SessionManager.create(workspace.path, sessionDirectory);
  manager.appendMessage({ role: "user", content: "Before compaction", timestamp: 100 });
  manager.appendCustomMessageEntry("test.hidden", "Hidden content", false);
  manager.appendMessage(assistant([{ type: "thinking", thinking: "Read the file" }, { type: "toolCall", name: "read", id: "call-read", arguments: { path: "README.md" } }]));
  manager.appendMessage({ role: "toolResult", toolCallId: "call-read", toolName: "read", content: [{ type: "text", text: "File contents" }], isError: false, timestamp: 300 });
  manager.appendCompaction("Compaction summary", null, 120000);
  manager.appendCustomMessageEntry("test.visible", "Visible custom content", true);
  for (let index = 0; index < 12; index += 1) {
    manager.appendMessage({ role: "user", content: `Question ${index}`, timestamp: 400 + index * 2 });
    manager.appendMessage(assistant([{ type: "text", text: `Answer ${index}` }]));
  }
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "Image question" }, { type: "image", data: "SECRET_BASE64", mimeType: "image/png" }], timestamp: 500 });
  const messages = buildSessionDisplayMessages(manager);
  const sessionLink = internalSessionLink(workspace.id, manager.getSessionId());
  const before = await readFile(manager.getSessionFile()!, "utf8");
  const beforeStat = await stat(manager.getSessionFile()!);
  const page = await reader.read({ link: sessionLink });
  assert.equal(page.kind, "session");
  assert.equal(page.messages!.length, 20);
  assert.equal(page.messages![0].position, messages.length - 19);
  assert.equal(page.session!.totalDisplayMessages, messages.length);
  assert.equal(page.pagination.hasEarlier, true);
  assert.equal(page.pagination.hasLater, false);
  const firstPage = await reader.read({ link: sessionLink, start: 1, limit: 3 });
  assert.deepEqual(firstPage.messages!.map((message) => message.entryId), messages.slice(0, 3).map((message) => message.entryId));
  assert.equal(firstPage.pagination.nextStart, 4);
  assert.equal(firstPage.messages![0].content, "Before compaction");
  assert.match(firstPage.messages![1].content, /\[Reasoning\]\nRead the file/);
  assert.match(firstPage.messages![1].content, /toolCallId=call-read/);
  assert.match(firstPage.messages![1].content, /README.md/);
  assert.equal(firstPage.messages![2].toolCallId, "call-read");
  assert.equal(firstPage.messages![2].content, "File contents");
  const shortLink = internalMessageLink(workspace.id, manager.getSessionId(), messages[2].messageId);
  const resolved = await reader.read({ link: shortLink });
  const legacy = await reader.read({ link: `${sessionLink}/message/3` });
  assert.deepEqual(legacy, resolved);
  assert.equal(resolved.target!.entryId, messages[2].entryId);
  assert.equal(resolved.target!.messageId, messages[2].messageId);
  const context = await reader.read({ link: shortLink, context: 2 });
  assert.deepEqual(context.messages!.map((message) => message.position), [1, 2, 3, 4, 5]);
  assert.equal(context.messages![3].content, "Compaction summary");
  assert.equal(context.messages![4].content, "Visible custom content");
  const image = await reader.read({ link: internalMessageLink(workspace.id, manager.getSessionId(), messages.at(-1)!.messageId) });
  assert.equal(image.messages![0].content, "Image question\n\n[Image: image/png]");
  assert.equal(serializeLinkResult(image).includes("SECRET_BASE64"), false);
  for (const input of [{ link: shortLink, context: 21 }, { link: shortLink, context: -1 }, { link: shortLink, context: 1.5 }, { link: sessionLink, limit: 101 }, { link: sessionLink, limit: 0 }, { link: sessionLink, start: 0 }, { link: shortLink, start: 1 }, { link: shortLink, limit: 1 }, { link: sessionLink, context: 0 }, { link: sessionLink, offset: 0 }, { link: shortLink, offset: -1 }]) await assert.rejects(reader.read(input), /INVALID_ARGUMENT/);
  await assert.rejects(reader.read({ link: `${sessionLink}/message/99999999999999999999999` }), /MESSAGE_NOT_FOUND/);
  await assert.rejects(reader.read({ link: sessionLink, start: 9999 }), /PAGE_OUT_OF_RANGE/);
  await assert.rejects(reader.read({ link: shortLink, offset: 9999 }), /CONTENT_OUT_OF_RANGE/);
  await assert.rejects(reader.read({ link: internalSessionLink(otherWorkspace.id, manager.getSessionId()) }), /UNKNOWN_SESSION/);
  assert.equal(await readFile(manager.getSessionFile()!, "utf8"), before);
  assert.equal((await stat(manager.getSessionFile()!)).mtimeMs, beforeStat.mtimeMs);

  const legacyFile = before.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  legacyFile[0].version = 2;
  await writeFile(manager.getSessionFile()!, legacyFile.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const legacyBytes = await readFile(manager.getSessionFile()!, "utf8");
  assert.deepEqual((await reader.read({ link: shortLink })).target, resolved.target);
  assert.equal(await readFile(manager.getSessionFile()!, "utf8"), legacyBytes);
  await writeFile(manager.getSessionFile()!, before);

  const activeReader = new SessionReader(registry, (_workspace, sessionId) => sessionId === manager.getSessionId() ? manager : undefined);
  const originalLeaf = manager.getLeafId();
  manager.branch(messages[0].entryId);
  const activeLeaf = manager.getLeafId();
  assert.equal((await activeReader.read({ link: sessionLink })).messages!.length, 1);
  await assert.rejects(activeReader.read({ link: shortLink }), /MESSAGE_NOT_FOUND/);
  const pinned = `${shortLink}?leafEntryId=${originalLeaf}`;
  assert.deepEqual(parseWebSessionLink(pinned), parseInternalSessionLink(pinned));
  const historical = await activeReader.read({ link: pinned });
  assert.equal(historical.target!.entryId, messages[2].entryId);
  assert.equal(historical.session!.leafEntryId, originalLeaf);
  assert.equal(historical.target!.link, pinned);
  assert.equal((await activeReader.read({ link: shortLink, leafEntryId: originalLeaf! })).target!.entryId, messages[2].entryId);
  await assert.rejects(activeReader.read({ link: pinned, leafEntryId: activeLeaf! }), /INVALID_ARGUMENT/);
  await assert.rejects(activeReader.read({ link: shortLink, leafEntryId: "unknown-entry" }), /BRANCH_NOT_FOUND/);
  assert.equal((await activeReader.images({ link: internalMessageLink(workspace.id, manager.getSessionId(), messages.at(-1)!.messageId), leafEntryId: originalLeaf! }))[0].data, "SECRET_BASE64");
  assert.equal(manager.getLeafId(), activeLeaf);
  assert.equal(await readFile(manager.getSessionFile()!, "utf8"), before);
  manager.branch(originalLeaf!);
  const branchSummary = manager.branchWithSummary(originalLeaf!, "Branch summary");
  const branchMessages = buildSessionDisplayMessages(manager);
  const branchResult = await activeReader.read({ link: internalMessageLink(workspace.id, manager.getSessionId(), branchMessages.at(-1)!.messageId) });
  assert.equal(branchResult.messages![0].entryId, branchSummary);
  assert.equal(branchResult.messages![0].content, "Branch summary");

  const longContent = "中文🚀\"\\\n".repeat(16000);
  manager.appendMessage({ role: "user", content: longContent, timestamp: 600 });
  const longLink = internalMessageLink(workspace.id, manager.getSessionId(), buildSessionDisplayMessages(manager).at(-1)!.messageId);
  let offset = 0;
  let reconstructed = "";
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const chunk = await activeReader.read({ link: longLink, offset });
    assert.ok(Buffer.byteLength(serializeLinkResult(chunk), "utf8") <= MAX_LINK_RESULT_BYTES);
    assert.equal(chunk.messages![0].contentOffset, offset);
    assert.equal(chunk.messages![0].totalContentCharacters, longContent.length);
    reconstructed += chunk.messages![0].content;
    const next = chunk.messages![0].nextContentOffset;
    if (next === undefined) break;
    assert.ok(next > offset);
    assert.equal(chunk.truncated, true);
    offset = next;
  }
  assert.equal(reconstructed, longContent);
  const longContext = await activeReader.read({ link: longLink, context: 20 });
  assert.ok(longContext.messages!.some((message) => message.link === longLink && message.content.length > 0));
  const workspaceResult = await activeReader.read({ link: internalWorkspaceLink(workspace.id), start: 1, limit: 1 });
  assert.equal(workspaceResult.sessions![0].id, manager.getSessionId());
  const tool = createReadPiArkLinkTool(activeReader);
  for (const link of [internalWorkspaceLink(workspace.id), sessionLink, shortLink, longLink]) {
    const result = await tool.execute("check", { link }, undefined, undefined, {} as never);
    assert.equal(Value.Check(tool.outputSchema!, result.structuredContent), true);
    assert.deepEqual(JSON.parse(result.content[0].type === "text" ? result.content[0].text : "null"), result.structuredContent);
  }
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(reader.read({ link: sessionLink }, abort.signal), { name: "AbortError" });

  const { AgentService } = await import("../apps/server/src/agents.ts");
  const { SettingsService } = await import("../apps/server/src/settings.ts");
  const { saveGlobalPreferences } = await import("../apps/server/src/config.ts");
  await mkdir(process.env.PI_ARK_HOME!, { recursive: true });
  await writeFile(join(process.env.PI_ARK_HOME!, "config.json"), JSON.stringify({ tls: { keyPath: "/tmp/key", certPath: "/tmp/cert" }, auth: { username: "check", passwordHash: "check" }, workspaces: [workspace, otherWorkspace] }));
  await saveGlobalPreferences({ agent: { tools: ["read"] }, files: { showHiddenFiles: true, maxPreviewSizeMb: 10 } });
  const agents = new AgentService(await SettingsService.create(workspace.path), registry);
  try {
    const opened = await agents.create(workspace);
    const internals = agents as unknown as { handles: Map<string, { session: import("@earendil-works/pi-coding-agent").AgentSession }>; onEvent(handle: unknown, event: unknown): void };
    const handle = internals.handles.get(`${workspace.id}:${opened.id}`)!;
    assert.deepEqual(handle.session.getActiveToolNames().sort(), ["read", READ_PI_ARK_LINK, "subagent"].sort());
    assert.match(handle.session.systemPrompt, /read_pi_ark_link/);
    assert.match(handle.session.systemPrompt, /Use read_pi_ark_link to read pi-ark:\/\/workspace/);
    const registered = handle.session.agent.state.tools.find((item) => item.name === READ_PI_ARK_LINK)!;
    internals.onEvent(handle, { type: "agent_start" });
    const statuses = agents.statuses(workspace);
    const size = internals.handles.size;
    const result = await registered.execute("runtime-check", { link: shortLink });
    assert.equal(result.content[0].type, "text");
    assert.equal(internals.handles.size, size);
    assert.deepEqual(agents.statuses(workspace), statuses);
    handle.session.sessionManager.appendMessage({ role: "user", content: "Current Session content", timestamp: 700 });
    const selfLeaf = handle.session.sessionManager.getLeafId();
    const self = await registered.execute("self-check", { link: internalSessionLink(workspace.id, opened.id) });
    assert.equal(self.content[0].type === "text" && JSON.parse(self.content[0].text).messages[0].content, "Current Session content");
    assert.equal(handle.session.sessionManager.getLeafId(), selfLeaf);
    assert.deepEqual(agents.statuses(workspace), statuses);
    const socket = { readyState: 1, OPEN: 1, send: (_payload: string) => undefined };
    const disconnect = await agents.connect(workspace, manager.getSessionId(), socket as never);
    const restored = internals.handles.get(`${workspace.id}:${manager.getSessionId()}`)!;
    assert.ok(restored.session.getActiveToolNames().includes(READ_PI_ARK_LINK));
    disconnect();
    assert.match((await agents.getGlobalSystemPrompt(workspace)).content, /read_pi_ark_link/);
    internals.onEvent(handle, { type: "agent_settled", aborted: true });
  } finally { await agents.dispose(); }
  const referenceSource = process.env.PI_ARK_CHECK_LINK_SESSION;
  if (referenceSource) {
    const entries = parseSessionEntries(await readFile(referenceSource, "utf8"));
    const header = entries.find((entry) => entry.type === "session")!;
    header.cwd = workspace.path;
    delete header.parentSession;
    await writeFile(join(sessionDirectory, "reference-fixture.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const reference = await reader.read({ link: internalMessageLink(workspace.id, header.id, "m0tmjc6") });
    assert.equal(reference.target!.messageId, "m0tmjc6");
    assert.match(reference.messages![0].content, /read_pi_ark_link/);
    const referenceProjection = buildSessionDisplayMessages(SessionManager.inMemory(workspace.path, undefined, entries));
    const legacyTarget = await reader.read({ link: `${internalSessionLink(workspace.id, header.id)}/message/2294` });
    assert.equal(legacyTarget.target!.entryId, referenceProjection[2293].entryId);
    assert.equal(legacyTarget.target!.messageId, referenceProjection[2293].messageId);
  }
  console.log("Pi-Ark link reader checks passed");
} finally { await rm(directory, { recursive: true, force: true }); }
