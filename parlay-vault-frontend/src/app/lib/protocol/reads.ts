import type { SuiJsonRpcClient, SuiObjectResponse } from '@mysten/sui/jsonRpc';

import {
  DEEPBOOK_QUOTE_TYPE,
  OPEN_SLIPS_ID,
  PROTOCOL_PACKAGE_ID,
  PROTOCOL_TYPE_PACKAGE_ID,
  VAULT_ID,
  protocolClient,
  protocolTypes,
} from './config';
import { deserializeMarketLegs, deserializeQuantities } from './bcs';
import type {
  CoinObjectRef,
  IndexedSlip,
  LPPosition,
  SlipPhase,
  SlipReceipt,
  VaultState,
} from './types';
import { chunk, decodeMarketLegFromFields, ensureMoveFields, normalizeId, toBigInt } from './utils';

async function multiGetObjectsChunked(
  client: SuiJsonRpcClient,
  ids: string[],
): Promise<SuiObjectResponse[]> {
  const responses: SuiObjectResponse[] = [];
  for (const batch of chunk(ids, 50)) {
    const next = await client.multiGetObjects({
      ids: batch,
      options: { showContent: true, showType: true, showOwner: true },
    });
    responses.push(...next);
  }
  return responses;
}

async function getAllDynamicFields(
  client: SuiJsonRpcClient,
  parentId: string,
) {
  const entries: Array<{ objectId: string; name: { value: unknown } }> = [];
  let cursor: string | null = null;

  do {
    const page = await client.getDynamicFields({
      parentId,
      cursor,
      limit: 100,
    });
    entries.push(...(page.data as Array<{ objectId: string; name: { value: unknown } }>));
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);

  return entries;
}

function parseVaultFromObject(object: SuiObjectResponse): VaultState {
  const objectData = object.data;
  if (!objectData?.content) {
    throw new Error('Vault object content is unavailable');
  }

  const fields = ensureMoveFields(objectData.content);
  const lpBalance = toBigInt(fields.lp_balance as string);
  const accruedYield = toBigInt(fields.accrued_yield as string);
  const lockedBonus = toBigInt(fields.locked_bonus as string);
  const totalShares = toBigInt(fields.total_shares as string);
  const availableLiquidity = lpBalance + accruedYield > lockedBonus
    ? lpBalance + accruedYield - lockedBonus
    : 0n;
  const sharePrice = totalShares === 0n ? 1_000_000n : (availableLiquidity * 1_000_000n) / totalShares;
  const bonusCapPct = toBigInt(fields.bonus_cap_pct as string);
  const bonusReserve = (lpBalance * bonusCapPct) / 10_000n;
  const availableBonusCapacity = bonusReserve > lockedBonus ? bonusReserve - lockedBonus : 0n;

  return {
    objectId: normalizeId(String(objectData.objectId)),
    packageId: PROTOCOL_PACKAGE_ID,
    typeOriginPackageId: PROTOCOL_TYPE_PACKAGE_ID,
    quoteType: DEEPBOOK_QUOTE_TYPE,
    currentEpoch: toBigInt(fields.current_epoch as string),
    epochSettled: Boolean(fields.epoch_settled),
    totalDeposits: toBigInt(fields.total_deposits as string),
    totalShares,
    lockedBonus,
    accruedYield,
    bonusCapPct,
    lpBalance,
    escrow: toBigInt(fields.escrow as string),
    sharePrice,
    bonusReserve,
    availableBonusCapacity,
    tableRefs: {
      pendingDeposits: normalizeId((fields.pending_deposits as { id: string }).id),
      pendingShareIds: normalizeId((fields.pending_share_ids as { id: string }).id),
      lpPositions: normalizeId((fields.lp_positions as { id: string }).id),
      pendingSlips: normalizeId((fields.pending_slips as { id: string }).id),
      activeSlips: normalizeId((fields.active_slips as { id: string }).id),
      epochSlipCounts: normalizeId((fields.epoch_slip_counts as { id: string }).id),
    },
  };
}

function parseReceipt(object: SuiObjectResponse): SlipReceipt {
  const objectData = object.data;
  if (!objectData?.content) {
    throw new Error('Slip receipt content is unavailable');
  }

  const fields = ensureMoveFields(objectData.content);
  const legs = (fields.legs as Array<{ fields: Record<string, unknown> }>).map((leg) =>
    decodeMarketLegFromFields(leg.fields),
  );

  return {
    receiptId: normalizeId((fields.id as { id: string }).id),
    owner: normalizeId(String(fields.owner)),
    legs,
    stake: toBigInt(fields.stake as string),
    combinedOdds: toBigInt(fields.combined_odds as string),
    bonusMultiplier: toBigInt(fields.bonus_multiplier as string),
    potentialPayout: toBigInt(fields.potential_payout as string),
    bonusAmount: toBigInt(fields.bonus_amount as string),
    placedAt: toBigInt(fields.placed_at as string),
  };
}

function parseLPPosition(object: SuiObjectResponse): LPPosition {
  const objectData = object.data;
  if (!objectData?.content) {
    throw new Error('LP position content is unavailable');
  }

  const field = ensureMoveFields(objectData.content);
  const value = (field.value as { fields: Record<string, unknown> }).fields;

  return {
    shareId: normalizeId(String(field.name)),
    principal: toBigInt(value.principal as string),
    shares: toBigInt(value.shares as string),
    activationEpoch: toBigInt(value.activation_epoch as string),
    autoRoll: Boolean(value.auto_roll),
    isActive: Boolean(value.is_active),
  };
}

function parseIndexedSlip(
  object: SuiObjectResponse,
  phase: SlipPhase,
): IndexedSlip {
  const objectData = object.data;
  if (!objectData?.content) {
    throw new Error('Slip table field content is unavailable');
  }

  const field = ensureMoveFields(objectData.content);
  const value = (field.value as { fields: Record<string, unknown> }).fields;
  const legsBytes = value.legs_data as number[];
  const quantitiesBytes = value.quantities_data as number[];

  return {
    slipId: normalizeId(String(field.name)),
    phase,
    owner: normalizeId(String(value.owner)),
    legs: deserializeMarketLegs(legsBytes),
    quantities: deserializeQuantities(quantitiesBytes),
    stake: toBigInt(value.stake as string),
    bonusAmount: toBigInt(value.bonus_amount as string),
    stakeReleased: phase === 'pending' ? Boolean(value.stake_released) : null,
    entryEpoch: phase === 'pending' ? null : toBigInt(value.entry_epoch as string),
  };
}

async function readSlipTable(
  client: SuiJsonRpcClient,
  parentId: string,
  phase: SlipPhase,
): Promise<IndexedSlip[]> {
  const entries = await getAllDynamicFields(client, parentId);
  if (entries.length === 0) {
    return [];
  }

  const objects = await multiGetObjectsChunked(
    client,
    entries.map((entry) => normalizeId(entry.objectId)),
  );
  return objects.map((object) => parseIndexedSlip(object, phase));
}

export async function getVaultState(
  client: SuiJsonRpcClient = protocolClient,
): Promise<VaultState> {
  const object = await client.getObject({
    id: VAULT_ID,
    options: { showContent: true, showType: true },
  });
  return parseVaultFromObject(object);
}

export async function getOwnedQuoteCoins(
  owner: string,
  client: SuiJsonRpcClient = protocolClient,
): Promise<CoinObjectRef[]> {
  const page = await client.getCoins({
    owner: normalizeId(owner),
    coinType: DEEPBOOK_QUOTE_TYPE,
  });

  return page.data.map((coin) => ({
    coinObjectId: normalizeId(coin.coinObjectId),
    balance: BigInt(coin.balance),
  }));
}

export async function getOwnedLpShares(
  owner: string,
  client: SuiJsonRpcClient = protocolClient,
): Promise<LPPosition[]> {
  const vault = await getVaultState(client);
  const owned = await client.getOwnedObjects({
    owner: normalizeId(owner),
    filter: { StructType: protocolTypes.lpShare },
    options: { showType: true },
  });

  const shareIds = owned.data
    .map((item) => item.data?.objectId)
    .filter((value): value is string => Boolean(value))
    .map(normalizeId);

  if (shareIds.length === 0) {
    return [];
  }

  const positions = await Promise.all(
    shareIds.map((shareId) =>
      client.getDynamicFieldObject({
        parentId: vault.tableRefs.lpPositions,
        name: {
          type: '0x2::object::ID',
          value: shareId,
        },
      })),
  );

  return positions.map(parseLPPosition);
}

export async function getOwnedSlipReceipts(
  owner: string,
  client: SuiJsonRpcClient = protocolClient,
): Promise<SlipReceipt[]> {
  const owned = await client.getOwnedObjects({
    owner: normalizeId(owner),
    filter: { StructType: protocolTypes.slipReceipt },
    options: { showContent: true, showType: true, showOwner: true },
  });

  return owned.data
    .filter((item) => Boolean(item.data?.content))
    .map(parseReceipt);
}

export async function getPendingSlips(
  client: SuiJsonRpcClient = protocolClient,
): Promise<IndexedSlip[]> {
  const vault = await getVaultState(client);
  return readSlipTable(client, vault.tableRefs.pendingSlips, 'pending');
}

export async function getActiveSlips(
  client: SuiJsonRpcClient = protocolClient,
): Promise<IndexedSlip[]> {
  const vault = await getVaultState(client);
  return readSlipTable(client, vault.tableRefs.activeSlips, 'active');
}

export async function getOpenSlips(
  client: SuiJsonRpcClient = protocolClient,
): Promise<IndexedSlip[]> {
  const object = await client.getObject({
    id: OPEN_SLIPS_ID,
    options: { showContent: true, showType: true },
  });

  const objectData = object.data;
  if (!objectData?.content) {
    throw new Error('Open slips object content is unavailable');
  }

  const fields = ensureMoveFields(objectData.content);
  const slipsTableId = normalizeId((fields.slips as { id: string }).id);
  return readSlipTable(client, slipsTableId, 'open');
}

export async function getProtocolSnapshot(
  owner?: string | null,
  client: SuiJsonRpcClient = protocolClient,
) {
  const [vault, pendingSlips, activeSlips, openSlips, ownedLpShares, ownedReceipts] = await Promise.all([
    getVaultState(client),
    getPendingSlips(client),
    getActiveSlips(client),
    getOpenSlips(client),
    owner ? getOwnedLpShares(owner, client) : Promise.resolve([]),
    owner ? getOwnedSlipReceipts(owner, client) : Promise.resolve([]),
  ]);

  return {
    vault,
    pendingSlips,
    activeSlips,
    openSlips,
    ownedLpShares,
    ownedReceipts,
  };
}
