import assert from "node:assert/strict";
import { marked, type Token } from "marked";
import { deferFileLinks, FILE_LINK_DELAY_MS, FILE_LINK_MAX_PATH, FileLinkResolver, FileLinkWorkQueue, FileLinkTextSnapshot, FilePathScanner, isObviousFilePath, localFileHref, type FileLinkTimer, type FileLinkTransport, type ResolvedFileLink } from "../apps/web/src/file-links.ts";

class Clock {
  now = 0;
  nextId = 0;
  tasks = new Map<number, { at: number; run: () => void }>();
  schedule: FileLinkTimer = (run, delay) => {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.now + delay, run });
    return () => { this.tasks.delete(id); };
  };
  async advance(ms: number) {
    const target = this.now + ms;
    for (let steps = 0; ; steps += 1) {
      assert.ok(steps < 10000, "timer work remains bounded");
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.now = next[1].at;
      this.tasks.delete(next[0]);
      next[1].run();
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    }
    this.now = target;
  }
}
function tokens(source: string, inline = false, size = 2048) {
  const scanner = new FilePathScanner(source, inline);
  const result = [];
  let steps = 0;
  while (!scanner.done) { result.push(...scanner.step(size)); steps += 1; assert.ok(steps < source.length + 2); }
  return { result, steps };
}
const cases = ["src/App.tsx", "README.md", "./docs/foo.md", "../file.md", "/absolute/workspace/file", "C:\\workspace\\src\\App.tsx", "\\\\server\\share\\file.md"];
for (const path of cases) assert.equal(isObviousFilePath(path), true, path);
for (const path of ["https://host/docs/a.md", "mailto:person@example.org", "person@example.org", "pi-ark://workspace/demo", "#L42", "v1.2.3", "1.2.3", "ordinary", "www.example.org/a.md", "example.com/a.md"]) assert.equal(isObviousFilePath(path), false, path);
assert.deepEqual(tokens("查看 src/App.tsx，README.md。 ./docs/foo.md:42 ../file.md#L42").result.map((item) => item.input), ["src/App.tsx", "README.md", "./docs/foo.md", "../file.md"]);
assert.deepEqual(tokens("docs/含 空格.md", true).result.map((item) => item.input), ["docs/含 空格.md"]);
assert.deepEqual(tokens("report%20name.md").result.map((item) => item.input), ["report%20name.md"]);
const boundary = tokens(`${" ".repeat(61)}src/App.tsx`, false, 64);
assert.equal(boundary.steps, 2);
assert.deepEqual(boundary.result, [{ start: 61, end: 72, input: "src/App.tsx" }]);
const long = tokens(`${"x".repeat(20000)} README.md`, false, 64);
assert.ok(long.steps > 300);
assert.deepEqual(long.result.map((item) => item.input), ["README.md"]);
assert.equal(FILE_LINK_MAX_PATH, 2048, "client matches the backend's path limit");
const maximumPath = `${"a".repeat(FILE_LINK_MAX_PATH - 3)}.md`;
assert.equal(isObviousFilePath(maximumPath), true);
assert.equal(localFileHref(maximumPath), maximumPath);
assert.equal(isObviousFilePath(`a${maximumPath}`), false);
assert.equal(localFileHref(`a${maximumPath}`), undefined);
const oversizedCandidate = `docs/${"a".repeat(FILE_LINK_MAX_PATH)}.md`;
assert.deepEqual(tokens(`${oversizedCandidate} README.md`, false, 64).result.map((item) => item.input), ["README.md"]);
assert.deepEqual(tokens(maximumPath, false, 64).result.map((item) => item.input), [maximumPath]);

// Use marked's nested inline tokens, matching the text/code boundaries the DOM receives.
const nestedPaths: string[] = [];
function collectInline(items: Token[]) {
  for (const item of items) {
    if (item.type === "codespan") nestedPaths.push(...tokens(item.text, true).result.map((token) => token.input));
    else if (item.type === "link" || item.type === "image" || item.type === "code" || item.type === "html") continue;
    else if ("tokens" in item && Array.isArray(item.tokens)) collectInline(item.tokens);
    else if (item.type === "text") nestedPaths.push(...tokens(item.text).result.map((token) => token.input));
  }
}
collectInline(marked.lexer("**查看 `docs/含 空格.md`**，随后 *`src/App.tsx:42`*；`README.md`。\n\n[external.md](https://host)\n\n```text\nignored.md\n```"));
assert.deepEqual(nestedPaths, ["docs/含 空格.md", "src/App.tsx", "README.md"]);

// A multi-megabyte Text is read once, even across many scan/validation slices.
let snapshotReads = 0;
let snapshotSource = `${"x".repeat(2 * 1024 * 1024)} README.md`;
let snapshotConnected = true;
const fakeText = {
  get data() { snapshotReads += 1; return snapshotSource; },
  get length() { return snapshotSource.length; },
  get isConnected() { return snapshotConnected; },
};
const snapshot = new FileLinkTextSnapshot(fakeText);
let snapshotSlices = 0;
const snapshotPaths: string[] = [];
while (!snapshot.scanner.done) {
  assert.equal(snapshot.isCurrent(), true);
  snapshotPaths.push(...snapshot.scanner.step().map((token) => token.input));
  snapshotSlices += 1;
}
assert.ok(snapshotSlices > 1000);
assert.equal(snapshotReads, 1);
assert.deepEqual(snapshotPaths, ["README.md"]);
snapshotSource = `${snapshotSource.slice(0, -1)}x`;
snapshot.invalidate();
assert.equal(snapshot.isCurrent(), false, "same-length mutations invalidate old results");
snapshot.useTail(fakeText);
snapshotConnected = false;
assert.equal(snapshot.isCurrent(), false, "removed text cannot receive old results");
snapshotConnected = true;
snapshotSource += "x";
assert.equal(snapshot.isCurrent(), false, "length changes invalidate old results");
const newTail = { get data(): string { throw new Error("retargeting must not reread Text.data"); }, length: 10, isConnected: true };
snapshot.useTail(newTail);
assert.equal(snapshot.isCurrent(), true);
assert.equal(snapshotReads, 1);

for (const value of ["https://host/a.md", "mailto:a@b.com", "pi-ark://workspace/demo", "#heading", "?page=files", "//host/a.md", "javascript:alert(1)", "%00README.md", "bad%path.md"]) assert.equal(localFileHref(value), undefined);
assert.equal(localFileHref("./docs/a%20b.md#L42"), "./docs/a b.md");
assert.equal(localFileHref("docs/a%2520b.md"), "docs/a%20b.md");
assert.equal(localFileHref("docs/a%23b.md"), "docs/a#b.md");
assert.equal(localFileHref("../file.md:42"), "../file.md");
assert.equal(localFileHref("README.md:42"), "README.md");
assert.deepEqual(tokens("README.md:42").result.map((item) => item.input), ["README.md"]);
assert.equal(localFileHref("C:\\workspace\\a.md"), "C:\\workspace\\a.md");

const clock = new Clock();
const calls: Array<{ workspaceId: string; paths: string[]; basePath: string }> = [];
const transport: FileLinkTransport = async (workspaceId, paths, basePath) => {
  calls.push({ workspaceId, paths, basePath });
  return { links: paths.filter((input) => input !== "missing.md").map((input) => ({ input, path: `${basePath}/${input}`, type: "file" })) };
};
const resolver = new FileLinkResolver(transport, { now: () => clock.now, schedule: clock.schedule });
const received: Array<ResolvedFileLink | undefined> = [];
const cancelledDelay = deferFileLinks(() => { throw new Error("cancelled delay ran"); }, clock.schedule);
cancelledDelay();
deferFileLinks(() => {
  resolver.request("workspace", "", "README.md", (link) => received.push(link));
  resolver.request("workspace", "", "README.md", (link) => received.push(link));
}, clock.schedule);
await clock.advance(FILE_LINK_DELAY_MS - 1);
assert.equal(calls.length, 0);
assert.equal(received.length, 0);
await clock.advance(1);
assert.equal(calls.length, 0);
await clock.advance(60);
assert.equal(calls.length, 1);
assert.deepEqual(calls[0]!.paths, ["README.md"]);
assert.equal(received.length, 2);
resolver.request("workspace", "", "README.md", (link) => received.push(link));
await clock.advance(60);
assert.equal(calls.length, 1);
assert.equal(received.length, 3);
resolver.request("other-workspace", "", "README.md", () => {});
resolver.request("workspace", "docs", "README.md", () => {});
await clock.advance(60);
assert.equal(calls.length, 3);
assert.deepEqual(calls.slice(1).map(({ workspaceId, basePath }) => [workspaceId, basePath]), [["other-workspace", ""], ["workspace", "docs"]]);
await clock.advance(60000);
resolver.request("workspace", "", "README.md", () => {});
await clock.advance(60);
assert.equal(calls.length, 4);
resolver.request("workspace", "", "missing.md", (link) => received.push(link));
await clock.advance(60);
assert.equal(received.at(-1), undefined);
const missingCalls = calls.length;
resolver.request("workspace", "", "missing.md", () => {});
await clock.advance(60);
assert.equal(calls.length, missingCalls);
await clock.advance(15000);
resolver.request("workspace", "", "missing.md", () => {});
await clock.advance(60);
assert.equal(calls.length, missingCalls + 1);
let cancelledResult = false;
const cancelQueued = resolver.request("workspace", "", "cancelled.md", () => { cancelledResult = true; });
cancelQueued();
await clock.advance(60);
assert.equal(cancelledResult, false);
assert.ok(!calls.some((call) => call.paths.includes("cancelled.md")));

const identityClock = new Clock();
const identityResolver = new FileLinkResolver(transport, { schedule: identityClock.schedule, now: () => identityClock.now });
const oldCancel = identityResolver.request("workspace", "", "reused.md", () => { throw new Error("cancelled subscription ran"); });
oldCancel();
let replacementResults = 0;
identityResolver.request("workspace", "", "reused.md", () => { replacementResults += 1; });
oldCancel();
await identityClock.advance(60);
assert.equal(replacementResults, 1, "old cancellation preserves a new entry with the same key");
let cancelDuringDelivery = () => {};
cancelDuringDelivery = identityResolver.request("workspace", "", "reentrant.md", () => {
  cancelDuringDelivery();
  identityResolver.request("workspace", "", "reentrant.md", () => { replacementResults += 1; });
});
await identityClock.advance(90);
assert.equal(replacementResults, 2, "delivery cleanup preserves a replacement entry created by its listener");
cancelDuringDelivery();
identityResolver.request("workspace", "", "reentrant.md", () => { replacementResults += 1; });
cancelDuringDelivery();
await identityClock.advance(60);
assert.equal(replacementResults, 3);

const validationClock = new Clock();
const validPaths: string[][] = [];
const validationResolver = new FileLinkResolver(async (_workspace, paths) => { validPaths.push(paths); return { links: [] }; }, { schedule: validationClock.schedule, now: () => validationClock.now });
validationResolver.request("workspace", "", maximumPath, () => {});
validationResolver.request("workspace", "", `a${maximumPath}`, () => {});
await validationClock.advance(60);
assert.deepEqual(validPaths, [[maximumPath]], "oversized paths never join a transport batch");

const batchClock = new Clock();
const batches: string[][] = [];
const completions: Array<() => void> = [];
let active = 0;
let maximumActive = 0;
const batchResolver = new FileLinkResolver((_workspace, paths) => new Promise((resolve) => {
  active += 1;
  maximumActive = Math.max(active, maximumActive);
  batches.push(paths);
  completions.push(() => { active -= 1; resolve({ links: paths.map((input) => ({ input, path: input, type: "file" })) }); });
}), { schedule: batchClock.schedule, now: () => batchClock.now, batchSize: 100, concurrency: 100 });
let batchDelivered = 0;
for (let index = 0; index < 200; index += 1) batchResolver.request("workspace", "", `file-${index}.md`, () => { batchDelivered += 1; });
const cancelInflight = batchResolver.request("workspace", "", "file-0.md", () => { throw new Error("cancelled inflight subscription ran"); });
await batchClock.advance(30);
cancelInflight();
assert.equal(batches.length, 2);
assert.ok(batches.every((paths) => paths.length <= 64));
assert.equal(maximumActive, 2);
while (batchDelivered < 200) {
  for (const complete of completions.splice(0)) complete();
  await batchClock.advance(120);
}
assert.equal(new Set(batches.flat()).size, 200);
assert.equal(batches.flat().length, 200);
assert.equal(batchResolver.size.pending, 0);
assert.equal(batchResolver.size.subscribers, 0);

const deliveryClock = new Clock();
const deliveryResolver = new FileLinkResolver(transport, { schedule: deliveryClock.schedule, now: () => deliveryClock.now });
let delivered = 0;
for (let index = 0; index < 200; index += 1) deliveryResolver.request("workspace", "", "shared.md", () => { delivered += 1; });
await deliveryClock.advance(30);
assert.equal(delivered, 0);
await deliveryClock.advance(30);
assert.equal(delivered, 64);
await deliveryClock.advance(30);
assert.equal(delivered, 128);
await deliveryClock.advance(60);
assert.equal(delivered, 200);

const limitClock = new Clock();
const limited = new FileLinkResolver(transport, { schedule: limitClock.schedule, now: () => limitClock.now, cacheLimit: 2, pendingLimit: 2, subscriberLimit: 3 });
for (let index = 0; index < 5; index += 1) limited.request("workspace", "", `bounded-${index}.md`, () => {});
assert.equal(limited.size.pending, 2);
assert.ok(limited.size.subscribers <= 3);
await limitClock.advance(90);
limited.request("workspace", "", "bounded-new.md", () => {});
await limitClock.advance(90);
assert.equal(limited.size.cached, 2);

const errorClock = new Clock();
let errorCalls = 0;
const failing = new FileLinkResolver(async () => { errorCalls += 1; throw new Error("offline"); }, { schedule: errorClock.schedule, now: () => errorClock.now });
let errorResult: ResolvedFileLink | undefined;
failing.request("workspace", "", "README.md", (result) => { errorResult = result; });
await errorClock.advance(60);
assert.equal(errorResult, undefined);
failing.request("workspace", "", "README.md", () => {});
await errorClock.advance(60);
assert.equal(errorCalls, 1);
await errorClock.advance(15000);
failing.request("workspace", "", "README.md", () => {});
await errorClock.advance(60);
assert.equal(errorCalls, 2);

const workClock = new Clock();
let workTime = 0;
const work = new FileLinkWorkQueue(workClock.schedule, () => workTime);
const order: string[] = [];
let a = 0;
let b = 0;
work.enqueue(() => { order.push("a"); a += 1; workTime += 1; return a === 5; });
work.enqueue(() => { order.push("b"); b += 1; workTime += 1; return b === 5; });
const cancelWork = work.enqueue(() => { throw new Error("cancelled idle work ran"); });
cancelWork();
await workClock.advance(0);
assert.deepEqual(order, ["a", "b", "a", "b", "a", "b", "a", "b", "a", "b"]);
assert.equal(workClock.tasks.size, 0);
const waitingClock = new Clock();
const waitingWork = new FileLinkWorkQueue(waitingClock.schedule, () => 0);
let completeWaiting: (() => void) | undefined;
const waitingResolver = new FileLinkResolver((_workspace, paths) => new Promise((resolve) => {
  completeWaiting = () => resolve({ links: paths.map((input) => ({ input, path: input, type: "file" })) });
}), { schedule: waitingClock.schedule, now: () => waitingClock.now });
let waitingSteps = 0;
const waitingJob = () => {
  waitingSteps += 1;
  if (waitingSteps === 1) waitingResolver.request("workspace", "", "README.md", () => { waitingWork.enqueue(waitingJob); });
  return true; // Pause while the network owns the pending work.
};
waitingWork.enqueue(waitingJob);
await waitingClock.advance(30);
assert.equal(waitingSteps, 1);
assert.equal(waitingClock.tasks.size, 0);
await waitingClock.advance(10000);
assert.equal(waitingSteps, 1, "network waits do not poll the idle queue");
completeWaiting!();
for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
await waitingClock.advance(60);
assert.equal(waitingSteps, 2, "a resolved batch resumes paused idle work");
assert.equal(waitingClock.tasks.size, 0);

const slices: Array<() => void> = [];
const boundedWork = new FileLinkWorkQueue((run) => { slices.push(run); return () => {}; }, () => 0);
let sliceSteps = 0;
for (let index = 0; index < 40; index += 1) boundedWork.enqueue(() => { sliceSteps += 1; return true; });
slices.shift()!();
assert.equal(sliceSteps, 16);
slices.shift()!();
assert.equal(sliceSteps, 32);
slices.shift()!();
assert.equal(sliceSteps, 40);
console.log("file link client checks passed");
