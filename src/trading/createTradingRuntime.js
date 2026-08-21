import { PaperTrader } from "../paperTrading.js";
import { TRADING_MODES } from "./mode.js";

class TradingRuntime {
  constructor({ mode, sectionTitle, logFilePath, trader }) {
    this.mode = mode;
    this.sectionTitle = sectionTitle;
    this.logFilePath = logFilePath;
    this.trader = trader;
  }

  observe(input) {
    return this.trader.observe(input);
  }

  settlePending(nowMs) {
    return this.trader.settlePending(nowMs);
  }

  getStatus(marketSlug, nowMs) {
    return this.trader.getStatus(marketSlug, nowMs);
  }

  getSummary() {
    return this.trader.getSummary();
  }
}

export function createTradingRuntime({ mode, paperConfig = {}, liveConfig = {} }) {
  if (mode === TRADING_MODES.PAPER) {
    const trader = new PaperTrader({ ...paperConfig, enabled: true });
    return new TradingRuntime({
      mode,
      sectionTitle: "Paper Trading",
      logFilePath: trader.filePath,
      trader
    });
  }

  if (mode === TRADING_MODES.LIVE) {
    const logFilePath = liveConfig.filePath ?? "./logs/live_trades.csv";
    throw new Error(
      `Live trading is not implemented. No orders were submitted. Future live trades will be stored in ${logFilePath}.`
    );
  }

  throw new Error(`Unsupported trading mode "${mode}".`);
}
