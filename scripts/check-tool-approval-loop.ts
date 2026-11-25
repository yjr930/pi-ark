import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type ContentBlock, type Model } from "@earendil-works/pi-ai";
import type { ToolApprovalDecision } from "../apps/server/src/tool-approvals.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = join(projectRoot, ".tmp");
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(join(temporaryRoot, "approval-loop-"));
process.env.PI_ARK_HOME = join(directory, "home");
process.env.PI_ARK_AGENT_DIR = join(directory, "home", "pi-agent");
process.env.PI_CODING_AGENT_DIR = process.env.PI_ARK_AGENT_DIR;
const workspace = { id: "approval-loop", name: "Approval loop checks", path: join(directory, "workspace") };
const { AgentService } = await import("../apps/server/src/agents.ts");
const { WorkspaceService } = await import("../apps/server/src/workspaces.ts");
const { saveApprovalSettings } = await import("../apps/server/src/config.ts");
const model: Model<"openai-completions"> = { provider: "openai", id: "approval-fixture", name: "Approval fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 };
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const settings = { getSessionModelConfiguration: async () => ({ model, scopedModels: [] }), getModelContextWindow: () => model.contextWindow, resolveModel: async () => model };
const agents = new AgentService(settings as never, new WorkspaceService([workspace]));
const internal = agents as unknown as {
  handles: Map<string, { session: AgentSession; pendingApprovals: Map<string, { request: { approvalId: string; anchorToolCallId: string; sessionLink?: string; sessionTitle?: string } }> }>;
  snapshotMessages(handle: unknown): Array<Record<string, unknown>>;
  snapshotPayload(handle: unknown, messages: unknown, client: unknown, full: boolean): { session: { approvals?: Array<{ approvalId: string }>; waitingForApproval?: boolean } };
  requestDeleteApproval(workspace: typeof workspace, input: { sessionId: string; toolCallId: string; command: string; matched: string; signal?: AbortSignal }): Promise<ToolApprovalDecision>;
};

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
const toolResults = new Map<string, { text: string; isError?: boolean }>();

await mkdir(process.env.PI_ARK_AGENT_DIR!, { recursive: true });
await mkdir(workspace.path);
await writeFile(join(process.env.PI_ARK_HOME!, "config.json"), JSON.stringify({ tls: { keyPath: "/tmp/key", certPath: "/tmp/cert" }, auth: { username: "check", passwordHash: "check" }, workspaces: [workspace] }));
await writeFile(join(process.env.PI_ARK_AGENT_DIR!, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));

const opened = await agents.create(workspace);
const handle = internal.handles.get(`${workspace.id}:${opened.id}`)!;
const session = handle.session;
await session.modelRuntime.setRuntimeApiKey("openai", "local-fixture-key");
session.agent.streamFunction = () => {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage: structuredClone(usage), stopReason: "stop", timestamp: Date.now() };
    const last = session.messages.at(-1);
    if (last?.role === "toolResult") {
      toolResults.set(String((last as { toolCallId?: string }).toolCallId), { text: messageText(last.content), isError: (last as { isError?: boolean }).isError });
      message.content = [{ type: "text", text: "Recorded the tool result." }];
      stream.push({ type: "done", reason: "stop", message });
    } else {
      const next = scripted.shift();
      if (!next) message.content = [{ type: "text", text: "Nothing else to run." }];
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
const approvals = () => [...handle.pendingApprovals.values()];

try {
  // Commands that keep files run without an approval request.
  scripted.push({ id: "bash-1", name: "bash", arguments: { command: "echo keep" } });
  sendPrompt("Print a word.");
  await waitFor(() => toolResults.has("bash-1"), "plain command result");
  assert.match(toolResults.get("bash-1")!.text, /keep/);
  assert.equal(status()?.waitingForApproval, false);
  assert.equal(approvals().length, 0);
  await session.waitForIdle();

  // An approved delete command removes the file after the decision.
  const approvedVictim = join(workspace.path, "approved.txt");
  await writeFile(approvedVictim, "delete me");
  scripted.push({ id: "bash-2", name: "bash", arguments: { command: "rm approved.txt" } });
  sendPrompt("Remove the temporary file.");
  await waitFor(() => status()?.waitingForApproval === true, "delete command pending");
  assert.equal(status()?.state, "running");
  const pending = approvals();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request.anchorToolCallId, "bash-2");
  const payload = internal.snapshotPayload(handle, internal.snapshotMessages(handle), { start: 0 }, true);
  assert.equal(payload.session.waitingForApproval, true);
  assert.equal(payload.session.approvals?.length, 1);
  await agents.decideApproval(workspace, opened.id, payload.session.approvals![0].approvalId, true);
  await waitFor(() => toolResults.has("bash-2"), "approved command result");
  await assert.rejects(access(approvedVictim), /ENOENT/);
  await session.waitForIdle();
  assert.equal(status()?.waitingForApproval, false);
  assert.equal(approvals().length, 0);

  // A denied delete command keeps the file and reports the rejection to the model.
  const deniedVictim = join(workspace.path, "denied.txt");
  await writeFile(deniedVictim, "keep me");
  scripted.push({ id: "bash-3", name: "bash", arguments: { command: "rm -f denied.txt" } });
  sendPrompt("Remove the other temporary file.");
  await waitFor(() => status()?.waitingForApproval === true, "denied command pending");
  await agents.decideApproval(workspace, opened.id, approvals()[0].request.approvalId, false);
  await waitFor(() => toolResults.has("bash-3"), "denied command result");
  assert.equal(toolResults.get("bash-3")!.isError, true);
  assert.match(toolResults.get("bash-3")!.text, /^\[删除审批\] 用户拒绝了该删除命令。命令：rm -f denied\.txt$/);
  assert.equal(await readFile(deniedVictim, "utf8"), "keep me");
  await session.waitForIdle();
  await assert.rejects(agents.decideApproval(workspace, opened.id, "missing-approval", true), /no longer open/);

  // The Settings switch disables the check for the next tool call.
  await saveApprovalSettings({ deleteCommands: false });
  const disabledVictim = join(workspace.path, "disabled.txt");
  await writeFile(disabledVictim, "delete me");
  scripted.push({ id: "bash-4", name: "bash", arguments: { command: "rm disabled.txt" } });
  sendPrompt("Remove the third temporary file.");
  await waitFor(() => toolResults.has("bash-4"), "unchecked command result");
  assert.equal(status()?.waitingForApproval, false);
  assert.equal(approvals().length, 0);
  await assert.rejects(access(disabledVictim), /ENOENT/);
  await session.waitForIdle();
  await saveApprovalSettings({ deleteCommands: true });

  // Subagent calls are approved in the parent Session with a link to the child.
  const childSessionId = "00000000-0000-4000-8000-0000000000c1";
  await agents.subagents.store.load(workspace);
  await agents.subagents.store.save(workspace, {
    version: 1, id: "00000000-0000-4000-8000-0000000000a1", parentSessionId: opened.id, parentLink: "", toolCallId: "sub-call-1",
    createdAt: new Date().toISOString(), revision: 0, model: { provider: model.provider, id: model.id }, thinkingLevel: "off", tools: ["bash"], systemPromptAppend: "",
    tasks: [{ sessionId: childSessionId, sessionLink: `pi-ark://workspace/${workspace.id}/session/${childSessionId}`, title: "Clean release build", task: "Remove build output", expectedResult: "Build output is gone", state: "running", references: [] }],
  });
  const routed = internal.requestDeleteApproval(workspace, { sessionId: childSessionId, toolCallId: "bash-child-1", command: "rm -rf build", matched: "rm" });
  await waitFor(() => approvals().length === 1, "routed approval pending");
  const routedRequest = approvals()[0].request;
  assert.equal(routedRequest.anchorToolCallId, "sub-call-1");
  assert.equal(routedRequest.sessionTitle, "Clean release build");
  assert.match(routedRequest.sessionLink || "", new RegExp(childSessionId));
  assert.equal(status()?.waitingForApproval, true);
  await agents.abort(workspace, opened.id);
  assert.deepEqual(await routed, { approved: false, reason: "[删除审批] 会话被中止，该命令没有执行。命令：rm -rf build" });
  assert.equal(approvals().length, 0);
  assert.equal(status()?.waitingForApproval, false);

  console.log("Delete command approval checks passed");
} finally {
  await agents.dispose();
  await rm(directory, { recursive: true, force: true });
}
