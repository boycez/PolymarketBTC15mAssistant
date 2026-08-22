import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { ResearchHealthMonitor } from "../src/research/healthMonitor.js";
import { MarketOutcomeTracker } from "../src/research/outcomeTracker.js";

function logger() {
  return { logs: [], warnings: [], log(message) { this.logs.push(message); }, warn(message) { this.warnings.push(message); } };
}

test("pauses research writes below the disk threshold without throwing", () => {
  const output = logger();
  const monitor = new ResearchHealthMonitor({
    storagePath: ".",
    minFreeBytes: 1_000,
    now: () => 10_000,
    statfs: () => ({ bavail: 5, bsize: 100 }),
    logger: output
  });

  assert.equal(monitor.canWrite(), false);
  assert.equal(output.warnings.length, 1);
  assert.equal(monitor.freeBytes, 500);
});

test("reports hourly research counters without a background timer", () => {
  let nowMs = 1_000;
  const output = logger();
  const monitor = new ResearchHealthMonitor({
    storagePath: ".",
    minFreeBytes: 0,
    reportIntervalMs: 3_000,
    now: () => nowMs,
    statfs: () => ({ bavail: 10, bsize: 100 }),
    logger: output
  });
  monitor.canWrite();
  monitor.recordDecision();
  monitor.recordOutcome();
  monitor.updatePending(2);

  assert.equal(monitor.maybeReport(), false);
  nowMs = 4_000;
  assert.equal(monitor.maybeReport(), true);
  assert.match(output.logs[0], /decisions=1 outcomes=1 pending=2 errors=0/);
});

test("preserves pending markets while low disk pauses outcome JSONL writes", async () => {
  const output = logger();
  const healthMonitor = new ResearchHealthMonitor({
    storagePath: ".",
    minFreeBytes: 1_000,
    statfs: () => ({ bavail: 5, bsize: 100 }),
    logger: output
  });
  const tracker = new MarketOutcomeTracker({
    filePath: `${process.env.TMPDIR || "/tmp"}/unused-outcomes.jsonl`,
    pendingFilePath: `${process.env.TMPDIR || "/tmp"}/research-health-pending-${process.pid}.json`,
    pollIntervalMs: 1,
    healthMonitor,
    fetchMarket: async () => ({ closed: true, umaResolutionStatus: "resolved", outcomes: ["Up", "Down"], outcomePrices: ["1", "0"] })
  });

  try {
    assert.equal(tracker.observeMarket({ slug: "btc-market", endDate: "2026-08-22T00:15:00Z" }), true);
    assert.deepEqual(await tracker.settlePending(Date.parse("2026-08-22T00:16:00Z")), []);
    assert.equal(tracker.pending.has("btc-market"), true);
  } finally {
    try { fs.rmSync(tracker.pendingFilePath, { force: true }); } catch {}
  }
});