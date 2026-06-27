export type PredictNetwork = 'testnet' | 'mainnet' | 'devnet' | 'localnet';
export type U64ish = bigint | number | string;
export type SlipPhase = 'pending' | 'active' | 'open';

export interface MarketLeg {
  oracleId: string;
  expiry: bigint;
  strike: bigint;
  isUp: boolean;
  askPrice: bigint;
  quantity: bigint;
}

export interface VaultTableRefs {
  pendingDeposits: string;
  pendingShareIds: string;
  lpPositions: string;
  pendingSlips: string;
  activeSlips: string;
  epochSlipCounts: string;
}

export interface VaultState {
  objectId: string;
  packageId: string;
  typeOriginPackageId: string;
  quoteType: string;
  currentEpoch: bigint;
  epochSettled: boolean;
  totalDeposits: bigint;
  totalShares: bigint;
  lockedBonus: bigint;
  accruedYield: bigint;
  bonusCapPct: bigint;
  lpBalance: bigint;
  escrow: bigint;
  sharePrice: bigint;
  bonusReserve: bigint;
  availableBonusCapacity: bigint;
  chainEpoch: bigint;
  currentEpochSlipCount: bigint;
  tableRefs: VaultTableRefs;
}

export interface LPPosition {
  shareId: string;
  principal: bigint;
  shares: bigint;
  activationEpoch: bigint;
  autoRoll: boolean;
  isActive: boolean;
  unsettledSlipCount: bigint;
  estimatedValue: bigint;
}

export interface SlipReceipt {
  receiptId: string;
  owner: string;
  legs: MarketLeg[];
  stake: bigint;
  combinedOdds: bigint;
  bonusMultiplier: bigint;
  potentialPayout: bigint;
  bonusAmount: bigint;
  placedAt: bigint;
}

export interface IndexedSlip {
  slipId: string;
  phase: SlipPhase;
  owner: string;
  legs: MarketLeg[];
  quantities: bigint[];
  stake: bigint;
  bonusAmount: bigint;
  stakeReleased: boolean | null;
  entryEpoch: bigint | null;
}

export interface PredictOracleCandidate {
  oracleId: string;
  gridObjectId: string;
  expiry: bigint;
  forward: bigint;
  spot: bigint;
  tickSize: bigint;
  minStrike: bigint;
  maxStrike: bigint;
  underlyingAsset: string;
  active: boolean;
}

export interface PredictStrikeOption {
  strike: bigint;
  isAtTheMoney: boolean;
  distanceFromAtmSteps: bigint;
}

export interface PredictMarket {
  marketId: string;
  oracleId: string;
  gridObjectId: string;
  expiry: bigint;
  forward: bigint;
  spot: bigint;
  tickSize: bigint;
  minStrike: bigint;
  maxStrike: bigint;
  underlyingAsset: string;
  atmStrike: bigint;
  strikeOptions: PredictStrikeOption[];
}

export interface PredictSelection {
  marketId: string;
  oracleId: string;
  expiry: bigint;
  strike: bigint;
  isUp: boolean;
  quantity: bigint;
  underlyingAsset: string;
}

export interface PredictQuote extends MarketLeg {
  quoteAmount: bigint;
  quoteAmountAlt: bigint;
}

export interface SlipPreview {
  legCount: bigint;
  combinedOdds: bigint;
  bonusMultiplier: bigint;
  potentialPayout: bigint;
  bonusAmount: bigint;
  quoteSubtotal: bigint;
  requiredStake: bigint;
}

export interface CoinObjectRef {
  coinObjectId: string;
  balance: bigint;
}

export interface OracleSettlement {
  oracleId: string;
  settlementPrice: bigint | null;
  active: boolean;
  expiry: bigint;
}
