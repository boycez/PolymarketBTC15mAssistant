import fs from "node:fs";
import path from "node:path";

import { fetchMarketById, fetchMarketBySlug } from "./data/polymarket.js";

const COLUMNS = [
  "strategy",
  "order_type",
  "market_id",
  "market_slug",
  "market_end_time",
  "entry_time",
  "side",
  "entry_price",
  "stake_usd",
  "requested_stake_usd",
  "filled_notional_usd",
  "fee_usd",
  "shares",
  "best_ask",
  "limit_price",
  "worst_fill_price",
  "slippage",
  "fill_status",
  "tick_size",
  "min_order_size",
  "fees_enabled",
  "fee_rate",
  "model_probability",
  "market_probability",
  "execution_edge",
  "signal_confirmed_seconds",
  "time_left_minutes",
  "regime",
  "phase",
  "strength",
  "status",
  "winner",
  "payout",
  "pnl",
  "settled_at"
];

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function floorTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
}

function floorToTick(value, tickSize) {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return value;
  return Math.floor((value + Number.EPSILON) / tickSize) * tickSize;
}

function roundFee(value) {
  return Math.round((value + Number.EPSILON) * 100_000) / 100_000;
}

function feePerShare(price, feesEnabled, feeSchedule) {
  if (!feesEnabled) return 0;
  const rate = finiteNumber(feeSchedule?.rate);
  if (rate === null || rate <= 0) return 0;
  const exponent = finiteNumber(feeSchedule?.exponent) ?? 1;
  return rate * ((price * (1 - price)) ** exponent);
}

export function simulateFokBuy({
  asks,
  stakeUsd,
  maxPrice,
  minOrderSize = 0,
  feesEnabled = false,
  feeSchedule = null
}) {
  const levels = (Array.isArray(asks) ? asks : [])
    .map((level) => ({ price: finiteNumber(level?.price), size: finiteNumber(level?.size) }))
    .filter((level) => level.price !== null && level.size !== null && level.price > 0 && level.size > 0)
    .sort((left, right) => left.price - right.price)
    .filter((level) => level.price <= maxPrice + Number.EPSILON);

  if (!levels.length || !Number.isFinite(stakeUsd) || stakeUsd <= 0) {
    return { filled: false, reason: "no_executable_liquidity" };
  }

  let affordableShares = 0;
  let remainingBudget = stakeUsd;
  for (const level of levels) {
    const unitCost = level.price + feePerShare(level.price, feesEnabled, feeSchedule);
    const shares = Math.min(level.size, remainingBudget / unitCost);
    affordableShares += shares;
    remainingBudget -= shares * unitCost;
    if (remainingBudget <= 1e-9) break;
  }

  let targetShares = floorTo(affordableShares, 2);
  const fillTarget = (sharesToFill) => {
    let remainingShares = sharesToFill;
    let notional = 0;
    let fee = 0;
    let worstFillPrice = null;

    for (const level of levels) {
      if (remainingShares <= 1e-9) break;
      const shares = Math.min(level.size, remainingShares);
      notional += shares * level.price;
      fee += shares * feePerShare(level.price, feesEnabled, feeSchedule);
      worstFillPrice = level.price;
      remainingShares -= shares;
    }

    const roundedFee = roundFee(fee);
    return {
      complete: remainingShares <= 1e-9,
      notional,
      fee: roundedFee,
      totalCost: notional + roundedFee,
      worstFillPrice
    };
  };

  let fill = fillTarget(targetShares);
  while (targetShares > 0 && fill.totalCost > stakeUsd + 1e-9) {
    targetShares = floorTo(targetShares - 0.01, 2);
    fill = fillTarget(targetShares);
  }

  if (!fill.complete || targetShares <= 0) {
    return { filled: false, reason: "insufficient_depth" };
  }

  const leftoverBudget = stakeUsd - fill.totalCost;
  const cheapestUnitCost = levels[0].price + feePerShare(levels[0].price, feesEnabled, feeSchedule);
  if (leftoverBudget >= cheapestUnitCost * 0.01 - 1e-9) {
    return { filled: false, reason: "insufficient_depth" };
  }

  if (fill.notional + 1e-9 < minOrderSize) {
    return { filled: false, reason: "below_min_order_size" };
  }

  const averagePrice = fill.notional / targetShares;
  return {
    filled: true,
    shares: targetShares,
    averagePrice,
    worstFillPrice: fill.worstFillPrice,
    notional: fill.notional,
    fee: fill.fee,
    totalCost: fill.totalCost,
    leftoverBudget
  };
}

export function getResolvedWinner(market) {
  if (market?.closed !== true) return null;

  const resolutionStatus = String(market?.umaResolutionStatus ?? "").toLowerCase();
  if (resolutionStatus && resolutionStatus !== "resolved") return null;

  const outcomes = parseArray(market?.outcomes);
  const outcomePrices = parseArray(market?.outcomePrices).map(Number);
  if (outcomes.length !== outcomePrices.length) return null;

  const winnerIndexes = outcomePrices
    .map((price, index) => price === 1 ? index : -1)
    .filter((index) => index >= 0);

  if (winnerIndexes.length !== 1) return null;
  return String(outcomes[winnerIndexes[0]]).toUpperCase();
}

export class PaperTrader {
  constructor({
    enabled = true,
    strategy = "TA_EDGE_V1_2_FOK",
    confirmationSeconds = 30,
    minRemainingMinutes = 5,
    maxRemainingMinutes = 10,
    minExecutionEdge = 0.1,
    maxSlippage = 0.02,
    requireTrendAlignment = true,
    stakeUsd = 10,
    settlementPollMs = 30_000,
    filePath = "./logs/paper_trades.csv",
    summaryFilePath = "./logs/paper_summary.json",
    fetchMarket = null
  } = {}) {
    this.enabled = enabled;
    this.strategy = strategy;
    this.confirmationMs = confirmationSeconds * 1_000;
    this.minRemainingMinutes = minRemainingMinutes;
    this.maxRemainingMinutes = maxRemainingMinutes;
    this.minExecutionEdge = minExecutionEdge;
    this.maxSlippage = maxSlippage;
    this.requireTrendAlignment = requireTrendAlignment;
    this.stakeUsd = stakeUsd;
    this.settlementPollMs = settlementPollMs;
    this.filePath = filePath;
    this.summaryFilePath = summaryFilePath;
    this.fetchMarket = fetchMarket ?? (async (trade) => {
      if (trade.market_id) {
        const market = await fetchMarketById(trade.market_id);
        if (market) return market;
      }
      return await fetchMarketBySlug(trade.market_slug);
    });
    this.trades = this.#loadTrades();
    this.candidate = null;
    this.lastSettlementCheckMs = 0;
    this.#saveSummary();
  }

  observe({
    market,
    recommendation,
    orderBooks,
    modelUp,
    modelDown,
    remainingMinutes,
    regime,
    nowMs = Date.now()
  }) {
    if (!this.enabled || !market?.slug) return this.getStatus(market?.slug, nowMs);

    const marketSlug = String(market.slug);
    const existingTrade = this.trades.find((trade) => trade.market_slug === marketSlug);
    if (existingTrade) {
      this.candidate = null;
      return this.getStatus(marketSlug, nowMs);
    }

    const side = String(recommendation?.side ?? "").toUpperCase();
    const timeIsEligible = Number.isFinite(remainingMinutes)
      && remainingMinutes >= this.minRemainingMinutes
      && remainingMinutes <= this.maxRemainingMinutes;
    const expectedRegime = side === "UP" ? "TREND_UP" : side === "DOWN" ? "TREND_DOWN" : null;
    const trendIsEligible = !this.requireTrendAlignment || regime === expectedRegime;

    if (recommendation?.action !== "ENTER" || !side || !timeIsEligible || !trendIsEligible) {
      this.candidate = null;
      return this.getStatus(marketSlug, nowMs);
    }

    const candidateKey = `${marketSlug}:${side}`;
    if (this.candidate?.key !== candidateKey) {
      this.candidate = { key: candidateKey, marketSlug, side, startedAtMs: nowMs };
      return this.getStatus(marketSlug, nowMs);
    }

    if (nowMs - this.candidate.startedAtMs < this.confirmationMs) {
      return this.getStatus(marketSlug, nowMs);
    }

    const orderBook = side === "UP" ? orderBooks?.up : orderBooks?.down;
    const bestAsk = finiteNumber(orderBook?.bestAsk);
    const tickSize = finiteNumber(orderBook?.tickSize)
      ?? finiteNumber(market.orderPriceMinTickSize)
      ?? 0.01;
    const minOrderSize = finiteNumber(orderBook?.minOrderSize)
      ?? finiteNumber(market.orderMinSize)
      ?? 0;
    const modelProbability = finiteNumber(side === "UP" ? modelUp : modelDown);
    const maxPrice = bestAsk === null
      ? null
      : Math.min(0.99, floorToTick(bestAsk + this.maxSlippage, tickSize));
    const feesEnabled = market.feesEnabled === true;
    const feeSchedule = market.feeSchedule ?? null;
    const fill = maxPrice === null
      ? { filled: false, reason: "missing_best_ask" }
      : simulateFokBuy({
          asks: orderBook?.asks,
          stakeUsd: this.stakeUsd,
          maxPrice,
          minOrderSize,
          feesEnabled,
          feeSchedule
        });
    const effectiveEntryPrice = fill.filled ? fill.totalCost / fill.shares : null;
    const executionEdge = effectiveEntryPrice === null || modelProbability === null
      ? null
      : modelProbability - effectiveEntryPrice;
    const endTimeMs = new Date(market.endDate).getTime();
    if (
      market.active !== true
      || market.closed === true
      || market.acceptingOrders !== true
      || market.enableOrderBook === false
      || !fill.filled
      || executionEdge === null
      || executionEdge < this.minExecutionEdge
      || !Number.isFinite(endTimeMs)
    ) {
      this.candidate = null;
      return this.getStatus(marketSlug, nowMs);
    }

    this.trades.push({
      strategy: this.strategy,
      order_type: "FOK",
      market_id: String(market.id ?? ""),
      market_slug: marketSlug,
      market_end_time: new Date(endTimeMs).toISOString(),
      entry_time: new Date(nowMs).toISOString(),
      side,
      entry_price: fill.averagePrice,
      stake_usd: fill.totalCost,
      requested_stake_usd: this.stakeUsd,
      filled_notional_usd: fill.notional,
      fee_usd: fill.fee,
      shares: fill.shares,
      best_ask: bestAsk,
      limit_price: maxPrice,
      worst_fill_price: fill.worstFillPrice,
      slippage: fill.averagePrice - bestAsk,
      fill_status: "FILLED",
      tick_size: tickSize,
      min_order_size: minOrderSize,
      fees_enabled: feesEnabled,
      fee_rate: finiteNumber(feeSchedule?.rate) ?? 0,
      model_probability: modelProbability,
      market_probability: fill.averagePrice,
      execution_edge: executionEdge,
      signal_confirmed_seconds: this.confirmationMs / 1_000,
      time_left_minutes: remainingMinutes,
      regime: String(regime ?? ""),
      phase: String(recommendation.phase ?? ""),
      strength: String(recommendation.strength ?? ""),
      status: "AWAITING_SETTLEMENT",
      winner: "",
      payout: "",
      pnl: "",
      settled_at: ""
    });
    this.candidate = null;
    this.#saveTrades();
    return this.getStatus(marketSlug, nowMs);
  }

  async settlePending(nowMs = Date.now()) {
    if (!this.enabled || nowMs - this.lastSettlementCheckMs < this.settlementPollMs) return [];
    this.lastSettlementCheckMs = nowMs;

    const dueTrades = this.trades.filter((trade) => {
      const endTimeMs = new Date(trade.market_end_time).getTime();
      return ["PENDING", "AWAITING_SETTLEMENT"].includes(trade.status)
        && Number.isFinite(endTimeMs)
        && endTimeMs <= nowMs;
    });

    const settledTrades = [];
    for (const trade of dueTrades) {
      try {
        const market = await this.fetchMarket(trade);
        const winner = getResolvedWinner(market);
        if (!winner) continue;

        const shares = finiteNumber(trade.shares) ?? 0;
        const stakeUsd = finiteNumber(trade.stake_usd) ?? 0;
        const payout = trade.side === winner ? shares : 0;
        trade.status = "SETTLED";
        trade.winner = winner;
        trade.payout = payout;
        trade.pnl = payout - stakeUsd;
        trade.settled_at = new Date(nowMs).toISOString();
        settledTrades.push(trade);
      } catch {
        // Retry on the next settlement poll.
      }
    }

    if (settledTrades.length) this.#saveTrades();
    return settledTrades;
  }

  getStatus(marketSlug, nowMs = Date.now()) {
    if (!this.enabled) return { state: "DISABLED", text: "disabled" };

    const trade = marketSlug
      ? this.trades.find((item) => item.market_slug === String(marketSlug))
      : null;
    if (trade) {
      const result = trade.status === "SETTLED"
        ? `${trade.side} ${trade.status} (${Number(trade.pnl) >= 0 ? "+" : ""}$${Number(trade.pnl).toFixed(2)})`
        : `${trade.side} ${trade.status} @ ${(Number(trade.entry_price) * 100).toFixed(1)}c`;
      return { state: trade.status, text: result, trade };
    }

    if (this.candidate?.marketSlug === String(marketSlug ?? "")) {
      const elapsedSeconds = Math.max(0, (nowMs - this.candidate.startedAtMs) / 1_000);
      return {
        state: "CONFIRMING",
        text: `${this.candidate.side} confirming ${elapsedSeconds.toFixed(0)}/${this.confirmationMs / 1_000}s`
      };
    }

    return { state: "WAITING", text: "waiting for stable signal" };
  }

  #loadTrades() {
    if (!fs.existsSync(this.filePath)) return [];
    const lines = fs.readFileSync(this.filePath, "utf8").trim().split("\n");
    if (lines.length < 2) return [];

    const columns = parseCsvLine(lines[0]);
    return lines.slice(1).filter(Boolean).map((line) => {
      const values = parseCsvLine(line);
      return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
    });
  }

  #saveTrades() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lines = [COLUMNS.join(",")];
    for (const trade of this.trades) {
      lines.push(COLUMNS.map((column) => csvValue(trade[column])).join(","));
    }
    fs.writeFileSync(this.filePath, `${lines.join("\n")}\n`, "utf8");
    this.#saveSummary();
  }

  #saveSummary() {
    const settledTrades = this.trades.filter((trade) => trade.status === "SETTLED");
    const pendingTrades = this.trades.filter((trade) => ["PENDING", "AWAITING_SETTLEMENT"].includes(trade.status));
    const wins = settledTrades.filter((trade) => (finiteNumber(trade.pnl) ?? 0) > 0).length;
    const losses = settledTrades.filter((trade) => (finiteNumber(trade.pnl) ?? 0) < 0).length;
    const realizedPnl = settledTrades.reduce((sum, trade) => sum + (finiteNumber(trade.pnl) ?? 0), 0);
    const settledPayout = settledTrades.reduce((sum, trade) => sum + (finiteNumber(trade.payout) ?? 0), 0);
    const pendingStake = pendingTrades.reduce((sum, trade) => sum + (finiteNumber(trade.stake_usd) ?? 0), 0);

    const summary = {
      updated_at: new Date().toISOString(),
      total_trades: this.trades.length,
      settled_trades: settledTrades.length,
      pending_trades: pendingTrades.length,
      wins,
      losses,
      win_rate_pct: settledTrades.length ? (wins / settledTrades.length) * 100 : 0,
      settled_payout_usd: settledPayout,
      realized_pnl_usd: realizedPnl,
      pending_stake_usd: pendingStake
    };

    fs.mkdirSync(path.dirname(this.summaryFilePath), { recursive: true });
    fs.writeFileSync(this.summaryFilePath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
}