import crypto from "node:crypto";

export const RESEARCH_SCHEMA_VERSION = 1;
export const RESEARCH_EVENT_TYPES = Object.freeze({
  DECISION: "decision_observation",
  OUTCOME: "market_outcome"
});

export function createResearchEvent(eventType, payload, recordedAtMs = Date.now()) {
  if (!Object.values(RESEARCH_EVENT_TYPES).includes(eventType)) {
    throw new Error(`Unsupported research event type: ${eventType}.`);
  }
  if (!Number.isFinite(recordedAtMs)) throw new Error("Research event timestamp must be finite.");

  const event = {
    ...payload,
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    eventType,
    eventId: crypto.randomUUID(),
    recordedAt: new Date(recordedAtMs).toISOString()
  };
  validateResearchEvent(event);
  return event;
}

export function validateResearchEvent(event) {
  if (event?.schemaVersion !== RESEARCH_SCHEMA_VERSION) throw new Error("Unsupported research schema version.");
  if (!Object.values(RESEARCH_EVENT_TYPES).includes(event?.eventType)) throw new Error("Invalid research event type.");
  if (!/^[0-9a-f-]{36}$/i.test(String(event?.eventId ?? ""))) throw new Error("Research event requires an event id.");
  if (!Number.isFinite(Date.parse(event?.recordedAt))) throw new Error("Research event requires a valid recordedAt timestamp.");
  if (!String(event?.market?.slug ?? "").trim()) throw new Error("Research event requires a market slug.");
  if (event.eventType === RESEARCH_EVENT_TYPES.DECISION && !String(event?.strategy?.key ?? "").trim()) {
    throw new Error("Decision research event requires a strategy key.");
  }
  if (event.eventType === RESEARCH_EVENT_TYPES.OUTCOME && !["UP", "DOWN"].includes(event?.outcome?.winner)) {
    throw new Error("Outcome research event requires an UP or DOWN winner.");
  }
  return event;
}