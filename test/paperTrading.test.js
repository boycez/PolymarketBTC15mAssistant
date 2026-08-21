import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getResolvedWinner, PaperTrader } from "../src/paperTrading.js";

function createTrader(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-paper-"));
  return new PaperTrader({
    confirmationSeconds: 15,
    stakeUsd: 10,
    settlementPollMs: 0,
    filePath: path.join(directory, "paper_trades.csv"),
    ...overrides
  });
}

function market(overrides = {}) {
  return {
    id: "123",
    slug: "btc-up-or-down-15m-test",
    endDate: "2026-08-21T10:15:00.000Z",
    ...overrides
  };
}

const enterUp = { action: "ENTER", side: "UP", phase: "MID", strength: "GOOD" };
const noTrade = { action: "NO_TRADE", side: null, phase: "MID" };

test("records one paper trade after a stable signal", () => {
  const trader = createTrader();
  const input = {
    market: market(),
    recommendation: enterUp,
    entryPrices: { up: 0.4, down: 0.6 },
    modelUp: 0.65,
    modelDown: 0.35
  };

  trader.observe({ ...input, nowMs: 0 });
  trader.observe({ ...input, nowMs: 14_999 });
  assert.equal(trader.trades.length, 0);

  trader.observe({ ...input, nowMs: 15_000 });
  trader.observe({ ...input, nowMs: 16_000 });

  assert.equal(trader.trades.length, 1);
  assert.equal(trader.trades[0].side, "UP");
  assert.equal(trader.trades[0].entry_price, 0.4);
  assert.equal(trader.trades[0].shares, 25);
  assert.equal(trader.trades[0].status, "PENDING");
});

test("resets confirmation when the recommendation disappears", () => {
  const trader = createTrader();
  const base = {
    market: market(),
    entryPrices: { up: 0.4, down: 0.6 },
    modelUp: 0.65,
    modelDown: 0.35
  };

  trader.observe({ ...base, recommendation: enterUp, nowMs: 0 });
  trader.observe({ ...base, recommendation: noTrade, nowMs: 10_000 });
  trader.observe({ ...base, recommendation: enterUp, nowMs: 11_000 });
  trader.observe({ ...base, recommendation: enterUp, nowMs: 25_999 });
  assert.equal(trader.trades.length, 0);

  trader.observe({ ...base, recommendation: enterUp, nowMs: 26_000 });
  assert.equal(trader.trades.length, 1);
});

test("settles a winning trade from the official resolved outcome", async () => {
  const trader = createTrader({
    fetchMarket: async () => ({
      closed: true,
      umaResolutionStatus: "resolved",
      outcomes: '["Up", "Down"]',
      outcomePrices: '["1", "0"]'
    })
  });
  const input = {
    market: market({ endDate: "1970-01-01T00:00:10.000Z" }),
    recommendation: enterUp,
    entryPrices: { up: 0.4, down: 0.6 },
    modelUp: 0.65,
    modelDown: 0.35
  };

  trader.observe({ ...input, nowMs: 0 });
  trader.observe({ ...input, nowMs: 15_000 });
  const settled = await trader.settlePending(20_000);

  assert.equal(settled.length, 1);
  assert.equal(trader.trades[0].winner, "UP");
  assert.equal(trader.trades[0].payout, 25);
  assert.equal(trader.trades[0].pnl, 15);
  assert.equal(trader.trades[0].status, "SETTLED");
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