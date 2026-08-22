import assert from "node:assert/strict";
import test from "node:test";

import { buildStrategyMarketContext, normalizeEpochMs } from "../src/strategyRuntime/contextBuilder.js";

test("normalizes second, millisecond, microsecond, and nanosecond epochs", () => {
  assert.equal(normalizeEpochMs(1_787_392_237), 1_787_392_237_000);
  assert.equal(normalizeEpochMs(1_787_392_237_000), 1_787_392_237_000);
  assert.equal(normalizeEpochMs(1_787_392_237_000_000), 1_787_392_237_000);
  assert.equal(normalizeEpochMs(1_787_392_237_000_000_000), 1_787_392_237_000);
});

test("builds observation-only data quality and source timing diagnostics", () => {
  const nowMs = 1_787_392_239_000;
  const context = buildStrategyMarketContext({
    nowMs,
    pollStartedAtMs: nowMs - 250,
    remainingMinutes: 8,
    windowMinutes: 15,
    market: { id: "1", slug: "btc-market", endDate: "2026-08-22T00:15:00Z" },
    marketPrices: { up: 0.45, down: 0.54 },
    orderBooks: {
      up: { bestAsk: 0.46, asks: [{ price: 0.46, size: 10 }] },
      down: { bestAsk: 0.55, asks: [{ price: 0.55, size: 10 }] }
    },
    indicators: { price: 77_000 },
    latestKline: { openTime: nowMs - 60_000, closeTime: nowMs + 999 },
    binanceWsAtMs: nowMs - 100,
    polymarketCurrentAtMs: nowMs - 200,
    chainlinkAtMs: nowMs - 300,
    twapObservedAtMs: nowMs - 400,
    twapFreshnessMs: 400,
    streamHealth: { summary: { healthy: 4 } }
  });

  assert.equal(context.strategy.indicators.price, 77_000);
  assert.equal(context.sources.pollLatencyMs, 250);
  assert.equal(context.sources.binanceWsAgeMs, 100);
  assert.equal(context.sources.sourceTimestampRangeMs, 300);
  assert.equal(context.sources.timestampSemantics, "mixed_source_and_receive");
  assert.equal(context.sources.latestKlineClosed, false);
  assert.equal(context.dataQuality.observationOnly, true);
  assert.deepEqual(context.dataQuality.reasons, ["unfinished_kline"]);
  assert.deepEqual(context.dataQuality.limitations, [
    "binance_ticker_timestamp_unavailable",
    "market_quote_timestamp_unavailable",
    "order_book_timestamp_unavailable"
  ]);
  assert.deepEqual(context.market.orderBooks.up.asks, [{ price: 0.46, size: 10 }]);
});

test("reports valid observed data separately from API timestamp limitations", () => {
  const nowMs = 1_787_392_239_000;
  const context = buildStrategyMarketContext({
    nowMs,
    pollStartedAtMs: nowMs - 100,
    remainingMinutes: 8,
    windowMinutes: 15,
    market: { slug: "btc-market", endDate: "2026-08-22T00:15:00Z" },
    marketPrices: { up: 0.45, down: 0.54 },
    orderBooks: { up: { bestAsk: 0.46 }, down: { bestAsk: 0.55 } },
    indicators: {},
    latestKline: { closeTime: nowMs - 1 },
    binanceWsAtMs: nowMs - 100,
    polymarketCurrentAtMs: nowMs - 200,
    twapObservedAtMs: nowMs - 300
  });

  assert.equal(context.dataQuality.valid, true);
  assert.deepEqual(context.dataQuality.reasons, []);
  assert.equal(context.dataQuality.limitations.length, 3);
});

test("normalizes Polymarket microsecond timestamps before age and range calculations", () => {
  const nowMs = 1_787_392_239_157;
  const context = buildStrategyMarketContext({
    nowMs,
    pollStartedAtMs: nowMs - 200,
    remainingMinutes: 8,
    windowMinutes: 15,
    market: { slug: "btc-market", endDate: "2026-08-22T00:15:00Z" },
    marketPrices: { up: 0.45, down: 0.54 },
    orderBooks: { up: { bestAsk: 0.46 }, down: { bestAsk: 0.55 } },
    indicators: {},
    latestKline: { closeTime: nowMs - 1 },
    binanceWsAtMs: 1_787_392_238_409,
    polymarketCurrentAtMs: 1_787_392_237_000_000,
    chainlinkAtMs: 1_787_392_237_000_000,
    twapObservedAtMs: 1_787_392_237_000
  });

  assert.equal(context.sources.polymarketCurrentAtMs, 1_787_392_237_000);
  assert.equal(context.sources.polymarketCurrentAgeMs, 2_157);
  assert.equal(context.sources.sourceTimestampRangeMs, 1_409);
});