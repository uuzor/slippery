import { NextResponse } from 'next/server';

import { listPredictMarkets } from '../../lib/protocol/predict';

export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 15_000;
const MIN_EXECUTION_WINDOW_MS = 5 * 60 * 1_000;

type SerializedMarket = {
  marketId: string;
  oracleId: string;
  gridObjectId: string;
  expiry: string;
  forward: string;
  spot: string;
  tickSize: string;
  minStrike: string;
  maxStrike: string;
  underlyingAsset: string;
  atmStrike: string;
  strikeOptions: Array<{
    strike: string;
    isAtTheMoney: boolean;
    distanceFromAtmSteps: string;
  }>;
};

type CacheEntry = {
  expiresAt: number;
  data: SerializedMarket[];
  inflight?: Promise<SerializedMarket[]>;
};

const marketCache = new Map<string, CacheEntry>();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const underlyingAsset = searchParams.get('underlyingAsset') ?? 'BTC';
  const limit = Number(searchParams.get('limit') ?? '8');
  const strikeDepth = Number(searchParams.get('strikeDepth') ?? '2');
  const cacheKey = `${underlyingAsset}:${limit}:${strikeDepth}`;
  const now = Date.now();
  const cached = marketCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return NextResponse.json(
      cached.data.filter((market) => Number(market.expiry) > now + MIN_EXECUTION_WINDOW_MS),
      {
      headers: {
        'cache-control': 'no-store',
      },
      },
    );
  }

  if (cached?.inflight) {
    const data = await cached.inflight;
    return NextResponse.json(
      data.filter((market) => Number(market.expiry) > Date.now() + MIN_EXECUTION_WINDOW_MS),
      {
      headers: {
        'cache-control': 'no-store',
      },
      },
    );
  }

  const inflight = (async () => {
    const markets = await listPredictMarkets({
      underlyingAsset,
      limit,
      strikeDepth,
    });

    const serialized = markets.map((market) => ({
      marketId: market.marketId,
      oracleId: market.oracleId,
      gridObjectId: market.gridObjectId,
      expiry: market.expiry.toString(),
      forward: market.forward.toString(),
      spot: market.spot.toString(),
      tickSize: market.tickSize.toString(),
      minStrike: market.minStrike.toString(),
      maxStrike: market.maxStrike.toString(),
      underlyingAsset: market.underlyingAsset,
      atmStrike: market.atmStrike.toString(),
      strikeOptions: market.strikeOptions.map((option) => ({
        strike: option.strike.toString(),
        isAtTheMoney: option.isAtTheMoney,
        distanceFromAtmSteps: option.distanceFromAtmSteps.toString(),
      })),
    }));

    marketCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      data: serialized,
    });

    return serialized;
  })();

  marketCache.set(cacheKey, {
    expiresAt: 0,
    data: cached?.data ?? [],
    inflight,
  });

  try {
    const data = await inflight;
    return NextResponse.json(data, {
      headers: {
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    if (cached?.data?.length) {
      return NextResponse.json(
        cached.data.filter((market) => Number(market.expiry) > Date.now() + MIN_EXECUTION_WINDOW_MS),
        {
        headers: {
          'cache-control': 'no-store',
          'x-parlay-cache': 'stale',
        },
        },
      );
    }
    marketCache.delete(cacheKey);
    throw error;
  }
}
