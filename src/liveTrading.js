import fs from "node:fs";
import path from "node:path";

import { OrderSide, OrderType, createSecureClient, relayerApiKey } from "@polymarket/client";
import {
  cancelAll,
  fetchBalanceAllowance,
  fetchClosedOnlyMode,
  placeMarketOrder,
  setupTradingApprovals
} from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";

import { getResolvedWinner, simulateFokBuy } from "./paperTrading.js";
import { fetchMarketById, fetchMarketBySlug } from "./data/polymarket.js";

const COLUMNS = [
  "strategy",
  "order_type",
  "order_id",
  "order_status",
  "market_id",
  "market_slug",
  "market_end_time",
  "entry_time",
  "side",
  "token_id",
  "entry_price",
  "stake_usd",
  "requested_stake_usd",
  "shares",
  "best_ask",
  "limit_price",
  "model_probability",
  "execution_edge",
  "reference_state",
  "status",
  "winner",
  "result",
  "payout",
  "pnl",
  "settled_at",
  "error"
];

const SDK_ACTIONS = Object.freeze({
  cancelAll,
  fetchBalanceAllowance,
  fetchClosedOnlyMode,
  placeMarketOrder,
  setupTradingApprovals
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function floorToTick(value, tickSize) {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return value;
  return Math.floor((value + Number.EPSILON) / tickSize) * tickSize;
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

function emptySummary() {
  return {
    updated_at: new Date().toISOString(),
    total_trades: 0,
    settled_trades: 0,
    pending_trades: 0,
    wins: 0,
    losses: 0,
    win_rate_pct: 0,
    settled_stake_usd: 0,
    settled_payout_usd: 0,
    realized_pnl_usd: 0,
    realized_return_pct: 0,
    pending_stake_usd: 0
  };
}

async function fetchGeoblock(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Polymarket geoblock preflight failed with HTTP ${response.status}.`);
  return await response.json();
}

function baseUnitsToUsd(value) {
  try {
    return Number(BigInt(String(value))) / 1_000_000;
  } catch {
    return null;
  }
}

export async function buildSecureClientOptions({
  privateKey: signerPrivateKey,
  relayerApiKey: relayerKey,
  walletAddress
}) {
  if (!signerPrivateKey) throw new Error("A signer private key is required when live trading is enabled.");
  if (!relayerKey) throw new Error("A Polymarket Relayer API key is required for live trading.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress ?? "")) {
    throw new Error("An existing Polymarket trading wallet address is required for live trading.");
  }
  const signer = privateKey(signerPrivateKey);
  return {
    signer,
    apiKey: relayerApiKey({
      key: relayerKey,
      address: await signer.getAddress()
    }),
    wallet: walletAddress
  };
}

export class LiveTrader {
  static async create(config = {}) {
    const trader = new LiveTrader(config);
    if (!trader.enabled) return trader;

    if (!trader.client) {
      const nodeMajor = Number(process.versions.node.split(".")[0]);
      if (nodeMajor < 24) throw new Error("Live trading requires Node.js 24 or newer.");
    }
    const geoblock = await (config.checkGeoblock
      ? config.checkGeoblock()
      : fetchGeoblock(config.geoblockUrl ?? "https://polymarket.com/api/geoblock"));
    if (geoblock?.blocked === true) {
      throw new Error(`Polymarket trading is blocked in this location${geoblock.country ? ` (${geoblock.country})` : ""}.`);
    }

    if (!trader.client) {
      trader.client = await createSecureClient(await buildSecureClientOptions(config));
    }

    trader.accountIdentity = trader.client.account ?? null;
    const closedOnly = await trader.actions.fetchClosedOnlyMode(trader.client);
    if (closedOnly) throw new Error("Polymarket account is in closed-only mode; live entries are blocked.");
    if (config.setupApprovals === true) await trader.actions.setupTradingApprovals(trader.client);
    const collateral = await trader.actions.fetchBalanceAllowance(trader.client, { assetType: "COLLATERAL" });
    const balanceUsd = baseUnitsToUsd(collateral?.balance);
    if (balanceUsd === null || balanceUsd < trader.stakeUsd) {
      throw new Error(`Insufficient Polymarket collateral balance for a $${trader.stakeUsd.toFixed(2)} live stake.`);
    }
    trader.balanceUsd = balanceUsd;
    trader.ready = true;
    return trader;
  }

  constructor({
    enabled = false,
    strategy = "TA_EDGE_V1_2_FOK_LIVE",
    confirmationSeconds = 30,
    minRemainingMinutes = 5,
    maxRemainingMinutes = 10,
    minExecutionEdge = 0.1,
    maxSlippage = 0.02,
    requireTrendAlignment = true,
    stakeUsd = 5,
    maxStakeUsd = 5,
    maxTradesPerSession = 1,
    settlementPollMs = 30_000,
    filePath = "./logs/live_trades.csv",
    client = null,
    actions = SDK_ACTIONS,
    fetchMarket = null
  } = {}) {
    this.enabled = enabled;
    this.ready = false;
    this.armState = "DISARMED";
    this.strategy = strategy;
    this.confirmationMs = confirmationSeconds * 1_000;
    this.minRemainingMinutes = minRemainingMinutes;
    this.maxRemainingMinutes = maxRemainingMinutes;
    this.minExecutionEdge = minExecutionEdge;
    this.maxSlippage = maxSlippage;
    this.requireTrendAlignment = requireTrendAlignment;
    this.stakeUsd = stakeUsd;
    this.maxStakeUsd = maxStakeUsd;
    this.maxTradesPerSession = maxTradesPerSession;
    this.settlementPollMs = settlementPollMs;
    this.filePath = filePath;
    this.client = client;
    this.actions = actions;
    this.accountIdentity = null;
    this.fetchMarket = fetchMarket ?? (async (trade) => {
      if (trade.market_id) return await fetchMarketById(trade.market_id);
      return await fetchMarketBySlug(trade.market_slug);
    });
    this.records = this.#loadRecords();
    this.trades = this.records.filter((record) => ["AWAITING_SETTLEMENT", "SETTLED"].includes(record.status));
    this.sessionTradeCount = 0;
    this.candidate = null;
    this.attemptedMarkets = new Set();
    this.lastSettlementCheckMs = 0;

    if (!Number.isFinite(this.stakeUsd) || this.stakeUsd <= 0 || this.stakeUsd > this.maxStakeUsd) {
      throw new Error("LIVE_TRADE_STAKE_USD must be positive and no greater than LIVE_TRADE_MAX_STAKE_USD.");
    }
    if (!Number.isInteger(this.maxTradesPerSession) || this.maxTradesPerSession < 1) {
      throw new Error("LIVE_TRADE_MAX_TRADES_PER_SESSION must be a positive integer.");
    }
  }

  async observe({
    market,
    tokens,
    recommendation,
    orderBooks,
    modelUp,
    modelDown,
    remainingMinutes,
    regime,
    reference,
    nowMs = Date.now()
  }) {
    const marketSlug = String(market?.slug ?? "");
    if (!this.enabled) return { state: "BLOCKED", text: "blocked: LIVE_TRADING_ENABLED is false" };
    if (!this.ready) return { state: "BLOCKED", text: "blocked: live preflight incomplete" };
    if (this.armState !== "ARMED") {
      this.candidate = null;
      return this.getStatus(marketSlug, nowMs);
    }
    if (!marketSlug) return this.getStatus(marketSlug, nowMs);
    if (this.trades.some((trade) => trade.market_slug === marketSlug) || this.attemptedMarkets.has(marketSlug)) {
      this.candidate = null;
      return this.getStatus(marketSlug, nowMs);
    }
    if (this.sessionTradeCount >= this.maxTradesPerSession) {
      return { state: "BLOCKED", text: "blocked: session trade limit reached" };
    }
    if (reference?.tradingAllowed !== true) {
      this.candidate = null;
      return { state: "BLOCKED", text: `blocked: ${reference?.state ?? "REFERENCE_UNAVAILABLE"}` };
    }

    const side = String(recommendation?.side ?? "").toUpperCase();
    const timeIsEligible = Number.isFinite(remainingMinutes)
      && remainingMinutes >= this.minRemainingMinutes
      && remainingMinutes <= this.maxRemainingMinutes;
    const expectedRegime = side === "UP" ? "TREND_UP" : side === "DOWN" ? "TREND_DOWN" : null;
    const trendIsEligible = !this.requireTrendAlignment || regime === expectedRegime;
    if (recommendation?.action !== "ENTER" || !expectedRegime || !timeIsEligible || !trendIsEligible) {
      this.candidate = null;
      return this.getStatus(marketSlug, nowMs);
    }

    const candidateKey = `${marketSlug}:${side}`;
    if (this.candidate?.key !== candidateKey) {
      this.candidate = { key: candidateKey, marketSlug, side, startedAtMs: nowMs };
      return this.getStatus(marketSlug, nowMs);
    }
    if (nowMs - this.candidate.startedAtMs < this.confirmationMs) return this.getStatus(marketSlug, nowMs);

    const orderBook = side === "UP" ? orderBooks?.up : orderBooks?.down;
    const tokenId = String(side === "UP" ? tokens?.upTokenId ?? "" : tokens?.downTokenId ?? "");
    const bestAsk = finiteNumber(orderBook?.bestAsk);
    const tickSize = finiteNumber(orderBook?.tickSize) ?? finiteNumber(market.orderPriceMinTickSize) ?? 0.01;
    const minOrderSize = finiteNumber(orderBook?.minOrderSize) ?? finiteNumber(market.orderMinSize) ?? 0;
    const modelProbability = finiteNumber(side === "UP" ? modelUp : modelDown);
    const maxPrice = bestAsk === null ? null : Math.min(0.99, floorToTick(bestAsk + this.maxSlippage, tickSize));
    const fill = maxPrice === null ? { filled: false } : simulateFokBuy({
      asks: orderBook?.asks,
      stakeUsd: this.stakeUsd,
      maxPrice,
      minOrderSize,
      feesEnabled: market.feesEnabled === true,
      feeSchedule: market.feeSchedule ?? null
    });
    const executionEdge = fill.filled && modelProbability !== null
      ? modelProbability - (fill.totalCost / fill.shares)
      : null;
    const endTimeMs = new Date(market.endDate).getTime();
    const eligible = tokenId
      && market.active === true
      && market.closed !== true
      && market.acceptingOrders === true
      && market.enableOrderBook !== false
      && fill.filled
      && executionEdge !== null
      && executionEdge >= this.minExecutionEdge
      && Number.isFinite(endTimeMs);
    if (!eligible) {
      this.candidate = null;
      return this.getStatus(marketSlug, nowMs);
    }

    this.candidate = null;
    this.attemptedMarkets.add(marketSlug);
    let response;
    try {
      response = await this.actions.placeMarketOrder(this.client, {
        tokenId,
        side: OrderSide.BUY,
        amount: this.stakeUsd,
        maxSpend: this.stakeUsd,
        maxPrice,
        orderType: OrderType.FOK
      });
    } catch (error) {
      this.#appendAttempt({
        market,
        side,
        tokenId,
        bestAsk,
        maxPrice,
        modelProbability,
        executionEdge,
        reference,
        nowMs,
        error: error?.message ?? String(error)
      });
      return { state: "ORDER_ERROR", text: "order failed; market locked for this session" };
    }

    const responseStake = response?.ok ? finiteNumber(response.makingAmount) : null;
    const responseShares = response?.ok ? finiteNumber(response.takingAmount) : null;
    const matched = response?.ok
      && String(response.status).toLowerCase() === "matched"
      && responseStake !== null
      && responseStake > 0
      && responseShares !== null
      && responseShares > 0;
    if (!matched) {
      this.#appendAttempt({
        market,
        side,
        tokenId,
        bestAsk,
        maxPrice,
        modelProbability,
        executionEdge,
        reference,
        nowMs,
        orderStatus: response?.ok ? response.status : response?.code ?? "REJECTED",
        error: response?.ok ? "FOK order returned without a matched fill" : response?.message ?? "order rejected"
      });
      return {
        state: response?.ok ? "NOT_FILLED" : "REJECTED",
        text: response?.ok ? "FOK order did not fill; market locked for this session" : `order rejected: ${response?.code ?? "unknown"}`
      };
    }

    const stakeUsd = responseStake;
    const shares = responseShares;
    const entryPrice = stakeUsd / shares;
    const trade = {
      strategy: this.strategy,
      order_type: "FOK",
      order_id: String(response.orderId),
      order_status: String(response.status),
      market_id: String(market.id ?? ""),
      market_slug: marketSlug,
      market_end_time: new Date(endTimeMs).toISOString(),
      entry_time: new Date(nowMs).toISOString(),
      side,
      token_id: tokenId,
      entry_price: entryPrice,
      stake_usd: stakeUsd,
      requested_stake_usd: this.stakeUsd,
      shares,
      best_ask: bestAsk,
      limit_price: maxPrice,
      model_probability: modelProbability,
      execution_edge: executionEdge,
      reference_state: reference.state,
      status: "AWAITING_SETTLEMENT",
      winner: "",
      result: "PENDING",
      payout: "",
      pnl: "",
      settled_at: "",
      error: ""
    };
    this.trades.push(trade);
    this.records.push(trade);
    this.sessionTradeCount += 1;
    this.#saveRecords();
    return this.getStatus(marketSlug, nowMs);
  }

  async settlePending(nowMs = Date.now()) {
    if (!this.enabled || nowMs - this.lastSettlementCheckMs < this.settlementPollMs) return [];
    this.lastSettlementCheckMs = nowMs;
    const settled = [];
    for (const trade of this.trades.filter((item) => item.status === "AWAITING_SETTLEMENT")) {
      if (new Date(trade.market_end_time).getTime() > nowMs) continue;
      try {
        const winner = getResolvedWinner(await this.fetchMarket(trade));
        if (!winner) continue;
        const shares = finiteNumber(trade.shares) ?? 0;
        const stakeUsd = finiteNumber(trade.stake_usd) ?? 0;
        const payout = trade.side === winner ? shares : 0;
        Object.assign(trade, {
          status: "SETTLED",
          winner,
          result: trade.side === winner ? "WIN" : "LOSE",
          payout,
          pnl: payout - stakeUsd,
          settled_at: new Date(nowMs).toISOString()
        });
        settled.push(trade);
      } catch {
        // Retry on the next settlement poll.
      }
    }
    if (settled.length) this.#saveRecords();
    return settled;
  }

  getStatus(marketSlug, nowMs = Date.now()) {
    if (!this.enabled) return { state: "BLOCKED", text: "blocked: LIVE_TRADING_ENABLED is false" };
    if (this.armState === "PENDING_CONFIRMATION") {
      return { state: "PENDING_CONFIRMATION", text: "press Enter to enable live trading; Esc to cancel" };
    }
    if (this.armState !== "ARMED") {
      return { state: "DISARMED", text: "trading stopped; press A to enable" };
    }
    const trade = this.trades.find((item) => item.market_slug === String(marketSlug ?? ""));
    if (trade) return {
      state: trade.status,
      text: `${trade.side} ${trade.status} @ ${(Number(trade.entry_price) * 100).toFixed(1)}c`,
      trade
    };
    if (this.candidate?.marketSlug === String(marketSlug ?? "")) {
      const elapsed = Math.max(0, (nowMs - this.candidate.startedAtMs) / 1_000);
      return { state: "CONFIRMING", text: `${this.candidate.side} confirming ${elapsed.toFixed(0)}/${this.confirmationMs / 1_000}s` };
    }
    return { state: "WAITING", text: "waiting for stable signal" };
  }

  getSummary() {
    if (!this.trades.length) return emptySummary();
    const settled = this.trades.filter((trade) => trade.status === "SETTLED");
    const pending = this.trades.filter((trade) => trade.status === "AWAITING_SETTLEMENT");
    const wins = settled.filter((trade) => trade.result === "WIN").length;
    const settledStake = settled.reduce((sum, trade) => sum + (finiteNumber(trade.stake_usd) ?? 0), 0);
    const payout = settled.reduce((sum, trade) => sum + (finiteNumber(trade.payout) ?? 0), 0);
    const pnl = settled.reduce((sum, trade) => sum + (finiteNumber(trade.pnl) ?? 0), 0);
    return {
      updated_at: new Date().toISOString(),
      total_trades: this.trades.length,
      settled_trades: settled.length,
      pending_trades: pending.length,
      wins,
      losses: settled.length - wins,
      win_rate_pct: settled.length ? (wins / settled.length) * 100 : 0,
      settled_stake_usd: settledStake,
      settled_payout_usd: payout,
      realized_pnl_usd: pnl,
      realized_return_pct: settledStake > 0 ? (pnl / settledStake) * 100 : 0,
      pending_stake_usd: pending.reduce((sum, trade) => sum + (finiteNumber(trade.stake_usd) ?? 0), 0)
    };
  }

  async cancelAll() {
    if (!this.enabled || !this.ready) return null;
    return await this.actions.cancelAll(this.client);
  }

  requestArm() {
    if (!this.enabled || !this.ready || this.armState === "ARMED") return false;
    this.armState = "PENDING_CONFIRMATION";
    return true;
  }

  confirmArm() {
    if (this.armState !== "PENDING_CONFIRMATION") return false;
    this.armState = "ARMED";
    return true;
  }

  cancelArm() {
    if (this.armState !== "PENDING_CONFIRMATION") return false;
    this.armState = "DISARMED";
    return true;
  }

  async disarm() {
    const wasActive = this.armState !== "DISARMED";
    this.armState = "DISARMED";
    this.candidate = null;
    if (this.enabled && this.ready) await this.cancelAll();
    return wasActive;
  }

  getControlState() {
    if (!this.enabled) return { state: "UNAVAILABLE", text: "Unavailable" };
    if (!this.ready) return { state: "BLOCKED", text: "Blocked" };
    if (this.armState === "ARMED") return { state: "ARMED", text: "Enabled" };
    if (this.armState === "PENDING_CONFIRMATION") return { state: "PENDING_CONFIRMATION", text: "Confirm with Enter" };
    return { state: "DISARMED", text: "Stopped" };
  }

  getAccountIdentity() {
    return this.accountIdentity;
  }

  #appendAttempt({ market, side, tokenId, bestAsk, maxPrice, modelProbability, executionEdge, reference, nowMs, orderStatus = "ERROR", error }) {
    const attempt = {
      strategy: this.strategy,
      order_type: "FOK",
      order_id: "",
      order_status: orderStatus,
      market_id: String(market.id ?? ""),
      market_slug: String(market.slug ?? ""),
      market_end_time: market.endDate ?? "",
      entry_time: new Date(nowMs).toISOString(),
      side,
      token_id: tokenId,
      entry_price: "",
      stake_usd: "",
      requested_stake_usd: this.stakeUsd,
      shares: "",
      best_ask: bestAsk,
      limit_price: maxPrice,
      model_probability: modelProbability,
      execution_edge: executionEdge,
      reference_state: reference?.state ?? "",
      status: "NOT_FILLED",
      winner: "",
      result: "",
      payout: "",
      pnl: "",
      settled_at: "",
      error
    };
    this.records.push(attempt);
    this.#saveRecords();
  }

  #loadRecords() {
    if (!fs.existsSync(this.filePath)) return [];
    const lines = fs.readFileSync(this.filePath, "utf8").trim().split("\n");
    if (lines.length < 2) return [];
    const columns = parseCsvLine(lines[0]);
    return lines.slice(1).filter(Boolean).map((line) => {
      const values = parseCsvLine(line);
      return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
    });
  }

  #saveRecords() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lines = [COLUMNS.join(",")];
    for (const record of this.records) lines.push(COLUMNS.map((column) => csvValue(record[column])).join(","));
    fs.writeFileSync(this.filePath, `${lines.join("\n")}\n`, "utf8");
  }
}