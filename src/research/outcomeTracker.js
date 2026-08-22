import fs from "node:fs";

import { getResolvedWinner } from "../paperTrading.js";
import { atomicWriteFileSync } from "../utils.js";
import { appendDailyJsonl, forEachJsonlEvent, listJsonlFiles } from "./jsonlStore.js";
import { createResearchEvent, RESEARCH_EVENT_TYPES } from "./schema.js";

async function withTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Outcome fetch timed out.")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class MarketOutcomeTracker {
  constructor({
    filePath = "./logs/research_outcomes.jsonl",
    eventFilePath = "./logs/research_events.jsonl",
    pendingFilePath = "./logs/research_pending_markets.json",
    pollIntervalMs = 30_000,
    fetchTimeoutMs = 10_000,
    maxMarketsPerPoll = 4,
    fetchMarket
  } = {}) {
    if (typeof fetchMarket !== "function") throw new Error("MarketOutcomeTracker requires fetchMarket().");
    this.filePath = filePath;
    this.eventFilePath = eventFilePath;
    this.pendingFilePath = pendingFilePath;
    this.pollIntervalMs = pollIntervalMs;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.maxMarketsPerPoll = maxMarketsPerPoll;
    this.fetchMarket = fetchMarket;
    this.lastPollAtMs = 0;
    this.lastError = null;
    this.settlementInFlight = false;
    this.resolved = this.#loadResolved();
    this.pending = this.#loadPending();
  }

  observeMarket(market, reference = {}) {
    const slug = String(market?.slug ?? "").trim();
    const endTimeMs = Date.parse(market?.endDate);
    if (!slug || !Number.isFinite(endTimeMs) || this.resolved.has(slug)) return false;

    const existing = this.pending.get(slug);
    if (existing) {
      const priceToBeatE18 = reference.priceToBeatE18 ?? existing.priceToBeatE18;
      const priceToBeat = reference.priceToBeat ?? existing.priceToBeat;
      if (priceToBeatE18 === existing.priceToBeatE18 && priceToBeat === existing.priceToBeat) return false;
      try {
        this.pending.set(slug, { ...existing, priceToBeatE18, priceToBeat });
        this.#savePending();
        this.lastError = null;
        return true;
      } catch (error) {
        this.pending.set(slug, existing);
        this.lastError = error?.message ?? String(error);
        return false;
      }
    }

    try {
      this.pending.set(slug, {
        id: String(market?.id ?? ""),
        slug,
        eventStartTime: market?.eventStartTime ?? market?.startTime ?? market?.startDate ?? null,
        endDate: new Date(endTimeMs).toISOString(),
        priceToBeatE18: reference.priceToBeatE18 ?? null,
        priceToBeat: reference.priceToBeat ?? null
      });
      this.#savePending();
      this.lastError = null;
      return true;
    } catch (error) {
      this.pending.delete(slug);
      this.lastError = error?.message ?? String(error);
      return false;
    }
  }

  async settlePending(nowMs = Date.now()) {
    if (this.settlementInFlight || nowMs - this.lastPollAtMs < this.pollIntervalMs) return [];
    this.lastPollAtMs = nowMs;
    this.settlementInFlight = true;
    const settled = [];
    let pendingChanged = false;
    let processed = 0;

    try {
      for (const pendingMarket of this.pending.values()) {
        if (this.resolved.has(pendingMarket.slug)) {
          this.pending.delete(pendingMarket.slug);
          pendingChanged = true;
          continue;
        }
        if (Date.parse(pendingMarket.endDate) > nowMs) continue;
        if (processed >= this.maxMarketsPerPoll) break;
        processed += 1;
        try {
          const market = await withTimeout(this.fetchMarket(pendingMarket), this.fetchTimeoutMs);
          const winner = getResolvedWinner(market);
          if (!winner) continue;
          const event = createResearchEvent(RESEARCH_EVENT_TYPES.OUTCOME, {
            market: {
              id: pendingMarket.id,
              slug: pendingMarket.slug,
              eventStartTime: pendingMarket.eventStartTime,
              endDate: pendingMarket.endDate
            },
            outcome: {
              winner,
              resolvedAt: new Date(nowMs).toISOString(),
              priceToBeatE18: pendingMarket.priceToBeatE18,
              priceToBeat: pendingMarket.priceToBeat
            }
          }, nowMs);
          appendDailyJsonl(this.filePath, event, nowMs);
          this.resolved.add(pendingMarket.slug);
          this.pending.delete(pendingMarket.slug);
          pendingChanged = true;
          settled.push(event);
          this.lastError = null;
        } catch (error) {
          this.lastError = error?.message ?? String(error);
        }
      }
      if (pendingChanged) {
        try {
          this.#savePending();
        } catch (error) {
          this.lastError = error?.message ?? String(error);
        }
      }
      return settled;
    } finally {
      this.settlementInFlight = false;
    }
  }

  #loadPending() {
    try {
      const entries = JSON.parse(fs.readFileSync(this.pendingFilePath, "utf8"));
      if (!Array.isArray(entries)) throw new Error("Pending market state must be an array.");
      return new Map(entries.filter((entry) => entry?.slug && !this.resolved.has(entry.slug)).map((entry) => [entry.slug, entry]));
    } catch (error) {
      if (error?.code === "ENOENT") return new Map();
      this.lastError = `Pending market state recovery: ${error?.message ?? String(error)}`;
      return this.#recoverPendingFromDecisions();
    }
  }

  #loadResolved() {
    const resolved = new Set();
    try {
      forEachJsonlEvent(listJsonlFiles(this.filePath), (event) => {
        if (event.eventType === RESEARCH_EVENT_TYPES.OUTCOME && event.market?.slug) resolved.add(event.market.slug);
      });
    } catch (error) {
      this.lastError = `Outcome history unavailable: ${error?.message ?? String(error)}`;
    }
    return resolved;
  }

  #recoverPendingFromDecisions() {
    const recovered = new Map();
    try {
      forEachJsonlEvent(listJsonlFiles(this.eventFilePath), (event) => {
        const market = event.eventType === RESEARCH_EVENT_TYPES.DECISION ? event.market : null;
        if (!market?.slug || !market?.endDate || this.resolved.has(market.slug)) return;
        recovered.set(market.slug, {
          id: String(market.id ?? ""),
          slug: market.slug,
          eventStartTime: market.eventStartTime ?? null,
          endDate: market.endDate,
          priceToBeatE18: event.reference?.priceToBeatE18 ?? null,
          priceToBeat: event.reference?.priceToBeat ?? null
        });
      });
    } catch (error) {
      this.lastError = `${this.lastError}; decision recovery unavailable: ${error?.message ?? String(error)}`;
    }
    return recovered;
  }

  #savePending() {
    atomicWriteFileSync(this.pendingFilePath, `${JSON.stringify([...this.pending.values()], null, 2)}\n`);
  }
}