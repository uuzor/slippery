import { normalizeSuiObjectId } from '@mysten/sui/utils';

import type { MarketLeg, U64ish } from './types';

export function normalizeId(value: string): string {
  return normalizeSuiObjectId(value);
}

export function toBigInt(value: U64ish | null | undefined): bigint {
  if (value === null || value === undefined) {
    return 0n;
  }
  return BigInt(value);
}

export function bytesToObjectId(bytes: number[] | Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return normalizeId(`0x${hex}`);
}

export function decodeMarketLegFromFields(fields: Record<string, unknown>): MarketLeg {
  return {
    oracleId: bytesToObjectId(fields.oracle_id as number[]),
    expiry: toBigInt(fields.expiry as U64ish),
    strike: toBigInt(fields.strike as U64ish),
    isUp: Boolean(fields.is_up),
    askPrice: toBigInt(fields.ask_price as U64ish),
    quantity: toBigInt(fields.quantity as U64ish),
  };
}

export function ensureMoveFields(
  content: unknown,
): Record<string, unknown> {
  const moveContent = content as { dataType?: string; fields?: Record<string, unknown> } | null;
  if (!moveContent || moveContent.dataType !== 'moveObject' || !moveContent.fields) {
    throw new Error('Move object content is unavailable');
  }
  return moveContent.fields;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
