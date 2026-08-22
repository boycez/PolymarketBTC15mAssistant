import assert from "node:assert/strict";
import test from "node:test";

import { quoteBothOutcomes, quoteOutcomeExecution } from "../src/execution/quoteExecution.js";

test("quotes fee-adjusted executable cost and edge without changing fill math", () => {
  const quote = quoteOutcomeExecution({
    orderBook: { bestAsk: 0.4, tickSize: 0.01, minOrderSize: 1, asks: [{ price: 0.4, size: 100 }] },
    market: { feesEnabled: false },
    stakeUsd: 10,
    maxSlippage: 0.02,
    modelProbability: 0.6
  });

  assert.equal(quote.fill.filled, true);
  assert.equal(quote.allInPrice, 0.4);
  assert.ok(Math.abs(quote.executionEdge - 0.2) < 1e-12);
  assert.equal(quote.slippage, 0);
});

test("quotes both outcomes independently for counterfactual research", () => {
  const quotes = quoteBothOutcomes({
    orderBooks: {
      up: { bestAsk: 0.4, asks: [{ price: 0.4, size: 100 }] },
      down: { bestAsk: 0.6, asks: [{ price: 0.6, size: 100 }] }
    },
    market: { feesEnabled: false },
    stakeUsd: 10,
    maxSlippage: 0.02,
    modelUp: 0.55,
    modelDown: 0.45
  });

  assert.equal(quotes.up.fill.filled, true);
  assert.equal(quotes.down.fill.filled, true);
  assert.ok(quotes.up.executionEdge > 0);
  assert.ok(quotes.down.executionEdge < 0);
});