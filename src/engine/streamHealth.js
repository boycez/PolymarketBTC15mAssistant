export class StreamHealthMonitor {
  constructor({
    streams,
    checkIntervalMs = 5_000,
    restartCooldownMs = 15_000,
    now = () => Date.now()
  }) {
    this.streams = streams;
    this.checkIntervalMs = checkIntervalMs;
    this.restartCooldownMs = restartCooldownMs;
    this.now = now;
    this.timer = null;
    this.lastRestartAt = new Map();
    this.watchdogRestarts = new Map();
    this.latest = this.inspect(false);
  }

  inspect(allowRestart = true) {
    const nowMs = this.now();
    const sources = this.streams.map(({ name, stream, staleAfterMs = null }) => {
      try {
        const health = stream.getHealth();
        const lastActivityAt = health.lastMessageAt ?? health.connectedAt ?? null;
        const ageMs = lastActivityAt === null ? null : Math.max(0, nowMs - lastActivityAt);
        const stale = Number.isFinite(staleAfterMs)
          && health.enabled !== false
          && health.connected === true
          && ageMs !== null
          && ageMs > staleAfterMs;

        if (stale && allowRestart && typeof stream.restart === "function") {
          const lastRestartAt = this.lastRestartAt.get(name) ?? 0;
          if (nowMs - lastRestartAt >= this.restartCooldownMs) {
            this.lastRestartAt.set(name, nowMs);
            this.watchdogRestarts.set(name, (this.watchdogRestarts.get(name) ?? 0) + 1);
            stream.restart("stale_watchdog");
          }
        }

        const state = health.enabled === false
          ? "DISABLED"
          : stale
            ? "STALE"
            : health.connected
              ? "HEALTHY"
              : "RECONNECTING";
        return {
          name,
          state,
          connected: health.connected === true,
          lastMessageAt: health.lastMessageAt ?? null,
          ageMs,
          reconnectCount: health.reconnectCount ?? 0,
          watchdogRestarts: this.watchdogRestarts.get(name) ?? 0,
          lastError: health.lastError
            ? (["stale_watchdog", "manual_restart"].includes(health.lastError) ? health.lastError : "connection_error")
            : null
        };
      } catch {
        return {
          name,
          state: "ERROR",
          connected: false,
          lastMessageAt: null,
          ageMs: null,
          reconnectCount: 0,
          watchdogRestarts: this.watchdogRestarts.get(name) ?? 0,
          lastError: "health_check_failed"
        };
      }
    });

    const summary = sources.reduce((counts, source) => {
      counts[source.state.toLowerCase()] = (counts[source.state.toLowerCase()] ?? 0) + 1;
      return counts;
    }, {});
    return { checkedAt: new Date(nowMs).toISOString(), summary, sources };
  }

  check() {
    this.latest = this.inspect(true);
    return this.latest;
  }

  getSnapshot() {
    return this.latest;
  }

  start() {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}