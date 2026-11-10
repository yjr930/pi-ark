import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentService, buildSessionDisplayMessages } from "../apps/server/src/agents.ts";
import { SettingsService } from "../apps/server/src/settings.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-session-actions-"));
const workspace = { id: "session-actions", name: "Session actions", path: directory };
try {
  const sessionDirectory = join(directory, ".pi-ark", "sessions");
  const compactedManager = SessionManager.create(directory, sessionDirectory);
  compactedManager.appendMessage({ role: "user", content: "Original history", timestamp: 100 });
  compactedManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Original answer" }], api: "openai-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 200 });
  const compactEntryId = compactedManager.appendCompaction("Compacted history summary", null, 120000, { readFiles: ["README.md"] });
  compactedManager.appendMessage({ role: "user", content: "Continued history", timestamp: 300 });
  compactedManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Continued answer" }], api: "openai-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 12, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 400 });
  assert.deepEqual(compactedManager.buildSessionProjection().messages.filter((message) => message.role === "user").map((message) => message.content), ["Continued history"]);
  const displayMessages = buildSessionDisplayMessages(compactedManager, () => 200000);
  assert.deepEqual(displayMessages.map((message) => message.role), ["user", "assistant", "compactionSummary", "user", "assistant"]);
  assert.deepEqual(displayMessages.filter((message) => message.role === "user").map((message) => message.content), ["Original history", "Continued history"]);
  assert.equal(displayMessages.find((message) => message.role === "compactionSummary")?.summary, "Compacted history summary");
  assert.equal(displayMessages.find((message) => message.role === "compactionSummary")?.entryId, compactEntryId);
  assert.equal(displayMessages.find((message) => message.role === "assistant")?.contextWindow, 200000);

  const manager = SessionManager.create(directory, sessionDirectory);
  const firstUser = manager.appendMessage({ role: "user", content: "First", timestamp: 1000 });
  const firstAssistant = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "First answer" }], api: "openai-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2000 });
  const beforeSecondTurn = manager.appendCustomEntry("test.before-second-turn", { retained: true });
  const secondUser = manager.appendMessage({ role: "user", content: "Second", timestamp: 3000 });
  manager.appendCustomEntry("test.action", { tool: "read" });
  const secondAssistant = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Second answer" }], api: "openai-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 20, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 26, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 4000 });
  assert.ok(firstUser && secondUser);
  const settings = await SettingsService.create(directory);
  const agents = new AgentService(settings);
  const forked = await agents.fork(workspace, manager.getSessionId(), firstAssistant);
  assert.notEqual(forked.id, manager.getSessionId());
  const service = agents as unknown as { rollbackEntryId(handle: unknown): string | undefined; rollbackState(handle: unknown): { id: string; targetId: string; restoreEntryId: string; draft: string } | undefined; onEvent(handle: unknown, event: unknown): void; handles: Map<string, { clients: Map<{ readyState: number; OPEN: number; send(payload: string): void }, { start: number }>; queue: Array<{ id: string; mode: "steering" | "followUp"; text: string; images: [] }>; session: { sessionManager: SessionManager; getSteeringMessages(): readonly string[]; getFollowUpMessages(): readonly string[] } }> };
  const handle = service.handles.get(`${workspace.id}:${manager.getSessionId()}`)!;
  const activeForkLeaf = handle.session.sessionManager.getLeafId();
  Object.defineProperty(handle.session, "isIdle", { value: false, configurable: true });
  const activeForked = await agents.fork(workspace, manager.getSessionId(), firstAssistant);
  assert.notEqual(activeForked.id, manager.getSessionId());
  assert.equal(handle.session.sessionManager.getLeafId(), activeForkLeaf);
  delete (handle.session as unknown as { isIdle?: boolean }).isIdle;
  assert.equal(service.rollbackEntryId(handle), secondAssistant);
  await assert.rejects(() => agents.rollbackLatest(workspace, manager.getSessionId(), firstAssistant), /Only the latest conversation message/);
  const preRollbackLeafId = handle.session.sessionManager.getLeafId();
  const rollback = await agents.rollbackLatest(workspace, manager.getSessionId(), secondAssistant);
  assert.equal(rollback.draft, "Second");
  assert.equal(rollback.targetId, secondAssistant);
  assert.equal(service.rollbackState(handle)?.restoreEntryId, preRollbackLeafId);
  const reopened = SessionManager.open(manager.getSessionFile()!, sessionDirectory);
  assert.deepEqual(reopened.buildSessionProjection().messages.filter((message) => message.role === "user" || message.role === "assistant").map((message) => message.role === "user" ? message.content : message.content.find((block) => block.type === "text")?.text), ["First", "First answer"]);
  assert.equal(reopened.getLeafEntry()?.parentId, beforeSecondTurn);
  await assert.rejects(() => agents.rollbackLatest(workspace, manager.getSessionId(), secondAssistant), /Restore the rolled back message or send a new message/);
  await agents.restoreRollback(workspace, manager.getSessionId());
  assert.deepEqual(handle.session.sessionManager.buildSessionProjection().messages.filter((message) => message.role === "user" || message.role === "assistant").map((message) => message.role === "user" ? message.content : message.content.find((block) => block.type === "text")?.text), ["First", "First answer", "Second", "Second answer"]);
  await agents.rollbackLatest(workspace, manager.getSessionId(), secondAssistant);
  handle.session.sessionManager.appendMessage({ role: "user", content: "Replacement", timestamp: 4500 });
  await assert.rejects(() => agents.restoreRollback(workspace, manager.getSessionId()), /no longer available/);
  handle.queue = [{ id: "queue-a", mode: "followUp", text: "A", images: [] }, { id: "queue-b", mode: "followUp", text: "B", images: [] }];
  await agents.updateQueue(workspace, manager.getSessionId(), "queue-b", { direction: "up" });
  assert.deepEqual(handle.session.getFollowUpMessages(), ["B", "A"]);
  await agents.updateQueue(workspace, manager.getSessionId(), "queue-a", { mode: "steering" });
  assert.deepEqual(handle.session.getSteeringMessages(), ["A"]);
  assert.deepEqual(handle.session.getFollowUpMessages(), ["B"]);
  handle.queue = [
    { id: "queue-steering", mode: "steering", text: "Steer", images: [] },
    { id: "queue-follow-up-1", mode: "followUp", text: "First follow-up", images: [] },
    { id: "queue-follow-up-2", mode: "followUp", text: "Second follow-up", images: [] },
    { id: "queue-follow-up-3", mode: "followUp", text: "Third follow-up", images: [] },
  ];
  await agents.mergeFollowUps(workspace, manager.getSessionId());
  assert.deepEqual(handle.session.getSteeringMessages(), ["Steer"]);
  assert.deepEqual(handle.session.getFollowUpMessages(), ["First follow-up\n\nSecond follow-up\n\nThird follow-up"]);
  assert.equal(handle.queue.find((item) => item.mode === "followUp")?.id, "queue-follow-up-1");
  const takenQueuedMessage = await agents.takeQueuedMessage(workspace, manager.getSessionId(), "queue-follow-up-1");
  assert.equal(takenQueuedMessage.text, "First follow-up\n\nSecond follow-up\n\nThird follow-up");
  assert.deepEqual(handle.session.getSteeringMessages(), ["Steer"]);
  assert.deepEqual(handle.session.getFollowUpMessages(), []);
  await assert.rejects(() => agents.takeQueuedMessage(workspace, manager.getSessionId(), "queue-follow-up-1"), /no longer available/);

  const firstTurnManager = SessionManager.create(directory, sessionDirectory);
  firstTurnManager.appendMessage({ role: "user", content: "Only turn", timestamp: 5000 });
  const onlyAssistant = firstTurnManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Only answer" }], api: "openai-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 6000 });
  const firstTurnRollback = await agents.rollbackLatest(workspace, firstTurnManager.getSessionId(), onlyAssistant);
  assert.equal(firstTurnRollback.draft, "Only turn");
  const reopenedFirstTurn = SessionManager.open(firstTurnManager.getSessionFile()!, sessionDirectory);
  assert.deepEqual(reopenedFirstTurn.buildSessionProjection().messages, []);
  await agents.restoreRollback(workspace, firstTurnManager.getSessionId());
  const restoredFirstTurn = SessionManager.open(firstTurnManager.getSessionFile()!, sessionDirectory);
  assert.deepEqual(restoredFirstTurn.buildSessionProjection().messages.filter((message) => message.role === "user" || message.role === "assistant").map((message) => message.role === "user" ? message.content : message.content.find((block) => block.type === "text")?.text), ["Only turn", "Only answer"]);

  const interruptedManager = SessionManager.create(directory, sessionDirectory);
  interruptedManager.appendMessage({ role: "user", content: "Interrupted turn", timestamp: 6100 });
  interruptedManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "interrupted-read", name: "read", arguments: { path: "README.md" } }], api: "openai-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 6200 });
  const interruptedResult = interruptedManager.appendMessage({ role: "toolResult", toolCallId: "interrupted-read", toolName: "read", content: [{ type: "text", text: "partial result" }], isError: false, timestamp: 6300 });
  const interruptedRollback = await agents.rollbackLatest(workspace, interruptedManager.getSessionId(), interruptedResult);
  assert.equal(interruptedRollback.draft, "Interrupted turn");
  assert.equal(interruptedRollback.targetId, interruptedResult);
  await agents.restoreRollback(workspace, interruptedManager.getSessionId());

  const pagedSession = await agents.create(workspace);
  const pagedHandle = service.handles.get(`${workspace.id}:${pagedSession.id}`)!;
  for (let turn = 1; turn <= 61; turn += 1) {
    pagedHandle.session.sessionManager.appendMessage({ role: "user", content: `Question ${turn}`, timestamp: 7000 + turn * 2 });
    pagedHandle.session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: `Answer ${turn}` }], api: "openai-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 7001 + turn * 2 });
  }
  const pagedPayloads: string[] = [];
  const pagedSocket = { readyState: 1, OPEN: 1, send: (payload: string) => pagedPayloads.push(payload) };
  const disconnectPaged = await agents.connect(workspace, pagedSession.id, pagedSocket as never);
  const initialPage = JSON.parse(pagedPayloads.at(-1)!).session;
  assert.equal(initialPage.messageNumberOffset, 22);
  assert.equal(initialPage.totalDisplayMessages, 122);
  assert.equal(initialPage.hasEarlierMessages, true);
  assert.equal(initialPage.messages.length, 100);
  assert.equal(initialPage.messages[0].content, "Question 12");
  agents.loadEarlier(workspace, pagedSession.id, pagedSocket as never);
  const expandedPage = JSON.parse(pagedPayloads.at(-1)!).session;
  assert.equal(expandedPage.messageNumberOffset, 0);
  assert.equal(expandedPage.hasEarlierMessages, false);
  assert.equal(expandedPage.messages.length, 122);
  disconnectPaged();

  const snapshotSession = await agents.create(workspace);
  const snapshotHandle = service.handles.get(`${workspace.id}:${snapshotSession.id}`)!;
  const sent: string[] = [];
  const snapshotSocket = { readyState: 1, OPEN: 1, send: (payload: string) => sent.push(payload) };
  snapshotHandle.clients.set(snapshotSocket, { start: 0 });
  const delayedMessage = { role: "user" as const, content: "Visible in the scheduled snapshot", timestamp: 7000 };
  service.onEvent(snapshotHandle, { type: "message_end", message: delayedMessage });
  snapshotHandle.session.sessionManager.appendMessage(delayedMessage);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const scheduledSnapshot = sent.map((payload) => JSON.parse(payload)).findLast((payload) => payload.type === "snapshot");
  assert.equal(scheduledSnapshot.session.messages.at(-1).content, "Visible in the scheduled snapshot");
  await agents.dispose();
  console.log("session action checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
