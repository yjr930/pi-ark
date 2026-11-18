import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { MEMORY_PROACTIVE_PROMPT } from "../apps/server/src/agent-tools/memory-prompt.ts";
import type { WorkspaceDefinition } from "../apps/server/src/config.ts";
import { internalMessageLink, pinnedPiArkLink } from "../apps/server/src/internal-links.ts";
import { registerMemoryRoutes } from "../apps/server/src/memory-routes.ts";
import { WorkspaceMemory, type MemoryDraft, type MemoryMessageSource } from "../apps/server/src/workspace-memory.ts";
import { WorkspaceService } from "../apps/server/src/workspaces.ts";

const temporary = resolve(".tmp");
await mkdir(temporary, { recursive: true });
const directory = await mkdtemp(join(temporary, "workspace-memory-check-"));
const storage = join(directory, "memory");
let now = "2026-01-01T00:00:00.000Z";
const memory = new WorkspaceMemory(storage, () => new Date(now));
const anotherRequest = new WorkspaceMemory(storage, () => new Date(now));
const store = randomUUID();
const isolated = randomUUID();
const catalog = randomUUID();
const disabled = { enabled: false, autoIndex: false, entries: [], proposals: [] };
const enabled = { enabled: true, autoIndex: true, entries: [], proposals: [] };
const base: MemoryDraft = {
  type: "project", title: "Monthly reporting 月度报表口径", summary: "到账日决定月度统计范围。",
  body: "Use the credit date. Private detail: hidden-body-token.", tags: ["settlement"], pinned: false,
};
const sessionId = randomUUID();
const origin: MemoryMessageSource = {
  kind: "message", sessionId, entryId: "e831add1", link: pinnedPiArkLink(internalMessageLink("workspace-memory-check", sessionId, "m123abc"), "17de891b"),
};
const settings = { enabled: true, autoIndex: true };
const draft = (overrides: Partial<MemoryDraft> = {}): MemoryDraft => ({ ...base, ...overrides });
const status = (statusCode: number) => ({ statusCode });

async function checkMemorySettings() {
  const home = join(directory, "home");
  process.env.PI_ARK_HOME = home;
  process.env.PI_ARK_AGENT_DIR = join(home, "pi-agent");
  process.env.PI_CODING_AGENT_DIR = process.env.PI_ARK_AGENT_DIR;
  const config = await import("../apps/server/src/config.ts");
  const inherited: WorkspaceDefinition = { id: "inherited", name: "Inherited", path: join(directory, "inherited") };
  const overridden: WorkspaceDefinition = { id: "overridden", name: "Overridden", path: join(directory, "overridden") };
  const legacyId = randomUUID();
  const legacy: WorkspaceDefinition = { id: "legacy", name: "Legacy", path: join(directory, "legacy"), memoryStoreId: legacyId };
  const workspaces = new WorkspaceService([inherited, overridden, legacy]);
  const root = join(home, "memory");
  const scoped = new WorkspaceMemory(root, undefined, config.loadMemoryDefaults);
  const originalConfig = JSON.stringify({ auth: { username: "check", passwordHash: "check" }, tls: { keyPath: "key", certPath: "cert" }, workspaces: workspaces.list() });
  await mkdir(home);
  await writeFile(config.configPath, originalConfig);

  const app = Fastify();
  registerMemoryRoutes(app, {
    memory: scoped, workspaces,
    ensureStore: (workspace) => workspaces.ensureMemoryStore(workspace.id, () => config.saveWorkspaceDefinitions(workspaces.list())),
    loadDefaults: config.loadMemoryDefaults, saveDefaults: config.saveMemoryDefaults, sourceStatus: async () => "active",
  });
  const global = "/api/settings/memory";
  const path = (workspace: WorkspaceDefinition) => `/api/workspaces/${workspace.id}/memory`;
  const settingsPath = (workspace: WorkspaceDefinition) => `${path(workspace)}/settings`;
  const write = (url: string, payload: unknown, method: "PATCH" | "PUT" | "POST" = "PATCH") =>
    app.inject({ method, url, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
  const json = async (url: string) => {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const off = { enabled: false, autoIndex: false, proactive: false, reviewEntries: false };
  const on = { enabled: true, autoIndex: true, proactive: true, reviewEntries: true };
  const defaultsOff = { ...off, reviewEntries: true };
  const inheritedOff = { defaults: defaultsOff, overrides: {}, effective: off };

  try {
    assert.deepEqual(await json(global), { defaults: defaultsOff, prompt: MEMORY_PROACTIVE_PROMPT });
    assert.deepEqual(await json(settingsPath(inherited)), inheritedOff);
    assert.deepEqual(await json(path(inherited)), disabled);
    assert.equal((await app.inject(`${path(inherited)}/export`)).statusCode, 200);
    assert.deepEqual((await write(settingsPath(inherited), {})).json(), inheritedOff);
    assert.deepEqual((await write(settingsPath(inherited), { enabled: null })).json(), inheritedOff);
    assert.equal((await write(`${path(inherited)}/entries`, base, "POST")).statusCode, 409);
    for (const invalid of [[], null, { enabled: "true" }, { autoIndex: 1 }, { proactive: {} }, { reviewEntries: "yes" }, { entries: [] }, JSON.parse('{"__proto__":false}')]) {
      assert.equal((await write(global, invalid)).statusCode, 400);
      assert.equal((await write(settingsPath(inherited), invalid)).statusCode, 400);
    }
    assert.equal((await write(global, { enabled: null })).statusCode, 400);
    assert.equal(inherited.memoryStoreId, undefined);
    assert.equal(await readFile(config.configPath, "utf8"), originalConfig);
    await assert.rejects(access(root), { code: "ENOENT" });

    const files = { showHiddenFiles: false, maxPreviewSizeMb: 20 };
    const append = { append: "Unrelated preference" };
    const [index, proactive] = await Promise.all([
      write(global, { autoIndex: true }), write(global, { proactive: true }),
      config.saveGlobalPreferences({ files }), config.saveGlobalSystemPrompt(append),
    ]);
    assert.equal(index.statusCode, 200, index.body);
    assert.equal(proactive.statusCode, 200, proactive.body);
    const desired = { ...on, enabled: false };
    assert.deepEqual(await json(global), { defaults: desired, prompt: MEMORY_PROACTIVE_PROMPT });
    assert.deepEqual(await json(settingsPath(inherited)), { ...inheritedOff, defaults: desired });
    const pinnedOff = await write(settingsPath(overridden), { enabled: false });
    assert.equal(pinnedOff.statusCode, 200, pinnedOff.body);
    assert.ok(overridden.memoryStoreId, "An explicit false override needs a store");
    assert.deepEqual(pinnedOff.json(), { defaults: desired, overrides: { enabled: false }, effective: off });
    const choices = await Promise.all([write(settingsPath(overridden), { autoIndex: false }), write(settingsPath(overridden), { proactive: false })]);
    for (const choice of choices) assert.equal(choice.statusCode, 200, choice.body);
    assert.deepEqual((await write(global, { enabled: true })).json(), { defaults: on, prompt: MEMORY_PROACTIVE_PROMPT });
    const preferences = (await config.loadConfig()).preferences;
    assert.deepEqual(preferences.files, files);
    assert.deepEqual(preferences.agent.systemPrompt, append);
    assert.deepEqual(preferences.memory, on);
    assert.deepEqual(JSON.parse(await readFile(config.configPath, "utf8")).preferences.memory, on);
    assert.deepEqual(await json(settingsPath(overridden)), { defaults: on, overrides: { enabled: false, autoIndex: false, proactive: false }, effective: off });
    assert.deepEqual((await write(settingsPath(overridden), { enabled: null, proactive: null })).json(), {
      defaults: on, overrides: { autoIndex: false }, effective: { ...on, autoIndex: false },
    });
    assert.deepEqual((await write(settingsPath(overridden), { reviewEntries: false })).json(), {
      defaults: on, overrides: { autoIndex: false, reviewEntries: false }, effective: { ...on, autoIndex: false, reviewEntries: false },
    });
    assert.deepEqual((await write(settingsPath(overridden), { reviewEntries: null })).json(), {
      defaults: on, overrides: { autoIndex: false }, effective: { ...on, autoIndex: false },
    });
    assert.equal((await write(global, { reviewEntries: false })).json().defaults.reviewEntries, false);
    assert.equal((await json(settingsPath(overridden))).effective.reviewEntries, false);
    assert.equal((await write(global, { reviewEntries: true })).json().defaults.reviewEntries, true);
    assert.equal((await json(settingsPath(overridden))).effective.reviewEntries, true);

    const inheritedOn = { defaults: on, overrides: {}, effective: on };
    assert.deepEqual(await json(settingsPath(inherited)), inheritedOn);
    assert.deepEqual(await json(path(inherited)), enabled);
    assert.equal(await scoped.isEnabled(undefined), true);
    assert.deepEqual(await scoped.recall(undefined, "reporting"), []);
    assert.equal(await scoped.directory(undefined, "reporting"), undefined);
    assert.equal((await write(`${path(inherited)}/entries`, { ...base, title: "" }, "POST")).statusCode, 400);
    assert.equal(inherited.memoryStoreId, undefined);
    const created = await write(`${path(inherited)}/entries`, base, "POST");
    assert.equal(created.statusCode, 201, created.body);
    const { id: entryId } = created.json();
    const inheritedId = workspaces.get(inherited.id).memoryStoreId!;
    const pending = await scoped.propose(inheritedId, base, origin);
    assert.deepEqual(await json(settingsPath(inherited)), inheritedOn);

    const legacyPath = join(root, `${legacyId}.json`);
    const legacyFile = JSON.stringify({ version: 1, ...disabled, autoIndex: true });
    await writeFile(legacyPath, legacyFile);
    assert.deepEqual(await scoped.getSettings(legacyId), { defaults: on, overrides: { enabled: false, autoIndex: true }, effective: off });
    assert.equal(await readFile(legacyPath, "utf8"), legacyFile);
    assert.deepEqual((await write(settingsPath(legacy), { enabled: null })).json(), { ...inheritedOn, overrides: { autoIndex: true } });
    assert.deepEqual((await write(settingsPath(legacy), { autoIndex: null })).json(), inheritedOn);
    assert.deepEqual(JSON.parse(await readFile(legacyPath, "utf8")), { version: 1, ...enabled, overrides: {} });

    await config.saveMemoryDefaults({ enabled: false });
    assert.deepEqual(await scoped.getSettings(legacyId), { ...inheritedOff, defaults: desired });
    assert.equal((await scoped.snapshot(inheritedId)).autoIndex, false);
    assert.equal((await scoped.snapshot(inheritedId)).entries[0].id, entryId);
    assert.equal(await scoped.directory(inheritedId, "reporting"), undefined);
    assert.deepEqual(await scoped.recall(inheritedId, "reporting"), []);
    await assert.rejects(scoped.create(inheritedId, base), status(409));
    await assert.rejects(scoped.propose(inheritedId, base, origin), status(409));
    await assert.rejects(scoped.read(inheritedId, entryId), status(409));
    await assert.rejects(scoped.confirm(inheritedId, pending.id, { draft: base }), status(409));

    const set = await write(settingsPath(inherited), { enabled: true, autoIndex: true }, "PUT");
    assert.equal(set.statusCode, 200, set.body);
    assert.equal(set.json().entries[0].id, entryId);
    assert.deepEqual(await json(settingsPath(inherited)), { defaults: desired, overrides: settings, effective: on });
    assert.equal((await scoped.confirm(inheritedId, pending.id, { draft: base })).status, "confirmed");
    assert.equal((await scoped.read(inheritedId, entryId)).body, base.body);
  } finally {
    await app.close();
  }
}

try {
  assert.deepEqual(await memory.snapshot(undefined), disabled);
  assert.deepEqual(await memory.snapshot(store), disabled);
  assert.deepEqual(await memory.setSettings(undefined, { enabled: false, autoIndex: true }), disabled);
  await assert.rejects(memory.setSettings(undefined, settings), status(409));
  await assert.rejects(memory.create(store, base), status(409));
  await assert.rejects(memory.propose(store, base, origin), status(409));
  await assert.rejects(memory.read(undefined, randomUUID()), status(409));
  assert.deepEqual(await memory.recall(undefined, "monthly"), []);
  assert.equal(await memory.directory(store, "monthly"), undefined);
  await assert.rejects(access(storage), { code: "ENOENT" });
  await assert.rejects(memory.snapshot("../outside"), status(400));
  await assert.rejects(memory.setSettings(store, { enabled: true, autoIndex: 1 }), status(400));

  assert.deepEqual(await memory.setSettings(store, settings), enabled);
  assert.deepEqual(await anotherRequest.snapshot(store), enabled);
  assert.deepEqual(await memory.snapshot(isolated), disabled);
  await memory.setSettings(isolated, settings);
  assert.equal(await memory.directory(store, "monthly"), undefined);

  await assert.rejects(memory.create(store, draft({ body: "界".repeat(2731) })), status(413));
  await assert.rejects(memory.create(store, draft({ title: "two\nlines" })), status(400));
  await assert.rejects(memory.create(store, draft({ reviewAfter: "2026-02-30" })), status(400));
  await assert.rejects(memory.create(store, draft({ reviewAfter: "0000-01-01T00:00:00+01:00" })), status(400));
  for (const sourceUrl of ["javascript:void(0)", "//example.test", "http://login@example.test", "https://example.test\\elsewhere"]) {
    await assert.rejects(memory.create(store, draft({ sourceUrl })), status(400));
  }
  await assert.rejects(memory.propose(store, base, { ...origin, link: origin.link.split("?")[0] }), status(400));
  assert.deepEqual((await memory.snapshot(store)).entries, []);

  const oversizedBoundary = "界".repeat(2730) + "ok";
  const external = await memory.create(isolated, draft({ title: "Isolated reference", type: "reference", summary: "Local docs", body: oversizedBoundary, tags: [], sourceUrl: "https://example.test/manual" }));
  assert.deepEqual(external.source, { kind: "external", url: "https://example.test/manual" });
  assert.equal((await memory.read(isolated, external.id)).body, oversizedBoundary);
  await assert.rejects(memory.read(store, external.id), status(404));
  assert.deepEqual(await memory.recall(store, "Isolated"), []);

  const [pending, retry] = await Promise.all([
    memory.propose(store, base, origin, "parallel-call"), anotherRequest.propose(store, base, origin, "parallel-call"),
  ]);
  assert.deepEqual(retry, pending);
  assert.equal(pending.status, "pending");
  assert.deepEqual(await anotherRequest.snapshot(store), { ...enabled, proposals: [pending] });
  assert.deepEqual(await memory.recall(store, "monthly"), []);
  await assert.rejects(memory.getProposal(isolated, pending.id), status(404));
  const browserDraft = draft({ sourceUrl: "https://example.test/ignored", fromNotebook: true });
  const [confirmed, duplicate] = await Promise.all([
    memory.confirm(store, pending.id, { draft: browserDraft, source: { kind: "manual" } }),
    anotherRequest.confirm(store, pending.id, { draft: draft({ title: "Different retry" }) }),
  ]);
  assert.deepEqual(duplicate, confirmed);
  assert.deepEqual(await memory.confirm(store, pending.id, null), confirmed);
  assert.deepEqual(await memory.getProposal(store, pending.id), confirmed);
  assert.equal(confirmed.status, "confirmed");
  const [initial] = (await memory.snapshot(store)).entries;
  assert.equal(confirmed.entryId, initial.id);
  assert.equal(initial.revision, 1);
  assert.equal(initial.reviewAfter, "2026-04-01T00:00:00.000Z");
  assert.equal(initial.verifiedAt, now);
  assert.equal(initial.title, base.title);
  assert.deepEqual(initial.source, origin);
  assert.deepEqual((await memory.snapshot(store)).proposals, []);
  assert.deepEqual(await memory.recall(store, "MONTHLY reporting"), [
    { id: initial.id, type: initial.type, title: initial.title, summary: initial.summary, tags: initial.tags, status: "active" },
  ]);
  assert.equal((await memory.recall(store, "按到账日生成月度报表"))[0]?.id, initial.id);
  assert.equal((await memory.recall(store, "SETTLEMENT"))[0]?.id, initial.id);
  assert.deepEqual(await memory.recall(store, "hidden-body-token"), []);
  assert.equal(await memory.directory(store, "unrelated"), undefined);

  const replacementOrigin = { ...origin, entryId: "ef7c800b", link: pinnedPiArkLink(internalMessageLink("workspace-memory-check", sessionId, "m123abd"), "ef7c800b") };
  const replacement = await memory.propose(store, draft({ summary: "按结算日统计。" }), replacementOrigin);
  assert.deepEqual((await memory.matches(store, replacement.id)).map(({ id }) => id), [initial.id]);
  await assert.rejects(memory.confirm(store, replacement.id, { draft: replacement.draft, target: { id: initial.id, revision: 2 } }), status(409));
  assert.equal((await memory.getProposal(store, replacement.id)).status, "pending");
  now = "2026-01-02T00:00:00.000Z";
  const replace = await memory.confirm(store, replacement.id, { draft: replacement.draft, target: { id: initial.id, revision: initial.revision }, reason: "Switched reporting date" });
  const revised = await memory.read(store, initial.id);
  assert.equal(replace.entryId, initial.id);
  assert.equal(revised.revision, 2);
  assert.equal(revised.changeReason, "Switched reporting date");
  assert.equal(revised.createdAt, initial.createdAt);
  assert.equal(revised.verifiedAt, now);
  assert.equal(revised.reviewAfter, "2026-04-02T00:00:00.000Z");
  assert.deepEqual(revised.source, replacement.source);
  assert.equal((await memory.snapshot(store)).entries.length, 1);
  const dismissed = await memory.propose(store, base, origin);
  assert.equal((await memory.dismiss(store, dismissed.id)).status, "dismissed");
  assert.equal((await memory.dismiss(store, dismissed.id)).status, "dismissed");
  await assert.rejects(memory.confirm(store, dismissed.id, { draft: base }), status(409));

  now = "2026-01-03T00:00:00.000Z";
  const writes = await Promise.allSettled([
    memory.update(store, initial.id, { ...replacement.draft, revision: revised.revision, title: "Monthly reporting update" }),
    anotherRequest.update(store, initial.id, { ...replacement.draft, revision: revised.revision, title: "Competing change" }),
  ]);
  const [edit, conflict] = writes;
  assert.equal(edit.status, "fulfilled");
  assert.equal(conflict.status, "rejected");
  assert.equal(conflict.reason.statusCode, 409);
  assert.equal(edit.value.revision, revised.revision + 1);
  assert.equal(edit.value.verifiedAt, revised.verifiedAt);
  assert.equal(edit.value.reviewAfter, revised.reviewAfter);
  assert.equal(edit.value.updatedAt, now);
  await assert.rejects(memory.remove(store, initial.id, revised.revision), status(409));
  assert.equal((await memory.read(store, initial.id)).title, "Monthly reporting update");

  const notebook = await memory.create(store, draft({ title: "Notebook fact", reviewAfter: null, fromNotebook: true }));
  assert.deepEqual(notebook.source, { kind: "notebook" });
  assert.equal(notebook.reviewAfter, undefined);
  now = "2026-04-02T00:00:00.000Z";
  const expired = (await memory.snapshot(store)).entries.find(({ id }) => id === initial.id)!;
  assert.equal(expired.status, "review");
  assert.equal(expired.revision, edit.value.revision);
  assert.deepEqual(await memory.recall(store, "monthly"), [
    { id: expired.id, type: expired.type, title: expired.title, summary: expired.summary, tags: expired.tags, status: "review", reviewAfter: expired.reviewAfter },
  ]);
  assert.deepEqual(JSON.parse((await memory.directory(store, "monthly"))!)[0], {
    id: expired.id, type: expired.type, title: expired.title, summary: expired.summary, status: "review", reviewAfter: expired.reviewAfter!.slice(0, 10),
  });
  assert.equal((await memory.read(store, initial.id)).status, "review");
  await memory.patchSettings(store, { reviewEntries: false });
  assert.deepEqual(await memory.recall(store, "monthly"), []);
  assert.equal(await memory.directory(store, "monthly"), undefined);
  await assert.rejects(memory.read(store, initial.id), status(404));
  await memory.patchSettings(store, { reviewEntries: null });
  assert.equal((await memory.read(store, notebook.id)).status, "active");
  const verified = await memory.update(store, initial.id, { ...replacement.draft, revision: expired.revision, reverify: true });
  assert.equal(verified.status, "active");
  assert.equal(verified.verifiedAt, now);
  assert.equal(verified.reviewAfter, "2026-07-01T00:00:00.000Z");
  const missing = await memory.markSourceMissing(store, initial.id, verified.revision);
  assert.equal(missing.status, "review");
  assert.equal(missing.revision, verified.revision + 1);
  assert.deepEqual(await memory.markSourceMissing(store, initial.id, missing.revision), missing);
  const archived = await memory.update(store, initial.id, { ...replacement.draft, revision: missing.revision, status: "archived" });
  assert.deepEqual(await memory.markSourceMissing(store, initial.id, archived.revision), archived);
  assert.deepEqual(await memory.recall(store, "monthly"), []);
  assert.equal(await memory.directory(store, "monthly"), undefined);
  await assert.rejects(memory.read(store, archived.id), status(404));

  const markdown = await memory.exportMarkdown(store);
  assert.match(markdown, /^# Workspace Memory\n/);
  assert.match(markdown, /## Monthly reporting 月度报表口径/);
  assert.match(markdown, /- Status: archived/);
  assert.ok(markdown.includes(`<${replacementOrigin.link}>`));
  assert.ok(!markdown.includes(origin.link));
  assert.ok(markdown.includes(archived.body));
  assert.ok(!markdown.includes(dismissed.id));
  assert.match(await memory.exportMarkdown(isolated), /<https:\/\/example\.test\/manual>/);

  await memory.setSettings(catalog, settings);
  const catalogDraft = draft({ type: "user", title: "Reports", summary: "Shared context.", tags: [], body: "Never place the body in the directory." });
  const pinned = await memory.create(catalog, { ...catalogDraft, title: "<pinned>", summary: "Quote \" and bidi \u202e", pinned: true });
  const others = await Promise.all(Array.from({ length: 9 }, (_, i) => [memory, anotherRequest][i % 2].create(catalog, { ...catalogDraft, title: `Reports ${i}` })));
  const top = await memory.create(catalog, { ...catalogDraft, title: "Reports to export", summary: "Reports again", tags: ["reports"] });
  assert.equal((await memory.snapshot(catalog)).entries.length, 11);
  const catalogText = (await memory.directory(catalog, "reports"))!;
  const lines = JSON.parse(catalogText);
  assert.equal(lines.length, 8);
  assert.equal(lines[0].id, pinned.id);
  assert.equal(lines[0].title, "<pinned>");
  assert.equal(lines[1].id, top.id);
  assert.deepEqual(lines.slice(2).map(({ id }: { id: string }) => id), others.map(({ id }) => id).sort().slice(0, 6));
  assert.equal(await anotherRequest.directory(catalog, "reports"), catalogText);
  assert.ok(!/[<>\u202e]/u.test(catalogText));
  assert.ok(!catalogText.includes(catalogDraft.body));
  assert.equal((await memory.recall(catalog, "reports")).length, 5);
  assert.equal(JSON.parse((await memory.directory(catalog, ""))!).length, 1);

  for (let i = 0; i < 8; i++) {
    await memory.create(catalog, { ...catalogDraft, title: `界${i}🚀`.repeat(35) + "<", summary: "多字节>".repeat(75), pinned: true });
  }
  const bounded = (await memory.directory(catalog, "界"))!;
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 2048);
  assert.ok(JSON.parse(bounded).length > 0 && JSON.parse(bounded).length < 8);
  assert.ok(!/[<>\uFFFD]/u.test(bounded));
  assert.equal((await readdir(storage)).some((name) => name.endsWith(".tmp")), false);

  await memory.setSettings(catalog, { enabled: true, autoIndex: false });
  assert.equal(await memory.directory(catalog, "reports"), undefined);
  assert.equal((await memory.recall(catalog, "reports"))[0]?.id, top.id);
  await memory.setSettings(catalog, { enabled: false, autoIndex: true });
  const rollbackFlags = JSON.parse(await readFile(join(storage, `${catalog}.json`), "utf8"));
  assert.equal(rollbackFlags.enabled, false);
  assert.equal(rollbackFlags.autoIndex, true);
  assert.equal((await memory.snapshot(catalog)).autoIndex, false);
  assert.equal(await memory.directory(catalog, "reports"), undefined);
  assert.deepEqual(await memory.recall(catalog, "reports"), []);
  await assert.rejects(memory.read(catalog, pinned.id), status(409));
  assert.match(await memory.exportMarkdown(catalog), /Reports to export/);
  await memory.remove(catalog, pinned.id, pinned.revision);
  assert.ok(!(await memory.snapshot(catalog)).entries.some(({ id }) => id === pinned.id));

  const broken = randomUUID();
  await writeFile(join(storage, `${broken}.json`), "{broken JSON");
  await assert.rejects(memory.snapshot(broken), status(500));
  await assert.rejects(memory.setSettings(broken, settings), status(500));
  await writeFile(join(storage, `${broken}.json`), JSON.stringify({ ...enabled, version: 1, entries: [null] }));
  await assert.rejects(memory.snapshot(broken), status(500));
  await memory.purge(broken);
  assert.deepEqual(await memory.snapshot(broken), disabled);
  await memory.purge(store);
  await memory.purge(store);
  assert.deepEqual(await memory.snapshot(store), disabled);
  assert.deepEqual(await memory.read(isolated, external.id), external);
  await checkMemorySettings();
  console.log("workspace memory storage and settings checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
