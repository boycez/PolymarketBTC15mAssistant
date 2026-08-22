export const TA_EDGE_V1_2_FOK = Object.freeze({
  strategy: "TA_EDGE_V1_2_FOK",
  confirmationSeconds: 30,
  minRemainingMinutes: 5,
  maxRemainingMinutes: 10,
  minExecutionEdge: 0.1,
  maxSlippage: 0.02,
  requireTrendAlignment: true
});

function optionalNumber(env, name, defaultValue) {
  if (env[name] === undefined) return defaultValue;
  const raw = String(env[name]).trim();
  if (!raw) throw new Error(`${name} must be a finite number.`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function optionalBoolean(env, name, defaultValue) {
  if (env[name] === undefined) return defaultValue;
  const value = String(env[name]).trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

export function resolveTaEdgeV12Config(env = process.env) {
  const strategy = String(env.PAPER_TRADE_STRATEGY ?? TA_EDGE_V1_2_FOK.strategy).trim();
  const resolved = {
    strategy,
    confirmationSeconds: optionalNumber(env, "PAPER_TRADE_CONFIRMATION_SECONDS", TA_EDGE_V1_2_FOK.confirmationSeconds),
    minRemainingMinutes: optionalNumber(env, "PAPER_TRADE_MIN_REMAINING_MINUTES", TA_EDGE_V1_2_FOK.minRemainingMinutes),
    maxRemainingMinutes: optionalNumber(env, "PAPER_TRADE_MAX_REMAINING_MINUTES", TA_EDGE_V1_2_FOK.maxRemainingMinutes),
    minExecutionEdge: optionalNumber(env, "PAPER_TRADE_MIN_EXECUTION_EDGE", TA_EDGE_V1_2_FOK.minExecutionEdge),
    maxSlippage: optionalNumber(env, "PAPER_TRADE_MAX_SLIPPAGE", TA_EDGE_V1_2_FOK.maxSlippage),
    requireTrendAlignment: optionalBoolean(env, "PAPER_TRADE_REQUIRE_TREND_ALIGNMENT", TA_EDGE_V1_2_FOK.requireTrendAlignment)
  };

  if (resolved.strategy !== TA_EDGE_V1_2_FOK.strategy) {
    throw new Error(`PAPER_TRADE_STRATEGY must be ${TA_EDGE_V1_2_FOK.strategy}.`);
  }
  if (resolved.confirmationSeconds < 0) throw new Error("PAPER_TRADE_CONFIRMATION_SECONDS must be zero or greater.");
  if (resolved.minRemainingMinutes < 0 || resolved.maxRemainingMinutes < resolved.minRemainingMinutes) {
    throw new Error("Paper trade remaining-minute limits must define a valid non-negative window.");
  }
  if (resolved.minExecutionEdge < 0 || resolved.minExecutionEdge > 1) {
    throw new Error("PAPER_TRADE_MIN_EXECUTION_EDGE must be between 0 and 1.");
  }
  if (resolved.maxSlippage < 0 || resolved.maxSlippage > 1) {
    throw new Error("PAPER_TRADE_MAX_SLIPPAGE must be between 0 and 1.");
  }
  return resolved;
}

export function resolvePaperStrategy(env = process.env) {
  return resolveTaEdgeV12Config(env);
}

export function formatRecommendationReason(reason) {
  const value = String(reason ?? "no qualifying recommendation");
  const probability = value.match(/^prob_below_([0-9.]+)$/);
  if (probability) return `model probability below ${(Number(probability[1]) * 100).toFixed(1)}%`;
  const edge = value.match(/^edge_below_([0-9.]+)$/);
  if (edge) return `quoted edge below ${(Number(edge[1]) * 100).toFixed(1)}%`;
  return value.replaceAll("_", " ");
}

export function strategyGateCategory(reason) {
  const value = String(reason ?? "");
  if (value.startsWith("outside entry window")) return "outside entry window";
  if (value.startsWith("execution edge ")) return "execution edge below minimum";
  return value;
}