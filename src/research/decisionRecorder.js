import { appendDailyJsonl } from "./jsonlStore.js";
import { createResearchEvent, RESEARCH_EVENT_TYPES } from "./schema.js";

export class DecisionResearchRecorder {
  constructor({ filePath = "./logs/research_events.jsonl", intervalMs = 15_000, healthMonitor = null } = {}) {
    this.filePath = filePath;
    this.intervalMs = intervalMs;
    this.lastRecordedAtMs = 0;
    this.lastStateKey = null;
    this.healthMonitor = healthMonitor;
  }

  record(event, nowMs = Date.now()) {
    const stateKey = [
      event.market?.slug,
      event.strategy?.key,
      event.decision?.recommendation?.action,
      event.decision?.recommendation?.side,
      event.execution?.status,
      event.execution?.gateReason,
      event.reference?.state,
      event.sources?.streamHealth?.summary?.healthy,
      event.sources?.streamHealth?.summary?.reconnecting,
      event.sources?.streamHealth?.summary?.stale,
      event.sources?.streamHealth?.summary?.disabled
    ].join(":");
    if (stateKey === this.lastStateKey && nowMs - this.lastRecordedAtMs < this.intervalMs) return false;
    if (this.healthMonitor && !this.healthMonitor.canWrite(nowMs)) return false;

    try {
      const researchEvent = createResearchEvent(RESEARCH_EVENT_TYPES.DECISION, event, nowMs);
      appendDailyJsonl(this.filePath, researchEvent, nowMs);
      this.lastRecordedAtMs = nowMs;
      this.lastStateKey = stateKey;
      this.lastError = null;
      this.healthMonitor?.recordDecision();
      return true;
    } catch (error) {
      this.lastError = error?.message ?? String(error);
      this.healthMonitor?.recordError(error);
      return false;
    }
  }
}