import { computeEdge, decide } from "../engines/edge.js";
import { applyTimeAwareness, scoreDirection } from "../engines/probability.js";
import { resolveTaEdgeV12Config } from "../trading/strategy.js";

export const taEdgeV12Strategy = Object.freeze({
  id: "ta-edge",
  version: "1.2.0",
  legacyName: "TA_EDGE_V1_2_FOK",

  resolveConfig(env) {
    return resolveTaEdgeV12Config({ ...env, PAPER_TRADE_STRATEGY: this.legacyName });
  },

  evaluate(context) {
    const scored = scoreDirection(context.indicators);
    const timeAware = applyTimeAwareness(scored.rawUp, context.remainingMinutes, context.windowMinutes);
    const edge = computeEdge({
      modelUp: timeAware.adjustedUp,
      modelDown: timeAware.adjustedDown,
      marketYes: context.marketPrices.up,
      marketNo: context.marketPrices.down
    });
    const recommendation = decide({
      remainingMinutes: context.remainingMinutes,
      edgeUp: edge.edgeUp,
      edgeDown: edge.edgeDown,
      modelUp: timeAware.adjustedUp,
      modelDown: timeAware.adjustedDown
    });

    return { scored, timeAware, edge, recommendation };
  }
});