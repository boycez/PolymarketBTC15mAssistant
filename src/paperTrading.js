import fs from "node:fs";
import path from "node:path";

import { fetchMarketById, fetchMarketBySlug } from "./data/polymarket.js";
import { quoteOutcomeExecution } from "./execution/quoteExecution.js";
import { formatRecommendationReason } from "./trading/strategy.js";
import { atomicWriteFileSync } from "./utils.js";

export { simulateFokBuy } from "./execution/quoteExecution.js";

const COLUMNS = [
  "strategy",
  "strategy_id",
  "strategy_version",
  "config_fingerprint",
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
  "reference_state",
  "price_to_beat_e18",
  "price_to_beat",
  "current_twap_e18",
  "current_twap",
  "twap_distance",
  "phase",
  "strength",
  "status",
  "winner",
  "result",
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

function tradeResult(trade) {
  if (trade?.status !== "SETTLED") return "PENDING";
  return String(trade?.side).toUpperCase() === String(trade?.winner).toUpperCase()
    ? "WIN"
    : "LOSE";
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
    strategyId = "ta-edge",
    strategyVersion = "1.2.0",
    configFingerprint = "",
    confirmationSeconds = 30,
    minRemainingMinutes = 5,
    maxRemainingMinutes = 10,
    minExecutionEdge = 0.1,
    maxSlippage = 0.02,
    requireTrendAlignment = true,
    stakeUsd = 10,
    startingEquityUsd = 1_000,
    settlementPollMs = 30_000,
    filePath = "./logs/paper_trades.csv",
    fetchMarket = null
  } = {}) {
    this.enabled = enabled;
    this.strategy = strategy;
    this.strategyId = strategyId;
    this.strategyVersion = strategyVersion;
    this.configFingerprint = configFingerprint;
    this.confirmationMs = confirmationSeconds * 1_000;
    this.minRemainingMinutes = minRemainingMinutes;
    this.maxRemainingMinutes = maxRemainingMinutes;
    this.minExecutionEdge = minExecutionEdge;
    this.maxSlippage = maxSlippage;
    this.requireTrendAlignment = requireTrendAlignment;
    this.stakeUsd = stakeUsd;
    this.startingEquityUsd = startingEquityUsd;
    this.settlementPollMs = settlementPollMs;
    this.filePath = filePath;
    this.fetchMarket = fetchMarket ?? (async (trade) => {
      if (trade.market_id) {
        const market = await fetchMarketById(trade.market_id);
        if (market) return market;
      }
      return await fetchMarketBySlug(trade.market_slug);
    });
    this.trades = this.#loadTrades();
    const needsResultMigration = this.trades.some((trade) => !trade.result);
    for (const trade of this.trades) trade.result = tradeResult(trade);
    if (needsResultMigration) this.#saveTrades();
    this.candidate = null;
    this.lastSettlementCheckMs = 0;
  }

  observe({
    market,
    recommendation,
    orderBooks,
    modelUp,
    modelDown,
    remainingMinutes,
    regime,
    reference,
    nowMs = Date.now()
  }) {
    if (!this.enabled || !market?.slug) return this.getStatus(market?.slug, nowMs);

    const marketSlug = String(market.slug);
    const existingTrade = this.trades.find((trade) => trade.market_slug === marketSlug);
    if (existingTrade) {
      this.candidate = null;
      return this.getStatus(marketSlug, nowMs);
    }

    if (reference?.tradingAllowed !== true) {
      this.candidate = null;
      const referenceState = reference?.state ?? "REFERENCE_UNAVAILABLE";
      return { state: "BLOCKED", text: `blocked: ${referenceState}` };
    }

    const side = String(recommendation?.side ?? "").toUpperCase();
    const timeIsEligible = Number.isFinite(remainingMinutes)
      && remainingMinutes >= this.minRemainingMinutes
      && remainingMinutes <= this.maxRemainingMinutes;
    const expectedRegime = side === "UP" ? "TREND_UP" : side === "DOWN" ? "TREND_DOWN" : null;
    const trendIsEligible = !this.requireTrendAlignment || regime === expectedRegime;

    if (!timeIsEligible) {
      this.candidate = null;
      const remaining = Number.isFinite(remainingMinutes) ? `${remainingMinutes.toFixed(1)}m remaining` : "time unavailable";
      return { state: "WAITING", text: `waiting: outside entry window (${remaining})` };
    }
    if (recommendation?.action !== "ENTER" || !expectedRegime) {
      this.candidate = null;
      const reason = formatRecommendationReason(recommendation?.reason);
      return { state: "WAITING", text: `waiting: ${reason}` };
    }
    if (!trendIsEligible) {
      this.candidate = null;
      return { state: "WAITING", text: `waiting: ${side} requires ${expectedRegime}` };
    }

    const candidateKey = `${marketSlug}:${side}`;
    if (this.candidate?.key !== candidateKey) {
      this.candidate = { key: candidateKey, marketSlug, side, startedAtMs: nowMs };
      return this.getStatus(marketSlug, nowMs);
    }

    if (nowMs - this.candidate.startedAtMs < this.confirmationMs) {
      return this.getStatus(marketSlug, nowMs);
    }

    const modelProbability = finiteNumber(side === "UP" ? modelUp : modelDown);
    const quote = quoteOutcomeExecution({
      orderBook: side === "UP" ? orderBooks?.up : orderBooks?.down,
      market,
      stakeUsd: this.stakeUsd,
      maxSlippage: this.maxSlippage,
      modelProbability
    });
    const { bestAsk, tickSize, minOrderSize, maxPrice, fill, executionEdge } = quote;
    const endTimeMs = new Date(market.endDate).getTime();
    let rejectionReason = null;
    if (market.active !== true || market.closed === true || market.acceptingOrders !== true || market.enableOrderBook === false) {
      rejectionReason = "market is not accepting orders";
    } else if (!fill.filled) {
      rejectionReason = String(fill.reason ?? "order is not executable").replaceAll("_", " ");
    } else if (executionEdge === null) {
      rejectionReason = "execution edge unavailable";
    } else if (executionEdge < this.minExecutionEdge) {
      rejectionReason = `execution edge ${(executionEdge * 100).toFixed(1)}% < ${(this.minExecutionEdge * 100).toFixed(1)}%`;
    } else if (!Number.isFinite(endTimeMs)) {
      rejectionReason = "market end time unavailable";
    }
    if (rejectionReason) {
      this.candidate = null;
      return { state: "WAITING", text: `waiting: ${rejectionReason}` };
    }

    this.trades.push({
      strategy: this.strategy,
      strategy_id: this.strategyId,
      strategy_version: this.strategyVersion,
      config_fingerprint: this.configFingerprint,
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
      fees_enabled: market.feesEnabled === true,
      fee_rate: finiteNumber(market.feeSchedule?.rate) ?? 0,
      model_probability: modelProbability,
      market_probability: fill.averagePrice,
      execution_edge: executionEdge,
      signal_confirmed_seconds: this.confirmationMs / 1_000,
      time_left_minutes: remainingMinutes,
      regime: String(regime ?? ""),
      reference_state: reference.state,
      price_to_beat_e18: reference.priceToBeatE18,
      price_to_beat: reference.priceToBeat,
      current_twap_e18: reference.currentTwapE18,
      current_twap: reference.currentTwap,
      twap_distance: reference.distance,
      phase: String(recommendation.phase ?? ""),
      strength: String(recommendation.strength ?? ""),
      status: "AWAITING_SETTLEMENT",
      winner: "",
      result: "PENDING",
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
        trade.result = tradeResult(trade);
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

  getStrategyConstraints() {
    return {
      confirmationSeconds: this.confirmationMs / 1_000,
      minRemainingMinutes: this.minRemainingMinutes,
      maxRemainingMinutes: this.maxRemainingMinutes,
      minExecutionEdge: this.minExecutionEdge,
      maxSlippage: this.maxSlippage,
      requireTrendAlignment: this.requireTrendAlignment
    };
  }

  getSummary(nowMs = Date.now()) {
    const settledTrades = this.trades.filter((trade) => trade.status === "SETTLED");
    const pendingTrades = this.trades.filter((trade) => ["PENDING", "AWAITING_SETTLEMENT"].includes(trade.status));
    const wins = settledTrades.filter((trade) => tradeResult(trade) === "WIN").length;
    const losses = settledTrades.filter((trade) => tradeResult(trade) === "LOSE").length;
    const realizedPnl = settledTrades.reduce((sum, trade) => sum + (finiteNumber(trade.pnl) ?? 0), 0);
    const settledStake = settledTrades.reduce((sum, trade) => sum + (finiteNumber(trade.stake_usd) ?? 0), 0);
    const settledPayout = settledTrades.reduce((sum, trade) => sum + (finiteNumber(trade.payout) ?? 0), 0);
    const pendingStake = pendingTrades.reduce((sum, trade) => sum + (finiteNumber(trade.stake_usd) ?? 0), 0);
    const chronological = [...settledTrades].sort((left, right) => {
      const leftTime = Date.parse(left.settled_at || left.entry_time) || 0;
      const rightTime = Date.parse(right.settled_at || right.entry_time) || 0;
      return leftTime - rightTime;
    });
    let equity = this.startingEquityUsd;
    let peakEquity = equity;
    let maxDrawdownUsd = 0;
    let maxDrawdownPct = 0;
    for (const trade of chronological) {
      equity += finiteNumber(trade.pnl) ?? 0;
      peakEquity = Math.max(peakEquity, equity);
      maxDrawdownUsd = Math.max(maxDrawdownUsd, peakEquity - equity);
      maxDrawdownPct = Math.max(maxDrawdownPct, peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0);
    }
    const currentDrawdownUsd = peakEquity - equity;
    const currentUtcDate = new Date(nowMs).toISOString().slice(0, 10);
    const dailyPnl = settledTrades.reduce((sum, trade) => {
      const settledDate = String(trade.settled_at ?? "").slice(0, 10);
      return settledDate === currentUtcDate ? sum + (finiteNumber(trade.pnl) ?? 0) : sum;
    }, 0);

    return {
      updated_at: new Date(nowMs).toISOString(),
      total_trades: this.trades.length,
      settled_trades: settledTrades.length,
      pending_trades: pendingTrades.length,
      wins,
      losses,
      win_rate_pct: settledTrades.length ? (wins / settledTrades.length) * 100 : 0,
      settled_stake_usd: settledStake,
      settled_payout_usd: settledPayout,
      realized_pnl_usd: realizedPnl,
      realized_return_pct: settledStake > 0 ? (realizedPnl / settledStake) * 100 : 0,
      pending_stake_usd: pendingStake,
      starting_equity_usd: this.startingEquityUsd,
      realized_equity_usd: equity,
      available_equity_usd: equity - pendingStake,
      pending_exposure_usd: pendingStake,
      peak_equity_usd: peakEquity,
      current_drawdown_usd: currentDrawdownUsd,
      current_drawdown_pct: peakEquity > 0 ? (currentDrawdownUsd / peakEquity) * 100 : 0,
      max_drawdown_usd: maxDrawdownUsd,
      max_drawdown_pct: maxDrawdownPct,
      daily_pnl_usd: dailyPnl
    };
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
    atomicWriteFileSync(this.filePath, `${lines.join("\n")}\n`);
  }
}