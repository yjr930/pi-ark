import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../apps/server/src/agents.ts";
import { SettingsService } from "../apps/server/src/settings.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-session-actions-"));
const workspace = { id: "session-actions", name: "Session actions", path: directory };
try {
  const sessionDirectory = join(directory, ".pi-ark", "sessions");
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
  const service = agents as unknown as { rollbackEntryId(handle: unknown): string | undefined; rollbackState(handle: unknown): { id: string; targetId: string; restoreEntryId: string; draft: string } | undefined; onEvent(handle: unknown, event: unknown): void; handles: Map<string, { clients: Set<{ readyState: number; OPEN: number; send(payload: string): void }>; queue: Array<{ id: string; mode: "steering" | "followUp"; text: string; images: [] }>; session: { sessionManager: SessionManager; getSteeringMessages(): readonly string[]; getFollowUpMessages(): readonly string[] } }> };
  const handle = service.handles.get(`${workspace.id}:${manager.getSessionId()}`)!;
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

  const snapshotSession = await agents.create(workspace);
  const snapshotHandle = service.handles.get(`${workspace.id}:${snapshotSession.id}`)!;
  const sent: string[] = [];
  snapshotHandle.clients.add({ readyState: 1, OPEN: 1, send: (payload) => sent.push(payload) });
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
