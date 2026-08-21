import { PaperTrader } from "../paperTrading.js";
import { LiveTrader } from "../liveTrading.js";
import { TRADING_MODES } from "./mode.js";

class TradingRuntime {
  constructor({ mode, sectionTitle, logFilePath, trader }) {
    this.mode = mode;
    this.sectionTitle = sectionTitle;
    this.logFilePath = logFilePath;
    this.trader = trader;
  }

  async observe(input) {
    return await this.trader.observe(input);
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

  async cancelAll() {
    if (typeof this.trader.cancelAll !== "function") return null;
    return await this.trader.cancelAll();
  }

  requestArm() {
    return this.trader.requestArm?.() ?? false;
  }

  confirmArm() {
    return this.trader.confirmArm?.() ?? false;
  }

  cancelArm() {
    return this.trader.cancelArm?.() ?? false;
  }

  async disarm() {
    return await (this.trader.disarm?.() ?? false);
  }

  getControlState() {
    return this.trader.getControlState?.() ?? { state: "UNAVAILABLE", text: "Unavailable" };
  }

  getAccountIdentity() {
    return this.trader.getAccountIdentity?.() ?? null;
  }
}

export async function createTradingRuntime({ mode, paperConfig = {}, liveConfig = {} }) {
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
    const trader = await LiveTrader.create(liveConfig);
    return new TradingRuntime({
      mode,
      sectionTitle: "Live Trading",
      logFilePath: trader.filePath,
      trader
    });
  }

  throw new Error(`Unsupported trading mode "${mode}".`);
}
