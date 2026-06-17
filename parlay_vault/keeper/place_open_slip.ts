import { bcs } from '@mysten/sui/bcs';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiObjectId } from '@mysten/sui/utils';

import {
  addPredictManagerDeposit,
  addPredictMintLegs,
  defaultPredictConfig,
  ensurePredictManager,
  serializeSlipLegs,
  type PredictConfig,
  type PredictLeg,
  type SlipLegData,
} from './predict_ptb.js';

type CoinRef = {
  coinObjectId: string;
  balance: bigint;
};

type OracleCandidate = {
  oracleId: string;
  expiry: bigint;
  forward: bigint;
  tickSize: bigint;
  minStrike: bigint;
  maxStrike: bigint;
};

type QuotedLeg = PredictLeg & {
  askPrice: bigint;
  quoteAmount: bigint;
  quoteAmountAlt: bigint;
};

const NETWORK = (process.env.SUI_NETWORK as PredictConfig['network'] | undefined) ?? 'testnet';
const QUOTE_TYPE = mustEnv('DEEPBOOK_QUOTE_TYPE');
const DEEPBOOK_PKG = normalizeSuiObjectId(mustEnv('DEEPBOOK_PKG'));
const DEEPBOOK_OBJ = normalizeSuiObjectId(mustEnv('DEEPBOOK_OBJ'));
const VAULT_PKG = normalizeSuiObjectId(mustEnv('VAULT_PKG'));
const VAULT_ID = normalizeSuiObjectId(mustEnv('VAULT_ID'));
const OPEN_SLIPS_ID = normalizeSuiObjectId(mustEnv('OPEN_SLIPS_ID'));
const ADMIN_CAP_ID = normalizeSuiObjectId(mustEnv('ADMIN_CAP_ID'));
const CLOCK_ID = normalizeSuiObjectId(process.env.CLOCK_OBJECT_ID ?? '0x6');
const QUANTITY = BigInt(process.env.SMOKE_QUANTITY ?? '1000000');
const STAKE_BUFFER = BigInt(process.env.SMOKE_STAKE_BUFFER ?? '250000');
const ORACLE_COUNT = Number(process.env.PLACE_OPEN_SLIP_LEGS ?? '3');

const client = new SuiJsonRpcClient({
  network: NETWORK,
  url: getJsonRpcFullnodeUrl(NETWORK),
});
const keypair = Ed25519Keypair.fromSecretKey(mustEnv('KEEPER_PRIVATE_KEY'));
const keeperAddress = keypair.toSuiAddress();
const predictConfig = defaultPredictConfig(QUOTE_TYPE, {
  network: NETWORK,
  packageId: DEEPBOOK_PKG,
  predictObjectId: DEEPBOOK_OBJ,
  clockObjectId: CLOCK_ID,
});

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => (typeof inner === 'bigint' ? inner.toString() : inner), 2);
}

function decodeU64(value: [number[], string]): bigint {
  return BigInt(bcs.u64().parse(Uint8Array.from(value[0])));
}

function roundToTick(value: bigint, tickSize: bigint): bigint {
  return (value / tickSize) * tickSize;
}

function scaleAskPrice(quoteAmount: bigint, quantity: bigint): bigint {
  return (quoteAmount * 1_000_000_000n) / quantity;
}

async function getQuoteCoins(): Promise<CoinRef[]> {
  const page = await client.getCoins({
    owner: keeperAddress,
    coinType: QUOTE_TYPE,
  });
  return page.data.map((coin) => ({
    coinObjectId: normalizeSuiObjectId(coin.coinObjectId),
    balance: BigInt(coin.balance),
  }));
}

async function mergeQuoteCoinsIfNeeded(): Promise<void> {
  const coins = await getQuoteCoins();
  if (coins.length <= 1) {
    return;
  }

  const sorted = [...coins].sort((left, right) => Number(right.balance - left.balance));
  const primary = sorted[0];
  const sources = sorted.slice(1);
  const tx = new Transaction();
  tx.setGasBudget(30_000_000);
  tx.mergeCoins(
    tx.object(primary.coinObjectId),
    sources.map((coin) => tx.object(coin.coinObjectId)),
  );

  await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: {
      showEffects: true,
    },
  });
}

async function readPredictObject(): Promise<Record<string, unknown>> {
  const object = await client.getObject({
    id: DEEPBOOK_OBJ,
    options: { showContent: true },
  });
  const fields = (object.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  if (!fields) {
    throw new Error('Predict object content is unavailable');
  }
  return fields;
}

async function findActiveOracles(limit: number): Promise<OracleCandidate[]> {
  const nowMs = BigInt(Date.now());
  const predictFields = await readPredictObject();
  const oracleConfig = predictFields.oracle_config as { fields?: Record<string, unknown> };
  const oracleGrids = oracleConfig.fields?.oracle_grids as { fields?: Record<string, unknown> };
  const oracleGridIdValue = oracleGrids.fields?.id as { id?: string } | string | undefined;
  const oracleGridParent = normalizeSuiObjectId(
    typeof oracleGridIdValue === 'string' ? oracleGridIdValue : String(oracleGridIdValue?.id),
  );

  const active: OracleCandidate[] = [];
  let cursor: string | null = null;

  while (active.length < limit) {
    const page = await client.getDynamicFields({
      parentId: oracleGridParent,
      cursor,
      limit: 100,
    });
    const ids = page.data.map((field) => normalizeSuiObjectId(String(field.name.value)));
    const objects = await client.multiGetObjects({
      ids,
      options: { showContent: true },
    });

    for (let i = 0; i < objects.length; i += 1) {
      const object = objects[i];
      const field = page.data[i];
      const content = object.data?.content as { fields?: Record<string, unknown> } | undefined;
      const fields = content?.fields;
      if (!fields || fields.active !== true || fields.underlying_asset !== 'BTC') {
        continue;
      }

      const expiry = BigInt(String(fields.expiry));
      if (expiry <= nowMs) {
        continue;
      }

      const gridObject = await client.getObject({
        id: normalizeSuiObjectId(field.objectId),
        options: { showContent: true },
      });
      const gridContent = gridObject.data?.content as { fields?: Record<string, unknown> } | undefined;
      const gridFields = (gridContent?.fields?.value as { fields?: Record<string, unknown> } | undefined)?.fields;
      if (!gridFields) {
        continue;
      }

      active.push({
        oracleId: normalizeSuiObjectId(String(object.data?.objectId)),
        expiry,
        forward: BigInt(String((fields.prices as { fields?: Record<string, unknown> }).fields?.forward)),
        tickSize: BigInt(String(gridFields.tick_size)),
        minStrike: BigInt(String(gridFields.min_strike)),
        maxStrike: BigInt(String(gridFields.max_strike)),
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

async function quoteLeg(
  oracle: OracleCandidate,
  isUp: boolean,
  strike: bigint,
  quantity: bigint,
): Promise<QuotedLeg> {
  const tx = new Transaction();
  const marketKey = tx.moveCall({
    target: `${DEEPBOOK_PKG}::market_key::${isUp ? 'up' : 'down'}`,
    arguments: [
      tx.pure.id(oracle.oracleId),
      tx.pure.u64(oracle.expiry),
      tx.pure.u64(strike),
    ],
  });
  tx.moveCall({
    target: `${DEEPBOOK_PKG}::predict::get_trade_amounts`,
    arguments: [
      tx.object(DEEPBOOK_OBJ),
      tx.object(oracle.oracleId),
      marketKey,
      tx.pure.u64(quantity),
      tx.object(CLOCK_ID),
    ],
  });

  const result = await client.devInspectTransactionBlock({
    sender: keeperAddress,
    transactionBlock: tx,
  });

  if (result.effects.status.status !== 'success') {
    throw new Error(result.effects.status.error ?? `Quote failed for ${oracle.oracleId}`);
  }

  const returnValues = result.results?.[1]?.returnValues;
  if (!returnValues || returnValues.length < 2) {
    throw new Error(`Quote returned no values for ${oracle.oracleId}`);
  }

  const quoteAmount = decodeU64(returnValues[0] as [number[], string]);
  const quoteAmountAlt = decodeU64(returnValues[1] as [number[], string]);

  return {
    oracleId: oracle.oracleId,
    expiry: oracle.expiry,
    strike,
    isUp,
    quantity,
    askPrice: scaleAskPrice(quoteAmount, quantity),
    quoteAmount,
    quoteAmountAlt,
  };
}

async function placeSlip(stake: bigint, legs: QuotedLeg[]): Promise<string> {
  await mergeQuoteCoinsIfNeeded();
  const coins = await getQuoteCoins();
  const source = coins.find((coin) => coin.balance >= stake);
  if (!source) {
    throw new Error(`No quote coin with at least ${stake.toString()} available for slip placement`);
  }

  const slipLegs: SlipLegData[] = legs.map((leg) => ({
    oracleId: leg.oracleId,
    expiry: leg.expiry,
    strike: leg.strike,
    isUp: leg.isUp,
    askPrice: leg.askPrice,
    quantity: leg.quantity,
  }));

  const tx = new Transaction();
  tx.setGasBudget(80_000_000);
  const [stakeCoin] = tx.splitCoins(tx.object(source.coinObjectId), [tx.pure.u64(stake)]);
  const receipt = tx.moveCall({
    target: `${VAULT_PKG}::slip_executor::place_slip_bcs`,
    typeArguments: [QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      stakeCoin,
      tx.pure.vector('u8', Array.from(serializeSlipLegs(slipLegs))),
    ],
  });
  tx.transferObjects([receipt], keeperAddress);

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: {
      showObjectChanges: true,
      showEffects: true,
    },
  });

  const receiptChange = result.objectChanges?.find((change) =>
    change.type === 'created' && change.objectType.endsWith('::slip_executor::SlipReceipt'),
  );
  if (!receiptChange || !('objectId' in receiptChange)) {
    throw new Error('SlipReceipt was not created');
  }

  return normalizeSuiObjectId(receiptChange.objectId);
}

async function executePendingSlip(managerId: string, slipId: string, legs: QuotedLeg[]): Promise<void> {
  const tx = new Transaction();
  tx.setGasBudget(200_000_000);

  const releasedStake = tx.moveCall({
    target: `${VAULT_PKG}::parlay_vault::release_pending_stake`,
    typeArguments: [QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      tx.pure.id(slipId),
      tx.object(ADMIN_CAP_ID),
    ],
  });

  addPredictManagerDeposit(tx, predictConfig, managerId, releasedStake);
  addPredictMintLegs(tx, predictConfig, managerId, legs);
  tx.moveCall({
    target: `${VAULT_PKG}::parlay_vault::finalize_slip`,
    typeArguments: [QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      tx.pure.id(slipId),
      tx.object(ADMIN_CAP_ID),
    ],
  });
  tx.moveCall({
    target: `${VAULT_PKG}::slip_executor::register_active_slip`,
    typeArguments: [QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      tx.object(OPEN_SLIPS_ID),
      tx.pure.id(slipId),
      tx.object(ADMIN_CAP_ID),
    ],
  });

  await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: {
      showEffects: true,
      showObjectChanges: true,
    },
  });
}

async function readSnapshot() {
  const [vault, openSlips] = await Promise.all([
    client.getObject({ id: VAULT_ID, options: { showContent: true } }),
    client.getObject({ id: OPEN_SLIPS_ID, options: { showContent: true } }),
  ]);

  const vaultFields = (vault.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  const openFields = (openSlips.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;

  return {
    current_epoch: vaultFields?.current_epoch,
    pending_slips_size: (vaultFields?.pending_slips as { size?: string } | undefined)?.size,
    active_slips_size: (vaultFields?.active_slips as { size?: string } | undefined)?.size,
    open_slips_size: (openFields?.slips as { size?: string } | undefined)?.size,
    open_slip_ids: openFields?.slip_ids,
  };
}

async function main(): Promise<void> {
  console.log(`Keeper: ${keeperAddress}`);
  const managerId = await ensurePredictManager({
    client,
    signer: keypair,
    config: predictConfig,
    managerId: process.env.PREDICT_MANAGER_ID,
  });
  console.log(`PredictManager: ${managerId}`);

  const activeOracles = await findActiveOracles(Math.max(ORACLE_COUNT, 3));
  if (activeOracles.length < ORACLE_COUNT) {
    throw new Error(`Only found ${activeOracles.length} future BTC oracles`);
  }

  const quotedLegs: QuotedLeg[] = [];
  for (let i = 0; i < ORACLE_COUNT; i += 1) {
    const oracle = activeOracles[i];
    const baseStrike = roundToTick(oracle.forward, oracle.tickSize);
    const isUp = i % 2 === 0;
    const strike = isUp
      ? (baseStrike - oracle.tickSize >= oracle.minStrike ? baseStrike - oracle.tickSize : baseStrike)
      : (baseStrike + oracle.tickSize <= oracle.maxStrike ? baseStrike + oracle.tickSize : baseStrike);

    quotedLegs.push(await quoteLeg(oracle, isUp, strike, QUANTITY));
  }

  const stake = quotedLegs.reduce((sum, leg) => sum + leg.quoteAmount, 0n) + STAKE_BUFFER;
  const slipId = await placeSlip(stake, quotedLegs);
  await executePendingSlip(managerId, slipId, quotedLegs);

  console.log(`Open slip created: ${slipId}`);
  console.log(`Legs: ${quotedLegs.length}`);
  console.log(`Stake: ${stake.toString()}`);
  console.log(`Quoted legs: ${stringify(quotedLegs)}`);
  console.log(`Snapshot: ${stringify(await readSnapshot())}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
