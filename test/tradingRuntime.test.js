import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTradingRuntime } from "../src/trading/createTradingRuntime.js";

test("creates a paper runtime with the shared trading contract", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-runtime-"));
  const filePath = path.join(directory, "paper_trades.csv");
  const runtime = createTradingRuntime({
    mode: "paper",
    paperConfig: { filePath }
  });

  assert.equal(runtime.mode, "paper");
  assert.equal(runtime.sectionTitle, "Paper Trading");
  assert.equal(runtime.logFilePath, filePath);
  assert.equal(typeof runtime.observe, "function");
  assert.equal(typeof runtime.settlePending, "function");
  assert.equal(typeof runtime.getStatus, "function");
  assert.equal(typeof runtime.getSummary, "function");
});

test("fails closed when live trading is selected", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-live-"));
  const filePath = path.join(directory, "live_trades.csv");

  assert.throws(
    () => createTradingRuntime({ mode: "live", liveConfig: { filePath } }),
    /Live trading is not implemented\. No orders were submitted\./
  );
  assert.equal(fs.existsSync(filePath), false);
});
