import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { AgentService } from "./agents.js";
import { AuthService } from "./auth.js";
import { loadConfig } from "./config.js";
import { openTerminal } from "./terminal.js";
import { WorkspaceService } from "./workspaces.js";

const config = await loadConfig();
const [key, cert] = await Promise.all([readFile(config.tls.keyPath), readFile(config.tls.certPath)]);
const app = Fastify({ logger: true, https: { key, cert }, bodyLimit: 1024 * 1024 });
const auth = new AuthService(config.auth.username, config.auth.passwordHash);
const workspaces = new WorkspaceService(config.workspaces);
const agents = new AgentService();

await app.register(cookie);
await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

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

app.get("/api/workspaces", async () => ({ workspaces: workspaces.list() }));
app.get<{ Params: { workspaceId: string }; Querystring: { path?: string } }>("/api/workspaces/:workspaceId/files", async (request) => {
  const workspace = workspaces.get(request.params.workspaceId);
  return { entries: await workspaces.listDirectory(workspace, request.query.path || "") };
});
app.get<{ Params: { workspaceId: string }; Querystring: { path: string } }>("/api/workspaces/:workspaceId/file", async (request) => {
  if (!request.query.path) throw Object.assign(new Error("A file path is required"), { statusCode: 400 });
  return workspaces.readTextFile(workspaces.get(request.params.workspaceId), request.query.path);
});
app.get<{ Params: { workspaceId: string }; Querystring: { path: string } }>("/api/workspaces/:workspaceId/image", async (request, reply) => {
  if (!request.query.path) throw Object.assign(new Error("An image path is required"), { statusCode: 400 });
  const image = await workspaces.readImage(workspaces.get(request.params.workspaceId), request.query.path);
  reply.header("X-Content-Type-Options", "nosniff").header("Cache-Control", "private, max-age=300").type(image.mimeType);
  return reply.send(image.content);
});

app.get<{ Params: { workspaceId: string } }>("/api/workspaces/:workspaceId/sessions", async (request) => ({
  sessions: await agents.list(workspaces.get(request.params.workspaceId)),
}));
app.post<{ Params: { workspaceId: string } }>("/api/workspaces/:workspaceId/sessions", async (request, reply) => {
  const created = await agents.create(workspaces.get(request.params.workspaceId));
  return reply.code(201).send(created);
});

app.get<{ Params: { workspaceId: string; sessionId: string } }>("/ws/agent/:workspaceId/:sessionId", { websocket: true }, (socket, request) => {
  const workspace = workspaces.get(request.params.workspaceId);
  const connection = agents.connect(workspace, request.params.sessionId, socket);
  const onMessage = async (raw: Buffer) => {
    try {
      const message = JSON.parse(raw.toString()) as { type?: string; text?: string };
      if (message.type === "prompt" && message.text?.trim()) await agents.prompt(workspace, request.params.sessionId, message.text.trim());
      else if (message.type === "abort") await agents.abort(workspace, request.params.sessionId);
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
