import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatE18 } from "../src/data/polymarketTwapWs.js";
import { ReferencePriceGate } from "../src/referencePrice.js";

const START_MS = Date.parse("2026-08-21T13:00:00.000Z");
const PRICE_E18 = "115234567890000000000000";

function market(overrides = {}) {
  return {
    id: "market-1",
    slug: "btc-updown-15m-test",
    eventStartTime: new Date(START_MS).toISOString(),
    endDate: new Date(START_MS + 15 * 60_000).toISOString(),
    cryptoMarketConfig: {
      asset: "btc",
      duration: "15m",
      twapEnabled: true,
      twapLookbackSeconds: 60
    },
    ...overrides
  };
}

function sample(observedAtMs = START_MS) {
  return {
    symbol: "btc/usd",
    windowSeconds: 60,
    observedAtMs,
    priceE18: PRICE_E18,
    priceDecimal: "115234.56789",
    source: "polymarket_rtds_chainlink_twap"
  };
}

function fakeStream({ at = null, last = null, connected = true } = {}) {
  return {
    getAt(timestamp) {
      return at?.observedAtMs === timestamp ? at : null;
    },
    getLast() {
      return last;
    },
    isConnected() {
      return connected;
    }
  };
}

function createGate(stream, filePath = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-reference-"));
  return new ReferencePriceGate({
    stream,
    filePath: filePath ?? path.join(directory, "market_references.csv"),
    captureGraceMs: 5_000,
    freshnessMs: 5_000
  });
}

test("preserves full E18 precision for display", () => {
  assert.equal(formatE18(PRICE_E18), "115234.56789");
});

test("enters READY only with the exact market-start TWAP", () => {
  const startSample = sample();
  const stream = fakeStream({ at: startSample, last: sample(START_MS + 1_000) });
  const gate = createGate(stream);

  const state = gate.evaluate(market(), START_MS + 1_000);

  assert.equal(state.state, "READY");
  assert.equal(state.tradingAllowed, true);
  assert.equal(state.priceToBeatE18, PRICE_E18);
  assert.equal(state.priceToBeat, "115234.56789");
  assert.equal(state.currentTwap, "115234.56789");
});

test("recovers a missed window when the exact start sample arrives late", () => {
  let startSample = null;
  const stream = {
    getAt(timestamp) {
      return startSample?.observedAtMs === timestamp ? startSample : null;
    },
    getLast() {
      return sample(START_MS + 6_000);
    },
    isConnected() {
      return true;
    }
  };
  const gate = createGate(stream);

  const state = gate.evaluate(market(), START_MS + 6_000);
  startSample = sample();
  const laterState = gate.evaluate(market(), START_MS + 7_000);

  assert.equal(state.state, "MISSED_WINDOW");
  assert.equal(state.reason, "start_twap_not_captured");
  assert.equal(state.tradingAllowed, false);
  assert.equal(laterState.state, "READY");
  assert.equal(laterState.tradingAllowed, true);
  assert.equal(laterState.priceToBeatE18, PRICE_E18);
});

test("keeps the window missed when only an approximate start sample arrives", () => {
  let approximateSample = null;
  const stream = {
    getAt(timestamp) {
      return approximateSample?.observedAtMs === timestamp ? approximateSample : null;
    },
    getLast() {
      return approximateSample ?? sample(START_MS + 6_000);
    },
    isConnected() {
      return true;
    }
  };
  const gate = createGate(stream);

  assert.equal(gate.evaluate(market(), START_MS + 6_000).state, "MISSED_WINDOW");
  approximateSample = sample(START_MS + 1);
  const laterState = gate.evaluate(market(), START_MS + 7_000);

  assert.equal(laterState.state, "MISSED_WINDOW");
  assert.equal(laterState.tradingAllowed, false);
});

test("moves to DEGRADED when a validated stream disconnects", () => {
  const startSample = sample();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-reference-"));
  const filePath = path.join(directory, "market_references.csv");
  const first = createGate(fakeStream({ at: startSample, last: startSample }), filePath);
  assert.equal(first.evaluate(market(), START_MS + 1_000).state, "READY");

  const restarted = createGate(fakeStream({ last: sample(START_MS + 2_000), connected: false }), filePath);
  const state = restarted.evaluate(market(), START_MS + 2_000);

  assert.equal(state.state, "DEGRADED");
  assert.equal(state.reason, "twap_stream_disconnected");
  assert.equal(state.tradingAllowed, false);
});

test("restores a validated reference after restart", () => {
  const startSample = sample();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-reference-"));
  const filePath = path.join(directory, "market_references.csv");
  const first = createGate(fakeStream({ at: startSample, last: startSample }), filePath);
  first.evaluate(market(), START_MS + 1_000);

  const restarted = createGate(fakeStream({ last: sample(START_MS + 2_000) }), filePath);
  const state = restarted.evaluate(market(), START_MS + 2_000);

  assert.equal(state.state, "READY");
  assert.equal(state.priceToBeatE18, PRICE_E18);
  assert.equal(state.tradingAllowed, true);
});
