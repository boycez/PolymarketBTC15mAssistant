import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRecommendationReason,
  resolvePaperStrategy,
  strategyGateCategory,
  TA_EDGE_V1_2_FOK
} from "../src/trading/strategy.js";

test("uses the default paper strategy settings", () => {
  assert.deepEqual(resolvePaperStrategy({}), TA_EDGE_V1_2_FOK);
});

test("reads all documented paper strategy environment overrides", () => {
  assert.deepEqual(resolvePaperStrategy({
    PAPER_TRADE_STRATEGY: "TA_EDGE_V1_2_FOK",
    PAPER_TRADE_CONFIRMATION_SECONDS: "12",
    PAPER_TRADE_MIN_REMAINING_MINUTES: "4",
    PAPER_TRADE_MAX_REMAINING_MINUTES: "11",
    PAPER_TRADE_MIN_EXECUTION_EDGE: "0.08",
    PAPER_TRADE_MAX_SLIPPAGE: "0.03",
    PAPER_TRADE_REQUIRE_TREND_ALIGNMENT: "false"
  }), {
    strategy: "TA_EDGE_V1_2_FOK",
    confirmationSeconds: 12,
    minRemainingMinutes: 4,
    maxRemainingMinutes: 11,
    minExecutionEdge: 0.08,
    maxSlippage: 0.03,
    requireTrendAlignment: false
  });
});

test("rejects malformed paper strategy environment overrides", () => {
  assert.throws(
    () => resolvePaperStrategy({ PAPER_TRADE_STRATEGY: "CUSTOM" }),
    /must be TA_EDGE_V1_2_FOK/
  );
  assert.throws(
    () => resolvePaperStrategy({ PAPER_TRADE_CONFIRMATION_SECONDS: "soon" }),
    /must be a finite number/
  );
  assert.throws(
    () => resolvePaperStrategy({ PAPER_TRADE_MIN_REMAINING_MINUTES: "10", PAPER_TRADE_MAX_REMAINING_MINUTES: "5" }),
    /valid non-negative window/
  );
  assert.throws(
    () => resolvePaperStrategy({ PAPER_TRADE_MIN_EXECUTION_EDGE: "1.1" }),
    /must be between 0 and 1/
  );
  assert.throws(
    () => resolvePaperStrategy({ PAPER_TRADE_REQUIRE_TREND_ALIGNMENT: "yes" }),
    /must be true or false/
  );
});

test("formats recommendation reasons and normalizes dynamic gate categories", () => {
  assert.equal(formatRecommendationReason("prob_below_0.6"), "model probability below 60.0%");
  assert.equal(formatRecommendationReason("edge_below_0.1"), "quoted edge below 10.0%");
  assert.equal(strategyGateCategory("outside entry window (12.0m remaining)"), "outside entry window");
  assert.equal(strategyGateCategory("execution edge 7.2% < 10.0%"), "execution edge below minimum");
});
