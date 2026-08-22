import assert from "node:assert/strict";
import test from "node:test";

import { buildStrategyMarketContext } from "../src/strategyRuntime/contextBuilder.js";

test("builds observation-only data quality and source timing diagnostics", () => {
  const context = buildStrategyMarketContext({
    nowMs: 20_000,
    pollStartedAtMs: 19_750,
    remainingMinutes: 8,
    windowMinutes: 15,
    market: { id: "1", slug: "btc-market", endDate: "2026-08-22T00:15:00Z" },
    marketPrices: { up: 0.45, down: 0.54 },
    orderBooks: {
      up: { bestAsk: 0.46, asks: [{ price: 0.46, size: 10 }] },
      down: { bestAsk: 0.55, asks: [{ price: 0.55, size: 10 }] }
    },
    indicators: { price: 77_000 },
    latestKline: { openTime: 0, closeTime: 20_999 },
    binanceWsAtMs: 19_900,
    polymarketCurrentAtMs: 19_800,
    chainlinkAtMs: 19_700,
    twapObservedAtMs: 19_600,
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
  const context = buildStrategyMarketContext({
    nowMs: 20_000,
    pollStartedAtMs: 19_900,
    remainingMinutes: 8,
    windowMinutes: 15,
    market: { slug: "btc-market", endDate: "2026-08-22T00:15:00Z" },
    marketPrices: { up: 0.45, down: 0.54 },
    orderBooks: { up: { bestAsk: 0.46 }, down: { bestAsk: 0.55 } },
    indicators: {},
    latestKline: { closeTime: 19_999 },
    binanceWsAtMs: 19_900,
    polymarketCurrentAtMs: 19_800,
    twapObservedAtMs: 19_700
  });

  assert.equal(context.dataQuality.valid, true);
  assert.deepEqual(context.dataQuality.reasons, []);
  assert.equal(context.dataQuality.limitations.length, 3);
});