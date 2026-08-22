import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export function buildBinanceTradeStreamUrl(symbol, baseUrl = CONFIG.binanceWsBaseUrl) {
  const s = String(symbol || "").toLowerCase();
  return new URL(`/ws/${s}@trade`, baseUrl).toString();
}

export function startBinanceTradeStream({ symbol = CONFIG.symbol, wsBaseUrl = CONFIG.binanceWsBaseUrl, onUpdate } = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500;
  let reconnectTimer = null;
  let lastPrice = null;
  let lastTs = null;
  let connected = false;
  let connectedAt = null;
  let reconnectCount = 0;
  let lastError = null;

  const scheduleReconnect = (reason) => {
    if (closed || reconnectTimer) return;
    connected = false;
    lastError = reason instanceof Error ? reason.message : reason ? String(reason) : lastError;
    try {
      ws?.terminate();
    } catch {
      // ignore
    }
    ws = null;
    reconnectCount += 1;
    const wait = reconnectMs;
    reconnectMs = Math.min(10_000, Math.floor(reconnectMs * 1.5));
    reconnectTimer = setTimeout(connect, wait);
  };

  const connect = () => {
    if (closed) return;
    reconnectTimer = null;

    const url = buildBinanceTradeStreamUrl(symbol, wsBaseUrl);
    ws = new WebSocket(url, { agent: wsAgentForUrl(url) });

    ws.on("open", () => {
      connected = true;
      connectedAt = Date.now();
      reconnectMs = 500;
      lastError = null;
    });

    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        const p = toNumber(msg.p);
        if (p === null) return;
        lastPrice = p;
        lastTs = Date.now();
        if (typeof onUpdate === "function") onUpdate({ price: lastPrice, ts: lastTs });
      } catch {
        return;
      }
    });

    ws.on("close", scheduleReconnect);
    ws.on("error", (error) => scheduleReconnect(error));
  };

  connect();

  return {
    getLast() {
      return { price: lastPrice, ts: lastTs };
    },
    getHealth() {
      return { enabled: true, connected, connectedAt, lastMessageAt: lastTs, reconnectCount, lastError };
    },
    restart(reason = "manual_restart") {
      if (closed) return false;
      scheduleReconnect(reason);
      return true;
    },
    close() {
      closed = true;
      connected = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };
}
