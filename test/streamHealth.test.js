import assert from "node:assert/strict";
import test from "node:test";

import { StreamHealthMonitor } from "../src/engine/streamHealth.js";

function fakeStream(health) {
  return {
    restarts: [],
    getHealth() {
      return { ...health };
    },
    restart(reason) {
      this.restarts.push(reason);
    }
  };
}

test("restarts a connected stream whose messages are stale", () => {
  let nowMs = 20_000;
  const stream = fakeStream({ enabled: true, connected: true, connectedAt: 1_000, lastMessageAt: 2_000 });
  const monitor = new StreamHealthMonitor({
    streams: [{ name: "twap", stream, staleAfterMs: 5_000 }],
    restartCooldownMs: 10_000,
    now: () => nowMs
  });

  const first = monitor.check();
  assert.equal(first.sources[0].state, "STALE");
  assert.deepEqual(stream.restarts, ["stale_watchdog"]);

  nowMs += 1_000;
  monitor.check();
  assert.equal(stream.restarts.length, 1);

  nowMs += 10_000;
  monitor.check();
  assert.equal(stream.restarts.length, 2);
});

test("reports healthy, reconnecting, and disabled streams without restarting them", () => {
  const healthy = fakeStream({ enabled: true, connected: true, connectedAt: 9_000, lastMessageAt: 9_500 });
  const reconnecting = fakeStream({ enabled: true, connected: false, connectedAt: 8_000, lastMessageAt: 8_500 });
  const disabled = fakeStream({ enabled: false, connected: false, connectedAt: null, lastMessageAt: null });
  const monitor = new StreamHealthMonitor({
    streams: [
      { name: "healthy", stream: healthy, staleAfterMs: 5_000 },
      { name: "reconnecting", stream: reconnecting, staleAfterMs: 5_000 },
      { name: "disabled", stream: disabled, staleAfterMs: null }
    ],
    now: () => 10_000
  });

  const snapshot = monitor.check();
  assert.deepEqual(snapshot.sources.map((source) => source.state), ["HEALTHY", "RECONNECTING", "DISABLED"]);
  assert.deepEqual(snapshot.summary, { healthy: 1, reconnecting: 1, disabled: 1 });
  assert.equal(healthy.restarts.length + reconnecting.restarts.length + disabled.restarts.length, 0);
});

test("redacts underlying connection errors from health snapshots", () => {
  const stream = fakeStream({
    enabled: true,
    connected: false,
    connectedAt: 1_000,
    lastMessageAt: 2_000,
    lastError: "connect failed through http://user:password@example.test"
  });
  const monitor = new StreamHealthMonitor({
    streams: [{ name: "private", stream, staleAfterMs: 5_000 }],
    now: () => 3_000
  });

  assert.equal(monitor.check().sources[0].lastError, "connection_error");
});