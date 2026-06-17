import { bcs } from '@mysten/sui/bcs';
import { fromHex } from '@mysten/sui/utils';

import type { MarketLeg, U64ish } from './types';
import { bytesToObjectId, normalizeId, toBigInt } from './utils';

const MarketLegBcs = bcs.struct('MarketLeg', {
  oracle_id: bcs.vector(bcs.u8()),
  expiry: bcs.u64(),
  strike: bcs.u64(),
  is_up: bcs.bool(),
  ask_price: bcs.u64(),
  quantity: bcs.u64(),
});

const MarketLegVectorBcs = bcs.vector(MarketLegBcs);
const U64VectorBcs = bcs.vector(bcs.u64());

function toU64String(value: U64ish): string {
  return BigInt(value).toString();
}

function oracleIdToBytes(oracleId: string): number[] {
  return Array.from(fromHex(normalizeId(oracleId)));
}

export function serializeMarketLegs(legs: MarketLeg[]): Uint8Array {
  return MarketLegVectorBcs.serialize(
    legs.map((leg) => ({
      oracle_id: oracleIdToBytes(leg.oracleId),
      expiry: toU64String(leg.expiry),
      strike: toU64String(leg.strike),
      is_up: leg.isUp,
      ask_price: toU64String(leg.askPrice),
      quantity: toU64String(leg.quantity),
    })),
  ).toBytes();
}

export function deserializeMarketLegs(bytes: Uint8Array | number[]): MarketLeg[] {
  const decoded = MarketLegVectorBcs.parse(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  return decoded.map((leg) => ({
    oracleId: bytesToObjectId(leg.oracle_id),
    expiry: toBigInt(leg.expiry),
    strike: toBigInt(leg.strike),
    isUp: leg.is_up,
    askPrice: toBigInt(leg.ask_price),
    quantity: toBigInt(leg.quantity),
  }));
}

export function serializeQuantities(quantities: U64ish[]): Uint8Array {
  return U64VectorBcs.serialize(quantities.map(toU64String)).toBytes();
}

export function deserializeQuantities(bytes: Uint8Array | number[]): bigint[] {
  return U64VectorBcs.parse(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)).map(
    (value) => toBigInt(value),
  );
}
