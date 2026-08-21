import WebSocket from "ws";

import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";

const E18 = 10n ** 18n;

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizePayload(payload) {
  if (!payload) return null;
  if (typeof payload === "object") return payload;
  if (typeof payload === "string") return safeJsonParse(payload);
  return null;
}

function normalizeEpochMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number < 1_000_000_000_000 ? Math.floor(number * 1_000) : Math.floor(number);
}

function decimalToE18(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const fraction = (match[3] ?? "").padEnd(18, "0").slice(0, 18);
  const scaled = BigInt(match[2]) * E18 + BigInt(fraction || "0");
  return `${match[1] === "-" ? -scaled : scaled}`;
}

function normalizeE18(payload) {
  const fullAccuracy = payload?.full_accuracy_value ?? payload?.fullAccuracyValue;
  if (fullAccuracy !== null && fullAccuracy !== undefined && /^-?\d+$/.test(String(fullAccuracy))) {
    return String(fullAccuracy);
  }
  return decimalToE18(payload?.value);
}

export function formatE18(value) {
  if (value === null || value === undefined || !/^-?\d+$/.test(String(value))) return null;
  const scaled = BigInt(value);
  const sign = scaled < 0n ? "-" : "";
  const absolute = scaled < 0n ? -scaled : scaled;
  const whole = absolute / E18;
  const fraction = (absolute % E18).toString().padStart(18, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function startPolymarketTwapStream({
  wsUrl = CONFIG.polymarket.liveDataWsUrl,
  symbol = "btc/usd",
  windowSeconds = 60,
  maxSamples = 600,
  onUpdate
} = {}) {
  const topic = windowSeconds === 30 ? "crypto_prices_twap_thirty" : "crypto_prices_twap_sixty";
  const samples = new Map();
  let socket = null;
  let closed = false;
  let connected = false;
  let reconnectMs = 500;
  let reconnectTimer = null;
  let heartbeat = null;
  let last = null;

  const addSample = (sample) => {
    samples.set(sample.observedAtMs, sample);
    while (samples.size > maxSamples) samples.delete(samples.keys().next().value);
    last = sample;
    if (typeof onUpdate === "function") onUpdate(sample);
  };

  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  const connect = () => {
    if (closed || !wsUrl) return;
    reconnectTimer = null;
    socket = new WebSocket(wsUrl, {
      handshakeTimeout: 10_000,
      agent: wsAgentForUrl(wsUrl)
    });

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      connected = false;
      stopHeartbeat();
      try {
        socket?.terminate();
      } catch {
        // ignore
      }
      socket = null;
      const wait = reconnectMs;
      reconnectMs = Math.min(10_000, Math.floor(reconnectMs * 1.5));
      reconnectTimer = setTimeout(connect, wait);
    };

    socket.on("open", () => {
      connected = true;
      reconnectMs = 500;
      try {
        socket.send(JSON.stringify({
          action: "subscribe",
          subscriptions: [{
            topic,
            type: "update",
            filters: JSON.stringify({ symbol })
          }]
        }));
        stopHeartbeat();
        heartbeat = setInterval(() => {
          try {
            if (socket?.readyState === WebSocket.OPEN) socket.send("PING");
          } catch {
            scheduleReconnect();
          }
        }, 5_000);
      } catch {
        scheduleReconnect();
      }
    });

    socket.on("message", (buffer) => {
      const text = typeof buffer === "string" ? buffer : buffer?.toString?.() ?? "";
      if (!text || text === "PONG") return;
      const message = safeJsonParse(text);
      if (!message || message.topic !== topic) return;
      const payload = normalizePayload(message.payload);
      const observedAtMs = normalizeEpochMs(payload?.timestamp);
      const priceE18 = normalizeE18(payload);
      const payloadSymbol = String(payload?.symbol ?? "").toLowerCase();
      const payloadWindow = Number(payload?.window_s ?? payload?.windowSeconds ?? windowSeconds);
      if (payloadSymbol !== symbol || payloadWindow !== windowSeconds || observedAtMs === null || priceE18 === null) return;

      addSample({
        symbol,
        windowSeconds,
        observedAtMs,
        publishedAtMs: normalizeEpochMs(message.timestamp),
        priceE18,
        priceDecimal: formatE18(priceE18),
        source: "polymarket_rtds_chainlink_twap"
      });
    });

    socket.on("close", scheduleReconnect);
    socket.on("error", scheduleReconnect);
  };

  connect();

  return {
    getAt(observedAtMs) {
      return samples.get(Number(observedAtMs)) ?? null;
    },
    getLast() {
      return last;
    },
    isConnected() {
      return connected;
    },
    close() {
      closed = true;
      connected = false;
      stopHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        socket?.close();
      } catch {
        // ignore
      }
      socket = null;
    }
  };
}