import assert from "node:assert/strict";
import test from "node:test";

import { computeEdge, decide } from "../src/engines/edge.js";
import { applyTimeAwareness, scoreDirection } from "../src/engines/probability.js";
import { strategyKey } from "../src/strategies/contract.js";
import { listStrategyPlugins, resolveStrategyPlugin } from "../src/strategies/registry.js";

const context = {
  remainingMinutes: 8,
  windowMinutes: 15,
  marketPrices: { up: 0.42, down: 0.57 },
  indicators: {
    price: 77_500,
    vwap: 77_400,
    vwapSlope: 4,
    rsi: 61,
    rsiSlope: 1.2,
    macd: { hist: 8, histDelta: 2, macd: 12 },
    heikenColor: "green",
    heikenCount: 3,
    failedVwapReclaim: false
  }
};

test("registers and resolves the legacy TA Edge strategy aliases", () => {
  const [plugin] = listStrategyPlugins();
  assert.equal(strategyKey(plugin), "ta-edge@1.2.0");
  assert.equal(resolveStrategyPlugin("TA_EDGE_V1_2_FOK"), plugin);
  assert.equal(resolveStrategyPlugin("ta-edge"), plugin);
  assert.equal(resolveStrategyPlugin("ta-edge@1.2.0"), plugin);
  assert.throws(() => resolveStrategyPlugin("unknown"), /Unknown strategy/);
});

test("TA Edge V1.2 plugin preserves the legacy decision pipeline", () => {
  const plugin = resolveStrategyPlugin("TA_EDGE_V1_2_FOK");
  const scored = scoreDirection(context.indicators);
  const timeAware = applyTimeAwareness(scored.rawUp, context.remainingMinutes, context.windowMinutes);
  const edge = computeEdge({
    modelUp: timeAware.adjustedUp,
    modelDown: timeAware.adjustedDown,
    marketYes: context.marketPrices.up,
    marketNo: context.marketPrices.down
  });
  const recommendation = decide({
    remainingMinutes: context.remainingMinutes,
    edgeUp: edge.edgeUp,
    edgeDown: edge.edgeDown,
    modelUp: timeAware.adjustedUp,
    modelDown: timeAware.adjustedDown
  });

  assert.deepEqual(plugin.evaluate(context), { scored, timeAware, edge, recommendation });
});