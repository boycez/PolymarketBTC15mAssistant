import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeSnapshot } from "../src/dashboard/runtimeSnapshot.js";
import { renderTerminalDashboard, stripAnsi } from "../src/dashboard/terminalRenderer.js";

function paperSnapshot() {
  return createRuntimeSnapshot({
    generatedAtMs: Date.parse("2026-08-22T04:08:13.000Z"),
    market: {
      title: "Bitcoin Up or Down",
      slug: "btc-updown-15m-test",
      timeLeftMinutes: 8.25,
      polymarketUp: 0.42,
      polymarketDown: 0.58,
      liquidityUsd: 12345,
      priceToBeatUsd: 100000,
      currentPriceUsd: 100025,
      previousCurrentPriceUsd: 100020,
      binancePriceUsd: 100030,
      previousBinancePriceUsd: 100028
    },
    signal: {
      modelUp: 0.64,
      modelDown: 0.36,
      heikenColor: "green",
      heikenCount: 3,
      rsi: 61.2,
      rsiSlope: 0.4,
      macdLabel: "bullish (expanding)",
      macdHistogram: 2.5,
      delta1m: 5,
      delta3m: 15,
      deltaBase: 100025,
      vwap: 100010,
      vwapDistance: 0.00015,
      vwapSlopeLabel: "UP",
      regime: "TREND_UP",
      recommendation: "BUY UP: MID GOOD"
    },
    readiness: {
      state: "READY",
      tradingAllowed: true,
      freshnessMs: 2400,
      reason: "validated",
      observedAtMs: Date.parse("2026-08-22T04:08:11.000Z"),
      source: "Chainlink BTC/USD TWAP 60s"
    },
    trading: {
      mode: "paper",
      strategy: { key: "ta-edge@1.2.0", configFingerprint: "a1b2c3d4e5f60708" },
      sectionTitle: "Paper Trading",
      status: { state: "WAITING", text: "waiting: quoted edge below 10.0%" },
      control: { state: "UNAVAILABLE", text: "Unavailable" },
      summary: {
        total_trades: 9,
        settled_trades: 9,
        pending_trades: 0,
        wins: 4,
        losses: 5,
        win_rate_pct: 44.4,
        realized_pnl_usd: 3.05,
        realized_return_pct: 3.4,
        pending_stake_usd: 0
      }
    },
    session: {}
  });
}

test("renders a deterministic Paper dashboard from a runtime snapshot", () => {
  const output = stripAnsi(renderTerminalDashboard(paperSnapshot(), { width: 60 }));

  assert.match(output, /MARKET SNAPSHOT/);
  assert.match(output, /Time Left:\s+08:15/);
  assert.match(output, /SIGNAL ANALYSIS/);
  assert.match(output, /Recommendation:\s+BUY UP: MID GOOD/);
  assert.match(output, /Reference State:\s+READY/);
  assert.match(output, /PAPER TRADING/);
  assert.match(output, /Strategy:\s+ta-edge@1\.2\.0 \| a1b2c3d4e5f60708/);
  assert.match(output, /Status:\s+waiting: quoted edge below 10\.0%/);
  assert.match(output, /Record:\s+4W \/ 5L \| 44\.4%/);
  assert.match(output, /ET \| Session:\s+00:08:13 \| Asia/);
  assert.equal(output.split("\n").find((line) => /^─+$/.test(line))?.length, 60);
});

test("renders Live account and pending confirmation details", () => {
  const base = paperSnapshot();
  const output = stripAnsi(renderTerminalDashboard({
    ...base,
    trading: {
      ...base.trading,
      mode: "live",
      sectionTitle: "Live Trading",
      account: {
        wallet: "0x2222222222222222222222222222222222222222",
        balanceUsd: 42.18,
        allowanceStatus: "Ready",
        authorizationStatus: "Verified",
        walletType: "DEPOSIT_WALLET"
      },
      control: { state: "PENDING_CONFIRMATION", text: "Confirm with Enter" },
      controlHelp: "Enter confirm | Esc cancel | S stop",
      pendingConfirmation: { stakeUsd: 5, maxTradesPerSession: 1, maxSlippage: 0.02 }
    }
  }));

  assert.match(output, /System Gate:/);
  assert.match(output, /Trading Wallet:\s+0x2222\.\.\.2222/);
  assert.match(output, /Available:\s+\$42\.18 USDC/);
  assert.match(output, /Authorization:\s+Verified/);
  assert.match(output, /Stake:\s+\$5\.00/);
  assert.match(output, /Session Limit:\s+1 trade/);
});

test("renders detached Engine link state and snapshot age", () => {
  const base = paperSnapshot();
  const output = stripAnsi(renderTerminalDashboard({
    ...base,
    session: {
      engineConnection: "DISCONNECTED",
      snapshotAgeMs: 12_400,
      streamHealth: { summary: { healthy: 2, reconnecting: 1, stale: 1, disabled: 0 } }
    }
  }));

  assert.match(output, /Engine Link:\s+DISCONNECTED \| snapshot 12\.4s old/);
  assert.match(output, /Data Streams:\s+2 healthy \| 1 reconnecting \| 1 stale \| 0 disabled/);
});
