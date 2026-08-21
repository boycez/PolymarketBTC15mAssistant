export const CONFIG = {
  symbol: "BTCUSDT",
  binanceBaseUrl: "https://api.binance.com",
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  pollIntervalMs: 1_000,
  candleWindowMinutes: 15,

  vwapSlopeLookbackMinutes: 5,
  rsiPeriod: 14,
  rsiMaPeriod: 14,

  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  paperTrading: {
    enabled: (process.env.PAPER_TRADING_ENABLED || "true").toLowerCase() === "true",
    strategy: process.env.PAPER_TRADE_STRATEGY || "TA_EDGE_V1_2_FOK",
    confirmationSeconds: Number(process.env.PAPER_TRADE_CONFIRMATION_SECONDS || 30),
    minRemainingMinutes: Number(process.env.PAPER_TRADE_MIN_REMAINING_MINUTES || 5),
    maxRemainingMinutes: Number(process.env.PAPER_TRADE_MAX_REMAINING_MINUTES || 10),
    minExecutionEdge: Number(process.env.PAPER_TRADE_MIN_EXECUTION_EDGE || 0.1),
    maxSlippage: Number(process.env.PAPER_TRADE_MAX_SLIPPAGE || 0.02),
    requireTrendAlignment: (process.env.PAPER_TRADE_REQUIRE_TREND_ALIGNMENT || "true").toLowerCase() === "true",
    stakeUsd: Number(process.env.PAPER_TRADE_STAKE_USD || 10),
    settlementPollMs: Number(process.env.PAPER_TRADE_SETTLEMENT_POLL_MS || 30_000),
    filePath: process.env.PAPER_TRADE_FILE || "./logs/paper_trades.csv"
  },

  referenceData: {
    filePath: process.env.MARKET_REFERENCE_FILE || "./logs/market_references.csv",
    captureGraceMs: Number(process.env.TWAP_CAPTURE_GRACE_MS || 5_000),
    freshnessMs: Number(process.env.TWAP_FRESHNESS_MS || 5_000)
  },

  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "",
    seriesId: process.env.POLYMARKET_SERIES_ID || "10192",
    seriesSlug: process.env.POLYMARKET_SERIES_SLUG || "btc-up-or-down-15m",
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true",
    dumpMarketSnapshots: (process.env.POLYMARKET_DUMP_MARKET_SNAPSHOTS || "false").toLowerCase() === "true",
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com",
    upOutcomeLabel: process.env.POLYMARKET_UP_LABEL || "Up",
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down"
  },

  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl: process.env.POLYGON_WSS_URL || "",
    btcUsdAggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  }
};
