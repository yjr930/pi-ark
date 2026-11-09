import assert from "node:assert/strict";
import { setImmediate as wait } from "node:timers/promises";
import { AuthFlowService } from "../apps/server/src/auth-flows.ts";

const service = new AuthFlowService(async (_providerId, interaction) => {
  interaction.notify({ type: "auth_url", url: "https://example.com/login", instructions: "Open login" });
  const account = await interaction.prompt({ type: "select", message: "Choose account", options: [{ id: "pro", label: "Pro" }] });
  assert.equal(account, "pro");
  const code = await interaction.prompt({ type: "manual_code", message: "Paste code" });
  assert.equal(code, "oauth-code");
  interaction.notify({ type: "progress", message: "Connected" });
});
const started = service.start("mock-subscription");
assert.equal(started.status, "pending");
assert.equal(started.events[0].type, "auth_url");
assert.equal(started.prompt?.type, "select");
service.answer(started.id, started.prompt!.id, "pro");
await wait();
const manual = service.get(started.id);
assert.equal(manual.prompt?.type, "manual_code");
service.answer(started.id, manual.prompt!.id, "oauth-code");
await wait();
assert.equal(service.get(started.id).status, "success");

const cancelService = new AuthFlowService(async (_providerId, interaction) => { await interaction.prompt({ type: "text", message: "Wait" }); });
const cancelled = cancelService.start("mock-subscription");
cancelService.cancel(cancelled.id);
assert.equal(cancelService.get(cancelled.id).status, "cancelled");
console.log("auth flow checks passed");
