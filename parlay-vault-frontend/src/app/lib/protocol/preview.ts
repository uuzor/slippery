import type { PredictQuote, SlipPreview } from './types';

const FLOAT_SCALING = 1_000_000_000n;
const HOUSE_MARGIN_FACTOR = 970_000_000n;
const STAKE_BUFFER = 250_000n;
const MIN_LEGS = 2n;
const MAX_LEGS = 10n;

const BONUS_MULTIPLIERS = new Map<bigint, bigint>([
  [2n, 1_030_000_000n],
  [3n, 1_080_000_000n],
  [4n, 1_150_000_000n],
  [5n, 1_230_000_000n],
  [6n, 1_320_000_000n],
  [7n, 1_420_000_000n],
  [8n, 1_530_000_000n],
  [9n, 1_650_000_000n],
  [10n, 1_800_000_000n],
]);

function mulDiv(a: bigint, b: bigint, scale: bigint): bigint {
  return (a * b) / scale;
}

function scaleDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator * FLOAT_SCALING) / denominator;
}

function getCombinedOdds(legs: PredictQuote[]): bigint {
  const legCount = BigInt(legs.length);
  if (legCount < MIN_LEGS || legCount > MAX_LEGS) {
    return 0n;
  }

  let jointProbability = FLOAT_SCALING;
  for (const leg of legs) {
    jointProbability = mulDiv(jointProbability, leg.askPrice, FLOAT_SCALING);
  }

  const adjustedProbability = mulDiv(jointProbability, HOUSE_MARGIN_FACTOR, FLOAT_SCALING);
  if (adjustedProbability === 0n) {
    return 0n;
  }

  return scaleDiv(FLOAT_SCALING, adjustedProbability);
}

export function getBonusMultiplier(legCount: bigint): bigint {
  if (legCount < MIN_LEGS || legCount > MAX_LEGS) {
    return 0n;
  }
  return BONUS_MULTIPLIERS.get(legCount) ?? BONUS_MULTIPLIERS.get(2n) ?? 0n;
}

export function computeRequiredStake(quotes: PredictQuote[], buffer = STAKE_BUFFER): bigint {
  if (quotes.length === 0) {
    return 0n;
  }
  return quotes.reduce((sum, quote) => sum + quote.quoteAmount, 0n) + buffer;
}

export function previewSlipFromQuotes(
  quotes: PredictQuote[],
  stake?: bigint,
): SlipPreview {
  const legCount = BigInt(quotes.length);
  const quoteSubtotal = quotes.reduce((sum, quote) => sum + quote.quoteAmount, 0n);
  const requiredStake = computeRequiredStake(quotes);
  const effectiveStake = stake ?? requiredStake;

  if (legCount < MIN_LEGS || legCount > MAX_LEGS) {
    return {
      legCount,
      combinedOdds: 0n,
      bonusMultiplier: 0n,
      potentialPayout: 0n,
      bonusAmount: 0n,
      quoteSubtotal,
      requiredStake,
    };
  }

  const combinedOdds = getCombinedOdds(quotes);
  if (combinedOdds === 0n) {
    return {
      legCount,
      combinedOdds,
      bonusMultiplier: 0n,
      potentialPayout: 0n,
      bonusAmount: 0n,
      quoteSubtotal,
      requiredStake,
    };
  }

  const bonusMultiplier = getBonusMultiplier(legCount);
  const basePayout = mulDiv(effectiveStake, combinedOdds, FLOAT_SCALING);
  const potentialPayout = mulDiv(basePayout, bonusMultiplier, FLOAT_SCALING);
  const bonusAmount = potentialPayout > basePayout ? potentialPayout - basePayout : 0n;

  return {
    legCount,
    combinedOdds,
    bonusMultiplier,
    potentialPayout,
    bonusAmount,
    quoteSubtotal,
    requiredStake,
  };
}

export const previewConstants = {
  floatScaling: FLOAT_SCALING,
  houseMarginFactor: HOUSE_MARGIN_FACTOR,
  stakeBuffer: STAKE_BUFFER,
  minLegs: MIN_LEGS,
  maxLegs: MAX_LEGS,
} as const;
