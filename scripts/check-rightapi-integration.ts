import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";

const catalog = {
  upstreams: [
    { name: "Codex", modality: "chat", supported_protocols: ["responses", "messages", "completions"], default_protocol: "responses", models: [{ name: "gpt-6-sol", is_available: true }] },
    { name: "Claude", modality: "chat", supported_protocols: ["responses", "messages", "completions"], default_protocol: "messages", models: [{ name: "claude-opus-4-8", is_available: true }] },
    { name: "Gemini", modality: "chat", supported_protocols: ["responses", "messages", "completions", "gemini"], default_protocol: "gemini", models: [{ name: "gemini-3.8-flash", is_available: true }] },
  ],
};

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  response.setHeader("content-type", "application/json");
  if (path === "/models/public") {
    response.end(JSON.stringify(catalog));
    return;
  }
  if (path === "/v1/models") {
    if (request.headers.authorization !== "Bearer sk-test") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "invalid API key" }));
      return;
    }
    response.end(JSON.stringify({ data: [{ id: "gpt-6-sol" }, { id: "claude-opus-4-8" }, { id: "gemini-3.8-flash" }] }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});
await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const port = (server.address() as AddressInfo).port;

const directory = await mkdtemp(join(resolve(".tmp"), "rightapi-integration-"));
const agentDir = join(directory, "pi-agent");
const home = join(directory, "home");
await mkdir(join(agentDir, "extensions"), { recursive: true });
await mkdir(home, { recursive: true });
await writeFile(join(home, "config.json"), JSON.stringify({
  listen: { host: "127.0.0.1", port: 14116 },
  tls: { keyPath: join(home, "tls.key"), certPath: join(home, "tls.crt") },
  auth: { username: "check", passwordHash: "scrypt$fixture$00" },
  workspaces: [],
}) + "\n");
process.env.PI_ARK_HOME = home;
process.env.PI_ARK_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
process.env.PI_ARK_RIGHTAPI_ORIGIN = `http://127.0.0.1:${port}`;

try {
  const { SettingsService } = await import("../apps/server/src/settings.ts");
  const service = await SettingsService.create(directory);
  const initial = await service.getGlobal();
  const initialProvider = initial.providers.find((provider) => provider.id === "rightcode");
  assert.ok(initialProvider, "Right Code provider is registered in Settings");
  assert.equal(initialProvider.configured, false);

  const loggedIn = await service.loginApiKey("rightcode", "sk-test");
  const loggedInProvider = loggedIn.providers.find((provider) => provider.id === "rightcode");
  assert.equal(loggedInProvider?.configured, true);

  const runtime = (service as unknown as { models: { refresh(options: { allowNetwork: boolean; force: boolean; providers: string[]; signal: AbortSignal }): Promise<{ aborted: boolean; errors: Map<string, Error> }> } }).models;
  const result = await runtime.refresh({ allowNetwork: true, force: true, providers: ["rightcode"], signal: AbortSignal.timeout(5000) });
  assert.equal(result.aborted, false);
  assert.deepEqual([...result.errors], []);

  const preferences = await service.getModelPreferences();
  const modelIds = preferences.models.filter((model) => model.provider === "rightcode").map((model) => model.id).sort();
  assert.deepEqual(modelIds, ["claude-opus-4-8", "gemini-3.8-flash", "gpt-6-sol"]);
  assert.equal(preferences.models.find((model) => model.id === "gpt-6-sol")?.providerName, "Right Code");

  const resolved = await service.resolveModel("rightcode", "gpt-6-sol");
  assert.equal(resolved.api, "openai-responses");
  assert.equal(resolved.baseUrl, `http://127.0.0.1:${port}/v1`);
  assert.equal(resolved.reasoning, true);

  console.log("Right Code Settings integration checks passed");
} finally {
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
}
