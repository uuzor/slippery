import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, type TransactionResult } from '@mysten/sui/transactions';
import { normalizeSuiObjectId } from '@mysten/sui/utils';

import {
  addPredictManagerWithdraw,
  addPredictRedeemLegs,
  defaultPredictConfig,
  type PredictLeg,
} from './predict_ptb.ts';

const RPC_URL = process.env.SUI_RPC_UPSTREAM_URL ?? 'https://sui-testnet-rpc.publicnode.com';
const NETWORK = 'testnet';
const QUOTE_TYPE = requireEnv('DEEPBOOK_QUOTE_TYPE');
const VAULT_PKG = normalizeSuiObjectId(requireEnv('VAULT_PKG'));
const VAULT_ID = normalizeSuiObjectId(requireEnv('VAULT_ID'));
const OPEN_SLIPS_ID = normalizeSuiObjectId(requireEnv('OPEN_SLIPS_ID'));
const ADMIN_CAP_ID = normalizeSuiObjectId(requireEnv('ADMIN_CAP_ID'));
const PREDICT_MANAGER_ID = normalizeSuiObjectId(requireEnv('PREDICT_MANAGER_ID'));
const SLIP_ID = normalizeSuiObjectId(
  process.argv[2] ?? '0x07beaf9a03136d7dbfab36b051012d9cdd2a9befccd0eda63453dbc0811f3770',
);
const SHARE_ID = normalizeSuiObjectId(
  process.argv[3] ?? '0xac0b4133968c88c826ead85ff56025032d08ac32ec53deb4570fa83aecfa4f95',
);

const PREDICT_CONFIG = defaultPredictConfig(QUOTE_TYPE, {
  network: NETWORK,
  packageId: process.env.DEEPBOOK_PKG,
  predictObjectId: process.env.DEEPBOOK_OBJ,
  clockObjectId: process.env.CLOCK_OBJECT_ID,
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function parsePrivateKey(): Uint8Array {
  const raw = requireEnv('KEEPER_PRIVATE_KEY');
  if (raw.startsWith('suiprivkey')) {
    return decodeSuiPrivateKey(raw).secretKey;
  }
  const normalized = raw.startsWith('0x') ? raw.slice(2) : raw;
  return Buffer.from(normalized, 'hex');
}

function decodeLegs(fields: Record<string, any>): PredictLeg[] {
  return (fields.legs as Array<{ fields: Record<string, any> }>).map((leg) => ({
    oracleId: normalizeSuiObjectId(`0x${Buffer.from(leg.fields.oracle_id).toString('hex')}`),
    expiry: BigInt(leg.fields.expiry),
    strike: BigInt(leg.fields.strike),
    isUp: Boolean(leg.fields.is_up),
    quantity: BigInt(leg.fields.quantity),
  }));
}

async function managerBalance(client: SuiJsonRpcClient): Promise<bigint> {
  const manager = await client.getObject({
    id: PREDICT_MANAGER_ID,
    options: { showContent: true },
  });
  const content = manager.data?.content as { fields?: Record<string, any> } | undefined;
  const balancesIdValue = content?.fields?.balance_manager?.fields?.balances?.fields?.id;
  const balancesId = typeof balancesIdValue === 'string' ? balancesIdValue : balancesIdValue?.id;
  if (!balancesId) {
    throw new Error('Unable to read Predict manager balances table');
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
        const entryContent = entry.data?.content as { fields?: Record<string, any> } | undefined;
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

async function matchingPositionQuantities(
  client: SuiJsonRpcClient,
  legs: PredictLeg[],
): Promise<bigint[]> {
  const manager = await client.getObject({
    id: PREDICT_MANAGER_ID,
    options: { showContent: true },
  });
  const content = manager.data?.content as { fields?: Record<string, any> } | undefined;
  const positionsIdValue = content?.fields?.positions?.fields?.id;
  const positionsId = typeof positionsIdValue === 'string' ? positionsIdValue : positionsIdValue?.id;
  if (!positionsId) {
    throw new Error('Unable to read Predict manager positions table');
  }

  const page = await client.getDynamicFields({
    parentId: normalizeSuiObjectId(positionsId),
    limit: 100,
  });
  const fields = page.data.length === 0
    ? []
    : await client.multiGetObjects({
      ids: page.data.map((entry) => normalizeSuiObjectId(entry.objectId)),
      options: { showContent: true },
    });

  return legs.map((leg) => {
    const direction = leg.isUp ? 0 : 1;
    const match = fields.find((entry) => {
      const value = (entry.data?.content as { fields?: Record<string, any> } | undefined)?.fields?.name;
      return value
        && normalizeSuiObjectId(String(value.oracle_id)) === leg.oracleId
        && BigInt(String(value.expiry)) === BigInt(leg.expiry)
        && BigInt(String(value.strike)) === BigInt(leg.strike)
        && Number(value.direction) === direction;
    });
    const quantity = (match?.data?.content as { fields?: Record<string, any> } | undefined)?.fields?.value;
    return quantity !== undefined ? BigInt(String(quantity)) : 0n;
  });
}

async function settlementCoinInput(
  client: SuiJsonRpcClient,
  keeperAddress: string,
  tx: Transaction,
  amount: bigint,
): Promise<TransactionResult> {
  if (amount > 0n) {
    return addPredictManagerWithdraw(tx, PREDICT_CONFIG, PREDICT_MANAGER_ID, amount);
  }

  const coins = await client.getCoins({
    owner: keeperAddress,
    coinType: QUOTE_TYPE,
  });
  const source = coins.data.find((coin) => BigInt(coin.balance) > 0n);
  if (!source) {
    throw new Error('No quote coin available to build zero-value settlement coin');
  }

  const [zeroCoin] = tx.splitCoins(tx.object(source.coinObjectId), [tx.pure.u64(0)]);
  return zeroCoin;
}

async function main(): Promise<void> {
  const signer = Ed25519Keypair.fromSecretKey(parsePrivateKey());
  const keeperAddress = signer.toSuiAddress();
  const client = new SuiJsonRpcClient({ url: RPC_URL });

  const receipt = await client.getObject({
    id: SLIP_ID,
    options: { showContent: true },
  });
  const receiptFields = (receipt.data?.content as { fields?: Record<string, any> } | undefined)?.fields;
  if (!receiptFields) {
    throw new Error(`Slip receipt ${SLIP_ID} is unavailable`);
  }

  const legs = decodeLegs(receiptFields);
  const oracleIds = [...new Set(legs.map((leg) => leg.oracleId))];
  const oracleObjects = await client.multiGetObjects({
    ids: oracleIds,
    options: { showContent: true },
  });

  let allSettled = true;
  let allWin = true;
  let expectedRedeemedAmount = 0n;
  for (const leg of legs) {
    const oracle = oracleObjects.find((item) => normalizeSuiObjectId(String(item.data?.objectId)) === leg.oracleId);
    const fields = (oracle?.data?.content as { fields?: Record<string, any> } | undefined)?.fields;
    const settlementRaw = fields?.settlement_price;
    if (settlementRaw === null || settlementRaw === undefined) {
      allSettled = false;
      allWin = false;
      break;
    }
    const settlementPrice = BigInt(String(settlementRaw));
    const legWon = leg.isUp
      ? settlementPrice > BigInt(leg.strike)
      : settlementPrice <= BigInt(leg.strike);
    if (legWon) {
      expectedRedeemedAmount += BigInt(leg.quantity);
    }
    if (!legWon) {
      allWin = false;
    }
  }

  if (!allSettled) {
    throw new Error(`Slip ${SLIP_ID} is not fully settled yet`);
  }

  const positionQuantities = await matchingPositionQuantities(client, legs);
  const hasUnredeemedPositions = positionQuantities.some((value) => value > 0n);

  let redeemDigest: string | null = null;
  let redeemedAmount = expectedRedeemedAmount;
  if (hasUnredeemedPositions) {
    const preRedeemBalance = await managerBalance(client);
    const redeemTx = new Transaction();
    redeemTx.setGasBudget(200_000_000);
    addPredictRedeemLegs(redeemTx, PREDICT_CONFIG, PREDICT_MANAGER_ID, legs, true);
    const redeemResult = await client.signAndExecuteTransaction({
      signer,
      transaction: redeemTx,
      options: { showEffects: true },
    });
    if (redeemResult.effects?.status.status !== 'success') {
      throw new Error(`Predict redeem failed: ${redeemResult.effects?.status.error ?? 'unknown error'}`);
    }

    const postRedeemBalance = await managerBalance(client);
    redeemedAmount = postRedeemBalance - preRedeemBalance;
    redeemDigest = redeemResult.digest;
  }

  const settleTx = new Transaction();
  settleTx.setGasBudget(200_000_000);
  const redeemedCoin = await settlementCoinInput(client, keeperAddress, settleTx, redeemedAmount);
  settleTx.moveCall({
    target: `${VAULT_PKG}::slip_executor::${allWin ? 'settle_all_win' : 'settle_not_all_win'}`,
    typeArguments: [QUOTE_TYPE],
    arguments: [
      settleTx.object(VAULT_ID),
      settleTx.object(OPEN_SLIPS_ID),
      settleTx.pure.id(SLIP_ID),
      redeemedCoin,
      settleTx.object(ADMIN_CAP_ID),
    ],
  });

  const settleResult = await client.signAndExecuteTransaction({
    signer,
    transaction: settleTx,
    options: { showEffects: true },
  });
  if (settleResult.effects?.status.status !== 'success') {
    throw new Error(`Vault settlement failed: ${settleResult.effects?.status.error ?? 'unknown error'}`);
  }

  const systemState = await client.getLatestSuiSystemState();
  const vault = await client.getObject({
    id: VAULT_ID,
    options: { showContent: true },
  });
  const vaultFields = (vault.data?.content as { fields?: Record<string, any> } | undefined)?.fields;
  const vaultEpoch = BigInt(String(vaultFields?.current_epoch ?? 0));
  const chainEpoch = BigInt(systemState.epoch);

  let advanceDigest: string | null = null;
  if (chainEpoch > vaultEpoch) {
    const advanceTx = new Transaction();
    advanceTx.setGasBudget(100_000_000);
    advanceTx.moveCall({
      target: `${VAULT_PKG}::parlay_vault::advance_epoch`,
      typeArguments: [QUOTE_TYPE],
      arguments: [advanceTx.object(VAULT_ID)],
    });
    const advanceResult = await client.signAndExecuteTransaction({
      signer,
      transaction: advanceTx,
      options: { showEffects: true },
    });
    if (advanceResult.effects?.status.status !== 'success') {
      throw new Error(`advance_epoch failed: ${advanceResult.effects?.status.error ?? 'unknown error'}`);
    }
    advanceDigest = advanceResult.digest;
  }

  const withdrawTx = new Transaction();
  withdrawTx.setGasBudget(100_000_000);
  const withdrawnCoin = withdrawTx.moveCall({
    target: `${VAULT_PKG}::parlay_vault::withdraw`,
    typeArguments: [QUOTE_TYPE],
    arguments: [withdrawTx.object(VAULT_ID), withdrawTx.object(SHARE_ID)],
  });
  withdrawTx.transferObjects([withdrawnCoin], withdrawTx.pure.address(keeperAddress));
  const withdrawResult = await client.signAndExecuteTransaction({
    signer,
    transaction: withdrawTx,
    options: { showEffects: true, showBalanceChanges: true, showObjectChanges: true },
  });
  if (withdrawResult.effects?.status.status !== 'success') {
    throw new Error(`withdraw failed: ${withdrawResult.effects?.status.error ?? 'unknown error'}`);
  }

  console.log(JSON.stringify({
    slipId: SLIP_ID,
    shareId: SHARE_ID,
    allWin,
    redeemedAmount: redeemedAmount.toString(),
    redeemDigest,
    settleDigest: settleResult.digest,
    advanceDigest,
    withdrawDigest: withdrawResult.digest,
  }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
