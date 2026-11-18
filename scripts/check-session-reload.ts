import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentService as SessionService } from "../apps/server/src/agents.ts";
import type { SettingsService } from "../apps/server/src/settings.ts";

const temporaryRoot = fileURLToPath(new URL("../.tmp/", import.meta.url));
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(join(temporaryRoot, "session-reload-"));
const home = join(directory, "home");
const agentDir = join(home, "pi-agent");
const temp = join(directory, "temp");
Object.assign(process.env, {
  PI_ARK_HOME: home, PI_ARK_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
  HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp,
});

const variantTool = "reload_check_variant";
const removedTool = "reload_check_removed";
const addedTool = "reload_check_added";
const mcpName = "reload_check";
const mcpTool = `mcp__${mcpName}__static_text`;
const mcpText = "Local MCP fixture response";
const originalInstructions = "Use the original reload fixture instructions.";
const updatedInstructions = "Use the updated reload fixture instructions.";
const originalContext = "Original reload fixture workspace context.";
const updatedContext = "Updated reload fixture workspace context.";

const defaultModel: Model<"openai-completions"> = {
  provider: "openai", id: "reload-fixture-default", name: "Reload fixture default", api: "openai-completions",
  baseUrl: "http://127.0.0.1:1", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 10_000,
};
const selectedModel = { ...defaultModel, id: "reload-fixture-selected", name: "Reload fixture selected" };
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function extensionSource(name: string, description: string, result: string): string {
  return `import { Type } from "typebox";
export default function (pi: any) {
  pi.registerTool({
    name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)},
    description: ${JSON.stringify(description)}, exposure: "direct", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: ${JSON.stringify(result)} }], details: {} }; },
  });
}
`;
}

// Minimal newline-delimited JSON-RPC over stdio, using Node built-ins only.
const mcpSource = `import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  const reply = { jsonrpc: "2.0", id };
  if (method === "initialize") {
    reply.result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "reload-check", version: "1.0.0" } };
  } else if (method === "tools/list") {
    reply.result = { tools: [{ name: "static_text", description: "Returns fixture text.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] };
  } else if (method === "tools/call" && params.name === "static_text") {
    reply.result = { content: [{ type: "text", text: ${JSON.stringify(mcpText)} }] };
  } else {
    reply.error = { code: -32601, message: "Unexpected fixture request" };
  }
  process.stdout.write(JSON.stringify(reply) + "\\n");
}
`;

let agents: SessionService | undefined;
try {
  const workspace = { id: "reload-check", name: "Reload check", path: join(directory, "workspace") };
  const extensionDir = join(agentDir, "extensions");
  const mcpConfig = join(agentDir, "mcp.json");
  const contextPath = join(workspace.path, "AGENTS.md");
  const variantPath = join(extensionDir, "variant.ts");
  const removedPath = join(extensionDir, "removed.ts");
  const brokenPath = join(extensionDir, "broken.ts");
  const emptyMcpConfig = JSON.stringify({ mcpServers: {} });
  await Promise.all([mkdir(extensionDir, { recursive: true }), mkdir(workspace.path), mkdir(temp)]);
  await Promise.all([
    writeFile(join(home, "config.json"), JSON.stringify({
      tls: { keyPath: "fixture-key", certPath: "fixture-cert" }, auth: { username: "fixture", passwordHash: "fixture" }, workspaces: [workspace],
      preferences: { agent: { systemPrompt: { append: originalInstructions } } },
    })),
    writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low", retry: { enabled: false }, compaction: { enabled: false } })),
    writeFile(contextPath, originalContext),
    writeFile(mcpConfig, emptyMcpConfig),
    writeFile(variantPath, extensionSource(variantTool, "Original fixture tool", "Original extension result")),
    writeFile(removedPath, extensionSource(removedTool, "Fixture tool to remove", "Removed extension result")),
  ]);

  const [{ AgentService }, { WorkspaceService }, { saveGlobalSystemPrompt }, { contentText, createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools }] = await Promise.all([
    import("../apps/server/src/agents.ts"), import("../apps/server/src/workspaces.ts"), import("../apps/server/src/config.ts"), import("@earendil-works/pi-ai"),
  ]);
  const settings = {
    getSessionModelConfiguration: async () => ({ model: defaultModel, scopedModels: [] }),
    getModelContextWindow: () => defaultModel.contextWindow,
    resolveModel: async (provider: string, id: string) => {
      assert.equal(provider, selectedModel.provider);
      assert.equal(id, selectedModel.id);
      return selectedModel;
    },
  } satisfies Pick<SettingsService, "getSessionModelConfiguration" | "getModelContextWindow" | "resolveModel">;
  const service = agents = new AgentService(settings as unknown as SettingsService, new WorkspaceService([workspace]));
  const { handles } = service as unknown as { handles: Map<string, { session: AgentSession }> };
  function getHandle(id: string) {
    const handle = handles.get(`${workspace.id}:${id}`);
    assert.ok(handle, `Missing loaded Session ${id}`);
    return handle;
  }
  function toolResultText(session: AgentSession, name: string): string {
    const result = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === name);
    assert.ok(result?.role === "toolResult", `Missing tool result for ${name}`);
    assert.equal(result.isError, false, `${name} returned an error: ${JSON.stringify(result.content)}`);
    return contentText(result.content);
  }
  async function recordRequests(session: AgentSession) {
    const requests: Array<{ model: string; systemPrompt: string; tools: Map<string, string>; users: string[] }> = [];
    const nextTools: Array<{ name: string; arguments?: ToolCall["arguments"] }> = [];
    session.agent.streamFunction = (model, context) => {
      requests.push({
        model: model.id,
        systemPrompt: getCurrentSystemPrompt(context.messages),
        tools: new Map(getCurrentTools(context.messages).map((tool) => [tool.name, tool.description])),
        users: context.messages.filter((message) => message.role === "user").map((message) => contentText(message.content)),
      });
      const calls: ToolCall[] = nextTools.splice(0).map((call, index) => ({ type: "toolCall", id: `reload-${requests.length}-${index}`, name: call.name, arguments: call.arguments ?? {} }));
      const stopReason = calls.length ? "toolUse" : "stop";
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: calls.length ? calls : [{ type: "text", text: "Fixture response." }],
        usage: structuredClone(usage), stopReason, timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: stopReason, message });
      stream.end();
      return stream;
    };
    await session.modelRuntime.setRuntimeApiKey(defaultModel.provider, "local-fixture-key");
    return { requests, nextTools };
  }

  const { id } = await service.create(workspace);
  const { id: otherId } = await service.create(workspace);
  const handle = getHandle(id);
  const original = handle.session;
  const unrelated = getHandle(otherId).session;
  const baseline = await recordRequests(original);
  const reload = () => service.reloadSessionResources(workspace, id);
  const prompt = (text: string) => service.prompt(workspace, id, text);
  await service.setModel(workspace, id, selectedModel.provider, selectedModel.id);
  await service.setThinkingLevel(workspace, id, "high");
  assert.equal(original.thinkingLevel, "high");

  const retainedTurn = "Keep this turn in the active history.";
  await prompt(retainedTurn);
  const manager = original.sessionManager;
  const leaf = manager.getLeafId();
  assert.ok(leaf);
  await prompt("Keep this turn only on the historical branch.");
  assert.notEqual(manager.getLeafId(), leaf);
  await original.navigateTree(leaf);
  assert.equal(manager.getLeafId(), leaf);
  const sessionFile = original.sessionFile;
  assert.ok(sessionFile);
  const history = await readFile(sessionFile, "utf8");
  const entries = structuredClone(manager.getEntries());
  const before = baseline.requests[0];
  assert.equal(before.model, selectedModel.id);
  assert.deepEqual(before.users, [retainedTurn]);
  assert.ok(before.systemPrompt.includes(originalInstructions));
  assert.ok(before.systemPrompt.includes(originalContext));
  assert.equal(before.tools.get(variantTool), "Original fixture tool");
  assert.ok(before.tools.has(removedTool));
  assert.ok(!before.tools.has(addedTool));
  assert.ok(!before.tools.has("codemode"));

  const mcpServer = join(directory, "mcp-fixture.mjs");
  await writeFile(mcpServer, mcpSource);
  await Promise.all([
    saveGlobalSystemPrompt({ append: updatedInstructions }),
    writeFile(contextPath, updatedContext),
    writeFile(variantPath, extensionSource(variantTool, "Updated fixture tool", "Updated extension result")),
    writeFile(join(extensionDir, "added.ts"), extensionSource(addedTool, "Added fixture tool", "Added extension result")),
    rm(removedPath),
    writeFile(mcpConfig, JSON.stringify({ mcpServers: { [mcpName]: { command: process.execPath, args: [mcpServer], exposure: "codemode", timeout: 5 } } })),
  ]);

  // Competing requests target the same loaded Session while the first reload prepares.
  const reloading = reload();
  await Promise.all([
    reloading,
    assert.rejects(reload, { statusCode: 409 }),
    assert.rejects(prompt("This prompt competes with reload."), { statusCode: 409 }),
    assert.rejects(service.compact(workspace, id), { statusCode: 409 }),
  ]);
  assert.equal(getHandle(id), handle);
  const reloaded = handle.session;
  assert.notEqual(reloaded, original);
  assert.equal(reloaded.sessionId, id);
  assert.equal(reloaded.sessionManager, manager);
  assert.equal(reloaded.sessionFile, sessionFile);
  assert.equal(manager.getLeafId(), leaf);
  assert.deepEqual(manager.getEntries(), entries);
  assert.equal(await readFile(sessionFile, "utf8"), history);
  assert.deepEqual(reloaded.model, selectedModel);
  assert.equal(reloaded.thinkingLevel, "high");

  const after = await recordRequests(reloaded);
  after.nextTools.push(
    { name: variantTool },
    { name: addedTool },
    { name: "codemode", arguments: { code: `const result = await tools.${mcpTool}({}); text(result.content[0].text);` } },
  );
  const invokeTurn = "Run the reloaded fixture tools.";
  await prompt(invokeTurn);
  assert.equal(after.requests.length, 2);
  const next = after.requests[0];
  assert.equal(next.model, selectedModel.id);
  assert.deepEqual(next.users, [retainedTurn, invokeTurn]);
  assert.ok(next.systemPrompt.includes(updatedInstructions));
  assert.ok(next.systemPrompt.includes(updatedContext));
  assert.ok(!next.systemPrompt.includes(originalInstructions));
  assert.ok(!next.systemPrompt.includes(originalContext));
  assert.match(next.tools.get(addedTool) ?? "", /^Added fixture tool\b/);
  assert.ok(!next.tools.has(removedTool));
  assert.ok(next.tools.has("codemode"), "The first request after reload must expose codemode for the new MCP server");
  assert.ok(next.systemPrompt.includes(`mcp__${mcpName}`));
  assert.equal(toolResultText(reloaded, addedTool), "Added extension result");
  assert.ok(toolResultText(reloaded, "codemode").includes(mcpText), "Codemode must return the local MCP server's response");
  const variantAfter = { description: next.tools.get(variantTool)?.split("\n")[0], result: toolResultText(reloaded, variantTool) };

  assert.equal(getHandle(otherId).session, unrelated);
  const other = await recordRequests(unrelated);
  await service.prompt(workspace, otherId, "Check the Session that did not reload.");
  const otherRequest = other.requests[0];
  assert.deepEqual(otherRequest.tools, before.tools);
  assert.ok(otherRequest.systemPrompt.includes(originalInstructions));
  assert.ok(otherRequest.systemPrompt.includes(originalContext));
  assert.ok(!otherRequest.systemPrompt.includes(updatedInstructions));
  assert.ok(!otherRequest.systemPrompt.includes(updatedContext));

  await writeFile(brokenPath, 'export default function () { throw new Error("Broken reload fixture"); }\n');
  await assert.rejects(reload, { statusCode: 422, message: /Broken reload fixture/ });
  assert.equal(getHandle(id), handle);
  assert.equal(handle.session, reloaded);
  await rm(brokenPath);

  // Hold a real SDK run in the fake stream until the busy reload has been rejected.
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const stream = reloaded.agent.streamFunction;
  reloaded.agent.streamFunction = async (...args) => {
    started.resolve();
    await release.promise;
    return stream(...args);
  };
  const busy = prompt("Hold a fixture response while checking the busy Session.");
  try {
    await Promise.race([started.promise, busy.then(() => assert.fail("The SDK run did not reach the held stream"))]);
    assert.equal(reloaded.isStreaming, true);
    await assert.rejects(reload, { statusCode: 409 });
    assert.equal(handle.session, reloaded);
  } finally {
    release.resolve();
    await busy;
    reloaded.agent.streamFunction = stream;
  }
  assert.ok(after.requests.at(-1)?.tools.has("codemode"), "The runtime must remain usable after a failed reload");
  assert.equal(service.statuses(workspace).find((status) => status.id === id)?.state, "ready");

  await writeFile(mcpConfig, emptyMcpConfig);
  await reload();
  assert.notEqual(handle.session, reloaded);
  assert.equal(handle.session.sessionManager, manager);
  const withoutMcp = await recordRequests(handle.session);
  await prompt("Check tools after removing the MCP server.");
  assert.ok(!handle.session.getAllTools().some((tool) => tool.name === mcpTool));
  assert.ok(!withoutMcp.requests[0].systemPrompt.includes(`mcp__${mcpName}`), "The next request must omit the removed MCP server");
  assert.ok(!withoutMcp.requests[0].tools.has("codemode"));
  assert.ok(withoutMcp.requests[0].tools.has(addedTool));
  assert.deepEqual(variantAfter, { description: "Updated fixture tool", result: "Updated extension result" }, "Reload must use the rewritten extension at the same path");

  // Settings refresh uses the same replacement path, including after a first-turn rollback.
  const onlyTurn = unrelated.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(onlyTurn);
  const rollback = await service.rollbackLatest(workspace, otherId, onlyTurn.id);
  assert.ok(!unrelated.sessionManager.buildSessionContext().messages.some((message) => message.role === "user" || message.role === "assistant"));
  const previousMain = handle.session;
  assert.equal(await service.reloadIdleSessions(), 2);
  assert.notEqual(handle.session, previousMain);
  const refreshedOther = getHandle(otherId).session;
  assert.notEqual(refreshedOther, unrelated);
  assert.ok(refreshedOther.getActiveToolNames().includes(addedTool));
  await service.restoreRollback(workspace, otherId);
  assert.ok(refreshedOther.sessionManager.getBranch().some((entry) => entry.id === rollback.restoreEntryId));
} finally {
  try { await agents?.dispose(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

console.log("Session resource reload checks passed (SDK runtime, request context, branch state, conflicts, and local stdio MCP).");
