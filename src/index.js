import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import { startPolymarketTwapStream } from "./data/polymarketTwapWs.js";
import {
  fetchMarketById,
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { appendCsvRow, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { ReferencePriceGate } from "./referencePrice.js";
import { acquireLivePrivateKey, acquireLiveRelayerApiKey } from "./security/terminalSecret.js";
import { createTradingRuntime } from "./trading/createTradingRuntime.js";
import { formatRecommendationReason, strategyGateCategory } from "./trading/strategy.js";
import { createRuntimeSnapshot } from "./dashboard/runtimeSnapshot.js";
import { renderTerminalDashboard } from "./dashboard/terminalRenderer.js";
import { pathToFileURL } from "node:url";
import { StreamHealthMonitor } from "./engine/streamHealth.js";
import { resolveStrategyPlugin } from "./strategies/registry.js";
import { strategyKey } from "./strategies/contract.js";
import { DecisionResearchRecorder } from "./research/decisionRecorder.js";
import { resolveCodeCommit, strategyConfigFingerprint } from "./research/strategyIdentity.js";
import { MarketOutcomeTracker } from "./research/outcomeTracker.js";

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

applyGlobalProxyFromEnv();

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

let alternateScreenActive = false;
let terminalInputCleanup = null;

function restoreTerminalScreen() {
  if (!alternateScreenActive) return;
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  alternateScreenActive = false;
}

process.once("exit", restoreTerminalScreen);

function restoreTerminalInput() {
  if (!terminalInputCleanup) return;
  terminalInputCleanup();
  terminalInputCleanup = null;
}

process.once("exit", restoreTerminalInput);

function startLiveKeyboardControls({ runtime, onShutdown }) {
  if (runtime.mode !== "live" || !process.stdin?.isTTY || !process.stdout?.isTTY) return false;

  let inputBusy = false;
  const onData = (key) => {
    if (key === "\u0003") {
      void onShutdown("SIGINT");
      return;
    }
    if (key === "\r" || key === "\n") {
      runtime.confirmArm();
      return;
    }
    if (key === "\u001b") {
      runtime.cancelArm();
      return;
    }
    if (String(key).toLowerCase() === "a") {
      runtime.requestArm();
      return;
    }
    if (String(key).toLowerCase() === "s" && !inputBusy) {
      inputBusy = true;
      void runtime.disarm().finally(() => {
        inputBusy = false;
      });
    }
  };

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", onData);
  terminalInputCleanup = () => {
    process.stdin.off("data", onData);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  };
  return true;
}

function renderScreen(text) {
  if (process.stdout?.isTTY) {
    if (!alternateScreenActive) {
      process.stdout.write("\x1b[?1049h\x1b[?25l");
      alternateScreenActive = true;
    }
    process.stdout.write(`\x1b[H\x1b[2J${text}`);
    return;
  }

  process.stdout.write(text);
}


function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const dumpedMarkets = new Set();
const loggedStrategyGates = new Set();

function safeFileSlug(x) {
  return String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat",
    "price_to_beat",
    "strikePrice",
    "strike_price",
    "strike",
    "threshold",
    "thresholdPrice",
    "threshold_price",
    "targetPrice",
    "target_price",
    "referencePrice",
    "reference_price"
  ];

  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }

  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];

  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object") continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);

    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === "object") {
        stack.push({ obj: value, depth: depth + 1 });
        continue;
      }

      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;

      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n)) continue;

      if (n > 1000 && n < 2_000_000) return n;
    }
  }

  return null;
}

function priceToBeatFromPolymarketMarket(market) {
  const n = extractNumericFromMarket(market);
  if (n !== null) return n;
  return parsePriceToBeat(market);
}

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null, bids: [], asks: [], minOrderSize: null, tickSize: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null, bids: [], asks: [], minOrderSize: null, tickSize: null };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBuy = yesBuy;
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = null;
    downBuy = null;
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null,
      bids: [],
      asks: [],
      minOrderSize: Number(market.orderMinSize) || null,
      tickSize: Number(market.orderPriceMinTickSize) || null
    };
    downBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null,
      bids: [],
      asks: [],
      minOrderSize: Number(market.orderMinSize) || null,
      tickSize: Number(market.orderPriceMinTickSize) || null
    };
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upBuy ?? gammaYes,
      down: downBuy ?? gammaNo
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

export async function runApplication({
  renderDashboard = true,
  onSnapshot = () => {},
  onShutdown = async () => {},
  onRuntimeReady = async () => {},
  externalControlsEnabled = false
} = {}) {
  const strategyPlugin = resolveStrategyPlugin(CONFIG.paperTrading.strategy);
  const activeTradingConfig = CONFIG.trading.mode === "live" ? CONFIG.liveTrading : CONFIG.paperTrading;
  const strategyIdentity = {
    id: strategyPlugin.id,
    version: strategyPlugin.version,
    key: strategyKey(strategyPlugin),
    configFingerprint: strategyConfigFingerprint(activeTradingConfig),
    codeCommit: resolveCodeCommit()
  };
  const researchRecorder = new DecisionResearchRecorder(CONFIG.research);
  const outcomeTracker = new MarketOutcomeTracker({
    filePath: CONFIG.research.outcomeFilePath,
    eventFilePath: CONFIG.research.filePath,
    pendingFilePath: CONFIG.research.pendingFilePath,
    pollIntervalMs: CONFIG.research.outcomePollIntervalMs,
    fetchMarket: async (pendingMarket) => {
      if (pendingMarket.id) {
        const market = await fetchMarketById(pendingMarket.id);
        if (market) return market;
      }
      return await fetchMarketBySlug(pendingMarket.slug);
    }
  });
  const livePrivateKey = await acquireLivePrivateKey({
    mode: CONFIG.trading.mode,
    enabled: CONFIG.liveTrading.enabled
  });
  const liveRelayerApiKey = await acquireLiveRelayerApiKey({
    mode: CONFIG.trading.mode,
    enabled: CONFIG.liveTrading.enabled
  });
  const tradingRuntime = await createTradingRuntime({
    mode: CONFIG.trading.mode,
    paperConfig: CONFIG.paperTrading,
    liveConfig: {
      ...CONFIG.liveTrading,
      strategyId: strategyIdentity.id,
      strategyVersion: strategyIdentity.version,
      configFingerprint: strategyIdentity.configFingerprint,
      privateKey: livePrivateKey,
      relayerApiKey: liveRelayerApiKey
    }
  });
  await onRuntimeReady(tradingRuntime);
  let shuttingDown = false;
  let streamHealthMonitor = null;
  let managedStreams = [];
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    restoreTerminalInput();
    restoreTerminalScreen();
    try {
      if (CONFIG.trading.mode === "live" && CONFIG.liveTrading.enabled && CONFIG.liveTrading.cancelOnExit) {
        await tradingRuntime.cancelAll();
        console.log(`Live kill switch completed on ${signal}: all open orders canceled.`);
      }
    } catch (error) {
      console.error(`Live kill switch failed on ${signal}: ${error?.message ?? String(error)}`);
      process.exitCode = 1;
    } finally {
      streamHealthMonitor?.stop();
      for (const stream of managedStreams) stream.close();
      try {
        await onShutdown(signal);
      } catch (error) {
        console.error(`Shutdown cleanup failed on ${signal}: ${error?.message ?? String(error)}`);
        process.exitCode = 1;
      }
      process.exit();
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  const liveKeyboardEnabled = renderDashboard
    ? startLiveKeyboardControls({ runtime: tradingRuntime, onShutdown: shutdown })
    : false;
  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});
  const twapStream = startPolymarketTwapStream({});
  managedStreams = [binanceStream, polymarketLiveStream, chainlinkStream, twapStream];
  streamHealthMonitor = new StreamHealthMonitor({
    streams: [
      { name: "binance", stream: binanceStream, staleAfterMs: CONFIG.streamHealth.binanceStaleMs },
      { name: "polymarket_current", stream: polymarketLiveStream, staleAfterMs: CONFIG.streamHealth.polymarketLiveStaleMs },
      { name: "chainlink_fallback", stream: chainlinkStream, staleAfterMs: null },
      { name: "polymarket_twap", stream: twapStream, staleAfterMs: CONFIG.streamHealth.twapStaleMs }
    ],
    checkIntervalMs: CONFIG.streamHealth.checkIntervalMs,
    restartCooldownMs: CONFIG.streamHealth.restartCooldownMs
  });
  streamHealthMonitor.start();
  const referenceGate = new ReferencePriceGate({
    stream: twapStream,
    ...CONFIG.referenceData
  });

  let prevSpotPrice = null;
  let prevCurrentPrice = null;

  const header = [
    "timestamp",
    "entry_minute",
    "time_left_min",
    "regime",
    "signal",
    "model_up",
    "model_down",
    "mkt_up",
    "mkt_down",
    "edge_up",
    "edge_down",
    "recommendation"
  ];
  const strategyGateHeader = [
    "timestamp",
    "mode",
    "market_slug",
    "time_left_min",
    "regime",
    "recommendation",
    "model_up",
    "model_down",
    "market_up",
    "market_down",
    "quoted_edge_up",
    "quoted_edge_down",
    "gate_reason"
  ];

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);
    const pollStartedAtMs = Date.now();

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;

    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;

    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines1m, klines5m, lastPrice, chainlink, poly] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchKlines({ interval: "5m", limit: 200 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);
      const marketDataReceivedAtMs = Date.now();

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;

      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;
      const reference = referenceGate.evaluate(poly.ok ? poly.market : null);

      const candles = klines1m;
      const closes = candles.map((c) => c.close);

      const vwap = computeSessionVwap(candles);
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];

      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const sub = closes.slice(0, i + 1);
        const r = computeRsi(sub, CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      const regimeInfo = detectRegime({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        vwapCrossCount,
        volumeRecent,
        volumeAvg
      });

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const strategyEvaluation = strategyPlugin.evaluate({
        remainingMinutes: timeLeftMin,
        windowMinutes: CONFIG.candleWindowMinutes,
        marketPrices: { up: marketUp, down: marketDown },
        indicators: {
          price: lastPrice,
          vwap: vwapNow,
          vwapSlope,
          rsi: rsiNow,
          rsiSlope,
          macd,
          heikenColor: consec.color,
          heikenCount: consec.count,
          failedVwapReclaim
        }
      });
      const { scored, timeAware, edge, recommendation: rec } = strategyEvaluation;

      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";

      const macdLabel = macd === null
        ? "-"
        : macd.hist < 0
          ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
          : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (expanding)" : "bullish");

      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

      const pLong = timeAware?.adjustedUp ?? null;
      const pShort = timeAware?.adjustedDown ?? null;

      const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";
      const liquidity = poly.ok
        ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null)
        : null;

      await tradingRuntime.settlePending();
      const tradingStatus = await tradingRuntime.observe({
        market: poly.ok ? poly.market : null,
        tokens: poly.ok ? poly.tokens : null,
        recommendation: rec,
        orderBooks: poly.ok ? poly.orderbook : null,
        modelUp: timeAware.adjustedUp,
        modelDown: timeAware.adjustedDown,
        remainingMinutes: timeLeftMin,
        regime: regimeInfo.regime,
        reference
      });
      const tradingSummary = tradingRuntime.getSummary();

      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = reference.currentTwap === null ? null : Number(reference.currentTwap);
      const priceToBeat = reference.priceToBeat === null ? null : Number(reference.priceToBeat);
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";

      researchRecorder.record({
        schemaVersion: 1,
        recordedAt: new Date(marketDataReceivedAtMs).toISOString(),
        strategy: strategyIdentity,
        market: {
          id: poly.ok ? String(poly.market?.id ?? "") : "",
          slug: marketSlug,
          eventStartTime: poly.ok ? poly.market?.eventStartTime ?? poly.market?.startTime ?? poly.market?.startDate ?? null : null,
          endDate: poly.ok ? poly.market?.endDate ?? null : null,
          timeLeftMinutes: timeLeftMin,
          upQuote: marketUp,
          downQuote: marketDown
        },
        sources: {
          pollStartedAt: new Date(pollStartedAtMs).toISOString(),
          receivedAt: new Date(marketDataReceivedAtMs).toISOString(),
          latestKlineOpenTimeMs: lastCandle?.openTime ?? null,
          latestKlineCloseTimeMs: lastCandle?.closeTime ?? null,
          latestKlineClosed: Number.isFinite(lastCandle?.closeTime) ? lastCandle.closeTime < marketDataReceivedAtMs : null,
          binanceWsAtMs: wsTick?.ts ?? null,
          polymarketCurrentAtMs: polymarketWsTick?.updatedAt ?? null,
          chainlinkAtMs: chainlink?.updatedAt ?? null,
          twapObservedAtMs: reference.currentObservedAtMs ?? null,
          twapFreshnessMs: reference.freshnessMs ?? null,
          streamHealth: streamHealthMonitor.getSnapshot()
        },
        indicators: {
          price: lastPrice,
          vwap: vwapNow,
          vwapSlope,
          rsi: rsiNow,
          rsiSlope,
          macd: macd === null ? null : { value: macd.macd, signal: macd.signal, histogram: macd.hist, histogramDelta: macd.histDelta },
          heikenColor: consec.color,
          heikenCount: consec.count,
          failedVwapReclaim,
          regime: regimeInfo.regime
        },
        decision: strategyEvaluation,
        execution: {
          upBook: poly.ok ? { bestBid: poly.orderbook.up.bestBid, bestAsk: poly.orderbook.up.bestAsk, spread: poly.orderbook.up.spread, askLiquidity: poly.orderbook.up.askLiquidity } : null,
          downBook: poly.ok ? { bestBid: poly.orderbook.down.bestBid, bestAsk: poly.orderbook.down.bestAsk, spread: poly.orderbook.down.spread, askLiquidity: poly.orderbook.down.askLiquidity } : null,
          status: tradingStatus.state,
          gateReason: tradingStatus.text
        },
        reference: {
          state: reference.state,
          tradingAllowed: reference.tradingAllowed,
          reason: reference.reason,
          priceToBeatE18: reference.priceToBeatE18 ?? null,
          priceToBeat: reference.priceToBeat ?? null
        }
      }, marketDataReceivedAtMs);

      if (CONFIG.polymarket.dumpMarketSnapshots && poly.ok && poly.market && priceToBeat === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            const fs = await import("node:fs");
            const path = await import("node:path");
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
          } catch {
            // ignore
          }
        }
      }

      const titleLine = poly.ok ? `${poly.market?.question ?? "-"}` : "-";

      const strategyConstraints = tradingRuntime.getStrategyConstraints();
      const recommendationText = (() => {
        if (!reference.tradingAllowed) return `NO TRADE: reference ${reference.state}`;
        if (rec.action !== "ENTER") return `NO TRADE: ${formatRecommendationReason(rec.reason)}`;
        if (timeLeftMin < strategyConstraints.minRemainingMinutes || timeLeftMin > strategyConstraints.maxRemainingMinutes) {
          return "NO TRADE: outside entry window";
        }
        const expectedRegime = rec.side === "UP" ? "TREND_UP" : "TREND_DOWN";
        if (strategyConstraints.requireTrendAlignment && regimeInfo.regime !== expectedRegime) {
          return `NO TRADE: ${rec.side} requires ${expectedRegime}`;
        }
        return `BUY ${rec.side}: ${rec.phase} ${rec.strength}`;
      })();
      const tradingAccount = tradingRuntime.getAccountIdentity();
      const tradingControl = tradingRuntime.getControlState();
      const tradingControlHelp = tradingControl.state === "PENDING_CONFIRMATION"
        ? "Enter confirm | Esc cancel | S stop"
        : tradingControl.state === "UNAVAILABLE"
          ? "Live controls unavailable"
        : liveKeyboardEnabled
          ? "A enable | S stop"
          : externalControlsEnabled
            ? "A enable | S stop | X cancel orders"
          : "Interactive terminal required";

      const dashboardSnapshot = createRuntimeSnapshot({
        generatedAtMs: Date.now(),
        market: {
          title: titleLine,
          slug: marketSlug || "-",
          timeLeftMinutes: timeLeftMin,
          polymarketUp: marketUp,
          polymarketDown: marketDown,
          liquidityUsd: liquidity,
          priceToBeatUsd: priceToBeat,
          currentPriceUsd: currentPrice,
          previousCurrentPriceUsd: prevCurrentPrice,
          binancePriceUsd: spotPrice,
          previousBinancePriceUsd: prevSpotPrice
        },
        signal: {
          modelUp: pLong,
          modelDown: pShort,
          heikenColor: consec.color,
          heikenCount: consec.count,
          rsi: rsiNow,
          rsiSlope,
          macdLabel,
          macdHistogram: macd?.hist ?? null,
          delta1m,
          delta3m,
          deltaBase: lastClose,
          vwap: vwapNow,
          vwapDistance: vwapDist,
          vwapSlopeLabel,
          regime: regimeInfo.regime,
          recommendation: recommendationText
        },
        readiness: {
          state: reference.state,
          tradingAllowed: reference.tradingAllowed,
          freshnessMs: reference.freshnessMs,
          reason: reference.reason,
          observedAtMs: reference.currentObservedAtMs,
          source: "Chainlink BTC/USD TWAP 60s"
        },
        trading: {
          mode: tradingRuntime.mode,
          strategy: strategyIdentity,
          sectionTitle: tradingRuntime.sectionTitle,
          status: tradingStatus,
          account: tradingAccount,
          control: tradingControl,
          controlHelp: tradingControlHelp,
          pendingConfirmation: tradingControl.state === "PENDING_CONFIRMATION" ? {
            stakeUsd: CONFIG.liveTrading.stakeUsd,
            maxTradesPerSession: CONFIG.liveTrading.maxTradesPerSession,
            maxSlippage: CONFIG.liveTrading.maxSlippage
          } : null,
          summary: tradingSummary
        },
        session: { streamHealth: streamHealthMonitor.getSnapshot() }
      });

      onSnapshot(dashboardSnapshot);
      if (renderDashboard) {
        renderScreen(renderTerminalDashboard(dashboardSnapshot, { width: screenWidth() }));
      }

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;

      appendCsvRow("./logs/signals.csv", header, [
        new Date().toISOString(),
        timing.elapsedMinutes.toFixed(3),
        timeLeftMin.toFixed(3),
        regimeInfo.regime,
        signal,
        timeAware.adjustedUp,
        timeAware.adjustedDown,
        marketUp,
        marketDown,
        edge.edgeUp,
        edge.edgeDown,
        reference.tradingAllowed && rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE"
      ]);

      if (poly.ok && poly.market) outcomeTracker.observeMarket(poly.market, reference);
      void outcomeTracker.settlePending(marketDataReceivedAtMs);

      if (marketSlug && tradingStatus.state === "WAITING" && tradingStatus.text.startsWith("waiting:")) {
        const gateReason = tradingStatus.text.slice("waiting:".length).trim();
        const gateKey = `${tradingRuntime.mode}:${marketSlug}:${strategyGateCategory(gateReason)}`;
        if (!loggedStrategyGates.has(gateKey)) {
          loggedStrategyGates.add(gateKey);
          appendCsvRow("./logs/strategy_gate_events.csv", strategyGateHeader, [
            new Date().toISOString(),
            tradingRuntime.mode,
            marketSlug,
            timeLeftMin.toFixed(3),
            regimeInfo.regime,
            rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE",
            timeAware.adjustedUp,
            timeAware.adjustedDown,
            marketUp,
            marketDown,
            edge.edgeUp,
            edge.edgeDown,
            gateReason
          ]);
        }
      }
    } catch (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${err?.message ?? String(err)}`);
      console.log("────────────────────────────");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runApplication().catch((error) => {
    console.error(`Startup Error: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
