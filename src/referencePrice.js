import fs from "node:fs";
import path from "node:path";

import { formatE18 } from "./data/polymarketTwapWs.js";

const COLUMNS = [
  "market_id",
  "market_slug",
  "market_start_time",
  "market_end_time",
  "symbol",
  "window_seconds",
  "price_e18",
  "price_decimal",
  "observed_at",
  "source",
  "validation"
];

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

function decimalDifference(left, right) {
  if (!left || !right) return null;
  const difference = Number(left) - Number(right);
  return Number.isFinite(difference) ? difference : null;
}

export class ReferencePriceGate {
  constructor({
    stream,
    filePath = "./logs/market_references.csv",
    symbol = "btc/usd",
    windowSeconds = 60,
    captureGraceMs = 5_000,
    freshnessMs = 5_000
  }) {
    this.stream = stream;
    this.filePath = filePath;
    this.symbol = symbol;
    this.windowSeconds = windowSeconds;
    this.captureGraceMs = captureGraceMs;
    this.freshnessMs = freshnessMs;
    this.references = this.#load();
    this.missedMarkets = new Set();
  }

  evaluate(market, nowMs = Date.now()) {
    if (!market?.slug) return this.#state("SYNCING", "market_not_available", { nowMs });

    const startMs = new Date(market.eventStartTime).getTime();
    const endMs = new Date(market.endDate).getTime();
    const config = market.cryptoMarketConfig ?? {};
    const validMarket = Number.isFinite(startMs)
      && Number.isFinite(endMs)
      && String(config.asset ?? "").toLowerCase() === "btc"
      && config.twapEnabled === true
      && Number(config.twapLookbackSeconds) === this.windowSeconds;
    if (!validMarket) return this.#state("DEGRADED", "unsupported_market_config", { market, startMs, endMs, nowMs });

    const key = String(market.id ?? market.slug);
    let reference = this.references.get(key) ?? null;
    if (reference) {
      const persistedStartMs = new Date(reference.observed_at).getTime();
      const persistedValid = reference.validation === "VALID"
        && reference.market_slug === String(market.slug)
        && reference.symbol === this.symbol
        && Number(reference.window_seconds) === this.windowSeconds
        && persistedStartMs === startMs
        && formatE18(reference.price_e18) === reference.price_decimal;
      if (!persistedValid) reference = null;
    }
    if (!reference && nowMs >= startMs) {
      const sample = this.stream.getAt(startMs);
      if (sample && sample.symbol === this.symbol && sample.windowSeconds === this.windowSeconds) {
        reference = {
          market_id: String(market.id ?? ""),
          market_slug: String(market.slug),
          market_start_time: new Date(startMs).toISOString(),
          market_end_time: new Date(endMs).toISOString(),
          symbol: this.symbol,
          window_seconds: this.windowSeconds,
          price_e18: sample.priceE18,
          price_decimal: sample.priceDecimal,
          observed_at: new Date(sample.observedAtMs).toISOString(),
          source: sample.source,
          validation: "VALID"
        };
        this.references.set(key, reference);
        this.missedMarkets.delete(key);
        this.#save();
      }
    }

    if (!reference) {
      if (this.missedMarkets.has(key)) {
        return this.#state("MISSED_WINDOW", "start_twap_not_captured", { market, startMs, endMs, nowMs });
      }
      if (nowMs < startMs) return this.#state("ARMED", "waiting_for_market_start", { market, startMs, endMs, nowMs });
      if (nowMs <= startMs + this.captureGraceMs) return this.#state("SYNCING", "waiting_for_start_twap", { market, startMs, endMs, nowMs });
      this.missedMarkets.add(key);
      return this.#state("MISSED_WINDOW", "start_twap_not_captured", { market, startMs, endMs, nowMs });
    }

    const last = this.stream.getLast();
    if (!this.stream.isConnected()) {
      return this.#state("DEGRADED", "twap_stream_disconnected", { market, startMs, endMs, reference, last, nowMs });
    }
    if (!last || nowMs - last.observedAtMs > this.freshnessMs || last.observedAtMs > nowMs + 1_000) {
      return this.#state("DEGRADED", "twap_stream_stale", { market, startMs, endMs, reference, last, nowMs });
    }

    return this.#state("READY", "validated", { market, startMs, endMs, reference, last, nowMs });
  }

  #state(state, reason, context = {}) {
    const reference = context.reference ?? null;
    const current = context.last ?? this.stream?.getLast?.() ?? null;
    return {
      state,
      reason,
      tradingAllowed: state === "READY",
      marketId: context.market?.id ? String(context.market.id) : null,
      marketSlug: context.market?.slug ? String(context.market.slug) : null,
      marketStartMs: Number.isFinite(context.startMs) ? context.startMs : null,
      marketEndMs: Number.isFinite(context.endMs) ? context.endMs : null,
      source: reference?.source ?? current?.source ?? "polymarket_rtds_chainlink_twap",
      priceToBeatE18: reference?.price_e18 ?? null,
      priceToBeat: reference?.price_decimal ?? null,
      currentTwapE18: current?.priceE18 ?? null,
      currentTwap: current?.priceDecimal ?? null,
      currentObservedAtMs: current?.observedAtMs ?? null,
      distance: decimalDifference(current?.priceDecimal, reference?.price_decimal),
      freshnessMs: current?.observedAtMs ? Math.max(0, (context.nowMs ?? Date.now()) - current.observedAtMs) : null
    };
  }

  #load() {
    const records = new Map();
    if (!fs.existsSync(this.filePath)) return records;
    const lines = fs.readFileSync(this.filePath, "utf8").trim().split("\n");
    if (lines.length < 2) return records;
    const columns = parseCsvLine(lines[0]);
    for (const line of lines.slice(1).filter(Boolean)) {
      const values = parseCsvLine(line);
      const record = Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
      if (record.validation !== "VALID" || !record.price_e18 || formatE18(record.price_e18) !== record.price_decimal) continue;
      records.set(record.market_id || record.market_slug, record);
    }
    return records;
  }

  #save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lines = [COLUMNS.join(",")];
    for (const reference of this.references.values()) {
      lines.push(COLUMNS.map((column) => csvValue(reference[column])).join(","));
    }
    fs.writeFileSync(this.filePath, `${lines.join("\n")}\n`, "utf8");
  }
}