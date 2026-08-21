import fs from "node:fs";

import { resolveTradingMode } from "./trading/mode.js";
import { TA_EDGE_V1_2_FOK } from "./trading/strategy.js";

const LIVE_CONFIG_KEYS = new Set([
  "stakeUsd",
  "maxTradesPerSession",
  "cancelOnExit",
  "setupApprovals",
  "settlementPollMs"
]);

const tradingMode = resolveTradingMode();
const liveConfigPath = process.env.LIVE_CONFIG_FILE || "./config/live.local.json";

function loadLocalLiveConfig() {
  if (tradingMode !== "live" || !fs.existsSync(liveConfigPath)) return {};

  let value;
  try {
    value = JSON.parse(fs.readFileSync(liveConfigPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse Live config ${liveConfigPath}: ${error?.message ?? String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Live config ${liveConfigPath} must contain a JSON object.`);
  }
  const unknownKeys = Object.keys(value).filter((key) => !LIVE_CONFIG_KEYS.has(key));
  if (unknownKeys.length) {
    throw new Error(`Unknown Live config field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`);
  }
  return value;
}

const localLiveConfig = loadLocalLiveConfig();

function liveValue(envName, configKey, defaultValue) {
  return process.env[envName] === undefined
    ? (localLiveConfig[configKey] ?? defaultValue)
    : process.env[envName];
}

function liveNumber(envName, configKey, defaultValue) {
  return Number(liveValue(envName, configKey, defaultValue));
}

function liveBoolean(envName, configKey, defaultValue) {
  return String(liveValue(envName, configKey, defaultValue)).toLowerCase() === "true";
}

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

  trading: {
    mode: tradingMode
  },

  paperTrading: {
    ...TA_EDGE_V1_2_FOK,
    stakeUsd: Number(process.env.PAPER_TRADE_STAKE_USD || 10),
    settlementPollMs: Number(process.env.PAPER_TRADE_SETTLEMENT_POLL_MS || 30_000),
    filePath: process.env.PAPER_TRADE_FILE || "./logs/paper_trades.csv"
  },

  liveTrading: {
    enabled: tradingMode === "live",
    geoblockUrl: process.env.POLYMARKET_GEOBLOCK_URL || "https://polymarket.com/api/geoblock",
    setupApprovals: liveBoolean("LIVE_TRADING_SETUP_APPROVALS", "setupApprovals", false),
    cancelOnExit: liveBoolean("LIVE_TRADING_CANCEL_ON_EXIT", "cancelOnExit", true),
    ...TA_EDGE_V1_2_FOK,
    stakeUsd: liveNumber("LIVE_TRADE_STAKE_USD", "stakeUsd", 5),
    maxStakeUsd: Number(process.env.LIVE_TRADE_HARD_MAX_STAKE_USD || 10),
    maxTradesPerSession: liveNumber("LIVE_TRADE_MAX_TRADES_PER_SESSION", "maxTradesPerSession", 1),
    settlementPollMs: liveNumber("LIVE_TRADE_SETTLEMENT_POLL_MS", "settlementPollMs", 30_000),
    filePath: "./logs/live_trades.csv",
    configPath: liveConfigPath
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
