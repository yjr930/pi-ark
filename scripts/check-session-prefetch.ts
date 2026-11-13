import assert from "node:assert/strict";
import { PREFETCH_MAX_CONNECTIONS, PREFETCH_RETRY_MS, SessionPrefetcher, type SessionPrefetchTarget } from "../apps/web/src/session-prefetch.ts";
import type { AgentSnapshot } from "../apps/web/src/types.ts";

function snapshot(id: string): AgentSnapshot {
  return {
    id,
    messages: [{ role: "user", content: id }],
    messageNumberOffset: 0,
    totalDisplayMessages: 1,
    hasEarlierMessages: false,
    isStreaming: false,
    isIdle: true,
    model: null,
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    queue: [],
    queueRevision: 0,
    stats: { userMessages: 1, assistantMessages: 0, toolCalls: 0, totalMessages: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
  };
}

interface FakeSocket {
  target: SessionPrefetchTarget;
  closed: boolean;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
  send(payload: unknown): void;
}

function createHarness(options: { maxConnections?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const cached: Array<{ key: string; id: string }> = [];
  let now = 1000;
  const prefetcher = new SessionPrefetcher({
    maxConnections: options.maxConnections ?? PREFETCH_MAX_CONNECTIONS,
    now: () => now,
    cache: (key, value) => cached.push({ key, id: value.id }),
    createSocket: (target) => {
      const socket: FakeSocket = {
        target, closed: false, onmessage: null, onclose: null, onerror: null,
        close() { socket.closed = true; },
        send(payload) { socket.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) }); },
      };
      sockets.push(socket);
      return socket;
    },
  });
  return { prefetcher, sockets, cached, advance: (ms: number) => { now += ms; } };
}

const first: SessionPrefetchTarget = { workspaceId: "workspace", sessionId: "running-a" };
const second: SessionPrefetchTarget = { workspaceId: "workspace", sessionId: "running-b" };

{
  const { prefetcher, sockets, cached } = createHarness();
  prefetcher.update([first, second], "workspace:running-a");
  assert.equal(sockets.length, 1, "the open Session is skipped");
  assert.deepEqual(sockets[0].target, second);
  sockets[0].send({ type: "snapshot", session: snapshot("running-b") });
  assert.deepEqual(cached, [{ key: "workspace:running-b", id: "running-b" }]);
  sockets[0].send({ type: "agent-event", event: { type: "message_update" } });
  sockets[0].send("not json");
  assert.equal(cached.length, 1);
  prefetcher.update([second], undefined);
  assert.equal(sockets[0].closed, false);
  prefetcher.update([], undefined);
  assert.equal(sockets[0].closed, true, "a Session that is no longer running stops prefetching");
  prefetcher.dispose();
}

{
  const { prefetcher, sockets } = createHarness({ maxConnections: 1 });
  prefetcher.update([first, second], undefined);
  assert.equal(sockets.length, 1);
  prefetcher.update([second, first], undefined);
  assert.equal(sockets.length, 1, "the connection cap bounds concurrent prefetch");
  prefetcher.dispose();
}

{
  const { prefetcher, sockets, cached, advance } = createHarness();
  prefetcher.update([first], undefined);
  assert.equal(sockets.length, 1);
  sockets[0].onclose?.();
  prefetcher.update([first], undefined);
  assert.equal(sockets.length, 1, "a closed prefetch connection waits before reconnecting");
  advance(PREFETCH_RETRY_MS + 1);
  prefetcher.update([first], undefined);
  assert.equal(sockets.length, 2);
  sockets[1].send({ type: "snapshot", session: snapshot("running-a") });
  assert.deepEqual(cached, [{ key: "workspace:running-a", id: "running-a" }]);
  prefetcher.setActive(false);
  assert.equal(sockets[1].closed, true, "a hidden page stops prefetching");
  prefetcher.update([first], undefined);
  assert.equal(sockets.length, 2);
  prefetcher.setActive(true);
  assert.equal(sockets.length, 3, "a visible page resumes prefetching");
  prefetcher.dispose();
  assert.equal(sockets[2].closed, true);
  prefetcher.update([first], undefined);
  assert.equal(sockets.length, 3);
}

console.log("session prefetch checks passed");
