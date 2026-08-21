import assert from "node:assert/strict";
import test from "node:test";

import { resolveTradingMode } from "../src/trading/mode.js";

test("defaults trading mode to paper", () => {
  assert.equal(resolveTradingMode({ argv: [], env: {} }), "paper");
});

test("reads trading mode from the environment", () => {
  assert.equal(resolveTradingMode({ argv: [], env: { TRADING_MODE: "live" } }), "live");
});

test("CLI trading mode overrides the environment", () => {
  assert.equal(resolveTradingMode({ argv: ["--mode=paper"], env: { TRADING_MODE: "live" } }), "paper");
  assert.equal(resolveTradingMode({ argv: ["--mode", "live"], env: {} }), "live");
});

test("rejects an unsupported trading mode", () => {
  assert.throws(
    () => resolveTradingMode({ argv: ["--mode=test"], env: {} }),
    /Expected "paper" or "live"/
  );
});
