import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, type TransactionObjectArgument, type TransactionResult } from '@mysten/sui/transactions';
import { normalizeSuiObjectId } from '@mysten/sui/utils';

import {
  addPredictManagerDeposit,
  addPredictManagerWithdraw,
  addPredictMintLegs,
  addPredictRedeemLegs,
  createPredictClient,
  defaultPredictConfig,
  ensurePredictManager,
  type PredictConfig,
  type PredictLeg,
} from './predict_ptb.js';

type EventCursor = { txDigest: string; eventSeq: string } | null;

type KeeperState = {
  pendingCursor: EventCursor;
  oracleCursor: EventCursor;
};

type PendingSlipEvent = {
  slip_id: string;
  owner: string;
  stake: string | number;
};

type OracleSettledEvent = {
  oracle_id: string;
  expiry: string;
  settlement_price: string;
  timestamp: string;
};

type TrackedSlip = {
  slipId: string;
  owner: string;
  stake: bigint;
  bonusAmount: bigint;
  legs: PredictLeg[];
  settleAfterMs: bigint;
  nextSettleAttemptMs: bigint;
};

type SlipResolution = {
  resolved: boolean;
  allWin: boolean;
  winningLegs: number;
  totalLegs: number;
  expectedRedeemedAmount: bigint;
};

type JsonFields = Record<string, unknown>;

const NETWORK = (process.env.SUI_NETWORK as PredictConfig['network'] | undefined) ?? 'testnet';

const VAULT_PKG = normalizeSuiObjectId(mustEnv('VAULT_PKG'));
const QUOTE_TYPE = mustEnv('DEEPBOOK_QUOTE_TYPE');
const VAULT_ID = normalizeSuiObjectId(mustEnv('VAULT_ID'));
const OPEN_SLIPS_ID = normalizeSuiObjectId(mustEnv('OPEN_SLIPS_ID'));
const ADMIN_CAP_ID = normalizeSuiObjectId(mustEnv('ADMIN_CAP_ID'));
const RESYNC_INTERVAL_MS = Number(process.env.KEEPER_RESYNC_INTERVAL_MS ?? '30000');
const POLL_INTERVAL_MS = Number(process.env.KEEPER_POLL_INTERVAL_MS ?? '5000');
const SETTLEMENT_GRACE_MS = BigInt(process.env.KEEPER_SETTLEMENT_GRACE_MS ?? '30000');
const SETTLEMENT_RETRY_MS = BigInt(process.env.KEEPER_SETTLEMENT_RETRY_MS ?? '60000');
const ENABLE_ORACLE_EVENT_POLLING = process.env.KEEPER_ENABLE_ORACLE_EVENT_POLLING === 'true';
const STATE_DIR = path.resolve(process.cwd(), '.state');
const STATE_PATH = path.join(STATE_DIR, 'bot-state.json');

const client = createPredictClient(NETWORK);
const keypair = Ed25519Keypair.fromSecretKey(parsePrivateKey(mustEnv('KEEPER_PRIVATE_KEY')));
const keeperAddress = keypair.toSuiAddress();
const predictConfig = defaultPredictConfig(QUOTE_TYPE, {
  network: NETWORK,
  packageId: process.env.DEEPBOOK_PKG,
  predictObjectId: process.env.DEEPBOOK_OBJ,
  clockObjectId: process.env.CLOCK_OBJECT_ID,
});

const trackedSlips = new Map<string, TrackedSlip>();
const executingSlips = new Set<string>();
const settlingSlips = new Set<string>();
const expiredPendingSlips = new Set<string>();

let predictManagerId: string;
let keeperState: KeeperState = {
  pendingCursor: null,
  oracleCursor: null,
};

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function parsePrivateKey(raw: string): Uint8Array {
  if (raw.startsWith('suiprivkey')) {
    return decodeSuiPrivateKey(raw).secretKey;
  }

  const normalized = raw.startsWith('0x') ? raw.slice(2) : raw;
  return Buffer.from(normalized, 'hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBigInt(value: unknown): bigint {
  return BigInt(String(value));
}

function log(message: string): void {
  console.log(`[bot] ${message}`);
}

function normalizeSlipId(slipId: string): string {
  return normalizeSuiObjectId(slipId);
}

function computeSettleAfterMs(legs: PredictLeg[]): bigint {
  let latestExpiry = 0n;
  for (const leg of legs) {
    const expiry = BigInt(leg.expiry);
    if (expiry > latestExpiry) {
      latestExpiry = expiry;
    }
  }
  return latestExpiry + SETTLEMENT_GRACE_MS;
}

function earliestLegExpiryMs(legs: PredictLeg[]): bigint {
  let earliestExpiry: bigint | null = null;
  for (const leg of legs) {
    const expiry = BigInt(leg.expiry);
    if (earliestExpiry === null || expiry < earliestExpiry) {
      earliestExpiry = expiry;
    }
  }
  return earliestExpiry ?? 0n;
}

function extractObjectId(value: unknown, label: string): string {
  if (typeof value === 'string') {
    return normalizeSuiObjectId(value);
  }
  if (value && typeof value === 'object' && 'id' in value) {
    return normalizeSuiObjectId(String((value as { id: unknown }).id));
  }
  throw new Error(`Unable to extract object id for ${label}`);
}

function extractTableId(value: unknown, label: string): string {
  if (value && typeof value === 'object' && 'fields' in value) {
    const fields = (value as { fields?: { id?: unknown } }).fields;
    if (fields?.id !== undefined) {
      return extractObjectId(fields.id, label);
    }
  }
  return extractObjectId(value, label);
}

async function saveState(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(keeperState, null, 2), 'utf8');
}

async function loadState(): Promise<void> {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<KeeperState>;
    keeperState = {
      pendingCursor: parsed.pendingCursor ?? null,
      oracleCursor: parsed.oracleCursor ?? null,
    };
  } catch {
    keeperState = {
      pendingCursor: null,
      oracleCursor: null,
    };
  }
}

async function getObjectFields(objectId: string): Promise<JsonFields> {
  const object = await client.getObject({
    id: normalizeSuiObjectId(objectId),
    options: { showContent: true },
  });
  const content = object.data?.content as { fields?: JsonFields } | undefined;
  if (!content?.fields) {
    throw new Error(`Object content unavailable for ${objectId}`);
  }
  return content.fields;
}

async function getTableFieldObjects(parentId: string): Promise<Array<{ objectId: string; name: unknown }>> {
  const items: Array<{ objectId: string; name: unknown }> = [];
  let cursor: string | null = null;

  do {
    const page = await client.getDynamicFields({
      parentId: normalizeSuiObjectId(parentId),
      cursor,
      limit: 50,
    });
    for (const entry of page.data) {
      items.push({
        objectId: normalizeSuiObjectId(entry.objectId),
        name: entry.name.value,
      });
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);

  return items;
}

async function hasObjectIdKey(parentId: string, objectId: string): Promise<boolean> {
  try {
    const response = await client.getDynamicFieldObject({
      parentId: normalizeSuiObjectId(parentId),
      name: {
        type: '0x2::object::ID',
        value: normalizeSuiObjectId(objectId),
      },
    });
    return response.data !== null;
  } catch {
    return false;
  }
}

async function getVaultTableIds(): Promise<{ pendingTableId: string; activeTableId: string }> {
  const vaultFields = await getObjectFields(VAULT_ID);
  return {
    pendingTableId: extractTableId(vaultFields.pending_slips, 'pending_slips'),
    activeTableId: extractTableId(vaultFields.active_slips, 'active_slips'),
  };
}

async function isSlipPendingOnChain(slipId: string): Promise<boolean> {
  const { pendingTableId } = await getVaultTableIds();
  return hasObjectIdKey(pendingTableId, slipId);
}

async function isSlipActiveOnChain(slipId: string): Promise<boolean> {
  const { activeTableId } = await getVaultTableIds();
  return hasObjectIdKey(activeTableId, slipId);
}

async function isSlipOpenOnChain(slipId: string): Promise<boolean> {
  const openFields = await getObjectFields(OPEN_SLIPS_ID);
  const slipsTableId = extractTableId(openFields.slips, 'open_slips.slips');
  return hasObjectIdKey(slipsTableId, slipId);
}

function decodeLegsFromReceipt(fields: JsonFields): PredictLeg[] {
  const rawLegs = fields.legs as Array<{ fields?: JsonFields }>;
  return rawLegs.map((leg) => {
    const legFields = leg.fields ?? {};
    return {
      oracleId: normalizeSuiObjectId(`0x${Buffer.from(legFields.oracle_id as number[]).toString('hex')}`),
      expiry: toBigInt(legFields.expiry),
      strike: toBigInt(legFields.strike),
      isUp: Boolean(legFields.is_up),
      quantity: toBigInt(legFields.quantity),
      askPrice: toBigInt(legFields.ask_price),
    };
  });
}

async function loadTrackedSlipFromReceipt(slipId: string): Promise<TrackedSlip> {
  const fields = await getObjectFields(slipId);
  const legs = decodeLegsFromReceipt(fields);
  const settleAfterMs = computeSettleAfterMs(legs);
  return {
    slipId: normalizeSlipId(slipId),
    owner: String(fields.owner),
    stake: toBigInt(fields.stake),
    bonusAmount: toBigInt(fields.bonus_amount),
    legs,
    settleAfterMs,
    nextSettleAttemptMs: settleAfterMs,
  };
}

async function bootstrapPendingSlips(): Promise<void> {
  const vaultFields = await getObjectFields(VAULT_ID);
  const pendingTableId = extractTableId(vaultFields.pending_slips, 'pending_slips');
  const entries = await getTableFieldObjects(pendingTableId);

  for (const entry of entries) {
    const slipId = normalizeSlipId(String(entry.name));
    try {
      const slip = await loadTrackedSlipFromReceipt(slipId);
      await executePendingSlip(slip);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`pending bootstrap skipped ${slipId}: ${message}`);
    }
  }
}

async function bootstrapActiveSlips(): Promise<void> {
  const openFields = await getObjectFields(OPEN_SLIPS_ID);
  const slipIds = (openFields.slip_ids as string[] | undefined) ?? [];

  for (const slipIdRaw of slipIds) {
    const slipId = normalizeSlipId(String(slipIdRaw));
    if (trackedSlips.has(slipId)) {
      continue;
    }
    try {
      const slip = await loadTrackedSlipFromReceipt(slipId);
      trackedSlips.set(slipId, slip);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`active bootstrap skipped ${slipId}: ${message}`);
    }
  }
}

async function readOracleSettlement(oracleId: string): Promise<{ settlementPrice: bigint | null }> {
  const fields = await getObjectFields(oracleId);
  const settlement = fields.settlement_price;
  return {
    settlementPrice: settlement === null || settlement === undefined ? null : toBigInt(settlement),
  };
}

function legWins(leg: PredictLeg, settlementPrice: bigint): boolean {
  return leg.isUp ? settlementPrice > BigInt(leg.strike) : settlementPrice <= BigInt(leg.strike);
}

function marketKeyId(leg: PredictLeg): string {
  return [
    normalizeSuiObjectId(leg.oracleId),
    BigInt(leg.expiry).toString(),
    BigInt(leg.strike).toString(),
    leg.isUp ? '0' : '1',
  ].join(':');
}

function canAttemptSettlement(slip: TrackedSlip): boolean {
  return BigInt(Date.now()) >= slip.nextSettleAttemptMs;
}

function formatSettleAfter(slip: TrackedSlip): string {
  return new Date(Number(slip.nextSettleAttemptMs)).toISOString();
}

function deferSettlement(slip: TrackedSlip, delayMs: bigint): void {
  slip.nextSettleAttemptMs = BigInt(Date.now()) + delayMs;
}

async function resolveSlip(slip: TrackedSlip): Promise<SlipResolution> {
  const settlements = new Map<string, bigint | null>();

  for (const leg of slip.legs) {
    const oracleId = normalizeSuiObjectId(leg.oracleId);
    if (!settlements.has(oracleId)) {
      const settlement = await readOracleSettlement(oracleId);
      settlements.set(oracleId, settlement.settlementPrice);
    }
  }

  if ([...settlements.values()].some((value) => value === null)) {
    return {
      resolved: false,
      allWin: false,
      winningLegs: 0,
      totalLegs: slip.legs.length,
      expectedRedeemedAmount: 0n,
    };
  }

  let winningLegs = 0;
  let expectedRedeemedAmount = 0n;
  for (const leg of slip.legs) {
    const settlementPrice = settlements.get(normalizeSuiObjectId(leg.oracleId));
    if (settlementPrice === null || settlementPrice === undefined) {
      throw new Error(`Settlement missing for ${leg.oracleId}`);
    }
    if (legWins(leg, settlementPrice)) {
      winningLegs += 1;
      expectedRedeemedAmount += BigInt(leg.quantity);
    }
  }

  return {
    resolved: true,
    allWin: winningLegs === slip.legs.length,
    winningLegs,
    totalLegs: slip.legs.length,
    expectedRedeemedAmount,
  };
}

async function managerBalance(): Promise<bigint> {
  const fields = await getObjectFields(predictManagerId);
  const balanceManager = fields.balance_manager as { fields?: JsonFields };
  const balances = balanceManager.fields?.balances as { fields?: JsonFields };
  const balancesIdValue = balances.fields?.id as { id?: string } | string | undefined;
  const balancesId = typeof balancesIdValue === 'string' ? balancesIdValue : balancesIdValue?.id;
  if (!balancesId) {
    throw new Error('Manager balances table unavailable');
  }

  const entries = await getTableFieldObjects(balancesId);
  if (entries.length === 0) {
    return 0n;
  }

  const objects = await client.multiGetObjects({
    ids: entries.map((entry) => entry.objectId),
    options: { showContent: true },
  });

  let total = 0n;
  for (const object of objects) {
    const content = object.data?.content as { fields?: JsonFields } | undefined;
    const value = content?.fields?.value;
    if (value !== undefined) {
      total += toBigInt(value);
    }
  }
  return total;
}

async function managerPositionQuantities(): Promise<Map<string, bigint>> {
  const fields = await getObjectFields(predictManagerId);
  const positions = fields.positions as { fields?: JsonFields };
  const positionsId = extractTableId(positions, 'predict_manager.positions');
  const entries = await getTableFieldObjects(positionsId);
  const quantities = new Map<string, bigint>();

  if (entries.length === 0) {
    return quantities;
  }

  const objects = await client.multiGetObjects({
    ids: entries.map((entry) => entry.objectId),
    options: { showContent: true },
  });

  for (const object of objects) {
    const content = object.data?.content as { fields?: JsonFields } | undefined;
    const fieldName = content?.fields?.name as { fields?: JsonFields } | JsonFields | undefined;
    const key: JsonFields | undefined = fieldName && 'fields' in fieldName
      ? fieldName.fields as JsonFields | undefined
      : fieldName as JsonFields | undefined;
    const quantity = content?.fields?.value;
    if (!key || quantity === undefined) {
      continue;
    }

    const leg: PredictLeg = {
      oracleId: normalizeSuiObjectId(String(key.oracle_id)),
      expiry: toBigInt(key.expiry),
      strike: toBigInt(key.strike),
      isUp: Number(key.direction) === 0,
      quantity: 0n,
    };
    quantities.set(marketKeyId(leg), toBigInt(quantity));
  }

  return quantities;
}

async function remainingRedeemLegs(legs: PredictLeg[]): Promise<PredictLeg[]> {
  const availableByMarket = await managerPositionQuantities();
  const remaining: PredictLeg[] = [];

  for (const leg of legs) {
    const key = marketKeyId(leg);
    const available = availableByMarket.get(key) ?? 0n;
    const requested = BigInt(leg.quantity);
    const quantity = available < requested ? available : requested;
    if (quantity === 0n) {
      continue;
    }

    remaining.push({ ...leg, quantity });
    availableByMarket.set(key, available - quantity);
  }

  return remaining;
}

async function settlementCoinInput(
  tx: Transaction,
  amount: bigint,
): Promise<ReturnType<Transaction['splitCoins']>[number] | TransactionResult> {
  if (amount > 0n) {
    return addPredictManagerWithdraw(tx, predictConfig, predictManagerId, amount);
  }

  const coins = await client.getCoins({
    owner: keeperAddress,
    coinType: QUOTE_TYPE,
  });
  const source = coins.data.find((coin) => BigInt(coin.balance) > 0n);
  if (!source) {
    throw new Error('No quote coin available to create zero-value settlement coin');
  }

  const [zeroCoin] = tx.splitCoins(tx.object(source.coinObjectId), [tx.pure.u64(0)]);
  return zeroCoin;
}

async function executePendingSlip(slip: TrackedSlip): Promise<void> {
  const slipId = normalizeSlipId(slip.slipId);
  if (executingSlips.has(slipId)) {
    return;
  }

  executingSlips.add(slipId);
  try {
    if (!(await isSlipPendingOnChain(slipId))) {
      expiredPendingSlips.delete(slipId);
      return;
    }

    if (BigInt(Date.now()) >= earliestLegExpiryMs(slip.legs)) {
      if (!expiredPendingSlips.has(slipId)) {
        expiredPendingSlips.add(slipId);
        log(`pending slip ${slipId} expired before execution; waiting for bettor cancellation`);
      }
      return;
    }

    const tx = new Transaction();
    // Gas budget must cover: release_pending_stake (1 cmd) + deposit (~2 cmds)
    // + mintLegs (legs × ~2 cmds each, including order-book mint + match) +
    // finalize_slip (1) + register_active_slip (1). 200M (0.2 SUI) is too
    // tight for 3+ leg slips — the dry-run aborts mid-mint at command 7 with
    // "InsufficientGas". 800M ceiling handles up to ~5 legs; the budget is
    // a ceiling so unused gas is refunded.
    tx.setGasBudget(800_000_000);

    const releasedStake = tx.moveCall({
      target: `${VAULT_PKG}::parlay_vault::release_pending_stake`,
      typeArguments: [QUOTE_TYPE],
      arguments: [
        tx.object(VAULT_ID),
        tx.pure.id(slipId),
        tx.object(ADMIN_CAP_ID),
      ],
    });

    addPredictManagerDeposit(tx, predictConfig, predictManagerId, releasedStake);
    addPredictMintLegs(tx, predictConfig, predictManagerId, slip.legs);

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
      options: { showEffects: true, showObjectChanges: true },
    });

    if (result.effects?.status.status !== 'success') {
      throw new Error(result.effects?.status.error ?? `execute pending failed for ${slipId}`);
    }

    trackedSlips.set(slipId, slip);
    log(`executed pending slip ${slipId}: ${result.digest} | settle after ${formatSettleAfter(slip)}`);
  } finally {
    executingSlips.delete(slipId);
  }
}

async function settleSlip(slipId: string): Promise<void> {
  const normalizedSlipId = normalizeSlipId(slipId);
  if (settlingSlips.has(normalizedSlipId)) {
    return;
  }

  const slip = trackedSlips.get(normalizedSlipId);
  if (!slip) {
    return;
  }

  settlingSlips.add(normalizedSlipId);
  try {
    const [isActive, isOpen] = await Promise.all([
      isSlipActiveOnChain(normalizedSlipId),
      isSlipOpenOnChain(normalizedSlipId),
    ]);
    if (!isActive || !isOpen) {
      trackedSlips.delete(normalizedSlipId);
      return;
    }

    if (!canAttemptSettlement(slip)) {
      return;
    }

    const resolution = await resolveSlip(slip);
    if (!resolution.resolved) {
      deferSettlement(slip, SETTLEMENT_RETRY_MS);
      return;
    }

    const redeemLegs = await remainingRedeemLegs(slip.legs);
    if (redeemLegs.length > 0) {
      const redeemTx = new Transaction();
      // Redemption is cheaper than execution — no mint, just order-book
      // settlement. 300M is plenty for up to ~10 legs in a single PTB.
      redeemTx.setGasBudget(300_000_000);
      addPredictRedeemLegs(redeemTx, predictConfig, predictManagerId, redeemLegs, true);
      const redeemResult = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: redeemTx,
        options: { showEffects: true, showEvents: true },
      });

      if (redeemResult.effects?.status.status !== 'success') {
        throw new Error(redeemResult.effects?.status.error ?? `redeem failed for ${normalizedSlipId}`);
      }
      log(`redeemed ${redeemLegs.length} remaining Predict position(s) for ${normalizedSlipId}: ${redeemResult.digest}`);
    } else {
      log(`Predict positions already redeemed permissionlessly for ${normalizedSlipId}`);
    }

    const redeemedAmount = resolution.expectedRedeemedAmount;
    const availableManagerBalance = await managerBalance();
    if (availableManagerBalance < redeemedAmount) {
      throw new Error(
        `PredictManager balance ${availableManagerBalance} is below slip proceeds ${redeemedAmount}`,
      );
    }

    const settleTx = new Transaction();
    // Settlement PTB: settle_all_win / settle_not_all_win does a single
    // balance update + transfer. 300M ceiling matches the redeem budget;
    // can drop to 200M if you're confident nothing else grows here.
    settleTx.setGasBudget(500_000_000);
    const redeemedCoin = await settlementCoinInput(settleTx, redeemedAmount);

    settleTx.moveCall({
      target: `${VAULT_PKG}::slip_executor::${resolution.allWin ? 'settle_all_win' : 'settle_not_all_win'}`,
      typeArguments: [QUOTE_TYPE],
      arguments: resolution.allWin
        ? [
          settleTx.object(VAULT_ID),
          settleTx.object(OPEN_SLIPS_ID),
          settleTx.pure.id(normalizedSlipId),
          redeemedCoin as TransactionObjectArgument | TransactionResult,
          settleTx.object(ADMIN_CAP_ID),
        ]
        : [
          settleTx.object(VAULT_ID),
          settleTx.object(OPEN_SLIPS_ID),
          settleTx.pure.id(normalizedSlipId),
          redeemedCoin as TransactionObjectArgument | TransactionResult,
          settleTx.object(ADMIN_CAP_ID),
        ],
    });

    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: settleTx,
      options: { showEffects: true, showEvents: true },
    });

    if (result.effects?.status.status !== 'success') {
      throw new Error(result.effects?.status.error ?? `settlement failed for ${normalizedSlipId}`);
    }

    trackedSlips.delete(normalizedSlipId);
    log(`settled slip ${normalizedSlipId}: ${result.digest} (${resolution.winningLegs}/${resolution.totalLegs})`);
  } catch (error) {
    deferSettlement(slip, SETTLEMENT_RETRY_MS);
    const message = error instanceof Error ? error.message : String(error);
    log(`deferred settlement for ${normalizedSlipId} until ${formatSettleAfter(slip)}: ${message}`);
  } finally {
    settlingSlips.delete(normalizedSlipId);
  }
}

async function resyncOnChainState(): Promise<void> {
  await bootstrapPendingSlips();
  await bootstrapActiveSlips();
}

async function pollPendingLoop(): Promise<never> {
  let backoffMs = POLL_INTERVAL_MS;
  for (;;) {
    try {
      const page = await client.queryEvents({
        query: {
          MoveEventModule: {
            package: VAULT_PKG,
            module: 'parlay_vault',
          },
        },
        cursor: keeperState.pendingCursor ?? undefined,
        limit: 50,
        order: 'ascending',
      });

      for (const event of page.data) {
        if (!event.type.includes('SlipPending')) {
          continue;
        }
        const parsed = event.parsedJson as PendingSlipEvent;
        const slip = await loadTrackedSlipFromReceipt(parsed.slip_id);
        await executePendingSlip(slip);
      }

      keeperState.pendingCursor = page.nextCursor ?? keeperState.pendingCursor;
      await saveState();
      backoffMs = POLL_INTERVAL_MS;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`SlipPending polling failed: ${message}`);
      backoffMs = Math.min(backoffMs * 2, 60000);
    }

    await sleep(backoffMs);
  }
}

async function pollOracleLoop(): Promise<never> {
  let backoffMs = POLL_INTERVAL_MS;
  for (;;) {
    try {
      const page = await client.queryEvents({
        query: {
          MoveEventModule: {
            package: predictConfig.packageId,
            module: 'oracle',
          },
        },
        cursor: keeperState.oracleCursor ?? undefined,
        limit: 50,
        order: 'ascending',
      });

      for (const event of page.data) {
        if (!event.type.includes('OracleSettled')) {
          continue;
        }
        const parsed = event.parsedJson as OracleSettledEvent;
        const oracleId = normalizeSuiObjectId(parsed.oracle_id);
        for (const [slipId, slip] of trackedSlips.entries()) {
          if (slip.legs.some((leg) => normalizeSuiObjectId(leg.oracleId) === oracleId)) {
            await settleSlip(slipId);
          }
        }
      }

      keeperState.oracleCursor = page.nextCursor ?? keeperState.oracleCursor;
      await saveState();
      backoffMs = POLL_INTERVAL_MS;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`OracleSettled polling failed: ${message}`);
      if (message.includes('Could not find the referenced transaction events')) {
        keeperState.oracleCursor = null;
      }
      backoffMs = Math.min(backoffMs * 2, 60000);
    }

    await sleep(backoffMs);
  }
}

async function settlementSchedulerLoop(): Promise<never> {
  for (;;) {
    try {
      for (const [slipId, slip] of trackedSlips.entries()) {
        if (!canAttemptSettlement(slip)) {
          continue;
        }
        await settleSlip(slipId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`settlement scheduler failed: ${message}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function resyncLoop(): Promise<never> {
  for (;;) {
    try {
      await resyncOnChainState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`resync failed: ${message}`);
    }
    await sleep(RESYNC_INTERVAL_MS);
  }
}

async function main(): Promise<void> {
  await loadState();

  predictManagerId = await ensurePredictManager({
    client,
    signer: keypair,
    config: predictConfig,
    managerId: process.env.PREDICT_MANAGER_ID,
  });

  log(`keeper ${keeperAddress}`);
  log(`predict manager ${predictManagerId}`);
  log(`vault ${VAULT_ID}`);
  log(`open slips ${OPEN_SLIPS_ID}`);

  await resyncOnChainState();

  void pollPendingLoop();
  if (ENABLE_ORACLE_EVENT_POLLING) {
    void pollOracleLoop();
  }
  void settlementSchedulerLoop();
  await resyncLoop();
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
