import { Transaction } from '@mysten/sui/transactions';

import {
  ADMIN_CAP_ID,
  DEEPBOOK_QUOTE_TYPE,
  OPEN_SLIPS_ID,
  VAULT_ID,
  protocolTargets,
} from './config';
import { serializeMarketLegs } from './bcs';
import type { MarketLeg, U64ish } from './types';
import { normalizeId } from './utils';

function takeCoinAmount(
  tx: Transaction,
  coinObjectIds: string[],
  amount: U64ish,
) {
  if (coinObjectIds.length === 0) {
    throw new Error('At least one quote coin object is required');
  }

  const primary = tx.object(normalizeId(coinObjectIds[0]));
  if (coinObjectIds.length > 1) {
    tx.mergeCoins(
      primary,
      coinObjectIds.slice(1).map((coinId) => tx.object(normalizeId(coinId))),
    );
  }

  const [splitCoin] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
  return splitCoin;
}

export function buildDepositTransaction(input: {
  owner: string;
  coinObjectIds: string[];
  amount: U64ish;
  autoRoll?: boolean;
}) {
  const tx = new Transaction();
  tx.setSender(input.owner);

  const depositCoin = takeCoinAmount(tx, input.coinObjectIds, input.amount);
  const target = input.autoRoll ? protocolTargets.queueDeposit : protocolTargets.deposit;
  const args = input.autoRoll
    ? [
        tx.object(VAULT_ID),
        depositCoin,
        tx.pure.bool(true),
      ]
    : [
        tx.object(VAULT_ID),
        depositCoin,
      ];

  const [share] = tx.moveCall({
    target,
    typeArguments: [DEEPBOOK_QUOTE_TYPE],
    arguments: args,
  });

  tx.transferObjects([share], tx.pure.address(input.owner));
  return tx;
}

export function buildSeedLiquidityTransaction(input: {
  owner: string;
  coinObjectIds: string[];
  amount: U64ish;
  adminCapId?: string;
}) {
  const tx = new Transaction();
  tx.setSender(input.owner);

  const seedCoin = takeCoinAmount(tx, input.coinObjectIds, input.amount);
  const [share] = tx.moveCall({
    target: protocolTargets.seedLiquidity,
    typeArguments: [DEEPBOOK_QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      seedCoin,
      tx.object(input.adminCapId ?? ADMIN_CAP_ID),
    ],
  });

  tx.transferObjects([share], tx.pure.address(input.owner));
  return tx;
}

export function buildWithdrawTransaction(input: {
  owner: string;
  shareId: string;
}) {
  const tx = new Transaction();
  tx.setSender(input.owner);

  const [coin] = tx.moveCall({
    target: protocolTargets.withdraw,
    typeArguments: [DEEPBOOK_QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      tx.object(normalizeId(input.shareId)),
    ],
  });

  tx.transferObjects([coin], tx.pure.address(input.owner));
  return tx;
}

export function buildCancelQueuedDepositTransaction(input: {
  owner: string;
  shareId: string;
}) {
  const tx = new Transaction();
  tx.setSender(input.owner);

  const [coin] = tx.moveCall({
    target: protocolTargets.cancelQueuedDeposit,
    typeArguments: [DEEPBOOK_QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      tx.object(normalizeId(input.shareId)),
    ],
  });

  tx.transferObjects([coin], tx.pure.address(input.owner));
  return tx;
}

export function buildRollOverTransaction(input: {
  owner: string;
  shareId: string;
}) {
  const tx = new Transaction();
  tx.setSender(input.owner);

  const [share] = tx.moveCall({
    target: protocolTargets.rollOver,
    typeArguments: [DEEPBOOK_QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      tx.object(normalizeId(input.shareId)),
    ],
  });

  tx.transferObjects([share], tx.pure.address(input.owner));
  return tx;
}

export function buildAdvanceEpochTransaction(input: {
  owner: string;
}) {
  const tx = new Transaction();
  tx.setSender(input.owner);

  tx.moveCall({
    target: protocolTargets.advanceEpoch,
    typeArguments: [DEEPBOOK_QUOTE_TYPE],
    arguments: [tx.object(VAULT_ID)],
  });

  return tx;
}

export function buildPlaceSlipTransaction(input: {
  owner: string;
  coinObjectIds: string[];
  stakeAmount: U64ish;
  legs: MarketLeg[];
}) {
  const tx = new Transaction();
  tx.setSender(input.owner);

  const stakeCoin = takeCoinAmount(tx, input.coinObjectIds, input.stakeAmount);
  const legsBytes = serializeMarketLegs(input.legs);
  const [receipt] = tx.moveCall({
    target: protocolTargets.placeSlipBcs,
    typeArguments: [DEEPBOOK_QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      stakeCoin,
      tx.pure.vector('u8', Array.from(legsBytes)),
    ],
  });

  tx.transferObjects([receipt], tx.pure.address(input.owner));
  return tx;
}

export function buildRegisterActiveSlipTransaction(input: {
  owner: string;
  slipId: string;
  adminCapId?: string;
}) {
  const tx = new Transaction();
  tx.setSender(input.owner);

  tx.moveCall({
    target: `${protocolTargets.placeSlipBcs.split('::').slice(0, 2).join('::')}::register_active_slip`,
    typeArguments: [DEEPBOOK_QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      tx.object(OPEN_SLIPS_ID),
      tx.pure.id(input.slipId),
      tx.object(input.adminCapId ?? ADMIN_CAP_ID),
    ],
  });

  return tx;
}
