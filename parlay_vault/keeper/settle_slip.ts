import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Ed25519Keypair as Ed25519Signer } from '@mysten/sui/keypairs/ed25519';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiObjectId } from '@mysten/sui/utils';

import {
  addPredictManagerDeposit,
  addPredictMintLegs,
  addPredictRedeemLegs,
  addPredictManagerWithdraw,
  createPredictClient,
  defaultPredictConfig,
  ensurePredictManager,
  serializeSlipLegs,
  type PredictConfig,
  type PredictLeg,
} from './predict_ptb.js';

type VaultOutcome = 'won' | 'lost';

interface OracleSettledEvent {
  oracle_id: string;
  expiry: string;
  settlement_price: string;
  timestamp: string;
}

interface PendingSlipEvent {
  slip_id: string;
  owner: string;
  stake: number;
}

export interface TrackedSlip {
  slipId: string;
  owner: string;
  stake: bigint;
  bonusAmount: bigint;
  legs: PredictLeg[];
}

interface OracleSettlement {
  oracleId: string;
  expiry: bigint;
  isActive: boolean;
  isSettled: boolean;
  settlementPrice: bigint | null;
}

interface SlipResolution {
  resolved: boolean;
  allWin: boolean;
  winningLegs: number;
  totalLegs: number;
}

const NETWORK = (process.env.SUI_NETWORK as PredictConfig['network'] | undefined) ?? 'testnet';
const DEEPBOOK_QUOTE_TYPE = process.env.DEEPBOOK_QUOTE_TYPE ?? '0xYourQuoteType';
const PREDICT_CONFIG = defaultPredictConfig(DEEPBOOK_QUOTE_TYPE, {
  network: NETWORK,
  packageId: process.env.DEEPBOOK_PKG,
  predictObjectId: process.env.DEEPBOOK_OBJ,
  clockObjectId: process.env.CLOCK_OBJECT_ID,
});

const VAULT_PKG = process.env.VAULT_PKG ?? '0xYourPackageId';
const VAULT_ID = process.env.VAULT_ID ?? '0xYourVaultId';
const OPEN_SLIPS_ID = process.env.OPEN_SLIPS_ID ?? '0xYourOpenSlipsId';
const ADMIN_CAP_ID = process.env.ADMIN_CAP_ID ?? '0xYourAdminCapId';

const client = createPredictClient(NETWORK);
const trackedSlips = new Map<string, TrackedSlip>();
const settlingSlips = new Set<string>();

let keeperKeypair: Ed25519Keypair | null = null;
let keeperAddress = '';
let managerId: string | null = process.env.PREDICT_MANAGER_ID
  ? normalizeSuiObjectId(process.env.PREDICT_MANAGER_ID)
  : null;

function normalizeHex(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}

function configuredObject(id: string, envName: string): string {
  if (id.startsWith('0xYour')) {
    throw new Error(`Set ${envName} before executing keeper transactions`);
  }

  return normalizeSuiObjectId(id);
}

function parsePrivateKey(): Uint8Array {
  const raw = process.env.KEEPER_PRIVATE_KEY;
  if (!raw) {
    throw new Error('KEEPER_PRIVATE_KEY is not set');
  }

  return Buffer.from(normalizeHex(raw), 'hex');
}

function quoteTypeConfigured(): boolean {
  return !DEEPBOOK_QUOTE_TYPE.startsWith('0xYour');
}

function configuredForExecution(): boolean {
  return quoteTypeConfigured()
    && !VAULT_PKG.startsWith('0xYour')
    && !VAULT_ID.startsWith('0xYour')
    && !ADMIN_CAP_ID.startsWith('0xYour');
}

export function registerSlip(slip: TrackedSlip): void {
  trackedSlips.set(normalizeSuiObjectId(slip.slipId), {
    ...slip,
    slipId: normalizeSuiObjectId(slip.slipId),
    legs: slip.legs.map((leg) => ({
      ...leg,
      oracleId: normalizeSuiObjectId(leg.oracleId),
    })),
  });
}

export function getTrackedSlip(slipId: string): TrackedSlip | undefined {
  return trackedSlips.get(normalizeSuiObjectId(slipId));
}

async function initKeeper(): Promise<void> {
  if (!process.env.KEEPER_PRIVATE_KEY) {
    console.log('No KEEPER_PRIVATE_KEY set; running in read-only mode');
    return;
  }

  keeperKeypair = Ed25519Signer.fromSecretKey(parsePrivateKey());
  keeperAddress = keeperKeypair.toSuiAddress();
  console.log(`Keeper loaded: ${keeperAddress}`);

  if (!quoteTypeConfigured()) {
    console.log('DEEPBOOK_QUOTE_TYPE is not configured; Predict PTBs are disabled');
    return;
  }

  managerId = await ensurePredictManager({
    client,
    signer: keeperKeypair,
    config: PREDICT_CONFIG,
    managerId,
  });

  console.log(`PredictManager: ${managerId}`);
}

function executionContext(): { keypair: Ed25519Keypair; manager: string } {
  if (!keeperKeypair) {
    throw new Error('Keeper keypair not loaded');
  }
  if (!managerId) {
    throw new Error('PredictManager is not available');
  }
  if (!configuredForExecution()) {
    throw new Error('Keeper execution is not fully configured');
  }

  return {
    keypair: keeperKeypair,
    manager: managerId,
  };
}

function legWins(leg: PredictLeg, settlementPrice: bigint): boolean {
  return leg.isUp ? settlementPrice > BigInt(leg.strike) : settlementPrice <= BigInt(leg.strike);
}

async function readOracleSettlement(oracleId: string): Promise<OracleSettlement> {
  const object = await client.getObject({
    id: normalizeSuiObjectId(oracleId),
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
      parentId: normalizeSuiObjectId(balancesId),
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

async function resolveSlip(slip: TrackedSlip): Promise<SlipResolution> {
  const settlements = new Map<string, OracleSettlement>();
  for (const leg of slip.legs) {
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
      totalLegs: slip.legs.length,
    };
  }

  let winningLegs = 0;
  for (const leg of slip.legs) {
    const settlement = settlements.get(normalizeSuiObjectId(leg.oracleId));
    if (!settlement || settlement.settlementPrice === null) {
      throw new Error(`Settlement missing for oracle ${leg.oracleId}`);
    }
    if (legWins(leg, settlement.settlementPrice)) {
      winningLegs += 1;
    }
  }

  return {
    resolved: true,
    allWin: winningLegs === slip.legs.length,
    winningLegs,
    totalLegs: slip.legs.length,
  };
}

async function settlementCoinInput(
  tx: Transaction,
  manager: string,
  amount: bigint,
): Promise<ReturnType<Transaction['splitCoins']>[number] | ReturnType<typeof addPredictManagerWithdraw>> {
  if (amount > 0n) {
    return addPredictManagerWithdraw(tx, PREDICT_CONFIG, manager, amount);
  }

  const coins = await client.getCoins({
    owner: keeperAddress,
    coinType: DEEPBOOK_QUOTE_TYPE,
  });
  const source = coins.data.find((coin) => BigInt(coin.balance) > 0n);
  if (!source) {
    throw new Error('No quote coin available to create a zero-value settlement coin');
  }
  const [zeroCoin] = tx.splitCoins(tx.object(source.coinObjectId), [tx.pure.u64(0)]);
  return zeroCoin;
}

export async function executePendingSlip(slip: TrackedSlip): Promise<string> {
  const { keypair, manager } = executionContext();

  const tx = new Transaction();
  tx.setGasBudget(200_000_000);

  const releasedStake = tx.moveCall({
    target: `${configuredObject(VAULT_PKG, 'VAULT_PKG')}::parlay_vault::release_pending_stake`,
    arguments: [
      tx.object(configuredObject(VAULT_ID, 'VAULT_ID')),
      tx.pure.id(slip.slipId),
      tx.object(configuredObject(ADMIN_CAP_ID, 'ADMIN_CAP_ID')),
    ],
  });

  addPredictManagerDeposit(tx, PREDICT_CONFIG, manager, releasedStake);
  addPredictMintLegs(tx, PREDICT_CONFIG, manager, slip.legs);

  tx.moveCall({
    target: `${configuredObject(VAULT_PKG, 'VAULT_PKG')}::parlay_vault::finalize_slip`,
    arguments: [
      tx.object(configuredObject(VAULT_ID, 'VAULT_ID')),
      tx.pure.id(slip.slipId),
      tx.object(configuredObject(ADMIN_CAP_ID, 'ADMIN_CAP_ID')),
    ],
  });

  tx.moveCall({
    target: `${configuredObject(VAULT_PKG, 'VAULT_PKG')}::slip_executor::register_active_slip`,
    arguments: [
      tx.object(configuredObject(VAULT_ID, 'VAULT_ID')),
      tx.object(configuredObject(OPEN_SLIPS_ID, 'OPEN_SLIPS_ID')),
      tx.pure.id(slip.slipId),
      tx.object(configuredObject(ADMIN_CAP_ID, 'ADMIN_CAP_ID')),
    ],
  });

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: {
      showEffects: true,
      showObjectChanges: true,
    },
  });

  registerSlip(slip);
  console.log(`Executed pending slip ${slip.slipId}: ${result.digest}`);
  return result.digest;
}

export async function redeemSlipPositions(
  slipId: string,
): Promise<string | null> {
  const { keypair, manager } = executionContext();

  const slip = getTrackedSlip(slipId);
  if (!slip) {
    console.log(`No tracked slip payload for ${slipId}; cannot build Predict redeem PTB`);
    return null;
  }

  const tx = new Transaction();
  tx.setGasBudget(200_000_000);
  addPredictRedeemLegs(tx, PREDICT_CONFIG, manager, slip.legs, true);

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: {
      showEffects: true,
      showEvents: true,
    },
  });

  console.log(`Redeemed Predict legs for ${slipId}: ${result.digest}`);
  return result.digest;
}

export async function settleSlip(
  slipId: string,
  forcedOutcome?: VaultOutcome,
  forcedRedeemedAmount?: bigint | number | string,
): Promise<void> {
  const normalizedSlipId = normalizeSuiObjectId(slipId);
  if (settlingSlips.has(normalizedSlipId)) {
    return;
  }

  const slip = getTrackedSlip(normalizedSlipId);
  if (!slip) {
    console.log(`No tracked slip payload for ${normalizedSlipId}; cannot settle`);
    return;
  }

  settlingSlips.add(normalizedSlipId);
  try {
    const resolution = await resolveSlip(slip);
    if (!resolution.resolved) {
      console.log(`Slip ${normalizedSlipId} still waiting on Predict oracle settlement`);
      return;
    }

    const { keypair, manager } = executionContext();
    const preRedeemBalance = await managerBalance(manager);
    const redeemDigest = await redeemSlipPositions(normalizedSlipId);
    if (!redeemDigest) {
      return;
    }
    const postRedeemBalance = await managerBalance(manager);
    const redeemedAmount = forcedRedeemedAmount !== undefined
      ? BigInt(forcedRedeemedAmount)
      : postRedeemBalance - preRedeemBalance;
    const vaultOutcome = forcedOutcome ?? (resolution.allWin ? 'won' : 'lost');

    const tx = new Transaction();
    tx.setGasBudget(150_000_000);
    const redeemedCoin = await settlementCoinInput(tx, manager, redeemedAmount);

    if (vaultOutcome === 'won') {
      tx.moveCall({
        target: `${configuredObject(VAULT_PKG, 'VAULT_PKG')}::slip_executor::settle_all_win`,
        arguments: [
          tx.object(configuredObject(VAULT_ID, 'VAULT_ID')),
          tx.object(configuredObject(OPEN_SLIPS_ID, 'OPEN_SLIPS_ID')),
          tx.pure.id(normalizedSlipId),
          redeemedCoin,
          tx.object(configuredObject(ADMIN_CAP_ID, 'ADMIN_CAP_ID')),
        ],
      });
    } else {
      tx.moveCall({
        target: `${configuredObject(VAULT_PKG, 'VAULT_PKG')}::slip_executor::settle_not_all_win`,
        arguments: [
          tx.object(configuredObject(VAULT_ID, 'VAULT_ID')),
          tx.object(configuredObject(OPEN_SLIPS_ID, 'OPEN_SLIPS_ID')),
          tx.pure.id(normalizedSlipId),
          redeemedCoin,
          tx.object(configuredObject(ADMIN_CAP_ID, 'ADMIN_CAP_ID')),
        ],
      });
    }

    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: {
        showEffects: true,
        showEvents: true,
      },
    });

    trackedSlips.delete(normalizedSlipId);
    console.log(`Settled vault slip ${normalizedSlipId}: ${result.digest} (${resolution.winningLegs}/${resolution.totalLegs} legs won)`);
  } finally {
    settlingSlips.delete(normalizedSlipId);
  }
}

function startEventPolling(
  rpc: SuiJsonRpcClient,
  label: string,
  query: unknown,
  onEvent: (event: { type: string; parsedJson?: unknown }) => Promise<void>,
  intervalMs = 5_000,
): () => void {
  let stopped = false;
  let cursor: unknown = null;

  const poll = async () => {
    if (stopped) {
      return;
    }

    try {
      const page = await rpc.queryEvents({
        query: query as never,
        cursor: cursor as never,
        limit: 50,
        order: 'ascending',
      });

      for (const event of page.data as Array<{ type: string; parsedJson?: unknown }>) {
        await onEvent(event);
      }

      cursor = page.nextCursor ?? cursor;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${label} polling failed: ${message}`);
    } finally {
      if (!stopped) {
        setTimeout(() => {
          void poll();
        }, intervalMs);
      }
    }
  };

  void poll();
  return () => {
    stopped = true;
  };
}

async function subscribeToPendingSlips(rpc: SuiJsonRpcClient): Promise<() => void> {
  console.log('Watching SlipPending events...');

  return startEventPolling(
    rpc,
    'SlipPending',
    {
      MoveEventModule: {
        module: 'parlay_vault',
        package: configuredObject(VAULT_PKG, 'VAULT_PKG'),
      },
    },
    async (event) => {
      if (!event.type.includes('SlipPending')) {
        return;
      }

      const slipEvent = event.parsedJson as PendingSlipEvent;
      console.log(`Pending slip ${slipEvent.slip_id} from ${slipEvent.owner} for ${slipEvent.stake}`);
      console.log(
        'Predict PTB path is live; the next keeper step is to load the canonical pending-slip quote from chain and execute it into Predict',
      );
    },
  );
}

async function subscribeToOracleEvents(rpc: SuiJsonRpcClient): Promise<() => void> {
  console.log('Watching OracleSettled events...');

  return startEventPolling(
    rpc,
    'OracleSettled',
    {
      MoveEventModule: {
        module: 'oracle',
        package: PREDICT_CONFIG.packageId,
      },
    },
    async (event) => {
      if (!event.type.includes('OracleSettled')) {
        return;
      }

      const oracleEvent = event.parsedJson as OracleSettledEvent;
      console.log(
        `Oracle settled ${oracleEvent.oracle_id} at ${oracleEvent.settlement_price} (expiry ${oracleEvent.expiry})`,
      );

      for (const [slipId, slip] of trackedSlips.entries()) {
        const touchesOracle = slip.legs.some(
          (leg) => normalizeSuiObjectId(leg.oracleId) === normalizeSuiObjectId(oracleEvent.oracle_id),
        );
        if (!touchesOracle) {
          continue;
        }

        try {
          await settleSlip(slipId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Failed to settle tracked slip ${slipId}: ${message}`);
        }
      }
    },
  );
}

async function main(): Promise<void> {
  const vaultPackageConfigured = !VAULT_PKG.startsWith('0xYour');

  console.log('Parlay Vault keeper');
  console.log(`Network: ${NETWORK}`);
  console.log(`Predict package: ${PREDICT_CONFIG.packageId}`);
  console.log(`Predict object: ${PREDICT_CONFIG.predictObjectId}`);

  await initKeeper();

  if (!configuredForExecution()) {
    console.log('Vault or quote configuration is incomplete; watcher will stay in read-only mode');
  }

  const unsubPending = vaultPackageConfigured
    ? await subscribeToPendingSlips(client)
    : () => undefined;
  const unsubOracle = await subscribeToOracleEvents(client);

  console.log('Keeper running. Press Ctrl+C to stop.');

  process.on('SIGINT', () => {
    console.log('Stopping keeper...');
    unsubPending();
    unsubOracle();
    process.exit(0);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
