import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTradingRuntime } from "../src/trading/createTradingRuntime.js";
import { buildSecureClientOptions } from "../src/liveTrading.js";

test("builds SDK authentication with the existing Polymarket trading wallet", async () => {
  const walletAddress = `0x${"2".repeat(40)}`;
  const options = await buildSecureClientOptions({
    privateKey: `0x${"1".repeat(64)}`,
    relayerApiKey: "relayer-key",
    walletAddress
  });

  const signerAddress = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
  const relayerHeaders = new Headers(await options.apiKey.authorize({}));
  assert.equal(await options.signer.getAddress(), signerAddress);
  assert.equal(relayerHeaders.get("RELAYER_API_KEY"), "relayer-key");
  assert.equal(relayerHeaders.get("RELAYER_API_KEY_ADDRESS"), signerAddress);
  assert.equal(options.wallet, walletAddress);
});

test("creates a paper runtime with the shared trading contract", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-runtime-"));
  const filePath = path.join(directory, "paper_trades.csv");
  const runtime = await createTradingRuntime({
    mode: "paper",
    paperConfig: { filePath }
  });

  assert.equal(runtime.mode, "paper");
  assert.equal(runtime.sectionTitle, "Paper Trading");
  assert.equal(runtime.logFilePath, filePath);
  assert.equal(typeof runtime.observe, "function");
  assert.equal(typeof runtime.settlePending, "function");
  assert.equal(typeof runtime.getStatus, "function");
  assert.equal(typeof runtime.getSummary, "function");
});

test("creates a disabled live runtime without initializing an authenticated client", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-live-"));
  const filePath = path.join(directory, "live_trades.csv");

  const runtime = await createTradingRuntime({
    mode: "live",
    liveConfig: { enabled: false, filePath }
  });

  assert.equal(runtime.mode, "live");
  assert.equal(runtime.sectionTitle, "Live Trading");
  assert.deepEqual(await runtime.observe({}), {
    state: "BLOCKED",
    text: "blocked: LIVE_TRADING_ENABLED is false"
  });
  assert.equal(fs.existsSync(filePath), false);
});

test("fails closed when Polymarket geoblocks live trading", async () => {
  let authenticatedCalls = 0;
  const client = {
    async fetchClosedOnlyMode() {
      authenticatedCalls += 1;
      return false;
    }
  };

  await assert.rejects(
    createTradingRuntime({
      mode: "live",
      liveConfig: {
        enabled: true,
        client,
        checkGeoblock: async () => ({ blocked: true, country: "US" })
      }
    }),
    /Polymarket trading is blocked in this location \(US\)\./
  );
  assert.equal(authenticatedCalls, 0);
});

test("fails closed when collateral does not cover the live stake", async () => {
  const client = {};
  const actions = {
    async fetchClosedOnlyMode(receivedClient) {
      assert.equal(receivedClient, client);
      return false;
    },
    async fetchBalanceAllowance(receivedClient, request) {
      assert.equal(receivedClient, client);
      assert.deepEqual(request, { assetType: "COLLATERAL" });
      return { balance: "4999999", allowances: {} };
    }
  };

  await assert.rejects(
    createTradingRuntime({
      mode: "live",
      liveConfig: {
        enabled: true,
        client,
        actions,
        checkGeoblock: async () => ({ blocked: false }),
        stakeUsd: 5,
        maxStakeUsd: 5
      }
    }),
    /Insufficient Polymarket collateral balance for a \$5\.00 live stake\./
  );
});

test("requires manual confirmation before submitting one guarded FOK order", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-live-order-"));
  const filePath = path.join(directory, "live_trades.csv");
  const requests = [];
  let cancelAllCalls = 0;
  const client = {
    account: {
      signer: "0x1111111111111111111111111111111111111111",
      wallet: "0x2222222222222222222222222222222222222222",
      walletType: "DEPOSIT_WALLET"
    }
  };
  const actions = {
    async fetchClosedOnlyMode(receivedClient) {
      assert.equal(receivedClient, client);
      return false;
    },
    async fetchBalanceAllowance(receivedClient, request) {
      assert.equal(receivedClient, client);
      assert.deepEqual(request, { assetType: "COLLATERAL" });
      return { balance: "5000000", allowances: {} };
    },
    async placeMarketOrder(receivedClient, request) {
      assert.equal(receivedClient, client);
      requests.push(request);
      return {
        ok: true,
        orderId: "order-1",
        status: "matched",
        makingAmount: "5",
        takingAmount: "12.5",
        tradeIds: ["trade-1"],
        transactionsHashes: []
      };
    },
    async cancelAll(receivedClient) {
      assert.equal(receivedClient, client);
      cancelAllCalls += 1;
      return { canceled: [] };
    }
  };
  const runtime = await createTradingRuntime({
    mode: "live",
    liveConfig: {
      enabled: true,
      client,
      actions,
      checkGeoblock: async () => ({ blocked: false }),
      filePath,
      confirmationSeconds: 0,
      stakeUsd: 5,
      maxStakeUsd: 5,
      maxTradesPerSession: 1
    }
  });
  const input = {
    market: {
      id: "market-1",
      slug: "btc-test",
      endDate: "2099-01-01T00:00:00.000Z",
      active: true,
      closed: false,
      acceptingOrders: true,
      enableOrderBook: true,
      feesEnabled: false
    },
    tokens: { upTokenId: "up-token", downTokenId: "down-token" },
    recommendation: { action: "ENTER", side: "UP" },
    orderBooks: {
      up: {
        bestAsk: 0.4,
        tickSize: 0.01,
        minOrderSize: 1,
        asks: [{ price: 0.4, size: 100 }]
      }
    },
    modelUp: 0.7,
    modelDown: 0.3,
    remainingMinutes: 7,
    regime: "TREND_UP",
    reference: { tradingAllowed: true, state: "READY" }
  };

  assert.equal(runtime.getControlState().state, "DISARMED");
  assert.deepEqual(runtime.getAccountIdentity(), client.account);
  assert.equal((await runtime.observe({ ...input, nowMs: 1_000 })).state, "DISARMED");
  assert.equal(requests.length, 0);
  assert.equal(runtime.requestArm(), true);
  assert.equal((await runtime.observe({ ...input, nowMs: 1_001 })).state, "PENDING_CONFIRMATION");
  assert.equal(requests.length, 0);
  assert.equal(runtime.confirmArm(), true);
  assert.equal(runtime.getControlState().state, "ARMED");
  assert.equal((await runtime.observe({ ...input, nowMs: 1_002 })).state, "CONFIRMING");
  assert.equal((await runtime.observe({ ...input, nowMs: 1_003 })).state, "AWAITING_SETTLEMENT");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    tokenId: "up-token",
    side: "BUY",
    amount: 5,
    maxSpend: 5,
    maxPrice: 0.42,
    orderType: "FOK"
  });
  assert.equal((await runtime.observe({ ...input, nowMs: 1_004 })).state, "AWAITING_SETTLEMENT");
  assert.equal(requests.length, 1);
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(await runtime.disarm(), true);
  assert.equal(cancelAllCalls, 1);
  assert.equal(runtime.getControlState().state, "DISARMED");
  assert.equal((await runtime.observe({ ...input, nowMs: 1_005 })).state, "DISARMED");
  assert.equal(requests.length, 1);
});
