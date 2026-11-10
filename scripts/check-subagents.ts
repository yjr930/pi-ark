import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { SubagentConfiguration } from "../apps/server/src/subagents.ts";
import type { SubagentRun } from "../apps/server/src/subagent-types.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-subagents-"));
process.env.PI_ARK_HOME = join(directory, "home");
process.env.PI_ARK_AGENT_DIR = join(directory, "home", "pi-agent");
process.env.PI_CODING_AGENT_DIR = process.env.PI_ARK_AGENT_DIR;
const workspace = { id: "subagents", name: "Subagent checks", path: join(directory, "workspace") };
const { AgentService } = await import("../apps/server/src/agents.ts");
const { WorkspaceService } = await import("../apps/server/src/workspaces.ts");
const { SubagentStore } = await import("../apps/server/src/subagent-store.ts");
const { SessionReader } = await import("../apps/server/src/session-reader.ts");
const { buildSessionDisplayMessages } = await import("../apps/server/src/session-display.ts");
const model: Model<"openai-completions"> = { provider: "openai", id: "subagent-fixture", name: "Subagent fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 };
const usage = { input: 12, output: 7, cacheRead: 3, cacheWrite: 0, totalTokens: 22, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const taskInput = (title: string) => ({ title, task: `Read the parent request and report the result for ${title}.`, expectedResult: `A self-contained report for ${title}.` });
async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${description}`); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
const settings = { getSessionModelConfiguration: async () => ({ model, scopedModels: [] }), getModelContextWindow: () => model.contextWindow, resolveModel: async () => model };
const registry = new WorkspaceService([workspace]);
const agents = new AgentService(settings as never, registry);
const internal = agents as unknown as { handles: Map<string, { session: AgentSession }>; getOrOpen(workspace: typeof workspace, sessionId: string): Promise<{ session: AgentSession }> };
const session = (id: string) => internal.handles.get(`${workspace.id}:${id}`)!.session;
const configuration: SubagentConfiguration = { model, thinkingLevel: "off", tools: ["read", "read_pi_ark_link"], systemPromptAppend: "Shared subagent fixture instructions" };
const gates = new Map<string, () => void>();
const seenImages = new Map<string, number>();
const seenReferences = new Set<string>();
let active = 0;
let maximumActive = 0;
let created = 0;
const runtimeFactory = agents.subagents as unknown as { createSession(workspace: typeof workspace, manager: SessionManager, config: SubagentConfiguration): Promise<AgentSession> };
const createSession = runtimeFactory.createSession.bind(runtimeFactory);
runtimeFactory.createSession = async (target, manager, config) => {
  const child = await createSession(target, manager, config);
  created += 1;
  await child.modelRuntime.setRuntimeApiKey("openai", "local-fixture-key");
  child.agent.streamFunction = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const title = child.sessionName!;
      const toolResult = context.messages.at(-1)?.role === "toolResult";
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: structuredClone(usage), stopReason: "stop", timestamp: Date.now() };
      if (!toolResult) {
        active += 1; maximumActive = Math.max(maximumActive, active);
        seenImages.set(title, context.messages.flatMap((item) => "content" in item && Array.isArray(item.content) ? item.content : []).filter((block) => block.type === "image").length);
        await new Promise<void>((resolve) => {
          const done = () => { options?.signal?.removeEventListener("abort", done); gates.delete(title); resolve(); };
          gates.set(title, done);
          options?.signal?.addEventListener("abort", done, { once: true });
          if (options?.signal?.aborted) done();
        });
        active -= 1;
      }
      if (options?.signal?.aborted || title.includes("failure")) {
        message.stopReason = options?.signal?.aborted ? "aborted" : "error";
        message.errorMessage = options?.signal?.aborted ? "Fixture aborted" : "Fixture provider error";
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else if (!toolResult) {
        const source = agents.subagents.store.findTask(workspace, child.sessionId)!.task.references[0];
        message.content = [{ type: "toolCall", id: `read-${child.sessionId}`, name: "read_pi_ark_link", arguments: { link: source.link, leafEntryId: source.leafEntryId } }];
        message.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message });
      } else {
        const result = context.messages.at(-1)!;
        assert.equal(result.role, "toolResult");
        assert.equal(result.isError, false);
        const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        assert.match(text, /Parent request/);
        seenReferences.add(title);
        message.content = [{ type: "text", text: `Result for ${title}: ${"中文报告".repeat(title.includes("long") ? 2000 : 2)}` }];
        stream.push({ type: "done", reason: "stop", message });
      }
      stream.end();
    })().catch((error) => {
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: structuredClone(usage), stopReason: "error", errorMessage: String(error), timestamp: Date.now() };
      stream.push({ type: "error", reason: "error", error: message }); stream.end();
    });
    return stream;
  };
  return child;
};
function releaseAll() { for (const release of [...gates.values()]) release(); }
function runFor(parentId: string, callId: string) { return agents.subagents.store.state(workspace, parentId).runs.find((run) => run.toolCallId === callId)!; }
const socketMessages: Array<Record<string, any>> = [];
const socket = { readyState: 1, OPEN: 1, send: (payload: string) => socketMessages.push(JSON.parse(payload)) };

try {
  await mkdir(process.env.PI_ARK_AGENT_DIR!, { recursive: true }); await mkdir(workspace.path);
  await writeFile(join(process.env.PI_ARK_HOME!, "config.json"), JSON.stringify({ tls: { keyPath: "/tmp/key", certPath: "/tmp/cert" }, auth: { username: "check", passwordHash: "check" }, workspaces: [workspace], preferences: { agent: { tools: ["read"], systemPrompt: { append: configuration.systemPromptAppend } } } }));
  await writeFile(join(process.env.PI_ARK_AGENT_DIR!, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const parent = await agents.create(workspace);
  const parentSession = session(parent.id);
  parentSession.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Parent request: inspect independently." }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }], timestamp: Date.now() });
  const disconnect = await agents.connect(workspace, parent.id, socket as never);
  const inputs = Array.from({ length: 6 }, (_, index) => ({ ...taskInput(`parallel-${index}`), ...(index === 0 ? { references: [{ link: `pi-ark://workspace/${workspace.id}/session/${parent.id}/message/${buildSessionDisplayMessages(parentSession.sessionManager).at(-1)!.messageId}`, purpose: "Explicitly reference the same source image" }] } : {}) }));
  const operation = agents.subagents.run(workspace, parentSession, configuration, "parallel", inputs);
  assert.equal(agents.subagents.run(workspace, parentSession, configuration, "parallel", inputs), operation);
  await waitFor(() => active === 4 && created === 6, "four active and two queued tasks");
  const running = runFor(parent.id, "parallel");
  assert.equal(running.tasks.filter((task) => task.state === "queued").length, 2);
  assert.equal((await agents.list(workspace)).filter((item) => item.subagentOrigin?.parentSessionId === parent.id).length, 6);
  const child = running.tasks.find((task) => task.state === "running")!;
  assert.deepEqual(session(child.sessionId).model, model);
  assert.equal(session(child.sessionId).thinkingLevel, configuration.thinkingLevel);
  assert.deepEqual(session(child.sessionId).getActiveToolNames().sort(), configuration.tools.slice().sort());
  assert.match(session(child.sessionId).systemPrompt, /Shared subagent fixture instructions/);
  assert.match(session(child.sessionId).systemPrompt, /First check that the delegated task is complete/);
  assert.equal(session(child.sessionId).getActiveToolNames().includes("subagent"), false);
  await assert.rejects(agents.prompt(workspace, child.sessionId, "interfere"), /managed by its parent/);
  await assert.rejects(agents.setThinkingLevel(workspace, child.sessionId, "off"), /managed by its parent/);
  const [openedA, openedB] = await Promise.all([internal.getOrOpen(workspace, child.sessionId), internal.getOrOpen(workspace, child.sessionId)]);
  assert.equal(openedA.session, openedB.session);
  disconnect();
  releaseAll();
  await waitFor(() => gates.size === 2, "remaining queued tasks start after browser disconnect");
  releaseAll();
  const completed = await operation;
  assert.equal(maximumActive, 4);
  assert.equal(completed.tasks.every((task) => task.state === "completed"), true, JSON.stringify(completed.tasks.map((task) => ({ state: task.state, error: task.error }))));
  assert.equal(completed.tasks.every((task) => seenImages.get(task.title) === 1 && seenReferences.has(task.title)), true, JSON.stringify({ images: [...seenImages], references: [...seenReferences] }));
  assert.equal(socketMessages.some((payload) => payload.type === "subagent-state"), true);
  const reader = new SessionReader(registry, (_workspace, id) => internal.handles.get(`${workspace.id}:${id}`)?.session.sessionManager);
  const first = completed.tasks[0];
  const resultBefore = await reader.read({ link: first.resultLink! });
  assert.match(resultBefore.messages![0].content, /Result for parallel-0/);
  const manager = session(first.sessionId).sessionManager;
  const historicalLeaf = manager.getLeafId(); manager.resetLeaf();
  assert.equal((await reader.read({ link: first.resultLink! })).target!.entryId, first.resultEntryId);
  const historicalMessages: Array<any> = [];
  const historicalSocket = { readyState: 1, OPEN: 1, send: (payload: string) => historicalMessages.push(JSON.parse(payload)) };
  const closeHistory = await agents.connect(workspace, first.sessionId, historicalSocket as never, { leafEntryId: first.resultLeafEntryId });
  assert.equal(historicalMessages[0].session.isIdle, true);
  assert.equal(historicalMessages[0].session.messages.at(-1).entryId, first.resultEntryId);
  assert.equal(manager.getLeafId(), null); closeHistory(); manager.branch(historicalLeaf!);
  const parentLeaf = parentSession.sessionManager.getLeafId(); parentSession.sessionManager.resetLeaf();
  assert.match((await reader.read({ link: completed.parentLink })).messages![0].content, /Parent request/);
  parentSession.sessionManager.branch(parentLeaf!);
  const disk = JSON.parse(await readFile(join(workspace.path, ".pi-ark", "subagent-runs", `${completed.id}.json`), "utf8"));
  assert.equal(disk.tasks.every((task: any) => task.state === "completed"), true);

  const stopping = agents.subagents.run(workspace, parentSession, configuration, "stop-one", [taskInput("stop-one"), taskInput("continue-one")]);
  await waitFor(() => gates.size === 2, "tasks before stopping one child");
  const stopRun = runFor(parent.id, "stop-one");
  await agents.abort(workspace, stopRun.tasks[0].sessionId);
  assert.equal(stopRun.tasks[0].state, "cancelled");
  assert.equal(stopRun.tasks[1].state, "running");
  releaseAll(); assert.equal((await stopping).tasks[1].state, "completed");

  const parentStop = agents.subagents.run(workspace, parentSession, configuration, "stop-parent", Array.from({ length: 6 }, (_, index) => taskInput(`stop-parent-${index}`)));
  await waitFor(() => gates.size === 4, "parent stop with queued tasks");
  await agents.abort(workspace, parent.id);
  assert.equal((await parentStop).tasks.every((task) => task.state === "cancelled"), true);
  const signal = new AbortController();
  const cancelled = agents.subagents.run(workspace, parentSession, configuration, "signal", [taskInput("signal")], signal.signal);
  await waitFor(() => gates.has("signal"), "abort signal task start"); signal.abort();
  assert.equal((await cancelled).tasks[0].state, "cancelled");

  const registered = parentSession.agent.state.tools.find((tool) => tool.name === "subagent")!;
  const longOperation = registered.execute("tool-long", { tasks: [taskInput("long-result")] });
  await waitFor(() => gates.has("long-result"), "registered subagent tool"); releaseAll();
  const toolResult = await longOperation;
  const longRun = runFor(parent.id, "tool-long");
  assert.equal(longRun.tasks[0].truncated, true);
  assert.ok(Buffer.byteLength(longRun.tasks[0].result!) <= 4096);
  assert.ok((await reader.read({ link: longRun.tasks[0].resultLink! })).messages![0].content.length > longRun.tasks[0].result!.length);
  assert.equal(toolResult.content[0].type, "text");
  const failed = agents.subagents.run(workspace, parentSession, configuration, "failure", [taskInput("failure")]);
  await waitFor(() => gates.has("failure"), "provider failure task start"); releaseAll();
  assert.equal((await failed).tasks[0].state, "failed");
  assert.match(runFor(parent.id, "failure").tasks[0].error!, /Fixture provider error/);

  const parentB = await agents.create(workspace); const parentC = await agents.create(workspace);
  for (const id of [parentB.id, parentC.id]) session(id).sessionManager.appendMessage({ role: "user", content: "Parent request for global parallelism", timestamp: Date.now() });
  maximumActive = 0;
  const globalRuns = [parent.id, parentB.id, parentC.id].map((id, index) => agents.subagents.run(workspace, session(id), configuration, `global-${index}`, Array.from({ length: 4 }, (_, taskIndex) => taskInput(`global-${index}-${taskIndex}`))));
  await waitFor(() => gates.size === 8, "global concurrency limit");
  assert.equal(active, 8); releaseAll(); await waitFor(() => gates.size === 4, "globally queued tasks start"); releaseAll();
  await Promise.all(globalRuns); assert.equal(maximumActive, 8);

  const queuedDeletion = agents.subagents.run(workspace, parentSession, configuration, "delete-queued", Array.from({ length: 6 }, (_, index) => taskInput(`delete-queued-${index}`)));
  await waitFor(() => gates.size === 4 && runFor(parent.id, "delete-queued").tasks.every((task) => internal.handles.has(`${workspace.id}:${task.sessionId}`)), "queued child ready for deletion");
  const queuedChild = runFor(parent.id, "delete-queued").tasks.find((task) => task.state === "queued")!;
  await agents.delete(workspace, queuedChild.sessionId);
  assert.equal(queuedChild.deleted, true); assert.equal(queuedChild.state, "cancelled");
  await agents.abort(workspace, parent.id); await queuedDeletion;
  assert.equal(internal.handles.has(`${workspace.id}:${queuedChild.sessionId}`), false);

  const restoredAgents = new AgentService(settings as never, registry);
  try {
    const restoredInternal = restoredAgents as unknown as typeof internal;
    const firstOpen = restoredInternal.getOrOpen(workspace, completed.tasks[1].sessionId);
    const secondOpen = restoredInternal.getOrOpen(workspace, completed.tasks[1].sessionId);
    assert.equal(firstOpen, secondOpen);
    const [firstHandle, secondHandle] = await Promise.all([firstOpen, secondOpen]);
    assert.equal(firstHandle.session, secondHandle.session); assert.equal(restoredInternal.handles.size, 1);
    assert.equal(restoredAgents.subagents.store.state(workspace, completed.tasks[1].sessionId).origin?.parentSessionId, parent.id);
  } finally { await restoredAgents.dispose(); }

  const recoveredStore = new SubagentStore();
  const recovered = await recoveredStore.load(workspace);
  assert.equal(recovered.get(completed.id)!.tasks[0].state, "completed");
  const interrupted: SubagentRun = structuredClone(completed); interrupted.id = crypto.randomUUID(); interrupted.toolCallId = "interrupted";
  interrupted.tasks[0].state = "running"; interrupted.tasks[1].state = "queued";
  await recoveredStore.save(workspace, interrupted);
  const restartStore = new SubagentStore(); const restarted = await restartStore.load(workspace);
  assert.deepEqual(restarted.get(interrupted.id)!.tasks.slice(0, 2).map((task) => task.state), ["interrupted", "interrupted"]);
  const countBefore = created;
  assert.equal((await agents.subagents.run(workspace, parentSession, configuration, "parallel", inputs)).id, completed.id);
  assert.equal(created, countBefore);
  await agents.subagents.deleted(workspace, completed.tasks[0].sessionId);
  assert.equal(agents.subagents.store.state(workspace, parent.id).runs[0].tasks[0].deleted, true);
  await agents.subagents.deleted(workspace, parent.id);
  assert.equal(agents.subagents.store.state(workspace, completed.tasks[1].sessionId).origin?.parentDeleted, true);
  assert.equal(buildSessionDisplayMessages(session(completed.tasks[1].sessionId).sessionManager).some((message) => message.role === "user"), true);
  await assert.rejects(agents.subagents.run(workspace, parentSession, configuration, "empty", []), /between 1 and 8/);
  console.log("subagent checks passed");
} finally { releaseAll(); await agents.dispose(); await rm(directory, { recursive: true, force: true }); }
