import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DecisionResearchRecorder } from "../src/research/decisionRecorder.js";
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
    assert.equal(fs.readFileSync(filePath, "utf8").trim().split("\n").length, 4);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fails soft when research events cannot be written", () => {
  const recorder = new DecisionResearchRecorder({ filePath: "/dev/null/events.jsonl" });
  const recorded = recorder.record({ market: {}, strategy: {}, decision: {}, execution: {} });

  assert.equal(recorded, false);
  assert.match(recorder.lastError, /EEXIST|ENOTDIR|not a directory|file already exists/i);
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