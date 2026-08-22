import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeSnapshot, RUNTIME_SNAPSHOT_VERSION } from "../src/dashboard/runtimeSnapshot.js";

test("creates a versioned JSON-serializable runtime snapshot", () => {
  const snapshot = createRuntimeSnapshot({
    generatedAtMs: Date.parse("2026-08-22T04:15:00.000Z"),
    market: { slug: "btc-updown-15m-test", timeLeftMinutes: 8.5 },
    signal: { regime: "TREND_UP", modelUp: 0.64 },
    readiness: { state: "READY", tradingAllowed: true },
    trading: { mode: "paper", status: { state: "WAITING", text: "waiting: quoted edge below 10.0%" } },
    session: { name: "Asia" }
  });

  assert.equal(snapshot.version, RUNTIME_SNAPSHOT_VERSION);
  assert.equal(snapshot.generatedAt, "2026-08-22T04:15:00.000Z");
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test("rejects an invalid snapshot timestamp", () => {
  assert.throws(() => createRuntimeSnapshot({ generatedAtMs: Number.NaN }), /must be finite/);
});