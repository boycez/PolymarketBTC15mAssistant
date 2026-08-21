import fs from "node:fs";
import path from "node:path";

import { fetchMarketBySlug } from "./data/polymarket.js";

const COLUMNS = [
  "strategy",
  "market_id",
  "market_slug",
  "market_end_time",
  "entry_time",
  "side",
  "entry_price",
  "stake_usd",
  "shares",
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
    strategy = "TA_EDGE_V1_1",
    confirmationSeconds = 30,
    minRemainingMinutes = 5,
    maxRemainingMinutes = 10,
    minExecutionEdge = 0.1,
    requireTrendAlignment = true,
    stakeUsd = 10,
    settlementPollMs = 30_000,
    filePath = "./logs/paper_trades.csv",
    summaryFilePath = "./logs/paper_summary.json",
    fetchMarket = fetchMarketBySlug
  } = {}) {
    this.enabled = enabled;
    this.strategy = strategy;
    this.confirmationMs = confirmationSeconds * 1_000;
    this.minRemainingMinutes = minRemainingMinutes;
    this.maxRemainingMinutes = maxRemainingMinutes;
    this.minExecutionEdge = minExecutionEdge;
    this.requireTrendAlignment = requireTrendAlignment;
    this.stakeUsd = stakeUsd;
    this.settlementPollMs = settlementPollMs;
    this.filePath = filePath;
    this.summaryFilePath = summaryFilePath;
    this.fetchMarket = fetchMarket;
    this.trades = this.#loadTrades();
    this.candidate = null;
    this.lastSettlementCheckMs = 0;
    this.#saveSummary();
  }

  observe({
    market,
    recommendation,
    entryPrices,
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

    const entryPrice = finiteNumber(side === "UP" ? entryPrices?.up : entryPrices?.down);
    const modelProbability = finiteNumber(side === "UP" ? modelUp : modelDown);
    const executionEdge = entryPrice === null || modelProbability === null
      ? null
      : modelProbability - entryPrice;
    const endTimeMs = new Date(market.endDate).getTime();
    if (
      entryPrice === null
      || entryPrice <= 0
      || entryPrice >= 1
      || executionEdge === null
      || executionEdge < this.minExecutionEdge
      || !Number.isFinite(endTimeMs)
    ) {
      this.candidate = null;
      return this.getStatus(marketSlug, nowMs);
    }

    const shares = this.stakeUsd / entryPrice;
    this.trades.push({
      strategy: this.strategy,
      market_id: String(market.id ?? ""),
      market_slug: marketSlug,
      market_end_time: new Date(endTimeMs).toISOString(),
      entry_time: new Date(nowMs).toISOString(),
      side,
      entry_price: entryPrice,
      stake_usd: this.stakeUsd,
      shares,
      model_probability: modelProbability,
      market_probability: entryPrice,
      execution_edge: executionEdge,
      signal_confirmed_seconds: this.confirmationMs / 1_000,
      time_left_minutes: remainingMinutes,
      regime: String(regime ?? ""),
      phase: String(recommendation.phase ?? ""),
      strength: String(recommendation.strength ?? ""),
      status: "PENDING",
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
      return trade.status === "PENDING" && Number.isFinite(endTimeMs) && endTimeMs <= nowMs;
    });

    const settledTrades = [];
    for (const trade of dueTrades) {
      try {
        const market = await this.fetchMarket(trade.market_slug);
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
    const pendingTrades = this.trades.filter((trade) => trade.status === "PENDING");
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