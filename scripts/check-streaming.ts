import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { applyAssistantUpdate, mergeAgentSnapshot, type AssistantUpdate } from "../apps/web/src/streaming.ts";
import type { AgentMessage, AgentSnapshot } from "../apps/web/src/types.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-streaming-"));
const workspace = { id: "streaming", name: "Streaming checks", path: join(directory, "workspace") };
process.env.PI_ARK_HOME = join(directory, "home");
process.env.PI_ARK_AGENT_DIR = join(directory, "home", "pi-agent");
process.env.PI_CODING_AGENT_DIR = process.env.PI_ARK_AGENT_DIR;
const { AgentService } = await import("../apps/server/src/agents.ts");
const { WorkspaceService } = await import("../apps/server/src/workspaces.ts");

const model: Model<"openai-completions"> = { provider: "openai", id: "streaming-fixture", name: "Streaming fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 10000 };
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const thinkingText = "Reasoning about the request. ".repeat(800);
const answerText = "The answer streams in pieces. ".repeat(400);

function message(content: AssistantMessage["content"] = []): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, usage: structuredClone(usage), stopReason: "stop", timestamp: Date.now() };
}

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 20000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${description}`); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

const settings = { getSessionModelConfiguration: async () => ({ model, scopedModels: [] }), getModelContextWindow: () => model.contextWindow, resolveModel: async () => model };
const agents = new AgentService(settings as never, new WorkspaceService([workspace]));
const internal = agents as unknown as { handles: Map<string, { session: AgentSession }> };

try {
  await mkdir(process.env.PI_ARK_AGENT_DIR!, { recursive: true });
  await mkdir(workspace.path, { recursive: true });
  await writeFile(join(workspace.path, "file.txt"), "fixture contents\n");
  await writeFile(join(process.env.PI_ARK_HOME!, "config.json"), JSON.stringify({ tls: { keyPath: "/tmp/key", certPath: "/tmp/cert" }, auth: { username: "check", passwordHash: "check" }, workspaces: [workspace] }));
  await writeFile(join(process.env.PI_ARK_AGENT_DIR!, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  await writeFile(join(process.env.PI_ARK_AGENT_DIR!, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: model.baseUrl, api: model.api, apiKey: "local-fixture-key", models: [model] } } }));

  const created = await agents.create(workspace);
  const session = internal.handles.get(`${workspace.id}:${created.id}`)!.session;
  await session.modelRuntime.setRuntimeApiKey("openai", "local-fixture-key");
  let call = 0;
  let resume: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  session.agent.streamFunction = () => {
    const index = ++call;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const output = message();
      stream.push({ type: "start", partial: output });
      if (index === 1) {
        output.content = [{ type: "toolCall", id: "call_read", name: "read", arguments: {} }];
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{\"path\":\"file.txt\"}", partial: output });
        const toolCall = { type: "toolCall" as const, id: "call_read", name: "read", arguments: { path: "file.txt" } };
        output.content = [toolCall];
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        output.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      }
      output.content = [{ type: "thinking", thinking: "" }];
      stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
      for (let offset = 0; offset < thinkingText.length; offset += 40) {
        const delta = thinkingText.slice(offset, offset + 40);
        (output.content[0] as { thinking: string }).thinking += delta;
        stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: output });
      }
      stream.push({ type: "thinking_end", contentIndex: 0, content: thinkingText, partial: output });
      await paused;
      output.content = [{ type: "thinking", thinking: thinkingText }, { type: "text", text: "" }];
      stream.push({ type: "text_start", contentIndex: 1, partial: output });
      for (let offset = 0; offset < answerText.length; offset += 40) {
        const delta = answerText.slice(offset, offset + 40);
        (output.content[1] as { text: string }).text += delta;
        stream.push({ type: "text_delta", contentIndex: 1, delta, partial: output });
      }
      stream.push({ type: "text_end", contentIndex: 1, content: answerText, partial: output });
      output.content = [{ type: "thinking", thinking: thinkingText }, { type: "text", text: answerText }];
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    })().catch((error) => {
      const failed = message();
      failed.stopReason = "error";
      failed.errorMessage = String(error);
      stream.push({ type: "error", reason: "error", error: failed });
      stream.end();
    });
    return stream;
  };

  const socketMessages: Array<Record<string, any>> = [];
  const socket = { readyState: 1, OPEN: 1, send: (payload: string) => socketMessages.push(JSON.parse(payload)) };
  await agents.connect(workspace, created.id, socket as never);
  const running = agents.prompt(workspace, created.id, "Stream the fixture response.");
  await waitFor(() => socketMessages.some((item) => item.type === "agent-event" && item.event?.kind === "thinking_end"), "the fixture reaches the mid-stream pause");
  const lateMessages: Array<Record<string, any>> = [];
  const lateSocket = { readyState: 1, OPEN: 1, send: (payload: string) => lateMessages.push(JSON.parse(payload)) };
  await agents.connect(workspace, created.id, lateSocket as never);
  const injected = lateMessages.find((item) => item.type === "agent-event" && item.event?.type === "message_start")?.event;
  assert.equal(injected?.message?.content?.[0]?.thinking, thinkingText, "a client connecting mid-stream receives the partial message");
  resume();
  await running;
  await waitFor(() => socketMessages.some((item) => item.type === "agent-event" && item.event?.type === "agent_settled"), "the fixture run settled");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(lateMessages.some((item) => item.type === "agent-event" && item.event?.kind === "text_delta"), true, "the late client keeps receiving compact updates");

  const events = socketMessages.filter((item) => item.type === "agent-event").map((item) => item.event);
  const updates = events.filter((event) => event.type === "message_update");
  assert.equal(updates.length > 100, true, "the fixture streams many updates");
  assert.equal(updates.every((event) => event.message === undefined), true, "updates carry no accumulated message");
  assert.equal(updates.every((event) => typeof event.kind === "string"), true, "updates carry a compact kind");
  const kinds = new Set(updates.map((event) => event.kind));
  for (const kind of ["thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_end"]) assert.equal(kinds.has(kind), true, `missing ${kind}`);
  assert.equal(kinds.has("toolcall_delta"), false, "tool-call argument deltas are not forwarded");
  const toolStart = updates.find((event) => event.kind === "toolcall_start")!;
  assert.deepEqual(toolStart.toolCall.arguments, {}, "the start event carries no streamed arguments");
  const toolEnd = updates.find((event) => event.kind === "toolcall_end")!;
  assert.deepEqual(toolEnd.toolCall.arguments, { path: "file.txt" }, "the end event carries the completed call");
  const thinkingStart = updates.find((event) => event.kind === "thinking_start")!;
  assert.equal(thinkingStart.thinking, undefined, "the start event carries no streamed reasoning");
  const updateBytes = Buffer.byteLength(JSON.stringify(updates));
  const streamedBytes = thinkingText.length + answerText.length;
  assert.equal(updateBytes < streamedBytes * 5, true, `updates stay proportional to the streamed text (${updateBytes} bytes for ${streamedBytes} streamed)`);

  const snapshots = socketMessages.filter((item) => item.type === "snapshot").map((item) => item.session as AgentSnapshot);
  assert.equal(snapshots.length > 2, true, "scheduled snapshots arrive");
  const scheduled = snapshots.slice(1);
  assert.equal(scheduled.every((snapshot) => snapshot.messages.length <= 2), true, "a scheduled snapshot only carries new messages");
  assert.equal(scheduled.some((snapshot) => (snapshot.messageSliceOffset ?? 0) > snapshot.messageNumberOffset), true, "a scheduled snapshot starts at the delivered offset");
  const ordered = [...scheduled].sort((a, b) => (a.messageSliceOffset ?? 0) - (b.messageSliceOffset ?? 0));
  let delivered = 0;
  for (const snapshot of ordered) {
    const slice = snapshot.messageSliceOffset ?? snapshot.messageNumberOffset;
    assert.equal(slice >= delivered, true, "snapshots do not overlap");
    delivered = Math.max(delivered, slice + snapshot.messages.length);
  }
  assert.equal(delivered, ordered.at(-1)!.totalDisplayMessages, "every display message is delivered once");

  const assistant: AgentMessage = { role: "assistant", content: [], timestamp: 1000 };
  let streamed = applyAssistantUpdate(assistant, { type: "message_update", kind: "thinking_start", contentIndex: 0 });
  streamed = applyAssistantUpdate(streamed, { type: "message_update", kind: "thinking_delta", contentIndex: 0, delta: "Plan" });
  streamed = applyAssistantUpdate(streamed, { type: "message_update", kind: "thinking_end", contentIndex: 0, content: "Plan", thinkingSignature: "sig" });
  streamed = applyAssistantUpdate(streamed, { type: "message_update", kind: "text_start", contentIndex: 1 });
  streamed = applyAssistantUpdate(streamed, { type: "message_update", kind: "text_delta", contentIndex: 1, delta: "Answer" });
  assert.deepEqual(streamed.content, [{ type: "thinking", thinking: "Plan", thinkingSignature: "sig" }, { type: "text", text: "Answer" }]);
  streamed = applyAssistantUpdate(streamed, { type: "message_update", kind: "toolcall_start", contentIndex: 2, toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: {} } });
  streamed = applyAssistantUpdate(streamed, { type: "message_update", kind: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: { path: "file.txt" } } });
  assert.deepEqual(streamed.content?.[2], { type: "toolCall", id: "call_1", name: "read", arguments: { path: "file.txt" } });
  assert.equal(applyAssistantUpdate(assistant, { type: "message_update", messageTimestamp: 999, kind: "text_delta", contentIndex: 0, delta: "stale" }), assistant, "an update for another message is ignored");

  const base: AgentSnapshot = { ...(snapshots[0] as AgentSnapshot), messages: [{ role: "user", content: "One" }, { role: "assistant", content: "Two" }], messageNumberOffset: 0, messageSliceOffset: undefined, totalDisplayMessages: 2 };
  const partial: AgentMessage = { role: "assistant", content: [{ type: "text", text: "Par" }], timestamp: 2000 };
  const incremental: AgentSnapshot = { ...base, messages: [], messageNumberOffset: 0, messageSliceOffset: 2, totalDisplayMessages: 2 };
  const merged = mergeAgentSnapshot({ ...base, messages: [...base.messages, partial] }, incremental, partial);
  assert.equal(merged.messages.length, 3, "the in-progress message survives an empty incremental snapshot");
  assert.equal(merged.messages[2], partial);
  const appended: AgentSnapshot = { ...base, messages: [{ role: "assistant", content: "Three", timestamp: 2000 }], messageNumberOffset: 0, messageSliceOffset: 2, totalDisplayMessages: 3 };
  const appendedMerged = mergeAgentSnapshot({ ...base, messages: [...base.messages, partial] }, appended, partial);
  assert.equal(appendedMerged.messages.length, 3);
  assert.deepEqual(appendedMerged.messages.map((item) => item.content), ["One", "Two", "Three"], "the partial is replaced by the persisted message");
  const branchSwitch = mergeAgentSnapshot(base, { ...appended, messageSliceOffset: undefined });
  assert.equal(branchSwitch.messages.length, 1, "a full snapshot replaces the message list");

  console.log("streaming checks passed");
} finally {
  await agents.dispose().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
