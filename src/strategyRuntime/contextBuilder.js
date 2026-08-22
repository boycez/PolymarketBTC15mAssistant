function ageMs(nowMs, timestampMs) {
  return Number.isFinite(timestampMs) ? Math.max(0, nowMs - timestampMs) : null;
}

export function normalizeEpochMs(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (timestamp >= 1e17) return Math.trunc(timestamp / 1e6);
  if (timestamp >= 1e14) return Math.trunc(timestamp / 1e3);
  if (timestamp >= 1e11) return Math.trunc(timestamp);
  return Math.trunc(timestamp * 1e3);
}

function compactBook(book) {
  if (!book) return null;
  return {
    bestBid: book.bestBid ?? null,
    bestAsk: book.bestAsk ?? null,
    spread: book.spread ?? null,
    bidLiquidity: book.bidLiquidity ?? null,
    askLiquidity: book.askLiquidity ?? null,
    asks: Array.isArray(book.asks) ? book.asks.slice(0, 5).map(({ price, size }) => ({ price, size })) : []
  };
}

export function buildStrategyMarketContext({
  nowMs,
  pollStartedAtMs,
  remainingMinutes,
  windowMinutes,
  market,
  marketPrices,
  orderBooks,
  indicators,
  latestKline,
  binanceWsAtMs,
  polymarketCurrentAtMs,
  chainlinkAtMs,
  twapObservedAtMs,
  twapFreshnessMs,
  streamHealth
}) {
  const normalizedBinanceWsAtMs = normalizeEpochMs(binanceWsAtMs);
  const normalizedPolymarketCurrentAtMs = normalizeEpochMs(polymarketCurrentAtMs);
  const normalizedChainlinkAtMs = normalizeEpochMs(chainlinkAtMs);
  const normalizedTwapObservedAtMs = normalizeEpochMs(twapObservedAtMs);
  const latestKlineCloseTimeMs = Number.isFinite(latestKline?.closeTime) ? latestKline.closeTime : null;
  const latestKlineClosed = latestKlineCloseTimeMs === null ? null : latestKlineCloseTimeMs < nowMs;
  const timestamps = [normalizedBinanceWsAtMs, normalizedPolymarketCurrentAtMs, normalizedChainlinkAtMs, normalizedTwapObservedAtMs].filter(Number.isFinite);
  const sourceTimestampRangeMs = timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : null;
  const reasons = [];
  const limitations = [
    "binance_ticker_timestamp_unavailable",
    "market_quote_timestamp_unavailable",
    "order_book_timestamp_unavailable"
  ];

  if (latestKlineClosed === false) reasons.push("unfinished_kline");
  if (latestKlineCloseTimeMs === null) reasons.push("kline_timestamp_unavailable");
  if (!Number.isFinite(normalizedBinanceWsAtMs)) reasons.push("binance_ws_timestamp_unavailable");
  if (!Number.isFinite(normalizedPolymarketCurrentAtMs)) reasons.push("polymarket_current_timestamp_unavailable");
  if (!Number.isFinite(normalizedTwapObservedAtMs)) reasons.push("twap_timestamp_unavailable");
  if (!Number.isFinite(marketPrices?.up) || !Number.isFinite(marketPrices?.down)) reasons.push("market_quote_incomplete");
  if (!Number.isFinite(orderBooks?.up?.bestAsk)) reasons.push("up_book_incomplete");
  if (!Number.isFinite(orderBooks?.down?.bestAsk)) reasons.push("down_book_incomplete");

  return {
    strategy: {
      remainingMinutes,
      windowMinutes,
      marketPrices,
      indicators
    },
    market: {
      id: String(market?.id ?? ""),
      slug: String(market?.slug ?? ""),
      eventStartTime: market?.eventStartTime ?? market?.startTime ?? market?.startDate ?? null,
      endDate: market?.endDate ?? null,
      remainingMinutes,
      prices: marketPrices,
      orderBooks: { up: compactBook(orderBooks?.up), down: compactBook(orderBooks?.down) }
    },
    sources: {
      pollStartedAt: new Date(pollStartedAtMs).toISOString(),
      receivedAt: new Date(nowMs).toISOString(),
      pollLatencyMs: Math.max(0, nowMs - pollStartedAtMs),
      latestKlineOpenTimeMs: latestKline?.openTime ?? null,
      latestKlineCloseTimeMs,
      latestKlineClosed,
      klineAgeMs: ageMs(nowMs, latestKlineCloseTimeMs),
      binanceWsAtMs: normalizedBinanceWsAtMs,
      binanceWsAgeMs: ageMs(nowMs, normalizedBinanceWsAtMs),
      binanceTickerAgeMs: null,
      marketQuoteAgeMs: null,
      orderBookAgeMs: null,
      polymarketCurrentAtMs: normalizedPolymarketCurrentAtMs,
      polymarketCurrentAgeMs: ageMs(nowMs, normalizedPolymarketCurrentAtMs),
      chainlinkAtMs: normalizedChainlinkAtMs,
      chainlinkAgeMs: ageMs(nowMs, normalizedChainlinkAtMs),
      twapObservedAtMs: normalizedTwapObservedAtMs,
      twapFreshnessMs: twapFreshnessMs ?? null,
      sourceTimestampRangeMs,
      timestampSemantics: "mixed_source_and_receive",
      streamHealth
    },
    dataQuality: {
      valid: reasons.length === 0,
      reasons,
      limitations,
      observationOnly: true
    }
  };
}