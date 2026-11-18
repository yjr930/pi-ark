import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Model, type ToolCall } from "@earendil-works/pi-ai";

const temp = resolve(".tmp");
await mkdir(temp, { recursive: true });
const directory = await mkdtemp(join(temp, "memory-agent-"));
process.env.PI_ARK_HOME = join(directory, "home");
process.env.PI_ARK_AGENT_DIR = join(directory, "home", "pi-agent");
process.env.PI_CODING_AGENT_DIR = process.env.PI_ARK_AGENT_DIR;
const [{ AgentService }, { WorkspaceService }, { WorkspaceMemory }, { registerMemoryRoutes }] = await Promise.all([
  import("../apps/server/src/agents.ts"), import("../apps/server/src/workspaces.ts"), import("../apps/server/src/workspace-memory.ts"), import("../apps/server/src/memory-routes.ts"),
]);
const workspace = { id: "source", name: "Source", path: join(directory, "source") };
const other = { id: "other", name: "Other", path: join(directory, "other") };
const workspaces = new WorkspaceService([workspace, other]);
const memory = new WorkspaceMemory(join(process.env.PI_ARK_HOME, "memory"));
const model: Model<"openai-completions"> = { provider: "openai", id: "memory-fixture", name: "Memory fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 };
const settings = { getSessionModelConfiguration: async () => ({ model, scopedModels: [] }), getModelContextWindow: () => model.contextWindow, resolveModel: async () => model };
const agents = new AgentService(settings as never, workspaces, memory);
const app = Fastify();
registerMemoryRoutes(app, { memory, workspaces, sourceStatus: (workspace, source) => agents.memorySourceStatus(workspace, source), saveSettings: async (id, input) => memory.setSettings(input.enabled ? await workspaces.ensureMemoryStore(id, async () => {}) : workspaces.get(id).memoryStoreId, input) });
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const base = "/api/workspaces/source/memory";

function fixture(session: AgentSession) {
  const calls: ToolCall[] = [];
  const requests: { text: string; tools: string[] }[] = [];
  session.agent.streamFunction = (_model, context) => {
    const tools = getCurrentTools(context.messages).map((tool) => tool.name);
    requests.push({ text: JSON.stringify(context.messages.filter((message) => message.role === "user")), tools });
    const call = calls.shift();
    const stopReason = call ? "toolUse" : "stop";
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: call ? [call] : [{ type: "text", text: "Recorded." }], usage: structuredClone(usage), stopReason, timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: stopReason, message });
    stream.end();
    return stream;
  };
  return { requests, calls };
}
async function open(workspace: typeof other) {
  const { id } = await agents.create(workspace);
  const session = (agents as unknown as { handles: Map<string, { session: AgentSession }> }).handles.get(`${workspace.id}:${id}`)!.session;
  await session.modelRuntime.setRuntimeApiKey("openai", "local-fixture-key");
  return { id, session, ...fixture(session) };
}

try {
  await mkdir(process.env.PI_ARK_AGENT_DIR, { recursive: true });
  await Promise.all([mkdir(workspace.path), mkdir(other.path)]);
  await writeFile(join(process.env.PI_ARK_HOME, "config.json"), JSON.stringify({ tls: { keyPath: "key", certPath: "cert" }, auth: { username: "fixture", passwordHash: "fixture" }, workspaces: [workspace, other] }));
  await writeFile(join(process.env.PI_ARK_AGENT_DIR, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const first = await open(workspace);
  await agents.prompt(workspace, first.id, "Workspace Memory is off");
  assert.equal(first.requests[0].tools.includes("memory_propose"), false);
  assert.equal((await app.inject({ method: "PUT", url: `${base}/settings`, payload: { enabled: true, autoIndex: true } })).statusCode, 200);
  const draft = { type: "project", title: "Monthly report calendar", summary: "Group cash receipts by their deposit date", body: "Use the deposit date so the report reconciles with the bank statement.", tags: ["monthly report"], pinned: false };
  first.calls.push({ type: "toolCall", id: randomUUID(), name: "memory_propose", arguments: draft });
  await agents.prompt(workspace, first.id, "Remember that the monthly report groups cash receipts by their deposit date.");
  assert.ok(first.requests.at(-1)?.tools.includes("memory_propose"));
  const snapshot = (await app.inject(base)).json();
  assert.equal(snapshot.entries.length, 0);
  assert.equal(snapshot.proposals.length, 1);
  const proposal = snapshot.proposals[0];
  const proposalPath = `${base}/proposals/${proposal.id}`;
  assert.match(proposal.source.link, /\/message\/m[0-9a-z]{6}\?leafEntryId=/);
  assert.equal((await app.inject(proposalPath)).json().historical, false);
  await agents.rollbackLatest(workspace, first.id);
  const review = (await app.inject(proposalPath)).json();
  assert.equal(review.historical, true);
  assert.equal(review.sourceAvailable, true);
  assert.equal((await app.inject({ method: "POST", url: `${proposalPath}/confirm`, payload: { draft } })).statusCode, 409);
  const approved = await app.inject({ method: "POST", url: `${proposalPath}/confirm`, payload: { draft, reviewHistorical: true } });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal((await app.inject({ method: "POST", url: `${proposalPath}/confirm`, payload: {} })).json().entryId, approved.json().entryId);

  const second = await open(workspace);
  second.calls.push({ type: "toolCall", name: "memory_read", id: randomUUID(), arguments: { id: approved.json().entryId } });
  await agents.prompt(workspace, second.id, "Prepare the monthly report.");
  assert.equal(second.requests.length, 2);
  for (const request of second.requests) {
    assert.equal(request.text.match(/<pi-ark-workspace-memory>/g)?.length, 1);
    assert.match(request.text, /Monthly report calendar/);
    assert.doesNotMatch(request.text, /reconciles with the bank statement/);
  }
  assert.ok(second.session.messages.some((message) => message.role === "toolResult" && !message.isError && JSON.stringify(message.content).includes("reconciles with the bank statement")));
  assert.doesNotMatch(await readFile(second.session.sessionFile!, "utf8"), /<pi-ark-workspace-memory>/);
  assert.match((await app.inject(`${base}/export`)).body, /# Workspace Memory[\s\S]*Monthly report calendar/);
  const isolated = await open(other);
  await agents.prompt(other, isolated.id, "Prepare the monthly report.");
  assert.doesNotMatch(isolated.requests[0].text, /Monthly report calendar/);
  assert.ok(!isolated.requests[0].tools.includes("memory_read"));

  const renamed = workspaces.rename(workspace.id, "Renamed source");
  await agents.prompt(renamed, second.id, "Check that monthly report setting two more times.");
  assert.match(second.requests.at(-1)!.text, /Monthly report calendar/);
  await app.inject({ method: "PUT", url: `${base}/settings`, payload: { enabled: true, autoIndex: false } });
  await agents.prompt(renamed, second.id, "Prepare another monthly report.");
  assert.doesNotMatch(second.requests.at(-1)!.text, /<pi-ark-workspace-memory>/);
  assert.ok(second.requests.at(-1)!.tools.includes("memory_read"));
  await app.inject({ method: "PUT", url: `${base}/settings`, payload: { enabled: false, autoIndex: true } });
  await agents.prompt(renamed, second.id, "Memory is now off.");
  assert.ok(!second.requests.at(-1)!.tools.includes("memory_read"));
  assert.equal((await app.inject(base)).json().entries.length, 1);

  await agents.delete(renamed, first.id);
  const source = await app.inject({ method: "POST", url: `${base}/entries/${approved.json().entryId}/check-source` });
  assert.equal(source.statusCode, 200, source.body);
  assert.equal(source.json().sourceAvailable, false);
  assert.equal(source.json().entry.status, "review");
  await agents.closeWorkspace(renamed);
  assert.ok(![...(agents as unknown as { handles: Map<string, unknown> }).handles.keys()].some((key) => key.startsWith("source:")));
  workspaces.remove(workspace.id);
  const newRegistration = await workspaces.add({ name: "Source", path: workspace.path });
  assert.equal(newRegistration.id, workspace.id);
  assert.equal(workspaces.currentRegistration(workspace), undefined);
  assert.equal((await app.inject(base)).json().entries.length, 0);
  console.log("Workspace Memory works with SDK tool calls, request-only indexing, review routes, branch sources, and independent Workspace registrations.");
} finally {
  await agents.dispose();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
