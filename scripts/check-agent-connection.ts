import assert from "node:assert/strict";
import { connectionStaleAfterMs, connectionWatchdogIntervalMs, isConnectionStale, reconnectDelay } from "../apps/web/src/connection-retry.ts";

assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map(reconnectDelay), [500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
assert.equal(reconnectDelay(-1), 500);
assert.equal(connectionWatchdogIntervalMs < connectionStaleAfterMs, true);

assert.equal(isConnectionStale(1000, 1000 + connectionStaleAfterMs), false);
assert.equal(isConnectionStale(1000, 1001 + connectionStaleAfterMs), true);
assert.equal(isConnectionStale(1000, 2000), false);
