function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function floorTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
}

function floorToTick(value, tickSize) {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return value;
  return Math.floor((value + Number.EPSILON) / tickSize) * tickSize;
}

function roundFee(value) {
  return Math.round((value + Number.EPSILON) * 100_000) / 100_000;
}

function feePerShare(price, feesEnabled, feeSchedule) {
  if (!feesEnabled) return 0;
  const rate = finiteNumber(feeSchedule?.rate);
  if (rate === null || rate <= 0) return 0;
  const exponent = finiteNumber(feeSchedule?.exponent) ?? 1;
  return rate * ((price * (1 - price)) ** exponent);
}

export function simulateFokBuy({
  asks,
  stakeUsd,
  maxPrice,
  minOrderSize = 0,
  feesEnabled = false,
  feeSchedule = null
}) {
  const levels = (Array.isArray(asks) ? asks : [])
    .map((level) => ({ price: finiteNumber(level?.price), size: finiteNumber(level?.size) }))
    .filter((level) => level.price !== null && level.size !== null && level.price > 0 && level.size > 0)
    .sort((left, right) => left.price - right.price)
    .filter((level) => level.price <= maxPrice + Number.EPSILON);

  if (!levels.length || !Number.isFinite(stakeUsd) || stakeUsd <= 0) {
    return { filled: false, reason: "no_executable_liquidity" };
  }

  let affordableShares = 0;
  let remainingBudget = stakeUsd;
  for (const level of levels) {
    const unitCost = level.price + feePerShare(level.price, feesEnabled, feeSchedule);
    const shares = Math.min(level.size, remainingBudget / unitCost);
    affordableShares += shares;
    remainingBudget -= shares * unitCost;
    if (remainingBudget <= 1e-9) break;
  }

  let targetShares = floorTo(affordableShares, 2);
  const fillTarget = (sharesToFill) => {
    let remainingShares = sharesToFill;
    let notional = 0;
    let fee = 0;
    let worstFillPrice = null;

    for (const level of levels) {
      if (remainingShares <= 1e-9) break;
      const shares = Math.min(level.size, remainingShares);
      notional += shares * level.price;
      fee += shares * feePerShare(level.price, feesEnabled, feeSchedule);
      worstFillPrice = level.price;
      remainingShares -= shares;
    }

    const roundedFee = roundFee(fee);
    return {
      complete: remainingShares <= 1e-9,
      notional,
      fee: roundedFee,
      totalCost: notional + roundedFee,
      worstFillPrice
    };
  };

  let fill = fillTarget(targetShares);
  while (targetShares > 0 && fill.totalCost > stakeUsd + 1e-9) {
    targetShares = floorTo(targetShares - 0.01, 2);
    fill = fillTarget(targetShares);
  }

  if (!fill.complete || targetShares <= 0) return { filled: false, reason: "insufficient_depth" };

  const leftoverBudget = stakeUsd - fill.totalCost;
  const cheapestUnitCost = levels[0].price + feePerShare(levels[0].price, feesEnabled, feeSchedule);
  if (leftoverBudget >= cheapestUnitCost * 0.01 - 1e-9) return { filled: false, reason: "insufficient_depth" };
  if (fill.notional + 1e-9 < minOrderSize) return { filled: false, reason: "below_min_order_size" };

  return {
    filled: true,
    shares: targetShares,
    averagePrice: fill.notional / targetShares,
    worstFillPrice: fill.worstFillPrice,
    notional: fill.notional,
    fee: fill.fee,
    totalCost: fill.totalCost,
    leftoverBudget
  };
}

export function quoteOutcomeExecution({ orderBook, market, stakeUsd, maxSlippage, modelProbability = null }) {
  const bestAsk = finiteNumber(orderBook?.bestAsk);
  const tickSize = finiteNumber(orderBook?.tickSize) ?? finiteNumber(market?.orderPriceMinTickSize) ?? 0.01;
  const minOrderSize = finiteNumber(orderBook?.minOrderSize) ?? finiteNumber(market?.orderMinSize) ?? 0;
  const maxPrice = bestAsk === null ? null : Math.min(0.99, floorToTick(bestAsk + maxSlippage, tickSize));
  const fill = maxPrice === null
    ? { filled: false, reason: "missing_best_ask" }
    : simulateFokBuy({
        asks: orderBook?.asks,
        stakeUsd,
        maxPrice,
        minOrderSize,
        feesEnabled: market?.feesEnabled === true,
        feeSchedule: market?.feeSchedule ?? null
      });
  const allInPrice = fill.filled ? fill.totalCost / fill.shares : null;
  const probability = finiteNumber(modelProbability);

  return {
    bestAsk,
    tickSize,
    minOrderSize,
    maxPrice,
    fill,
    allInPrice,
    executionEdge: allInPrice === null || probability === null ? null : probability - allInPrice,
    slippage: fill.filled && bestAsk !== null ? fill.averagePrice - bestAsk : null
  };
}

export function quoteBothOutcomes({ orderBooks, market, stakeUsd, maxSlippage, modelUp, modelDown }) {
  return {
    up: quoteOutcomeExecution({ orderBook: orderBooks?.up, market, stakeUsd, maxSlippage, modelProbability: modelUp }),
    down: quoteOutcomeExecution({ orderBook: orderBooks?.down, market, stakeUsd, maxSlippage, modelProbability: modelDown })
  };
}