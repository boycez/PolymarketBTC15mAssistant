export const RUNTIME_SNAPSHOT_VERSION = 1;

function copySection(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

export function createRuntimeSnapshot({
  generatedAtMs = Date.now(),
  market,
  signal,
  readiness,
  trading,
  session
}) {
  if (!Number.isFinite(generatedAtMs)) throw new Error("Runtime snapshot generatedAtMs must be finite.");

  return {
    version: RUNTIME_SNAPSHOT_VERSION,
    generatedAt: new Date(generatedAtMs).toISOString(),
    market: copySection(market),
    signal: copySection(signal),
    readiness: copySection(readiness),
    trading: copySection(trading),
    session: copySection(session)
  };
}