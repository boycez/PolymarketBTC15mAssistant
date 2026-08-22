import fs from "node:fs";
import path from "node:path";

function existingAncestor(filePath) {
  let current = path.resolve(filePath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
  return current;
}

function formatMiB(bytes) {
  return Number.isFinite(bytes) ? `${(bytes / (1024 ** 2)).toFixed(0)} MiB` : "unknown";
}

export class ResearchHealthMonitor {
  constructor({
    storagePath,
    minFreeBytes = 512 * 1024 * 1024,
    checkIntervalMs = 60 * 60_000,
    reportIntervalMs = 60 * 60_000,
    now = () => Date.now(),
    statfs = (target) => fs.statfsSync(target),
    logger = console
  }) {
    this.storagePath = storagePath;
    this.minFreeBytes = minFreeBytes;
    this.checkIntervalMs = checkIntervalMs;
    this.reportIntervalMs = reportIntervalMs;
    this.now = now;
    this.statfs = statfs;
    this.logger = logger;
    this.startedAtMs = now();
    this.lastCheckAtMs = 0;
    this.lastReportAtMs = this.startedAtMs;
    this.freeBytes = null;
    this.writable = true;
    this.decisions = 0;
    this.outcomes = 0;
    this.pending = 0;
    this.errors = 0;
    this.lastError = null;
  }

  canWrite(nowMs = this.now()) {
    if (nowMs - this.lastCheckAtMs < this.checkIntervalMs && this.lastCheckAtMs !== 0) return this.writable;
    this.lastCheckAtMs = nowMs;
    try {
      const stats = this.statfs(existingAncestor(this.storagePath));
      this.freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const wasWritable = this.writable;
      this.writable = Number.isFinite(this.freeBytes) && this.freeBytes >= this.minFreeBytes;
      this.lastError = null;
      if (wasWritable && !this.writable) {
        this.logger.warn(`Research paused: disk free ${formatMiB(this.freeBytes)} is below ${formatMiB(this.minFreeBytes)}.`);
      }
    } catch (error) {
      this.errors += 1;
      this.lastError = error?.message ?? String(error);
      this.writable = false;
      this.logger.warn("Research paused: disk space check failed.");
    }
    return this.writable;
  }

  recordDecision() {
    this.decisions += 1;
  }

  recordOutcome() {
    this.outcomes += 1;
  }

  recordError(error) {
    this.errors += 1;
    this.lastError = error?.message ?? String(error);
  }

  updatePending(count) {
    this.pending = Number.isFinite(count) ? count : this.pending;
  }

  maybeReport(nowMs = this.now()) {
    if (nowMs - this.lastReportAtMs < this.reportIntervalMs) return false;
    this.lastReportAtMs = nowMs;
    this.logger.log(`Research health: decisions=${this.decisions} outcomes=${this.outcomes} pending=${this.pending} errors=${this.errors} free=${formatMiB(this.freeBytes)} writable=${this.writable}.`);
    return true;
  }
}