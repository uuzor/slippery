import { Transaction } from '@mysten/sui/transactions';

import {
  CLOCK_OBJECT_ID,
  DEEPBOOK_OBJECT_ID,
  DEV_INSPECT_SENDER,
  predictTargets,
  protocolClient,
} from './config';
import type {
  PredictMarket,
  PredictOracleCandidate,
  PredictQuote,
  PredictSelection,
  PredictStrikeOption,
  U64ish,
} from './types';
import { normalizeId, toBigInt } from './utils';

export const DEFAULT_PREDICT_QUANTITY = 1_000_000n;

function decodeU64(value: [number[], string]): bigint {
  return BigInt(value[0].reduceRight((acc, byte) => (acc << 8n) + BigInt(byte), 0n));
}

function scaleAskPrice(quoteAmount: bigint, quantity: bigint): bigint {
  return (quoteAmount * 1_000_000_000n) / quantity;
}

function roundToTick(value: bigint, tickSize: bigint): bigint {
  return (value / tickSize) * tickSize;
}

function clampStrike(value: bigint, minStrike: bigint, maxStrike: bigint): bigint {
  if (value < minStrike) {
    return minStrike;
  }
  if (value > maxStrike) {
    return maxStrike;
  }
  return value;
}

function buildStrikeOptions(
  oracle: PredictOracleCandidate,
  strikeDepth: number,
): PredictStrikeOption[] {
  const cappedDepth = Math.max(0, strikeDepth);
  const atmStrike = clampStrike(
    roundToTick(oracle.forward, oracle.tickSize),
    oracle.minStrike,
    oracle.maxStrike,
  );
  const options: PredictStrikeOption[] = [];
  const seen = new Set<string>();

  for (let step = -cappedDepth; step <= cappedDepth; step += 1) {
    const strike = clampStrike(
      atmStrike + BigInt(step) * oracle.tickSize,
      oracle.minStrike,
      oracle.maxStrike,
    );
    const key = strike.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({
      strike,
      isAtTheMoney: strike === atmStrike,
      distanceFromAtmSteps: BigInt(step < 0 ? -step : step),
    });
  }

  options.sort((left, right) => Number(left.strike - right.strike));
  return options;
}

async function readPredictObjectFields() {
  const object = await protocolClient.getObject({
    id: DEEPBOOK_OBJECT_ID,
    options: { showContent: true },
  });
  const content = object.data?.content as { fields?: Record<string, unknown> } | undefined;
  if (!content?.fields) {
    throw new Error('Predict object content is unavailable');
  }
  return content.fields;
}

export async function listFuturePredictOracles(
  underlyingAsset = 'BTC',
  limit = 10,
): Promise<PredictOracleCandidate[]> {
  const nowMs = BigInt(Date.now());
  const predictFields = await readPredictObjectFields();
  const oracleConfig = predictFields.oracle_config as { fields?: Record<string, unknown> };
  const oracleGrids = oracleConfig.fields?.oracle_grids as { fields?: Record<string, unknown> };
  const oracleGridIdValue = oracleGrids.fields?.id as { id?: string } | string | undefined;
  const oracleGridParent = normalizeId(
    typeof oracleGridIdValue === 'string' ? oracleGridIdValue : String(oracleGridIdValue?.id),
  );

  const active: PredictOracleCandidate[] = [];
  let cursor: string | null = null;

  while (active.length < limit) {
    const page = await protocolClient.getDynamicFields({
      parentId: oracleGridParent,
      cursor,
      limit: Math.max(limit * 3, 24),
    });

    if (page.data.length === 0) {
      break;
    }

    const oracleIds = page.data.map((field) => normalizeId(field.name.value as string));
    const gridFieldIds = page.data.map((field) => normalizeId(field.objectId));

    const [objects, gridObjects] = await Promise.all([
      protocolClient.multiGetObjects({
        ids: oracleIds,
        options: { showContent: true },
      }),
      protocolClient.multiGetObjects({
        ids: gridFieldIds,
        options: { showContent: true },
      }),
    ]);

    for (let i = 0; i < objects.length; i += 1) {
      const object = objects[i];
      const gridObject = gridObjects[i];
      const field = page.data[i];
      const content = object.data?.content as { fields?: Record<string, unknown> } | undefined;
      const fields = content?.fields;
      if (!fields) {
        continue;
      }

      const expiry = BigInt(String(fields.expiry));
      const asset = String(fields.underlying_asset);
      if (fields.active !== true || asset !== underlyingAsset || expiry <= nowMs) {
        continue;
      }

      const gridContent = gridObject.data?.content as { fields?: Record<string, unknown> } | undefined;
      const gridFields = (gridContent?.fields?.value as { fields?: Record<string, unknown> } | undefined)
        ?.fields;
      if (!gridFields) {
        continue;
      }

      active.push({
        oracleId: normalizeId(String(object.data?.objectId)),
        gridObjectId: normalizeId(field.objectId),
        expiry,
        forward: BigInt(String((fields.prices as { fields?: Record<string, unknown> }).fields?.forward)),
        spot: BigInt(String((fields.prices as { fields?: Record<string, unknown> }).fields?.spot)),
        tickSize: BigInt(String(gridFields.tick_size)),
        minStrike: BigInt(String(gridFields.min_strike)),
        maxStrike: BigInt(String(gridFields.max_strike)),
        underlyingAsset: asset,
        active: true,
      });

      if (active.length >= limit) {
        break;
      }
    }

    if (!page.hasNextPage || !page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }

  active.sort((left, right) => Number(left.expiry - right.expiry));
  return active.slice(0, limit);
}

export async function listPredictMarkets(input?: {
  underlyingAsset?: string;
  limit?: number;
  strikeDepth?: number;
}): Promise<PredictMarket[]> {
  const underlyingAsset = input?.underlyingAsset ?? 'BTC';
  const limit = input?.limit ?? 10;
  const strikeDepth = input?.strikeDepth ?? 2;
  const oracles = await listFuturePredictOracles(underlyingAsset, limit);

  return oracles.map((oracle) => {
    const strikeOptions = buildStrikeOptions(oracle, strikeDepth);
    const atmStrike = strikeOptions.find((option) => option.isAtTheMoney)?.strike
      ?? clampStrike(roundToTick(oracle.forward, oracle.tickSize), oracle.minStrike, oracle.maxStrike);

    return {
      marketId: `${oracle.oracleId}:${oracle.expiry.toString()}`,
      oracleId: oracle.oracleId,
      gridObjectId: oracle.gridObjectId,
      expiry: oracle.expiry,
      forward: oracle.forward,
      spot: oracle.spot,
      tickSize: oracle.tickSize,
      minStrike: oracle.minStrike,
      maxStrike: oracle.maxStrike,
      underlyingAsset: oracle.underlyingAsset,
      atmStrike,
      strikeOptions,
    };
  });
}

export function buildPredictSelection(input: {
  market: PredictMarket;
  strike: U64ish;
  isUp: boolean;
  quantity?: U64ish;
}): PredictSelection {
  return {
    marketId: input.market.marketId,
    oracleId: normalizeId(input.market.oracleId),
    expiry: input.market.expiry,
    strike: toBigInt(input.strike),
    isUp: input.isUp,
    quantity: toBigInt(input.quantity ?? DEFAULT_PREDICT_QUANTITY),
    underlyingAsset: input.market.underlyingAsset,
  };
}

export async function quotePredictLeg(input: {
  oracleId: string;
  expiry: U64ish;
  strike: U64ish;
  isUp: boolean;
  quantity: U64ish;
  sender?: string;
}): Promise<PredictQuote> {
  const tx = new Transaction();
  const marketKey = tx.moveCall({
    target: input.isUp ? predictTargets.marketUp : predictTargets.marketDown,
    arguments: [
      tx.pure.id(input.oracleId),
      tx.pure.u64(input.expiry),
      tx.pure.u64(input.strike),
    ],
  });

  tx.moveCall({
    target: predictTargets.tradeAmounts,
    arguments: [
      tx.object(DEEPBOOK_OBJECT_ID),
      tx.object(input.oracleId),
      marketKey,
      tx.pure.u64(input.quantity),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  const result = await protocolClient.devInspectTransactionBlock({
    sender: input.sender ?? DEV_INSPECT_SENDER,
    transactionBlock: tx,
  });

  if (result.effects.status.status !== 'success') {
    throw new Error(result.effects.status.error ?? 'Predict quote failed');
  }

  const returnValues = result.results?.[1]?.returnValues;
  if (!returnValues || returnValues.length < 2) {
    throw new Error('Predict quote returned no values');
  }

  const quoteAmount = decodeU64(returnValues[0] as [number[], string]);
  const quoteAmountAlt = decodeU64(returnValues[1] as [number[], string]);
  const quantity = toBigInt(input.quantity);

  return {
    oracleId: normalizeId(input.oracleId),
    expiry: toBigInt(input.expiry),
    strike: toBigInt(input.strike),
    isUp: input.isUp,
    quantity,
    askPrice: scaleAskPrice(quoteAmount, quantity),
    quoteAmount,
    quoteAmountAlt,
  };
}

export async function quotePredictSelection(
  input: PredictSelection & { sender?: string },
): Promise<PredictQuote> {
  return quotePredictLeg({
    oracleId: input.oracleId,
    expiry: input.expiry,
    strike: input.strike,
    isUp: input.isUp,
    quantity: input.quantity,
    sender: input.sender,
  });
}
