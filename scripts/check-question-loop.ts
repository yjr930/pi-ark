import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type ContentBlock, type Model } from "@earendil-works/pi-ai";

const directory = await mkdtemp(join(tmpdir(), "pi-ark-question-loop-"));
process.env.PI_ARK_HOME = join(directory, "home");
process.env.PI_ARK_AGENT_DIR = join(directory, "home", "pi-agent");
process.env.PI_CODING_AGENT_DIR = process.env.PI_ARK_AGENT_DIR;
const workspace = { id: "question-loop", name: "Question loop checks", path: join(directory, "workspace") };
const { AgentService } = await import("../apps/server/src/agents.ts");
const { WorkspaceService } = await import("../apps/server/src/workspaces.ts");
const model: Model<"openai-completions"> = { provider: "openai", id: "question-fixture", name: "Question fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 };
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const settings = { getSessionModelConfiguration: async () => ({ model, scopedModels: [] }), getModelContextWindow: () => model.contextWindow, resolveModel: async () => model };
const agents = new AgentService(settings as never, new WorkspaceService([workspace]));
const internal = agents as unknown as { handles: Map<string, { session: AgentSession }> };

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((block): block is ContentBlock => Boolean(block) && typeof block === "object" && "type" in block && block.type === "text" && "text" in block).map((block) => block.text || "").join("") : "";
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const scripted: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
const toolResults = new Map<string, { status?: string; reason?: string; answers?: unknown; token?: string }>();
const customTexts: string[] = [];

await mkdir(process.env.PI_ARK_AGENT_DIR!, { recursive: true });
await mkdir(workspace.path);
await writeFile(join(process.env.PI_ARK_HOME!, "config.json"), JSON.stringify({ tls: { keyPath: "/tmp/key", certPath: "/tmp/cert" }, auth: { username: "check", passwordHash: "check" }, workspaces: [workspace] }));
await writeFile(join(process.env.PI_ARK_AGENT_DIR!, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));

const opened = await agents.create(workspace);
const session = internal.handles.get(`${workspace.id}:${opened.id}`)!.session;
await session.modelRuntime.setRuntimeApiKey("openai", "local-fixture-key");
session.agent.streamFunction = () => {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: structuredClone(usage), stopReason: "stop", timestamp: Date.now() };
    const last = session.messages.at(-1);
    if (last?.role === "toolResult") {
      toolResults.set(String((last as { toolCallId?: string }).toolCallId), JSON.parse(messageText(last.content) || "{}"));
      message.content = [{ type: "text", text: "Recorded the tool result." }];
      stream.push({ type: "done", reason: "stop", message });
    } else if (last?.role === "custom") {
      customTexts.push(messageText(last.content));
      message.content = [{ type: "text", text: "Recorded the answer message." }];
      stream.push({ type: "done", reason: "stop", message });
    } else {
      const next = scripted.shift();
      if (!next) message.content = [{ type: "text", text: "Nothing else to ask." }];
      else { message.content = [{ type: "toolCall", id: next.id, name: next.name, arguments: next.arguments }]; message.stopReason = "toolUse"; }
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    }
    stream.end();
  })().catch((error) => {
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: structuredClone(usage), stopReason: "error", errorMessage: String(error), timestamp: Date.now() };
    stream.push({ type: "error", reason: "error", error: message });
    stream.end();
  });
  return stream;
};

function sendPrompt(text: string): void {
  void agents.prompt(workspace, opened.id, text).catch((error) => { console.error(error); process.exit(1); });
}

const status = () => agents.statuses(workspace).find((item) => item.id === opened.id);
const display = () => (agents as unknown as { snapshotMessages(handle: unknown): Array<Record<string, unknown>> }).snapshotMessages(internal.handles.get(`${workspace.id}:${opened.id}`));
const questionState = () => (agents as unknown as { questionGroups(handle: unknown): Array<{ toolCallId: string; status: string; token?: string }> }).questionGroups(internal.handles.get(`${workspace.id}:${opened.id}`));

try {
  const formatQuestion = { questions: [{ header: "Output format", question: "How should the report be formatted?", options: [{ label: "Summary" }, { label: "Detailed" }] }] };

  // Blocking question: the run pauses until the user submits an answer.
  scripted.push({ id: "ask-1", name: "question", arguments: formatQuestion });
  sendPrompt("Confirm the output format.");
  await waitFor(() => status()?.waitingForAnswer === true, "blocking question pending");
  assert.equal(status()?.state, "running");
  assert.equal(questionState().find((group) => group.toolCallId === "ask-1")?.status, "pending");
  await agents.answerQuestion(workspace, opened.id, "ask-1", [{ index: 0, selected: ["Detailed"], custom: "" }]);
  await waitFor(() => toolResults.has("ask-1"), "blocking tool result");
  assert.deepEqual(toolResults.get("ask-1"), { status: "answered", answers: [{ index: 0, selected: ["Detailed"], custom: "" }] });
  await session.waitForIdle();
  assert.equal(status()?.waitingForAnswer, false);
  assert.equal(questionState().find((group) => group.toolCallId === "ask-1")?.status, "answered");
  await assert.rejects(agents.answerQuestion(workspace, opened.id, "ask-1", [{ index: 0, selected: ["Summary"] }]), /no longer open/);

  // Background question: the run continues, and the answer arrives as a custom message.
  scripted.push({ id: "ask-2", name: "question_background", arguments: { questions: [{ header: "Charts", question: "Include charts?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: true }] } });
  sendPrompt("Start the report.");
  await waitFor(() => toolResults.has("ask-2"), "background tool result");
  assert.equal(toolResults.get("ask-2")?.status, "pending");
  await session.waitForIdle();
  const token = toolResults.get("ask-2")?.token;
  assert.ok(token);
  await waitFor(() => status()?.waitingForAnswer === true, "background question pending");
  assert.equal(questionState().find((group) => group.toolCallId === "ask-2")?.status, "pending");
  await agents.answerQuestion(workspace, opened.id, "ask-2", [{ index: 0, selected: ["Yes", "No"], custom: "按月拆分" }]);
  await waitFor(() => customTexts.length >= 1, "background answer message");
  assert.match(customTexts.at(-1)!, /^\[问题回答\] Q2 「Charts」Include charts\? → Yes；No；自由输入：按月拆分$/);
  await session.waitForIdle();
  assert.equal(status()?.waitingForAnswer, false);
  assert.equal(questionState().find((group) => group.toolCallId === "ask-2")?.status, "answered");

  // Dismissing a background question writes a cancellation message.
  scripted.push({ id: "ask-3", name: "question_background", arguments: { questions: [{ question: "Pick a logo", options: [{ label: "Circle" }, { label: "Square" }] }] } });
  sendPrompt("Continue drafting.");
  await waitFor(() => toolResults.has("ask-3"), "second background tool result");
  await session.waitForIdle();
  await agents.dismissQuestion(workspace, opened.id, "ask-3");
  await waitFor(() => customTexts.at(-1)?.startsWith("[问题取消]"), "background cancellation message");
  assert.match(customTexts.at(-1)!, /^\[问题取消\] Q3 用户放弃了作答。问题：Pick a logo$/);
  await session.waitForIdle();

  // A new user message settles an open blocking question before it is delivered.
  scripted.push({ id: "ask-4", name: "question", arguments: { questions: [{ question: "Keep the old draft?", options: [{ label: "Keep" }, { label: "Discard" }] }] } });
  sendPrompt("Ask before rewriting.");
  await waitFor(() => status()?.waitingForAnswer === true, "second blocking question pending");
  sendPrompt("Actually, start over.");
  await waitFor(() => toolResults.has("ask-4"), "settled blocking tool result");
  assert.deepEqual(toolResults.get("ask-4"), { status: "unanswered", reason: "user_prompt", answers: [] });
  await session.waitForIdle();
  assert.equal(status()?.waitingForAnswer, false);

  // Stop settles an open blocking question through the abort signal.
  scripted.push({ id: "ask-5", name: "question", arguments: { questions: [{ question: "Confirm before stopping?", options: [{ label: "Yes" }, { label: "No" }] }] } });
  sendPrompt("Ask, then wait.");
  await waitFor(() => status()?.waitingForAnswer === true, "third blocking question pending");
  await agents.abort(workspace, opened.id);
  const abortedResult = () => session.messages.find((message) => message.role === "toolResult" && (message as { toolCallId?: string }).toolCallId === "ask-5");
  await waitFor(() => Boolean(abortedResult()), "aborted blocking tool result");
  assert.deepEqual(JSON.parse(messageText(abortedResult()!.content)), { status: "unanswered", reason: "aborted", answers: [] });
  await session.waitForIdle();

  // A stored tool call without a result is healed when the Session is opened again.
  const manager = session.sessionManager;
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "ask-orphan", name: "question", arguments: formatQuestion }], api: model.api, provider: model.provider, model: model.id, usage: structuredClone(usage), stopReason: "toolUse", timestamp: Date.now() });
  const reopenedAgents = new AgentService(settings as never, new WorkspaceService([workspace]));
  try {
    const reopened = await (reopenedAgents as unknown as { getOrOpen(workspace: typeof workspace, sessionId: string): Promise<{ session: AgentSession }> }).getOrOpen(workspace, opened.id);
    const healedResults = reopened.session.messages.filter((message) => message.role === "toolResult" && (message as { toolCallId?: string }).toolCallId === "ask-orphan");
    assert.equal(healedResults.length, 1);
    assert.equal(JSON.parse(messageText(healedResults[0].content)).reason, "aborted");
  } finally {
    await reopenedAgents.dispose();
  }

  // Subagent sessions never expose the question tools.
  const childTools = ["read", "bash", "edit", "write", "read_pi_ark_link", "webfetch"];
  assert.deepEqual(["question", "question_background"].filter((name) => childTools.includes(name)), []);
  console.log("Question tool loop checks passed");
} finally {
  await agents.dispose();
  await rm(directory, { recursive: true, force: true });
}
