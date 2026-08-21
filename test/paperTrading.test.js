import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getResolvedWinner, PaperTrader, simulateFokBuy } from "../src/paperTrading.js";

function createTrader(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-paper-"));
  return new PaperTrader({
    confirmationSeconds: 15,
    stakeUsd: 10,
    settlementPollMs: 0,
    filePath: path.join(directory, "paper_trades.csv"),
    summaryFilePath: path.join(directory, "paper_summary.json"),
    ...overrides
  });
}

function readSummary(trader) {
  return JSON.parse(fs.readFileSync(trader.summaryFilePath, "utf8"));
}

function market(overrides = {}) {
  return {
    id: "123",
    slug: "btc-up-or-down-15m-test",
    endDate: "2026-08-21T10:15:00.000Z",
    active: true,
    closed: false,
    acceptingOrders: true,
    enableOrderBook: true,
    feesEnabled: false,
    orderMinSize: 5,
    orderPriceMinTickSize: 0.01,
    ...overrides
  };
}

function orderBook(bestAsk = 0.4, asks = [{ price: bestAsk, size: 100 }]) {
  return {
    bestAsk,
    asks,
    tickSize: 0.01,
    minOrderSize: 5
  };
}

function eligibleInput(overrides = {}) {
  return {
    market: market(),
    recommendation: enterUp,
    orderBooks: {
      up: orderBook(0.4),
      down: orderBook(0.6)
    },
    modelUp: 0.65,
    modelDown: 0.35,
    remainingMinutes: 8,
    regime: "TREND_UP",
    ...overrides
  };
}

const enterUp = { action: "ENTER", side: "UP", phase: "MID", strength: "GOOD" };
const noTrade = { action: "NO_TRADE", side: null, phase: "MID" };

test("records one paper trade after a stable signal", () => {
  const trader = createTrader();
  const input = eligibleInput();

  trader.observe({ ...input, nowMs: 0 });
  trader.observe({ ...input, nowMs: 14_999 });
  assert.equal(trader.trades.length, 0);

  trader.observe({ ...input, nowMs: 15_000 });
  trader.observe({ ...input, nowMs: 16_000 });

  assert.equal(trader.trades.length, 1);
  assert.equal(trader.trades[0].side, "UP");
  assert.equal(trader.trades[0].entry_price, 0.4);
  assert.equal(trader.trades[0].shares, 25);
  assert.equal(trader.trades[0].strategy, "TA_EDGE_V1_2_FOK");
  assert.equal(trader.trades[0].order_type, "FOK");
  assert.equal(trader.trades[0].fill_status, "FILLED");
  assert.equal(trader.trades[0].fee_usd, 0);
  assert.equal(trader.trades[0].worst_fill_price, 0.4);
  assert.equal(trader.trades[0].execution_edge, 0.25);
  assert.equal(trader.trades[0].time_left_minutes, 8);
  assert.equal(trader.trades[0].regime, "TREND_UP");
  assert.equal(trader.trades[0].status, "AWAITING_SETTLEMENT");

  const summary = readSummary(trader);
  assert.equal(summary.total_trades, 1);
  assert.equal(summary.pending_trades, 1);
  assert.equal(summary.pending_stake_usd, 10);
  assert.equal(summary.realized_pnl_usd, 0);
});

test("resets confirmation when the recommendation disappears", () => {
  const trader = createTrader();
  const base = eligibleInput();

  trader.observe({ ...base, recommendation: enterUp, nowMs: 0 });
  trader.observe({ ...base, recommendation: noTrade, nowMs: 10_000 });
  trader.observe({ ...base, recommendation: enterUp, nowMs: 11_000 });
  trader.observe({ ...base, recommendation: enterUp, nowMs: 25_999 });
  assert.equal(trader.trades.length, 0);

  trader.observe({ ...base, recommendation: enterUp, nowMs: 26_000 });
  assert.equal(trader.trades.length, 1);
});

test("does not trade during the early phase", () => {
  const trader = createTrader();
  const input = eligibleInput({
    recommendation: { ...enterUp, phase: "EARLY" },
    remainingMinutes: 12
  });

  trader.observe({ ...input, nowMs: 0 });
  trader.observe({ ...input, nowMs: 60_000 });

  assert.equal(trader.trades.length, 0);
  assert.equal(trader.candidate, null);
});

test("does not trade against the detected trend", () => {
  const trader = createTrader();
  const input = eligibleInput({ regime: "TREND_DOWN" });

  trader.observe({ ...input, nowMs: 0 });
  trader.observe({ ...input, nowMs: 60_000 });

  assert.equal(trader.trades.length, 0);
  assert.equal(trader.candidate, null);
});

test("rechecks edge against the executable entry price", () => {
  const trader = createTrader();
  const input = eligibleInput({
    orderBooks: {
      up: orderBook(0.6),
      down: orderBook(0.4)
    },
    modelUp: 0.65
  });

  trader.observe({ ...input, nowMs: 0 });
  trader.observe({ ...input, nowMs: 15_000 });

  assert.equal(trader.trades.length, 0);
  assert.equal(trader.candidate, null);
});

test("walks multiple ask levels and records slippage", () => {
  const fill = simulateFokBuy({
    asks: [
      { price: 0.4, size: 5 },
      { price: 0.41, size: 50 }
    ],
    stakeUsd: 10,
    maxPrice: 0.42,
    minOrderSize: 5
  });

  assert.equal(fill.filled, true);
  assert.equal(fill.worstFillPrice, 0.41);
  assert.ok(fill.averagePrice > 0.4);
  assert.ok(fill.totalCost <= 10);
  assert.ok(fill.leftoverBudget < 0.01);
});

test("includes the official dynamic taker fee", () => {
  const fill = simulateFokBuy({
    asks: [{ price: 0.5, size: 100 }],
    stakeUsd: 10,
    maxPrice: 0.5,
    minOrderSize: 5,
    feesEnabled: true,
    feeSchedule: { rate: 0.07, exponent: 1, takerOnly: true }
  });

  assert.equal(fill.filled, true);
  assert.equal(fill.shares, 19.32);
  assert.equal(fill.notional, 9.66);
  assert.equal(fill.fee, 0.3381);
  assert.equal(fill.totalCost, 9.9981);
});

test("rejects an FOK simulation when book depth is insufficient", () => {
  const fill = simulateFokBuy({
    asks: [{ price: 0.4, size: 1 }],
    stakeUsd: 10,
    maxPrice: 0.42,
    minOrderSize: 5
  });

  assert.equal(fill.filled, false);
  assert.equal(fill.reason, "insufficient_depth");
});

test("settles a winning trade from the official resolved outcome", async () => {
  let fetchedTrade = null;
  const trader = createTrader({
    fetchMarket: async (trade) => {
      fetchedTrade = trade;
      return {
        closed: true,
        umaResolutionStatus: "resolved",
        outcomes: '["Up", "Down"]',
        outcomePrices: '["1", "0"]'
      };
    }
  });
  const input = eligibleInput({
    market: market({ endDate: "1970-01-01T00:00:10.000Z" })
  });

  trader.observe({ ...input, nowMs: 0 });
  trader.observe({ ...input, nowMs: 15_000 });
  const settled = await trader.settlePending(20_000);

  assert.equal(settled.length, 1);
  assert.equal(fetchedTrade.market_id, "123");
  assert.equal(fetchedTrade.market_slug, "btc-up-or-down-15m-test");
  assert.equal(trader.trades[0].winner, "UP");
  assert.equal(trader.trades[0].payout, 25);
  assert.equal(trader.trades[0].pnl, 15);
  assert.equal(trader.trades[0].status, "SETTLED");

  const summary = readSummary(trader);
  assert.equal(summary.settled_trades, 1);
  assert.equal(summary.pending_trades, 0);
  assert.equal(summary.wins, 1);
  assert.equal(summary.win_rate_pct, 100);
  assert.equal(summary.settled_payout_usd, 25);
  assert.equal(summary.realized_pnl_usd, 15);
  assert.equal(summary.pending_stake_usd, 0);
});

test("does not infer a winner before official resolution", () => {
  assert.equal(getResolvedWinner({
    closed: false,
    outcomes: '["Up", "Down"]',
    outcomePrices: '["1", "0"]'
  }), null);

  assert.equal(getResolvedWinner({
    closed: true,
    umaResolutionStatus: "proposed",
    outcomes: '["Up", "Down"]',
    outcomePrices: '["1", "0"]'
  }), null);
});