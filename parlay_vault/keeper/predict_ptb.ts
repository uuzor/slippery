import { bcs } from '@mysten/sui/bcs';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  Transaction,
  type TransactionObjectArgument,
  type TransactionResult,
} from '@mysten/sui/transactions';
import { fromHex, normalizeSuiObjectId, SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';

export type PredictNetwork = 'testnet' | 'mainnet' | 'devnet' | 'localnet';

export const DEFAULT_TESTNET_PREDICT_PACKAGE =
  '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
export const DEFAULT_TESTNET_PREDICT_OBJECT_ID =
  '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';

export interface PredictConfig {
  network: PredictNetwork;
  packageId: string;
  predictObjectId: string;
  quoteType: string;
  clockObjectId: string;
}

export interface PredictLeg {
  oracleId: string;
  expiry: bigint | number | string;
  strike: bigint | number | string;
  isUp: boolean;
  quantity: bigint | number | string;
  askPrice?: bigint | number | string;
}

export interface SlipLegData {
  oracleId: string;
  expiry: bigint | number | string;
  strike: bigint | number | string;
  isUp: boolean;
  askPrice: bigint | number | string;
  quantity: bigint | number | string;
}

interface EnsurePredictManagerArgs {
  client: SuiJsonRpcClient;
  signer: Ed25519Keypair;
  config: PredictConfig;
  managerId?: string | null;
}

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

function toU64String(value: bigint | number | string): string {
  return BigInt(value).toString();
}

function oracleIdToBytes(oracleId: string): number[] {
  return Array.from(fromHex(normalizeSuiObjectId(oracleId)));
}

export function defaultPredictConfig(
  quoteType: string,
  overrides: Partial<Omit<PredictConfig, 'quoteType'>> = {},
): PredictConfig {
  return {
    network: overrides.network ?? 'testnet',
    packageId: overrides.packageId ?? DEFAULT_TESTNET_PREDICT_PACKAGE,
    predictObjectId: overrides.predictObjectId ?? DEFAULT_TESTNET_PREDICT_OBJECT_ID,
    quoteType,
    clockObjectId: overrides.clockObjectId ?? SUI_CLOCK_OBJECT_ID,
  };
}

export function createPredictClient(network: PredictNetwork): SuiJsonRpcClient {
  const overrideUrl = process.env.SUI_RPC_UPSTREAM_URL;
  return new SuiJsonRpcClient({
    network,
    url: overrideUrl && overrideUrl.length > 0
      ? overrideUrl
      : getJsonRpcFullnodeUrl(network),
  });
}

export function predictManagerStructType(config: PredictConfig): string {
  return `${config.packageId}::predict_manager::PredictManager`;
}

export function predictManagerCreatedEventType(config: PredictConfig): string {
  return `${config.packageId}::predict_manager::PredictManagerCreated`;
}

async function findSharedPredictManager(
  client: SuiJsonRpcClient,
  owner: string,
  config: PredictConfig,
): Promise<string | null> {
  const response = await client.queryEvents({
    query: {
      MoveEventType: predictManagerCreatedEventType(config),
    },
    limit: 20,
    order: 'descending',
  });

  for (const event of response.data) {
    const parsed = event.parsedJson as Record<string, unknown> | null;
    if (!parsed) {
      continue;
    }

    if (parsed.owner === owner && typeof parsed.manager_id === 'string') {
      return normalizeSuiObjectId(parsed.manager_id);
    }
  }

  return null;
}

export async function ensurePredictManager({
  client,
  signer,
  config,
  managerId,
}: EnsurePredictManagerArgs): Promise<string> {
  if (managerId) {
    return normalizeSuiObjectId(managerId);
  }

  const owner = signer.toSuiAddress();
  const existing = await findSharedPredictManager(client, owner, config);
  if (existing) {
    return normalizeSuiObjectId(existing);
  }

  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  tx.moveCall({
    target: `${config.packageId}::predict::create_manager`,
  });

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: {
      showEffects: true,
      showObjectChanges: true,
      showEvents: true,
    },
  });

  if (result.effects?.status.status !== 'success') {
    throw new Error(`PredictManager creation failed: ${result.effects?.status.error ?? 'unknown error'}`);
  }

  const createdChange = result.objectChanges?.find((change) =>
    change.type === 'created'
    && change.objectType === predictManagerStructType(config),
  );
  if (createdChange && 'objectId' in createdChange) {
    return normalizeSuiObjectId(createdChange.objectId);
  }

  const created = await findSharedPredictManager(client, owner, config);
  if (created) {
    return normalizeSuiObjectId(created);
  }

  throw new Error('PredictManager was created but could not be discovered from the transaction result or creation events');
}

export function serializeSlipLegs(legs: SlipLegData[]): Uint8Array {
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

export function deserializeSlipLegs(bytes: Uint8Array): SlipLegData[] {
  const decoded = MarketLegVectorBcs.parse(bytes);
  return decoded.map((leg) => ({
    oracleId: normalizeSuiObjectId(`0x${Buffer.from(leg.oracle_id).toString('hex')}`),
    expiry: leg.expiry,
    strike: leg.strike,
    isUp: leg.is_up,
    askPrice: leg.ask_price,
    quantity: leg.quantity,
  }));
}

export function serializeLegQuantities(
  legs: Array<Pick<PredictLeg, 'quantity'>>,
): Uint8Array {
  return U64VectorBcs.serialize(legs.map((leg) => toU64String(leg.quantity))).toBytes();
}

export function buildMarketKey(
  tx: Transaction,
  config: PredictConfig,
  leg: Pick<PredictLeg, 'oracleId' | 'expiry' | 'strike' | 'isUp'>,
): TransactionResult {
  const target = leg.isUp ? 'up' : 'down';
  return tx.moveCall({
    target: `${config.packageId}::market_key::${target}`,
    arguments: [
      tx.pure.id(leg.oracleId),
      tx.pure.u64(leg.expiry),
      tx.pure.u64(leg.strike),
    ],
  });
}

export function addPredictManagerDeposit(
  tx: Transaction,
  config: PredictConfig,
  managerId: string,
  quoteCoin: TransactionObjectArgument | TransactionResult,
): void {
  tx.moveCall({
    target: `${config.packageId}::predict_manager::deposit`,
    typeArguments: [config.quoteType],
    arguments: [tx.object(managerId), quoteCoin],
  });
}

export function addPredictMintLegs(
  tx: Transaction,
  config: PredictConfig,
  managerId: string,
  legs: PredictLeg[],
): void {
  for (const leg of legs) {
    const marketKey = buildMarketKey(tx, config, leg);
    tx.moveCall({
      target: `${config.packageId}::predict::mint`,
      typeArguments: [config.quoteType],
      arguments: [
        tx.object(config.predictObjectId),
        tx.object(managerId),
        tx.object(leg.oracleId),
        marketKey,
        tx.pure.u64(leg.quantity),
        tx.object(config.clockObjectId),
      ],
    });
  }
}

export function addPredictRedeemLegs(
  tx: Transaction,
  config: PredictConfig,
  managerId: string,
  legs: PredictLeg[],
  permissionless = true,
): void {
  const fn = permissionless ? 'redeem_permissionless' : 'redeem';

  for (const leg of legs) {
    const marketKey = buildMarketKey(tx, config, leg);
    tx.moveCall({
      target: `${config.packageId}::predict::${fn}`,
      typeArguments: [config.quoteType],
      arguments: [
        tx.object(config.predictObjectId),
        tx.object(managerId),
        tx.object(leg.oracleId),
        marketKey,
        tx.pure.u64(leg.quantity),
        tx.object(config.clockObjectId),
      ],
    });
  }
}

export function addPredictManagerWithdraw(
  tx: Transaction,
  config: PredictConfig,
  managerId: string,
  amount: bigint | number | string,
): TransactionResult {
  return tx.moveCall({
    target: `${config.packageId}::predict_manager::withdraw`,
    typeArguments: [config.quoteType],
    arguments: [
      tx.object(managerId),
      tx.pure.u64(amount),
    ],
  });
}

export function addPredictSupply(
  tx: Transaction,
  config: PredictConfig,
  quoteCoin: TransactionObjectArgument | TransactionResult,
): TransactionResult {
  return tx.moveCall({
    target: `${config.packageId}::predict::supply`,
    typeArguments: [config.quoteType],
    arguments: [
      tx.object(config.predictObjectId),
      quoteCoin,
      tx.object(config.clockObjectId),
    ],
  });
}

export function addPredictWithdraw(
  tx: Transaction,
  config: PredictConfig,
  plpCoin: TransactionObjectArgument | TransactionResult,
): TransactionResult {
  return tx.moveCall({
    target: `${config.packageId}::predict::withdraw`,
    typeArguments: [config.quoteType],
    arguments: [
      tx.object(config.predictObjectId),
      plpCoin,
      tx.object(config.clockObjectId),
    ],
  });
}
