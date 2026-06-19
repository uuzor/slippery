'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from '@mysten/dapp-kit';
import {
  buildPredictSelection,
  listFuturePredictOracles,
  quotePredictLeg,
  quotePredictSelection,
} from './predict';
import {
  getActiveSlips,
  getOpenSlips,
  getOwnedLpShares,
  getOwnedQuoteCoins,
  getOwnedSlipReceipts,
  getOracleSettlements,
  getPendingSlips,
  getProtocolSnapshot,
  getVaultState,
} from './reads';
import type {
  IndexedSlip,
  LPPosition,
  OracleSettlement,
  PredictMarket,
  PredictSelection,
  PredictOracleCandidate,
  PredictQuote,
  SlipReceipt,
  VaultState,
} from './types';
import { toBigInt } from './utils';
import {
  buildAdvanceEpochTransaction,
  buildCancelPendingSlipTransaction,
  buildCancelQueuedDepositTransaction,
  buildDepositTransaction,
  buildPlaceSlipTransaction,
  buildRollOverTransaction,
  buildSeedLiquidityTransaction,
  buildWithdrawTransaction,
} from './writes';

interface QueryState<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function useQuery<T>(
  enabled: boolean,
  load: () => Promise<T>,
  deps: unknown[],
  pollMs?: number,
): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const next = await loadRef.current();
      setData(next);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh, ...deps]);

  useEffect(() => {
    if (!enabled || !pollMs) {
      return;
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [enabled, pollMs, refresh]);

  return { data, isLoading, error, refresh };
}

export function useVaultState(pollMs = 15_000) {
  return useQuery<VaultState>(true, () => getVaultState(), [pollMs], pollMs);
}

export function useOwnedQuoteCoins(owner?: string | null, pollMs = 15_000) {
  return useQuery(
    Boolean(owner),
    () => getOwnedQuoteCoins(owner!),
    [owner, pollMs],
    pollMs,
  );
}

export function useOwnedLpShares(owner?: string | null, pollMs = 15_000) {
  return useQuery<LPPosition[]>(
    Boolean(owner),
    () => getOwnedLpShares(owner!),
    [owner, pollMs],
    pollMs,
  );
}

export function useOwnedSlipReceipts(owner?: string | null, pollMs = 15_000) {
  return useQuery<SlipReceipt[]>(
    Boolean(owner),
    () => getOwnedSlipReceipts(owner!),
    [owner, pollMs],
    pollMs,
  );
}

export function usePendingSlips(pollMs = 15_000) {
  return useQuery<IndexedSlip[]>(true, () => getPendingSlips(), [pollMs], pollMs);
}

export function useActiveSlips(pollMs = 15_000) {
  return useQuery<IndexedSlip[]>(true, () => getActiveSlips(), [pollMs], pollMs);
}

export function useOpenSlips(pollMs = 15_000) {
  return useQuery<IndexedSlip[]>(true, () => getOpenSlips(), [pollMs], pollMs);
}

export function useProtocolSnapshot(owner?: string | null, pollMs = 15_000) {
  return useQuery(
    true,
    () => getProtocolSnapshot(owner),
    [owner, pollMs],
    pollMs,
  );
}

export function useFutureBtcOracles(limit = 8, pollMs = 30_000) {
  return useQuery<PredictOracleCandidate[]>(
    true,
    () => listFuturePredictOracles('BTC', limit),
    [limit, pollMs],
    pollMs,
  );
}

export function usePredictMarkets(
  underlyingAsset = 'BTC',
  limit = 8,
  strikeDepth = 2,
  pollMs = 30_000,
) {
  const loadMarkets = useCallback(async (): Promise<PredictMarket[]> => {
    const params = new URLSearchParams({
      underlyingAsset,
      limit: String(limit),
      strikeDepth: String(strikeDepth),
    });
    const response = await fetch(`/api/predict-markets?${params.toString()}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Predict markets request failed: ${response.status}`);
    }
    const payload = (await response.json()) as Array<{
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
    }>;

    return payload.map((market) => ({
      marketId: market.marketId,
      oracleId: market.oracleId,
      gridObjectId: market.gridObjectId,
      expiry: toBigInt(market.expiry),
      forward: toBigInt(market.forward),
      spot: toBigInt(market.spot),
      tickSize: toBigInt(market.tickSize),
      minStrike: toBigInt(market.minStrike),
      maxStrike: toBigInt(market.maxStrike),
      underlyingAsset: market.underlyingAsset,
      atmStrike: toBigInt(market.atmStrike),
      strikeOptions: market.strikeOptions.map((option) => ({
        strike: toBigInt(option.strike),
        isAtTheMoney: option.isAtTheMoney,
        distanceFromAtmSteps: toBigInt(option.distanceFromAtmSteps),
      })),
    }));
  }, [underlyingAsset, limit, strikeDepth]);

  return useQuery<PredictMarket[]>(
    true,
    loadMarkets,
    [underlyingAsset, limit, strikeDepth, pollMs],
    pollMs,
  );
}

export function usePredictQuote() {
  const [data, setData] = useState<PredictQuote | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quote = useCallback(
    async (input: Parameters<typeof quotePredictLeg>[0]) => {
      setIsLoading(true);
      try {
        const next = await quotePredictLeg(input);
        setData(next);
        setError(null);
        return next;
      } catch (quoteError) {
        const message = quoteError instanceof Error ? quoteError.message : String(quoteError);
        setError(message);
        throw quoteError;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  return { data, isLoading, error, quote };
}

export function usePredictSelectionQuote() {
  const [data, setData] = useState<PredictQuote | null>(null);
  const [selection, setSelection] = useState<PredictSelection | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quote = useCallback(
    async (input: Parameters<typeof quotePredictSelection>[0]) => {
      setIsLoading(true);
      try {
        const next = await quotePredictSelection(input);
        setData(next);
        setSelection({
          marketId: input.marketId,
          oracleId: input.oracleId,
          expiry: BigInt(input.expiry),
          strike: BigInt(input.strike),
          isUp: input.isUp,
          quantity: BigInt(input.quantity),
          underlyingAsset: input.underlyingAsset,
        });
        setError(null);
        return next;
      } catch (quoteError) {
        const message = quoteError instanceof Error ? quoteError.message : String(quoteError);
        setError(message);
        throw quoteError;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const quoteFromMarket = useCallback(
    async (input: Parameters<typeof buildPredictSelection>[0] & { sender?: string }) => {
      const selectionInput = buildPredictSelection(input);
      return quote({
        ...selectionInput,
        sender: input.sender,
      });
    },
    [quote],
  );

  return { data, selection, isLoading, error, quote, quoteFromMarket };
}

export function useProtocolWrites() {
  const currentAccount = useCurrentAccount();
  const { mutateAsync: signAndExecuteTransaction } = useSignAndExecuteTransaction();
  const address = currentAccount?.address ?? null;
  const isReady = Boolean(currentAccount);

  const requireAddress = useCallback(() => {
    if (!address) {
      throw new Error('Wallet is not connected');
    }
    return address;
  }, [address]);

  const deposit = useCallback(
    async (input: Omit<Parameters<typeof buildDepositTransaction>[0], 'owner'>) => {
      const owner = requireAddress();
      const transaction = buildDepositTransaction({ ...input, owner });
      return signAndExecuteTransaction({ transaction });
    },
    [requireAddress, signAndExecuteTransaction],
  );

  const seedLiquidity = useCallback(
    async (input: Omit<Parameters<typeof buildSeedLiquidityTransaction>[0], 'owner'>) => {
      const owner = requireAddress();
      const transaction = buildSeedLiquidityTransaction({ ...input, owner });
      return signAndExecuteTransaction({ transaction });
    },
    [requireAddress, signAndExecuteTransaction],
  );

  const withdraw = useCallback(
    async (input: Omit<Parameters<typeof buildWithdrawTransaction>[0], 'owner'>) => {
      const owner = requireAddress();
      const transaction = buildWithdrawTransaction({ ...input, owner });
      return signAndExecuteTransaction({ transaction });
    },
    [requireAddress, signAndExecuteTransaction],
  );

  const cancelQueuedDeposit = useCallback(
    async (input: Omit<Parameters<typeof buildCancelQueuedDepositTransaction>[0], 'owner'>) => {
      const owner = requireAddress();
      const transaction = buildCancelQueuedDepositTransaction({ ...input, owner });
      return signAndExecuteTransaction({ transaction });
    },
    [requireAddress, signAndExecuteTransaction],
  );

  const rollOver = useCallback(
    async (input: Omit<Parameters<typeof buildRollOverTransaction>[0], 'owner'>) => {
      const owner = requireAddress();
      const transaction = buildRollOverTransaction({ ...input, owner });
      return signAndExecuteTransaction({ transaction });
    },
    [requireAddress, signAndExecuteTransaction],
  );

  const advanceEpoch = useCallback(async () => {
    const owner = requireAddress();
    const transaction = buildAdvanceEpochTransaction({ owner });
    return signAndExecuteTransaction({ transaction });
  }, [requireAddress, signAndExecuteTransaction]);

  const placeSlip = useCallback(
    async (input: Omit<Parameters<typeof buildPlaceSlipTransaction>[0], 'owner'>) => {
      const owner = requireAddress();
      const transaction = buildPlaceSlipTransaction({ ...input, owner });
      return signAndExecuteTransaction({ transaction });
    },
    [requireAddress, signAndExecuteTransaction],
  );

  const cancelPendingSlip = useCallback(
    async (input: Omit<Parameters<typeof buildCancelPendingSlipTransaction>[0], 'owner'>) => {
      const owner = requireAddress();
      const transaction = buildCancelPendingSlipTransaction({ ...input, owner });
      return signAndExecuteTransaction({ transaction });
    },
    [requireAddress, signAndExecuteTransaction],
  );

  return useMemo(
    () => ({
      address,
      isReady,
      deposit,
      seedLiquidity,
      withdraw,
      cancelQueuedDeposit,
      rollOver,
      advanceEpoch,
      cancelPendingSlip,
      placeSlip,
    }),
    [
      address,
      isReady,
      deposit,
      seedLiquidity,
      withdraw,
      cancelQueuedDeposit,
      rollOver,
      advanceEpoch,
      cancelPendingSlip,
      placeSlip,
    ],
  );
}

export function useOracleSettlements(oracleIds: string[], pollMs = 30_000) {
  const normalizedKey = [...new Set(oracleIds)].sort().join(',');
  return useQuery<OracleSettlement[]>(
    normalizedKey.length > 0,
    () => getOracleSettlements(normalizedKey.split(',')),
    [normalizedKey, pollMs],
    pollMs,
  );
}
