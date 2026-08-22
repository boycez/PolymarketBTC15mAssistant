import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DecisionResearchRecorder } from "../src/research/decisionRecorder.js";
import { appendDailyJsonl, dailyJsonlPath, listJsonlFiles, readJsonlFiles } from "../src/research/jsonlStore.js";
import { MarketOutcomeTracker } from "../src/research/outcomeTracker.js";
import { RESEARCH_EVENT_TYPES, validateResearchEvent } from "../src/research/schema.js";
import { resolveCodeCommit, strategyConfigFingerprint } from "../src/research/strategyIdentity.js";
import { atomicWriteFileSync } from "../src/utils.js";

test("creates stable strategy config fingerprints", () => {
  assert.equal(
    strategyConfigFingerprint({ threshold: 0.1, nested: { enabled: true, limit: 2 } }),
    strategyConfigFingerprint({ nested: { limit: 2, enabled: true }, threshold: 0.1 })
  );
  assert.notEqual(strategyConfigFingerprint({ threshold: 0.1 }), strategyConfigFingerprint({ threshold: 0.2 }));
});

test("records research events on state changes and configured intervals", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-research-"));
  const filePath = path.join(directory, "events.jsonl");
  const recorder = new DecisionResearchRecorder({ filePath, intervalMs: 15_000 });
  const event = {
    market: { slug: "btc-market" },
    strategy: { key: "ta-edge@1.2.0" },
    decision: { recommendation: { action: "NO_TRADE", side: null } },
    execution: { gateReason: "waiting: quoted edge below 10.0%" }
  };

  try {
    assert.equal(recorder.record(event, 1_000), true);
    assert.equal(recorder.record(event, 2_000), false);
    assert.equal(recorder.record(event, 16_000), true);
    assert.equal(recorder.record({ ...event, execution: { gateReason: "waiting: model probability below 60.0%" } }, 17_000), true);
    assert.equal(recorder.record({ ...event, reference: { state: "DEGRADED" } }, 18_000), true);
    const dailyPath = dailyJsonlPath(filePath, 18_000);
    const events = fs.readFileSync(dailyPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.length, 4);
    assert.ok(events.every((item) => item.eventType === RESEARCH_EVENT_TYPES.DECISION));
    assert.ok(events.every((item) => validateResearchEvent(item) === item));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fails soft when research events cannot be written", () => {
  const recorder = new DecisionResearchRecorder({ filePath: "/dev/null/events.jsonl" });
  const recorded = recorder.record({
    market: { slug: "btc-market" },
    strategy: { key: "ta-edge@1.2.0" },
    decision: {},
    execution: {}
  });

  assert.equal(recorded, false);
  assert.match(recorder.lastError, /EEXIST|ENOTDIR|not a directory|file already exists/i);
});

test("rotates JSONL files by UTC date and reports malformed rows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "research-jsonl-"));
  const basePath = path.join(directory, "events.jsonl");
  const firstPath = dailyJsonlPath(basePath, Date.parse("2026-08-22T23:59:59Z"));
  const secondPath = dailyJsonlPath(basePath, Date.parse("2026-08-23T00:00:00Z"));
  fs.writeFileSync(firstPath, '{"ok":true}\ninvalid\n');
  fs.writeFileSync(secondPath, '{"ok":false}\n');

  try {
    const result = readJsonlFiles([firstPath, secondPath]);
    assert.deepEqual(result.events, [{ ok: true }, { ok: false }]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].line, 2);
    fs.writeFileSync(path.join(directory, "events-backup.jsonl"), '{"ignored":true}\n');
    assert.deepEqual(listJsonlFiles(basePath), [firstPath, secondPath]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("recovers malformed pending state from decision observations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "research-recovery-"));
  const eventFilePath = path.join(directory, "events.jsonl");
  const outcomeFilePath = path.join(directory, "outcomes.jsonl");
  const pendingFilePath = path.join(directory, "pending.json");
  const timestamp = Date.parse("2026-08-22T00:10:00Z");
  const event = {
    schemaVersion: 1,
    eventType: RESEARCH_EVENT_TYPES.DECISION,
    eventId: "12345678-1234-1234-1234-123456789abc",
    recordedAt: new Date(timestamp).toISOString(),
    market: { id: "1", slug: "btc-market", endDate: "2026-08-22T00:15:00.000Z" },
    strategy: { key: "ta-edge@1.2.0" },
    reference: { priceToBeat: "77000" }
  };

  try {
    appendDailyJsonl(eventFilePath, event, timestamp);
    fs.writeFileSync(pendingFilePath, "{invalid");
    const tracker = new MarketOutcomeTracker({
      filePath: outcomeFilePath,
      eventFilePath,
      pendingFilePath,
      fetchMarket: async () => null
    });
    assert.equal(tracker.pending.size, 1);
    assert.equal(tracker.pending.get("btc-market").priceToBeat, "77000");
    assert.match(tracker.lastError, /Pending market state recovery/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restores pending markets and records each official outcome once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "research-outcomes-"));
  const filePath = path.join(directory, "outcomes.jsonl");
  const pendingFilePath = path.join(directory, "pending.json");
  const endDate = "2026-08-22T00:15:00.000Z";
  const fetchMarket = async () => ({
    closed: true,
    umaResolutionStatus: "resolved",
    outcomes: ["Up", "Down"],
    outcomePrices: ["1", "0"]
  });

  try {
    const first = new MarketOutcomeTracker({ filePath, pendingFilePath, pollIntervalMs: 1, fetchMarket });
    assert.equal(first.observeMarket({ id: "1", slug: "btc-market", endDate }), true);
    assert.equal(first.observeMarket({ id: "1", slug: "btc-market", endDate }, { priceToBeat: "77000" }), true);
    assert.equal(first.observeMarket({ id: "1", slug: "btc-market", endDate }, { priceToBeat: "77000" }), false);
    const restored = new MarketOutcomeTracker({ filePath, pendingFilePath, pollIntervalMs: 1, fetchMarket });
    const settled = await restored.settlePending(Date.parse("2026-08-22T00:16:00Z"));
    assert.equal(settled.length, 1);
    assert.equal(settled[0].outcome.winner, "UP");
    assert.equal((await restored.settlePending(Date.parse("2026-08-22T00:17:00Z"))).length, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(pendingFilePath, "utf8")), []);
    const outcomePath = dailyJsonlPath(filePath, Date.parse("2026-08-22T00:16:00Z"));
    assert.equal(readJsonlFiles([outcomePath]).events.length, 1);
    fs.writeFileSync(pendingFilePath, `${JSON.stringify([{ id: "1", slug: "btc-market", endDate }])}\n`);
    const stalePending = new MarketOutcomeTracker({ filePath, pendingFilePath, pollIntervalMs: 1, fetchMarket });
    assert.equal(stalePending.observeMarket({ id: "1", slug: "btc-market", endDate }), false);
    assert.equal((await stalePending.settlePending(Date.parse("2026-08-22T00:18:00Z"))).length, 0);
    assert.equal(readJsonlFiles([outcomePath]).events.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("does not overlap background outcome settlement polls", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "research-concurrency-"));
  const pendingFilePath = path.join(directory, "pending.json");
  let releaseFetch;
  const fetchMarket = () => new Promise((resolve) => {
    releaseFetch = () => resolve(null);
  });

  try {
    const tracker = new MarketOutcomeTracker({
      filePath: path.join(directory, "outcomes.jsonl"),
      pendingFilePath,
      pollIntervalMs: 1,
      fetchTimeoutMs: 1_000,
      fetchMarket
    });
    tracker.observeMarket({ slug: "btc-market", endDate: "2026-08-22T00:15:00.000Z" });
    const firstPoll = tracker.settlePending(Date.parse("2026-08-22T00:16:00Z"));
    await Promise.resolve();
    assert.deepEqual(await tracker.settlePending(Date.parse("2026-08-22T00:17:00Z")), []);
    releaseFetch();
    assert.deepEqual(await firstPoll, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("resolves commits from worktree-style git directories and packed refs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-git-"));
  const gitDirectory = path.join(directory, "git-data");
  const checkout = path.join(directory, "checkout");
  fs.mkdirSync(gitDirectory);
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, ".git"), "gitdir: ../git-data\n");
  fs.writeFileSync(path.join(gitDirectory, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(gitDirectory, "packed-refs"), "1234567890abcdef refs/heads/main\n");

  try {
    assert.equal(resolveCodeCommit(checkout), "1234567890abcdef");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("atomically replaces files without leaving temporary artifacts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
  const filePath = path.join(directory, "ledger.csv");

  try {
    atomicWriteFileSync(filePath, "first\n");
    atomicWriteFileSync(filePath, "second\n");
    assert.equal(fs.readFileSync(filePath, "utf8"), "second\n");
    assert.deepEqual(fs.readdirSync(directory), ["ledger.csv"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});