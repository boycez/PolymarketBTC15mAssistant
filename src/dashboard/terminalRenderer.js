import { formatNumber, formatPct } from "../utils.js";

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  softWhite: "\x1b[37m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

const LABEL_WIDTH = 18;

export function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function kv(label, value) {
  const text = String(label);
  return `${text}${" ".repeat(Math.max(0, LABEL_WIDTH - stripAnsi(text).length))}${value}`;
}

function section(title) {
  return `${ANSI.softWhite}${String(title).toUpperCase()}${ANSI.reset}`;
}

function separator(width) {
  return `${ANSI.white}${"─".repeat(width)}${ANSI.reset}`;
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  return " ".repeat(left) + text + " ".repeat(width - visible - left);
}

function fmtTimeLeft(minutes) {
  const totalSeconds = Math.max(0, Math.floor(Number(minutes) * 60));
  const wholeMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(wholeMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatProbPct(probability) {
  if (probability === null || probability === undefined || !Number.isFinite(Number(probability))) return "-";
  return `${(Number(probability) * 100).toFixed(0)}%`;
}

function narrativeFromSign(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) === 0) return "NEUTRAL";
  return Number(value) > 0 ? "LONG" : "SHORT";
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const percent = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${percent.toFixed(2)}%`;
}

function priceValue({ price, previousPrice, decimals, prefix }) {
  if (price === null || price === undefined) return `${ANSI.gray}-${ANSI.reset}`;
  const numericPrice = Number(price);
  const previous = previousPrice === null || previousPrice === undefined ? null : Number(previousPrice);
  let color = ANSI.reset;
  let arrow = "";
  if (previous !== null && Number.isFinite(previous) && Number.isFinite(numericPrice) && numericPrice !== previous) {
    color = numericPrice > previous ? ANSI.green : ANSI.red;
    arrow = numericPrice > previous ? " ↑" : " ↓";
  }
  return `${color}${prefix}${formatNumber(numericPrice, decimals)}${arrow}${ANSI.reset}`;
}

function referenceColor(state) {
  if (state === "READY") return ANSI.green;
  if (state === "ARMED" || state === "SYNCING") return ANSI.yellow;
  return ANSI.red;
}

function timeColor(minutes) {
  if (minutes >= 10 && minutes <= 15) return ANSI.green;
  if (minutes >= 5 && minutes < 10) return ANSI.yellow;
  if (minutes >= 0 && minutes < 5) return ANSI.red;
  return ANSI.reset;
}

function fmtEtTime(date) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(date);
  } catch {
    return "-";
  }
}

function btcSession(date) {
  const hour = date.getUTCHours();
  const inAsia = hour >= 0 && hour < 8;
  const inEurope = hour >= 7 && hour < 16;
  const inUs = hour >= 13 && hour < 22;
  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function maskAddress(value) {
  const address = String(value ?? "");
  return address.length >= 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : "-";
}

function formatSnapshotAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "-";
  if (ageMs < 1_000) return "<1s";
  if (ageMs < 60_000) return `${(ageMs / 1_000).toFixed(1)}s`;
  return `${(ageMs / 60_000).toFixed(1)}m`;
}

function formatStreamHealth(streamHealth) {
  if (!streamHealth?.summary) return null;
  const summary = streamHealth.summary;
  return `${summary.healthy ?? 0} healthy | ${summary.reconnecting ?? 0} reconnecting | ${summary.stale ?? 0} stale | ${summary.disabled ?? 0} disabled`;
}

export function renderTerminalDashboard(snapshot, { width = 80 } = {}) {
  const safeWidth = Number.isFinite(width) && width >= 40 ? Math.floor(width) : 80;
  const market = snapshot.market ?? {};
  const signal = snapshot.signal ?? {};
  const readiness = snapshot.readiness ?? {};
  const trading = snapshot.trading ?? {};
  const session = snapshot.session ?? {};
  const streamHealth = formatStreamHealth(session.streamHealth);
  const summary = trading.summary ?? {};
  const account = trading.account ?? null;
  const control = trading.control ?? {};
  const live = trading.mode === "live";
  const generatedAt = new Date(snapshot.generatedAt);

  const marketUp = market.polymarketUp;
  const marketDown = market.polymarketDown;
  const polymarketValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUp ?? "-"}${marketUp === null || marketUp === undefined ? "" : "¢"}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${marketDown ?? "-"}${marketDown === null || marketDown === undefined ? "" : "¢"}`;
  const currentDelta = Number.isFinite(market.currentPriceUsd) && Number.isFinite(market.priceToBeatUsd)
    ? market.currentPriceUsd - market.priceToBeatUsd
    : null;
  const currentDeltaColor = currentDelta === null ? ANSI.gray : currentDelta > 0 ? ANSI.green : currentDelta < 0 ? ANSI.red : ANSI.gray;
  const currentDeltaText = currentDelta === null
    ? `${ANSI.gray}-${ANSI.reset}`
    : `${currentDeltaColor}${currentDelta > 0 ? "+" : currentDelta < 0 ? "-" : ""}$${Math.abs(currentDelta).toFixed(2)}${ANSI.reset}`;
  const currentPrice = `${priceValue({ price: market.currentPriceUsd, previousPrice: market.previousCurrentPriceUsd, decimals: 2, prefix: "$" })} (${currentDeltaText})`;
  const binanceDifference = Number.isFinite(market.binancePriceUsd) && Number.isFinite(market.currentPriceUsd) && market.currentPriceUsd !== 0
    ? market.binancePriceUsd - market.currentPriceUsd
    : null;
  const binanceDifferenceText = binanceDifference === null
    ? ""
    : ` (${binanceDifference > 0 ? "+" : binanceDifference < 0 ? "-" : ""}$${Math.abs(binanceDifference).toFixed(2)}, ${binanceDifference > 0 ? "+" : binanceDifference < 0 ? "-" : ""}${Math.abs((binanceDifference / market.currentPriceUsd) * 100).toFixed(2)}%)`;
  const binancePrice = `${priceValue({ price: market.binancePriceUsd, previousPrice: market.previousBinancePriceUsd, decimals: 0, prefix: "$" })}${binanceDifferenceText}`;

  const predictValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(signal.modelUp)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(signal.modelDown)}${ANSI.reset}`;
  const heikenColor = String(signal.heikenColor ?? "").toLowerCase();
  const heikenNarrative = heikenColor === "green" ? "LONG" : heikenColor === "red" ? "SHORT" : "NEUTRAL";
  const rsiArrow = signal.rsiSlope < 0 ? "↓" : signal.rsiSlope > 0 ? "↑" : "-";
  const deltaValue = `${colorByNarrative(formatSignedDelta(signal.delta1m, signal.deltaBase), narrativeFromSign(signal.delta1m))} | ${colorByNarrative(formatSignedDelta(signal.delta3m, signal.deltaBase), narrativeFromSign(signal.delta3m))}`;

  const controlColor = control.state === "ARMED" ? ANSI.green : control.state === "PENDING_CONFIRMATION" ? ANSI.yellow : ANSI.red;
  const pnl = Number(summary.realized_pnl_usd ?? 0);
  const pnlColor = pnl > 0 ? ANSI.green : pnl < 0 ? ANSI.red : ANSI.gray;
  const returnValue = Number(summary.realized_return_pct ?? 0);
  const referenceObserved = readiness.observedAtMs ? new Date(readiness.observedAtMs).toISOString().slice(11, 19) : "-";
  const freshness = readiness.freshnessMs === null || readiness.freshnessMs === undefined ? "-" : `${(readiness.freshnessMs / 1_000).toFixed(1)}s`;
  const pending = trading.pendingConfirmation ?? null;

  return [
    `${ANSI.white}POLYMARKET BTC 15M ASSISTANT${ANSI.reset}`,
    "",
    separator(safeWidth),
    "",
    section("Market Snapshot"),
    "",
    kv("Market:", market.title ?? "-"),
    kv("Slug:", market.slug ?? "-"),
    kv("Time Left:", `${timeColor(market.timeLeftMinutes)}${fmtTimeLeft(market.timeLeftMinutes)}${ANSI.reset}`),
    kv("Polymarket:", polymarketValue),
    Number.isFinite(market.liquidityUsd) ? kv("Liquidity:", `$${formatNumber(market.liquidityUsd, 0)}`) : null,
    Number.isFinite(market.priceToBeatUsd) ? kv("Price To Beat:", `$${formatNumber(market.priceToBeatUsd, 2)}`) : kv("Price To Beat:", `${ANSI.gray}unavailable${ANSI.reset}`),
    kv("Current Price:", currentPrice),
    kv("BTC (Binance):", binancePrice),
    "",
    separator(safeWidth),
    "",
    section("Signal Analysis"),
    "",
    kv("TA Predict:", predictValue),
    kv("Heiken Ashi:", colorByNarrative(`${signal.heikenColor ?? "-"} x${signal.heikenCount ?? 0}`, heikenNarrative)),
    kv("RSI:", colorByNarrative(`${formatNumber(signal.rsi, 1)} ${rsiArrow}`, narrativeFromSign(signal.rsiSlope))),
    kv("MACD:", colorByNarrative(signal.macdLabel ?? "-", narrativeFromSign(signal.macdHistogram))),
    kv("Delta 1/3:", deltaValue),
    kv("VWAP:", colorByNarrative(`${formatNumber(signal.vwap, 0)} (${formatPct(signal.vwapDistance, 2)}) | slope: ${signal.vwapSlopeLabel ?? "-"}`, narrativeFromSign(signal.vwapDistance))),
    kv("Regime:", signal.regime ?? "-"),
    kv("Recommendation:", signal.recommendation ?? "-"),
    "",
    separator(safeWidth),
    "",
    section("Trading Readiness"),
    "",
    kv("Mode:", live ? "Live" : "Paper"),
    kv("Reference State:", `${referenceColor(readiness.state)}${readiness.state ?? "-"}${ANSI.reset}`),
    kv(live ? "System Gate:" : "Trading Gate:", readiness.tradingAllowed ? `${ANSI.green}OPEN${ANSI.reset}` : `${ANSI.red}CLOSED${ANSI.reset}`),
    live ? kv("Auto Orders:", `${controlColor}${control.text ?? "-"}${ANSI.reset}`) : null,
    kv("Freshness:", freshness),
    kv("Reason:", readiness.reason ?? "-"),
    kv("Observed UTC:", referenceObserved),
    kv("Source:", readiness.source ?? "-"),
    "",
    separator(safeWidth),
    "",
    section(trading.sectionTitle ?? "Trading"),
    "",
    kv("Status:", trading.status?.text ?? "-"),
    live && account?.wallet ? kv("Trading Wallet:", maskAddress(account.wallet)) : null,
    live && Number.isFinite(account?.balanceUsd) ? kv("Available:", `$${formatNumber(account.balanceUsd, 2)} USDC`) : null,
    live && account?.allowanceStatus ? kv("Allowance:", account.allowanceStatus) : null,
    live && account?.authorizationStatus ? kv("Authorization:", account.authorizationStatus) : null,
    live && account?.walletType ? kv("Wallet Type:", account.walletType) : null,
    live ? kv("Control:", trading.controlHelp ?? "-") : null,
    pending ? kv("Stake:", `$${formatNumber(pending.stakeUsd, 2)}`) : null,
    pending ? kv("Session Limit:", `${pending.maxTradesPerSession} trade${pending.maxTradesPerSession === 1 ? "" : "s"}`) : null,
    pending ? kv("Max Slippage:", `${formatNumber(pending.maxSlippage * 100, 1)}%`) : null,
    pending ? kv("Stop Action:", "block new orders and cancel open orders") : null,
    kv("Trades:", `${summary.total_trades ?? 0} total | ${summary.settled_trades ?? 0} settled | ${summary.pending_trades ?? 0} awaiting`),
    kv("Record:", `${summary.wins ?? 0}W / ${summary.losses ?? 0}L | ${formatNumber(summary.win_rate_pct ?? 0, 1)}%`),
    kv("Realized PnL:", `${pnlColor}${pnl > 0 ? "+" : ""}$${formatNumber(pnl, 2)} (${returnValue > 0 ? "+" : ""}${formatNumber(returnValue, 1)}%)${ANSI.reset}`),
    kv("Pending Stake:", `$${formatNumber(summary.pending_stake_usd ?? 0, 2)}`),
    "",
    separator(safeWidth),
    "",
    section("Session"),
    "",
    session.engineConnection ? kv("Engine Link:", `${session.engineConnection} | snapshot ${formatSnapshotAge(session.snapshotAgeMs)} old`) : null,
    streamHealth ? kv("Data Streams:", streamHealth) : null,
    session.controlFeedback ? kv("Control Reply:", session.controlFeedback) : null,
    kv("ET | Session:", `${ANSI.white}${fmtEtTime(generatedAt)}${ANSI.reset} | ${ANSI.white}${btcSession(generatedAt)}${ANSI.reset}`),
    "",
    separator(safeWidth),
    "",
    centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis · enhanced by @boycez${ANSI.reset}`, safeWidth)
  ].filter((line) => line !== null).join("\n") + "\n";
}
