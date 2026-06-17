import { bcs } from '@mysten/sui/bcs';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiObjectId } from '@mysten/sui/utils';

import {
  addPredictManagerDeposit,
  addPredictManagerWithdraw,
  addPredictMintLegs,
  addPredictRedeemLegs,
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
  gridObjectId: string;
  expiry: bigint;
  forward: bigint;
  spot: bigint;
  tickSize: bigint;
  minStrike: bigint;
  maxStrike: bigint;
};

type QuotedLeg = PredictLeg & {
  askPrice: bigint;
  quoteAmount: bigint;
  quoteAmountAlt: bigint;
};

type OracleSettlement = {
  oracleId: string;
  expiry: bigint;
  isActive: boolean;
  isSettled: boolean;
  settlementPrice: bigint | null;
};

type SlipResolution = {
  resolved: boolean;
  allWin: boolean;
  winningLegs: number;
  totalLegs: number;
  settlements: Map<string, OracleSettlement>;
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
const SEED_AMOUNT = BigInt(process.env.SMOKE_SEED_AMOUNT ?? '100000000');
const STAKE_BUFFER = BigInt(process.env.SMOKE_STAKE_BUFFER ?? '250000');
const QUANTITY = BigInt(process.env.SMOKE_QUANTITY ?? '1000000');
const MAX_ORACLE_SCAN = Number(process.env.SMOKE_ORACLE_SCAN ?? '2500');
const WAIT_POLL_MS = Number(process.env.SMOKE_WAIT_POLL_MS ?? '15000');
const WAIT_TIMEOUT_MS = Number(process.env.SMOKE_WAIT_TIMEOUT_MS ?? '1800000');

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
  return JSON.stringify(value, (_key, inner) => typeof inner === 'bigint' ? inner.toString() : inner, 2);
}

function decodeU64(value: [number[], string]): bigint {
  return BigInt(bcs.u64().parse(Uint8Array.from(value[0])));
}

function scaleAskPrice(quoteAmount: bigint, quantity: bigint): bigint {
  return (quoteAmount * 1_000_000_000n) / quantity;
}

function roundToTick(value: bigint, tickSize: bigint): bigint {
  return (value / tickSize) * tickSize;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function legWins(leg: QuotedLeg, settlementPrice: bigint): boolean {
  return leg.isUp ? settlementPrice > BigInt(leg.strike) : settlementPrice <= BigInt(leg.strike);
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

  const sorted = [...coins].sort((a, b) => Number(b.balance - a.balance));
  const primary = sorted[0];
  const sources = sorted.slice(1);
  const tx = new Transaction();
  tx.setGasBudget(30_000_000);
  tx.mergeCoins(
    tx.object(primary.coinObjectId),
    sources.map((coin) => tx.object(coin.coinObjectId)),
  );

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: {
      showEffects: true,
      showObjectChanges: true,
    },
  });

  console.log(`Merged quote coins: ${result.digest}`);
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
  let scanned = 0;

  while (scanned < MAX_ORACLE_SCAN) {
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
      scanned += 1;
      if (!fields || fields.active !== true || fields.underlying_asset !== 'BTC') {
        continue;
      }
      if (BigInt(String(fields.expiry)) <= nowMs) {
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
        gridObjectId: normalizeSuiObjectId(field.objectId),
        expiry: BigInt(String(fields.expiry)),
        forward: BigInt(String((fields.prices as { fields?: Record<string, unknown> }).fields?.forward)),
        spot: BigInt(String((fields.prices as { fields?: Record<string, unknown> }).fields?.spot)),
        tickSize: BigInt(String(gridFields.tick_size)),
        minStrike: BigInt(String(gridFields.min_strike)),
        maxStrike: BigInt(String(gridFields.max_strike)),
      });

      if (active.length >= limit) {
        return active;
      }
    }

    if (!page.hasNextPage || !page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }

  active.sort((a, b) => Number(a.expiry - b.expiry));
  return active;
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
    throw new Error(`Quote failed for ${oracle.oracleId}: ${result.effects.status.error}`);
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

async function readOracleSettlement(oracleId: string): Promise<OracleSettlement> {
  const object = await client.getObject({
    id: oracleId,
    options: { showContent: true },
  });

  const content = object.data?.content as { fields?: Record<string, unknown> } | undefined;
  const fields = content?.fields;
  if (!fields) {
    throw new Error(`Oracle content unavailable for ${oracleId}`);
  }

  const settlementPriceRaw = fields.settlement_price;
  return {
    oracleId: normalizeSuiObjectId(oracleId),
    expiry: BigInt(String(fields.expiry)),
    isActive: fields.active === true,
    isSettled: settlementPriceRaw !== null && settlementPriceRaw !== undefined,
    settlementPrice: settlementPriceRaw === null || settlementPriceRaw === undefined
      ? null
      : BigInt(String(settlementPriceRaw)),
  };
}

async function resolveSlip(legs: QuotedLeg[]): Promise<SlipResolution> {
  const settlements = new Map<string, OracleSettlement>();
  for (const leg of legs) {
    const oracleId = normalizeSuiObjectId(leg.oracleId);
    if (!settlements.has(oracleId)) {
      settlements.set(oracleId, await readOracleSettlement(oracleId));
    }
  }

  if ([...settlements.values()].some((settlement) => !settlement.isSettled || settlement.settlementPrice === null)) {
    return {
      resolved: false,
      allWin: false,
      winningLegs: 0,
      totalLegs: legs.length,
      settlements,
    };
  }

  let winningLegs = 0;
  for (const leg of legs) {
    const settlement = settlements.get(normalizeSuiObjectId(leg.oracleId));
    if (!settlement || settlement.settlementPrice === null) {
      throw new Error(`Resolved settlement missing for ${leg.oracleId}`);
    }
    if (legWins(leg, settlement.settlementPrice)) {
      winningLegs += 1;
    }
  }

  return {
    resolved: true,
    allWin: winningLegs === legs.length,
    winningLegs,
    totalLegs: legs.length,
    settlements,
  };
}

async function waitForSlipSettlement(legs: QuotedLeg[]): Promise<SlipResolution> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    const resolution = await resolveSlip(legs);
    if (resolution.resolved) {
      return resolution;
    }

    attempt += 1;
    const unsettled = [...resolution.settlements.values()]
      .filter((settlement) => !settlement.isSettled)
      .map((settlement) => `${settlement.oracleId}@${settlement.expiry.toString()}`);
    console.log(`Waiting for Predict settlement (${attempt}) on ${unsettled.join(', ')}`);
    await delay(WAIT_POLL_MS);
  }

  throw new Error(`Timed out waiting for oracle settlement after ${WAIT_TIMEOUT_MS}ms`);
}

async function ensureManager(): Promise<string> {
  const manager = await ensurePredictManager({
    client,
    signer: keypair,
    config: predictConfig,
    managerId: process.env.PREDICT_MANAGER_ID || undefined,
  });
  return normalizeSuiObjectId(manager);
}

async function managerBalance(managerId: string): Promise<bigint> {
  const object = await client.getObject({
    id: managerId,
    options: { showContent: true },
  });
  const content = object.data?.content as { fields?: Record<string, unknown> } | undefined;
  const fields = content?.fields;
  const balanceManager = fields?.balance_manager as { fields?: Record<string, unknown> } | undefined;
  const balances = balanceManager?.fields?.balances as { fields?: Record<string, unknown> } | undefined;
  const balancesIdValue = balances?.fields?.id as { id?: string } | string | undefined;
  const balancesId = typeof balancesIdValue === 'string'
    ? balancesIdValue
    : balancesIdValue?.id;
  if (!balancesId) {
    throw new Error(`Unable to read manager balances table for ${managerId}`);
  }

  let total = 0n;
  let cursor: string | null = null;
  do {
    const page = await client.getDynamicFields({
      parentId: normalizeSuiObjectId(String(balancesId)),
      cursor,
      limit: 50,
    });

    if (page.data.length > 0) {
      const entries = await client.multiGetObjects({
        ids: page.data.map((entry) => normalizeSuiObjectId(entry.objectId)),
        options: { showContent: true },
      });

      for (const entry of entries) {
        const entryContent = entry.data?.content as { fields?: Record<string, unknown> } | undefined;
        const value = entryContent?.fields?.value;
        if (value !== undefined) {
          total += BigInt(String(value));
        }
      }
    }

    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);

  return total;
}

async function seedLiquidity(amount: bigint): Promise<string> {
  await mergeQuoteCoinsIfNeeded();
  const coins = await getQuoteCoins();
  const source = coins.find((coin) => coin.balance >= amount);
  if (!source) {
    throw new Error(`No quote coin with at least ${amount} available for seeding`);
  }

  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  const [seedCoin] = tx.splitCoins(tx.object(source.coinObjectId), [tx.pure.u64(amount)]);
  const share = tx.moveCall({
    target: `${VAULT_PKG}::parlay_vault::seed_liquidity`,
    typeArguments: [QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      seedCoin,
      tx.object(ADMIN_CAP_ID),
    ],
  });
  tx.transferObjects([share], keeperAddress);

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: {
      showObjectChanges: true,
      showEffects: true,
      showBalanceChanges: true,
    },
  });

  const shareChange = result.objectChanges?.find((change) =>
    change.type === 'created'
    && change.objectType.endsWith('::parlay_vault::LPShare'),
  );

  console.log(`Seeded LP liquidity: ${result.digest}`);
  if (!shareChange || !('objectId' in shareChange)) {
    throw new Error('LPShare was not created during liquidity seed');
  }
  return normalizeSuiObjectId(shareChange.objectId);
}

async function placeSlip(stake: bigint, legs: QuotedLeg[]): Promise<string> {
  await mergeQuoteCoinsIfNeeded();
  const coins = await getQuoteCoins();
  const source = coins.find((coin) => coin.balance >= stake);
  if (!source) {
    throw new Error(`No quote coin with at least ${stake} available for slip placement`);
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
      showEvents: true,
    },
  });

  const receiptChange = result.objectChanges?.find((change) =>
    change.type === 'created'
    && change.objectType.endsWith('::slip_executor::SlipReceipt'),
  );

  console.log(`Placed slip: ${result.digest}`);
  if (!receiptChange || !('objectId' in receiptChange)) {
    throw new Error('SlipReceipt was not created during slip placement');
  }
  return normalizeSuiObjectId(receiptChange.objectId);
}

async function executePendingSlip(managerId: string, slipId: string, legs: QuotedLeg[]): Promise<string> {
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

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: {
      showEffects: true,
      showObjectChanges: true,
      showEvents: true,
    },
  });

  console.log(`Executed pending slip: ${result.digest}`);
  return result.digest;
}

async function redeemSlip(managerId: string, legs: QuotedLeg[]): Promise<string> {
  const tx = new Transaction();
  tx.setGasBudget(200_000_000);
  addPredictRedeemLegs(tx, predictConfig, managerId, legs, false);

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: {
      showEffects: true,
      showEvents: true,
    },
  });

  console.log(`Redeemed Predict legs: ${result.digest}`);
  return result.digest;
}

async function settlementCoinInput(tx: Transaction, managerId: string, amount: bigint) {
  if (amount > 0n) {
    return addPredictManagerWithdraw(tx, predictConfig, managerId, amount);
  }

  await mergeQuoteCoinsIfNeeded();
  const coins = await getQuoteCoins();
  const source = coins.find((coin) => coin.balance > 0n);
  if (!source) {
    throw new Error('No quote coin available to create a zero-value settlement coin');
  }
  const [zeroCoin] = tx.splitCoins(tx.object(source.coinObjectId), [tx.pure.u64(0)]);
  return zeroCoin;
}

async function settleToLp(managerId: string, slipId: string, amount: bigint): Promise<string> {
  const tx = new Transaction();
  tx.setGasBudget(180_000_000);
  const redeemedCoin = await settlementCoinInput(tx, managerId, amount);
  tx.moveCall({
    target: `${VAULT_PKG}::slip_executor::settle_not_all_win`,
    typeArguments: [QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      tx.object(OPEN_SLIPS_ID),
      tx.pure.id(slipId),
      redeemedCoin,
      tx.object(ADMIN_CAP_ID),
    ],
  });

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: {
      showEffects: true,
      showEvents: true,
      showBalanceChanges: true,
    },
  });

  console.log(`Settled slip to LP: ${result.digest}`);
  return result.digest;
}

async function settleToWinner(managerId: string, slipId: string, amount: bigint): Promise<string> {
  const tx = new Transaction();
  tx.setGasBudget(180_000_000);
  const redeemedCoin = await settlementCoinInput(tx, managerId, amount);
  tx.moveCall({
    target: `${VAULT_PKG}::slip_executor::settle_all_win`,
    typeArguments: [QUOTE_TYPE],
    arguments: [
      tx.object(VAULT_ID),
      tx.object(OPEN_SLIPS_ID),
      tx.pure.id(slipId),
      redeemedCoin,
      tx.object(ADMIN_CAP_ID),
    ],
  });

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: {
      showEffects: true,
      showEvents: true,
      showBalanceChanges: true,
    },
  });

  console.log(`Settled slip to winner: ${result.digest}`);
  return result.digest;
}

async function readVaultSnapshot(): Promise<Record<string, unknown>> {
  const object = await client.getObject({
    id: VAULT_ID,
    options: { showContent: true },
  });
  const fields = (object.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  if (!fields) {
    throw new Error('Vault content is unavailable');
  }

  return {
    current_epoch: fields.current_epoch,
    total_deposits: fields.total_deposits,
    total_shares: fields.total_shares,
    lp_balance: fields.lp_balance,
    escrow: fields.escrow,
    locked_bonus: fields.locked_bonus,
    pending_slips_size: (fields.pending_slips as { fields?: Record<string, unknown> }).fields?.size,
    active_slips_size: (fields.active_slips as { fields?: Record<string, unknown> }).fields?.size,
    epoch_settled: fields.epoch_settled,
  };
}

async function main(): Promise<void> {
  console.log(`Keeper: ${keeperAddress}`);
  console.log(`Vault package: ${VAULT_PKG}`);
  const managerId = await ensureManager();
  console.log(`PredictManager: ${managerId}`);
  console.log(`Initial vault snapshot: ${stringify(await readVaultSnapshot())}`);
  const initialManagerBalance = await managerBalance(managerId);
  console.log(`Initial manager balance: ${initialManagerBalance.toString()}`);

  const shareId = await seedLiquidity(SEED_AMOUNT);
  console.log(`Seeded LPShare: ${shareId}`);

  const activeOracles = await findActiveOracles(8);
  if (activeOracles.length < 1) {
    throw new Error('No active BTC oracles found');
  }

  const chosenOracle = activeOracles[0];
  const baseStrike = roundToTick(chosenOracle.forward, chosenOracle.tickSize);
  const lowerStrike = baseStrike - chosenOracle.tickSize >= chosenOracle.minStrike
    ? baseStrike - chosenOracle.tickSize
    : baseStrike;
  const upperStrike = lowerStrike + chosenOracle.tickSize <= chosenOracle.maxStrike
    ? lowerStrike + chosenOracle.tickSize
    : baseStrike + chosenOracle.tickSize;
  if (upperStrike <= lowerStrike || upperStrike > chosenOracle.maxStrike) {
    throw new Error(`Unable to derive complementary strikes for oracle ${chosenOracle.oracleId}`);
  }
  const quotedLegs: QuotedLeg[] = [
    await quoteLeg(chosenOracle, true, lowerStrike, QUANTITY),
    await quoteLeg(chosenOracle, false, upperStrike, QUANTITY),
  ];

  const stake = quotedLegs.reduce((sum, leg) => sum + leg.quoteAmount, 0n) + STAKE_BUFFER;
  const slipId = await placeSlip(stake, quotedLegs);
  console.log(`Slip receipt: ${slipId} (${quotedLegs.length} legs, oracle ${chosenOracle.oracleId}, expiry ${chosenOracle.expiry.toString()})`);

  await executePendingSlip(managerId, slipId, quotedLegs);
  const postMintManagerBalance = await managerBalance(managerId);
  console.log(`Manager balance after mint: ${postMintManagerBalance}`);

  const resolution = await waitForSlipSettlement(quotedLegs);
  console.log(`Slip resolved: ${resolution.winningLegs}/${resolution.totalLegs} winning legs`);

  const preRedeemBalance = await managerBalance(managerId);
  console.log(`Manager balance before redeem: ${preRedeemBalance}`);
  await redeemSlip(managerId, quotedLegs);
  const redeemableBalance = await managerBalance(managerId);
  console.log(`Manager balance after redeem: ${redeemableBalance}`);
  const settleAmount = redeemableBalance - preRedeemBalance;
  if (settleAmount <= 0n) {
    throw new Error('Manager balance did not increase after redeem; nothing to settle');
  }

  if (resolution.allWin) {
    await settleToWinner(managerId, slipId, settleAmount);
  } else {
    await settleToLp(managerId, slipId, settleAmount);
  }
  console.log(`Final vault snapshot: ${stringify(await readVaultSnapshot())}`);
  console.log(`Final manager balance: ${(await managerBalance(managerId)).toString()}`);
  console.log(`Legs used: ${stringify(quotedLegs)}`);
  console.log(`Settlements: ${stringify([...resolution.settlements.values()])}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
