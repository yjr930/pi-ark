import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { heartbeatIntervalMs, startHeartbeat } from "../apps/server/src/websocket-heartbeat.ts";

class FakeSocket extends EventEmitter {
  readyState = 1;
  pings = 0;
  terminated = 0;
  sent: string[] = [];
  ping() { this.pings += 1; }
  send(data: string) { this.sent.push(data); }
  terminate() { this.terminated += 1; this.emit("close"); }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const asSocket = (socket: FakeSocket) => socket as unknown as WebSocket;

assert.equal(heartbeatIntervalMs, 15000);

const answered = new FakeSocket();
const stopAnswered = startHeartbeat(asSocket(answered), { intervalMs: 20, notice: true });
const pong = setInterval(() => { if (answered.pings > 0) answered.emit("pong"); }, 10);
await wait(70);
clearInterval(pong);
assert.equal(answered.terminated, 0);
assert.equal(answered.pings >= 3, true);
assert.equal(answered.sent.length, answered.pings);
assert.equal(answered.sent.every((item) => JSON.parse(item).type === "ping"), true);
const pingsAtStop = answered.pings;
stopAnswered();
await wait(40);
assert.equal(answered.pings, pingsAtStop);

const silent = new FakeSocket();
startHeartbeat(asSocket(silent), { intervalMs: 20 });
await wait(25);
assert.equal(silent.pings, 1);
assert.equal(silent.terminated, 0);
await wait(30);
assert.equal(silent.terminated, 1);

const closed = new FakeSocket();
startHeartbeat(asSocket(closed), { intervalMs: 20 });
await wait(25);
const pingsBeforeClose = closed.pings;
closed.emit("close");
await wait(40);
assert.equal(closed.pings, pingsBeforeClose);
