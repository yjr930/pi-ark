import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { AgentService } from "./agents.js";
import { AuthFlowService } from "./auth-flows.js";
import { AuthService } from "./auth.js";
import { ensurePiArkAgentState, ensureWorkspaceState, loadConfig, loadUiSettings, loadWorkspaceSettings, piArkAgentDir, saveGlobalArkSettings, saveWorkspaceDefinitions, saveWorkspacePreferences, saveWorkspaceSystemPrompt, type ArkUiSettings, type WorkspaceSettings, type WorkspaceTool } from "./config.js";
import { createSessionGroup, deleteSessionGroup, listSessionGroups, renameSessionGroup } from "./session-metadata.js";
import { PiCoreService } from "./pi-core.js";
import { SettingsService, type GlobalAgentDefaultsInput, type GlobalSettingsInput, type ModelPreferencesInput } from "./settings.js";
import { openTerminal } from "./terminal.js";
import { WorkspaceService } from "./workspaces.js";

const previousAgentDir = process.env.PI_ARK_MIGRATE_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
await ensurePiArkAgentState(previousAgentDir);
process.env.PI_CODING_AGENT_DIR = piArkAgentDir;
const config = await loadConfig();
const [key, cert] = await Promise.all([readFile(config.tls.keyPath), readFile(config.tls.certPath)]);
const app = Fastify({ logger: true, https: { key, cert }, bodyLimit: 1024 * 1024 });
const auth = new AuthService(config.auth.username, config.auth.passwordHash);
const workspaces = new WorkspaceService(config.workspaces);
const settings = await SettingsService.create(config.workspaces[0]?.path || process.cwd());
const piCore = new PiCoreService();
const authFlows = new AuthFlowService((providerId, interaction) => settings.loginSubscription(providerId, interaction));
const agents = new AgentService(settings);

function contentDispositionFilename(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

await app.register(cookie);
await app.register(websocket, { options: { maxPayload: 28 * 1024 * 1024 } });

app.addHook("onRequest", async (request, reply) => {
  const protectedPath = request.url.startsWith("/api/") || request.url.startsWith("/ws/");
  const publicPath = request.url === "/api/health" || request.url === "/api/auth/login";
  if (protectedPath && !publicPath && !auth.authenticated(request)) await reply.code(401).send({ error: "Authentication required" });
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const appError = error instanceof Error ? error : new Error("Unknown server error");
  const statusCode = "statusCode" in appError && typeof appError.statusCode === "number" ? appError.statusCode : 500;
  reply.code(statusCode).send({ error: statusCode === 500 ? "Internal server error" : appError.message });
});

app.get("/api/health", async () => ({ status: "ok" }));
app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
  const { username = "", password = "" } = request.body || {};
  if (!(await auth.login(username, password, reply))) return reply.code(401).send({ error: "Invalid username or password" });
  return { authenticated: true };
});
app.post("/api/auth/logout", async (request, reply) => {
  auth.logout(request, reply);
  return { authenticated: false };
});
app.get("/api/auth/session", async () => ({ authenticated: true, username: config.auth.username }));

app.get("/api/ui", async () => loadUiSettings());
app.put<{ Body: ArkUiSettings }>("/api/ui", async (request) => saveGlobalArkSettings(request.body));
app.get("/api/workspaces", async () => ({ workspaces: workspaces.list() }));
app.get<{ Querystring: { path: string } }>("/api/directories", async (request) => workspaces.suggestDirectories(request.query.path || ""));
app.post<{ Body: { name?: string; path: string } }>("/api/workspaces", async (request, reply) => {
  const workspace = await workspaces.add(request.body || { path: "" });
  try {
    await ensureWorkspaceState(workspace);
    await saveWorkspaceDefinitions(workspaces.list());
  } catch (error) {
    workspaces.remove(workspace.id);
    throw error;
  }
  return reply.code(201).send(workspace);
});
app.patch<{ Params: { workspaceId: string }; Body: { name: string } }>("/api/workspaces/:workspaceId", async (request) => {
  const previous = workspaces.get(request.params.workspaceId);
  const workspace = workspaces.rename(request.params.workspaceId, request.body?.name);
  try { await saveWorkspaceDefinitions(workspaces.list()); }
  catch (error) { workspaces.rename(previous.id, previous.name); throw error; }
  return workspace;
});
app.delete<{ Params: { workspaceId: string } }>("/api/workspaces/:workspaceId", async (request, reply) => {
  const workspace = workspaces.remove(request.params.workspaceId);
  try { await saveWorkspaceDefinitions(workspaces.list()); }
  catch (error) { workspaces.restore(workspace); throw error; }
  return reply.code(204).send();
});
app.get("/api/settings/global", async () => settings.getGlobal());
app.get<{ Querystring: { latest?: string } }>("/api/settings/release", async (request) => piCore.info(request.query.latest === "true"));
app.post("/api/settings/release/update", async () => piCore.update());
app.post("/api/settings/release/rollback", async () => piCore.rollback());
app.get<{ Querystring: { provider: string } }>("/api/settings/models", async (request) => ({ models: settings.getModels(request.query.provider) }));
app.get("/api/settings/model-preferences", async () => settings.getModelPreferences());
app.put<{ Body: ModelPreferencesInput }>("/api/settings/model-preferences", async (request) => settings.saveModelPreferences(request.body));
app.get("/api/settings/session-models", async () => ({ models: await settings.getSessionModels() }));
app.post<{ Params: { providerId: string }; Body: { apiKey: string } }>("/api/settings/providers/:providerId/api-key", async (request) => settings.loginApiKey(request.params.providerId, request.body?.apiKey));
app.delete<{ Params: { providerId: string } }>("/api/settings/providers/:providerId/credential", async (request) => settings.disconnectProvider(request.params.providerId));
app.post<{ Body: { providerId: string } }>("/api/settings/subscription-logins", async (request, reply) => reply.code(201).send(authFlows.start(request.body?.providerId)));
app.get<{ Params: { flowId: string } }>("/api/settings/subscription-logins/:flowId", async (request) => authFlows.get(request.params.flowId));
app.post<{ Params: { flowId: string }; Body: { promptId: string; value: string } }>("/api/settings/subscription-logins/:flowId/answer", async (request) => authFlows.answer(request.params.flowId, request.body?.promptId, request.body?.value));
app.delete<{ Params: { flowId: string } }>("/api/settings/subscription-logins/:flowId", async (request, reply) => { authFlows.cancel(request.params.flowId); return reply.code(204).send(); });
app.put<{ Body: GlobalSettingsInput }>("/api/settings/global", async (request) => settings.saveGlobal(request.body));
app.put<{ Body: GlobalAgentDefaultsInput }>("/api/settings/agent-defaults", async (request) => settings.saveAgentDefaults(request.body));
app.get<{ Querystring: { workspaceId?: string } }>("/api/settings/system-prompt", async (request) => {
  const workspace = request.query.workspaceId ? workspaces.get(request.query.workspaceId) : workspaces.list()[0] || { id: "global-preview", name: "Global preview", path: process.cwd() };
  return agents.getGlobalSystemPrompt(workspace);
});
app.get<{ Params: { workspaceId: string } }>("/api/workspaces/:workspaceId/settings", async (request) => loadWorkspaceSettings(workspaces.get(request.params.workspaceId)));
app.put<{ Params: { workspaceId: string }; Body: { agent: { tools: WorkspaceTool[] }; files: WorkspaceSettings["files"] } }>("/api/workspaces/:workspaceId/settings", async (request) => saveWorkspacePreferences(workspaces.get(request.params.workspaceId), request.body));
app.put<{ Params: { workspaceId: string }; Body: WorkspaceSettings["agent"]["systemPrompt"] }>("/api/workspaces/:workspaceId/system-prompt", async (request) => saveWorkspaceSystemPrompt(workspaces.get(request.params.workspaceId), request.body));
app.get<{ Params: { workspaceId: string }; Querystring: { path?: string } }>("/api/workspaces/:workspaceId/files", async (request) => {
  const workspace = workspaces.get(request.params.workspaceId);
  const workspaceSettings = await loadWorkspaceSettings(workspace);
  return { entries: await workspaces.listDirectory(workspace, request.query.path || "", workspaceSettings.files.showHiddenFiles) };
});
app.get<{ Params: { workspaceId: string }; Querystring: { path: string } }>("/api/workspaces/:workspaceId/file", async (request) => {
  if (!request.query.path) throw Object.assign(new Error("A file path is required"), { statusCode: 400 });
  const workspace = workspaces.get(request.params.workspaceId);
  const workspaceSettings = await loadWorkspaceSettings(workspace);
  return workspaces.readFilePreview(workspace, request.query.path, workspaceSettings.files.maxPreviewSizeMb * 1024 * 1024);
});
app.get<{ Params: { workspaceId: string }; Querystring: { path: string } }>("/api/workspaces/:workspaceId/image", async (request, reply) => {
  if (!request.query.path) throw Object.assign(new Error("An image path is required"), { statusCode: 400 });
  const workspace = workspaces.get(request.params.workspaceId);
  const workspaceSettings = await loadWorkspaceSettings(workspace);
  const image = await workspaces.readImage(workspace, request.query.path, workspaceSettings.files.maxPreviewSizeMb * 1024 * 1024);
  reply.header("X-Content-Type-Options", "nosniff").header("Cache-Control", "private, max-age=300").header("Content-Length", image.size).type(image.mimeType);
  return reply.send(image.content);
});
app.get<{ Params: { workspaceId: string }; Querystring: { path: string } }>("/api/workspaces/:workspaceId/download", async (request, reply) => {
  if (!request.query.path) throw Object.assign(new Error("A file path is required"), { statusCode: 400 });
  const download = await workspaces.downloadFile(workspaces.get(request.params.workspaceId), request.query.path);
  reply.header("X-Content-Type-Options", "nosniff").header("Content-Length", download.size).header("Content-Disposition", contentDispositionFilename(download.name)).type("application/octet-stream");
  return reply.send(download.content);
});

app.get<{ Params: { workspaceId: string } }>("/api/workspaces/:workspaceId/sessions", async (request) => ({
  sessions: await agents.list(workspaces.get(request.params.workspaceId)),
}));
app.post<{ Params: { workspaceId: string } }>("/api/workspaces/:workspaceId/sessions", async (request, reply) => {
  const created = await agents.create(workspaces.get(request.params.workspaceId));
  return reply.code(201).send(created);
});
app.get<{ Params: { workspaceId: string } }>("/api/workspaces/:workspaceId/session-groups", async (request) => ({ groups: await listSessionGroups(workspaces.get(request.params.workspaceId)) }));
app.post<{ Params: { workspaceId: string }; Body: { name: string } }>("/api/workspaces/:workspaceId/session-groups", async (request, reply) => reply.code(201).send(await createSessionGroup(workspaces.get(request.params.workspaceId), request.body?.name)));
app.patch<{ Params: { workspaceId: string; groupId: string }; Body: { name: string } }>("/api/workspaces/:workspaceId/session-groups/:groupId", async (request) => renameSessionGroup(workspaces.get(request.params.workspaceId), request.params.groupId, request.body?.name));
app.delete<{ Params: { workspaceId: string; groupId: string } }>("/api/workspaces/:workspaceId/session-groups/:groupId", async (request, reply) => { await deleteSessionGroup(workspaces.get(request.params.workspaceId), request.params.groupId); return reply.code(204).send(); });
app.post<{ Params: { workspaceId: string; sessionId: string }; Body: { entryId: string } }>("/api/workspaces/:workspaceId/sessions/:sessionId/fork", async (request, reply) => reply.code(201).send(await agents.fork(workspaces.get(request.params.workspaceId), request.params.sessionId, request.body?.entryId)));
app.post<{ Params: { workspaceId: string; sessionId: string }; Body: { entryId?: string } }>("/api/workspaces/:workspaceId/sessions/:sessionId/rollback", async (request) => agents.rollbackLatest(workspaces.get(request.params.workspaceId), request.params.sessionId, request.body?.entryId));
app.post<{ Params: { workspaceId: string; sessionId: string } }>("/api/workspaces/:workspaceId/sessions/:sessionId/rollback/restore", async (request, reply) => { await agents.restoreRollback(workspaces.get(request.params.workspaceId), request.params.sessionId); return reply.code(204).send(); });
app.patch<{ Params: { workspaceId: string; sessionId: string; itemId: string }; Body: { direction?: "up" | "down"; mode?: "steering" | "followUp"; operationId?: string } }>("/api/workspaces/:workspaceId/sessions/:sessionId/queue/:itemId", async (request) => agents.updateQueue(workspaces.get(request.params.workspaceId), request.params.sessionId, request.params.itemId, request.body || {}, request.body?.operationId));
app.delete<{ Params: { workspaceId: string; sessionId: string; itemId: string }; Querystring: { operationId?: string } }>("/api/workspaces/:workspaceId/sessions/:sessionId/queue/:itemId", async (request) => agents.takeQueuedMessage(workspaces.get(request.params.workspaceId), request.params.sessionId, request.params.itemId, request.query.operationId));
app.post<{ Params: { workspaceId: string; sessionId: string }; Body: { operationId?: string } }>("/api/workspaces/:workspaceId/sessions/:sessionId/queue/merge-follow-ups", async (request) => agents.mergeFollowUps(workspaces.get(request.params.workspaceId), request.params.sessionId, request.body?.operationId));
app.patch<{ Params: { workspaceId: string; sessionId: string }; Body: { name?: string; pinned?: boolean; archived?: boolean; groups?: string[] } }>("/api/workspaces/:workspaceId/sessions/:sessionId", async (request) => {
  const patch: { name?: string; pinned?: boolean; archived?: boolean; groups?: string[] } = {};
  if (typeof request.body?.name === "string") patch.name = request.body.name;
  if (typeof request.body?.pinned === "boolean") patch.pinned = request.body.pinned;
  if (typeof request.body?.archived === "boolean") patch.archived = request.body.archived;
  if (Array.isArray(request.body?.groups) && request.body.groups.every((id) => typeof id === "string")) patch.groups = request.body.groups;
  if (Object.keys(patch).length === 0) throw Object.assign(new Error("Provide a session update"), { statusCode: 400 });
  return agents.updateSession(workspaces.get(request.params.workspaceId), request.params.sessionId, patch);
});
app.delete<{ Params: { workspaceId: string; sessionId: string } }>("/api/workspaces/:workspaceId/sessions/:sessionId", async (request, reply) => {
  await agents.delete(workspaces.get(request.params.workspaceId), request.params.sessionId);
  return reply.code(204).send();
});

app.get<{ Params: { workspaceId: string; sessionId: string }; Querystring: { message?: string; start?: string } }>("/ws/agent/:workspaceId/:sessionId", { websocket: true }, (socket, request) => {
  const workspace = workspaces.get(request.params.workspaceId);
  const targetMessageNumber = Number(request.query.message);
  const requestedStart = Number(request.query.start);
  const connection = agents.connect(workspace, request.params.sessionId, socket, { targetMessageNumber: Number.isInteger(targetMessageNumber) && targetMessageNumber > 0 ? targetMessageNumber : undefined, start: Number.isInteger(requestedStart) && requestedStart >= 0 ? requestedStart : undefined });
  const onMessage = async (raw: Buffer) => {
    try {
      const message = JSON.parse(raw.toString()) as { type?: string; text?: string; name?: string; provider?: string; model?: string; level?: string; attachments?: Array<{ name: string; mimeType: string; data: string }> };
      if (message.type === "prompt" && (message.text?.trim() || message.attachments?.length)) await agents.prompt(workspace, request.params.sessionId, message.text || "", message.attachments || []);
      else if (message.type === "load-earlier") agents.loadEarlier(workspace, request.params.sessionId, socket);
      else if (message.type === "abort") await agents.abort(workspace, request.params.sessionId);
      else if (message.type === "rename-session" && message.name?.trim()) await agents.updateSession(workspace, request.params.sessionId, { name: message.name });
      else if (message.type === "set-model" && message.provider && message.model) await agents.setModel(workspace, request.params.sessionId, message.provider, message.model);
      else if (message.type === "set-thinking-level" && message.level) await agents.setThinkingLevel(workspace, request.params.sessionId, message.level);
      else socket.send(JSON.stringify({ type: "error", message: "Unknown agent command" }));
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Agent command failed" }));
    }
  };
  socket.on("message", onMessage);
  connection.catch((error) => {
    socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Agent connection failed" }));
    socket.close();
  });
  socket.on("close", () => {
    socket.off("message", onMessage);
    void connection.then((disconnect) => disconnect());
  });
});

app.get<{ Params: { workspaceId: string } }>("/ws/terminal/:workspaceId", { websocket: true }, (socket, request) => {
  const workspace = workspaces.get(request.params.workspaceId);
  const close = openTerminal(socket, workspace.path);
  socket.on("close", close);
});

const serverDir = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(serverDir, "../../web/dist");
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveWebAsset(pathname: string, reply: import("fastify").FastifyReply) {
  const clean = pathname.replace(/^\/+/, "");
  let target = resolve(webDist, clean || "index.html");
  if (target !== webDist && !target.startsWith(webDist + sep)) return reply.code(404).send();
  try {
    if (!(await stat(target)).isFile()) throw new Error("Not a file");
  } catch {
    if (extname(clean)) return reply.code(404).send();
    target = join(webDist, "index.html");
  }
  reply.type(mimeTypes[extname(target)] || "application/octet-stream");
  if (/\.[a-f0-9]{8,}\./.test(target)) reply.header("Cache-Control", "public, max-age=31536000, immutable");
  else reply.header("Cache-Control", "no-cache");
  return reply.send(await readFile(target));
}
app.get("/", async (_request, reply) => serveWebAsset("", reply));
app.get<{ Params: { "*": string } }>("/*", async (request, reply) => serveWebAsset(request.params["*"], reply));

const shutdown = async () => {
  await agents.dispose();
  await app.close();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

await app.listen(config.listen);
