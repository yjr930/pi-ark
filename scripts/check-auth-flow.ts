import assert from "node:assert/strict";
import { setImmediate as wait } from "node:timers/promises";
import { AuthFlowService } from "../apps/server/src/auth-flows.ts";
import { SettingsService } from "../apps/server/src/settings.ts";

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

const deviceId = "550e8400-e29b-41d4-a716-446655440000";
let receivedDeviceId: string | undefined;
const settings = Object.assign(Object.create(SettingsService.prototype), {
  manager: { getOrCreateDeviceId: () => deviceId },
  models: {
    getProvider: (providerId: string) => providerId === "openai" ? { auth: { oauth: { isSubscription: true } } } : undefined,
    login: async (_providerId: string, _type: string, _interaction: unknown, options?: { getDeviceId?: () => string }) => { receivedDeviceId = options?.getDeviceId?.(); },
  },
}) as SettingsService;
await settings.loginSubscription("openai", { signal: new AbortController().signal, prompt: async () => "", notify: () => undefined });
assert.equal(receivedDeviceId, deviceId);

const cancelService = new AuthFlowService(async (_providerId, interaction) => { await interaction.prompt({ type: "text", message: "Wait" }); });
const cancelled = cancelService.start("mock-subscription");
cancelService.cancel(cancelled.id);
assert.equal(cancelService.get(cancelled.id).status, "cancelled");

const replacementSignals: AbortSignal[] = [];
const replacementService = new AuthFlowService(async (_providerId, interaction) => {
  replacementSignals.push(interaction.signal);
  interaction.notify({ type: "auth_url", url: "https://example.com/login" });
  await interaction.prompt({ type: "manual_code", message: "Paste callback URL" });
});
const replaced = replacementService.start("openai");
const replacement = replacementService.start("openai");
assert.equal(replacementService.get(replaced.id).status, "cancelled");
assert.equal(replacementSignals[0].aborted, true);
assert.equal(replacementSignals[1].aborted, false);
assert.equal(replacementService.get(replacement.id).status, "pending");
assert.equal(replacementService.get(replacement.id).prompt?.type, "manual_code");
const otherProvider = replacementService.start("anthropic");
assert.equal(replacementService.get(replacement.id).status, "pending");
replacementService.cancel(replacement.id);
replacementService.cancel(otherProvider.id);
console.log("auth flow checks passed");
