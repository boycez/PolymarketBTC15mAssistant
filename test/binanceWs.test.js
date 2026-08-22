import assert from "node:assert/strict";
import test from "node:test";

import { buildBinanceTradeStreamUrl } from "../src/data/binanceWs.js";

test("builds a Binance market-data-only trade stream URL", () => {
  assert.equal(
    buildBinanceTradeStreamUrl("BTCUSDT", "wss://data-stream.binance.vision"),
    "wss://data-stream.binance.vision/ws/btcusdt@trade"
  );
});