import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';

import type { PredictNetwork } from './types';
import { normalizeId } from './utils';

const DEFAULT_PROTOCOL_PACKAGE_ID =
  '0x83f28cf54815dc10c9085fda06ce802578c70c48e56c4d188d577f6e45bda0f9';
const DEFAULT_PROTOCOL_TYPE_PACKAGE_ID =
  '0x9f896cde3ab09755fe02a1cb5a4e2a982bb71e8be60792cfc59a021b81260d34';
const DEFAULT_VAULT_ID =
  '0xc5b7d6189e77c87381a0a80ab7826ec2cb3ff9f15c904ac7d1a3885a2f4aa0f1';
const DEFAULT_OPEN_SLIPS_ID =
  '0xe0411a8957e3e72e9408086652b891e49a49f38a70e5eb2160f4a7656f019930';
const DEFAULT_ADMIN_CAP_ID =
  '0x9e6c306c0260a8e8a64809a15a5b8fbbe8160d0288d963f4988edc0aee8cf738';
const DEFAULT_DEEPBOOK_PACKAGE_ID =
  '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
const DEFAULT_DEEPBOOK_OBJECT_ID =
  '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';
const DEFAULT_DEEPBOOK_QUOTE_TYPE =
  '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC';
const DEFAULT_CLOCK_OBJECT_ID = '0x6';
const DEFAULT_DEV_INSPECT_SENDER =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

export const SUI_NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ??
  'testnet') as PredictNetwork;
const DEFAULT_BROWSER_RPC_URL = '/api/sui';
const DEFAULT_SERVER_RPC_URL =
  process.env.SUI_RPC_UPSTREAM_URL ??
  process.env.NEXT_PUBLIC_SUI_RPC_URL ??
  getJsonRpcFullnodeUrl(SUI_NETWORK);
export const SUI_RPC_URL =
  process.env.NEXT_PUBLIC_SUI_RPC_URL ??
  (typeof window === 'undefined' ? DEFAULT_SERVER_RPC_URL : DEFAULT_BROWSER_RPC_URL);

export const PROTOCOL_PACKAGE_ID = normalizeId(
  process.env.NEXT_PUBLIC_PROTOCOL_PACKAGE_ID ?? DEFAULT_PROTOCOL_PACKAGE_ID,
);
export const PROTOCOL_TYPE_PACKAGE_ID = normalizeId(
  process.env.NEXT_PUBLIC_PROTOCOL_TYPE_PACKAGE_ID ?? DEFAULT_PROTOCOL_TYPE_PACKAGE_ID,
);
export const VAULT_ID = normalizeId(
  process.env.NEXT_PUBLIC_VAULT_ID ?? DEFAULT_VAULT_ID,
);
export const OPEN_SLIPS_ID = normalizeId(
  process.env.NEXT_PUBLIC_OPEN_SLIPS_ID ?? DEFAULT_OPEN_SLIPS_ID,
);
export const ADMIN_CAP_ID = normalizeId(
  process.env.NEXT_PUBLIC_ADMIN_CAP_ID ?? DEFAULT_ADMIN_CAP_ID,
);
export const DEEPBOOK_PACKAGE_ID = normalizeId(
  process.env.NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID ?? DEFAULT_DEEPBOOK_PACKAGE_ID,
);
export const DEEPBOOK_OBJECT_ID = normalizeId(
  process.env.NEXT_PUBLIC_DEEPBOOK_OBJECT_ID ?? DEFAULT_DEEPBOOK_OBJECT_ID,
);
export const DEEPBOOK_QUOTE_TYPE =
  process.env.NEXT_PUBLIC_DEEPBOOK_QUOTE_TYPE ?? DEFAULT_DEEPBOOK_QUOTE_TYPE;
export const CLOCK_OBJECT_ID = normalizeId(
  process.env.NEXT_PUBLIC_CLOCK_OBJECT_ID ?? DEFAULT_CLOCK_OBJECT_ID,
);
export const DEV_INSPECT_SENDER = normalizeId(
  process.env.NEXT_PUBLIC_DEV_INSPECT_SENDER ?? DEFAULT_DEV_INSPECT_SENDER,
);

export const protocolClient = new SuiJsonRpcClient({
  network: SUI_NETWORK,
  url: SUI_RPC_URL,
});

export const protocolTypes = {
  vault: `${PROTOCOL_TYPE_PACKAGE_ID}::parlay_vault::Vault<${DEEPBOOK_QUOTE_TYPE}>`,
  lpShare: `${PROTOCOL_TYPE_PACKAGE_ID}::parlay_vault::LPShare`,
  lpPosition: `${PROTOCOL_TYPE_PACKAGE_ID}::parlay_vault::LPPosition`,
  slipReceipt: `${PROTOCOL_TYPE_PACKAGE_ID}::slip_executor::SlipReceipt`,
  openSlips: `${PROTOCOL_TYPE_PACKAGE_ID}::slip_executor::OpenSlips`,
  openSlipData: `${PROTOCOL_TYPE_PACKAGE_ID}::slip_executor::OpenSlipData`,
  marketLeg: `${PROTOCOL_TYPE_PACKAGE_ID}::slip_pricer::MarketLeg`,
} as const;

export const protocolTargets = {
  deposit: `${PROTOCOL_PACKAGE_ID}::parlay_vault::deposit`,
  queueDeposit: `${PROTOCOL_PACKAGE_ID}::parlay_vault::queue_deposit`,
  seedLiquidity: `${PROTOCOL_PACKAGE_ID}::parlay_vault::seed_liquidity`,
  withdraw: `${PROTOCOL_PACKAGE_ID}::parlay_vault::withdraw`,
  cancelQueuedDeposit: `${PROTOCOL_PACKAGE_ID}::parlay_vault::cancel_queued_deposit`,
  rollOver: `${PROTOCOL_PACKAGE_ID}::parlay_vault::roll_over`,
  advanceEpoch: `${PROTOCOL_PACKAGE_ID}::parlay_vault::advance_epoch`,
  placeSlipBcs: `${PROTOCOL_PACKAGE_ID}::slip_executor::place_slip_bcs`,
  deepbookPredictPackage: `${PROTOCOL_PACKAGE_ID}::slip_executor::deepbook_predict_package`,
} as const;

export const predictTargets = {
  marketUp: `${DEEPBOOK_PACKAGE_ID}::market_key::up`,
  marketDown: `${DEEPBOOK_PACKAGE_ID}::market_key::down`,
  tradeAmounts: `${DEEPBOOK_PACKAGE_ID}::predict::get_trade_amounts`,
} as const;
