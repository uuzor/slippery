/**
 * Settlement Keeper — Watches DeepBook Predict oracle events and settles slips
 * 
 * Based on DeepBook Predict API:
 * - predict::mint() - buy position (ask price)
 * - predict::redeem() - sell position (bid price)
 * - predict::supply() - supply to vault (PLP)
 * - OracleSVI - volatility surface oracle
 * 
 * Flow:
 * 1. Watch for OracleSettled event
 * 2. Scan all open slips containing this market
 * 3. Redeem ALL positions via predict::redeem()
 * 4. Distribute payouts / release locked amounts to vault
 */

import { SuiClient, getFullNodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypair';

// Configuration
const NETWORK = 'testnet';
const PACKAGE_ID = '0xYourPackageId'; // TODO: Set after deployment
const VAULT_ID = '0xYourVaultId'; // TODO: Set after deployment

// DeepBook Predict package (from predict-testnet-4-16 branch)
const DEEPBOOK_PREDICT_PACKAGE = '0x9ae0e853e7f39f893dc2d64386c12bb1d570f4f0bb3d3d63b40fd1b3ddf6b3f8';

// Initialize Sui client
const client = new SuiClient({ url: getFullNodeUrl(NETWORK) });

interface MarketLeg {
  market_id: string;    // DeepBook Predict market ID
  expiry: string;       // Expiry timestamp
  strike: string;       // Strike price
  is_up: boolean;       // true = UP position, false = DOWN position
  quantity: string;      // Position size
}

interface SlipData {
  id: string;
  owner: string;
  manager_id: string;   // PredictManager ID
  legs: MarketLeg[];
  stake: string;
  combined_odds: string;
  bonus_multiplier: string;
  potential_payout: string;
  locked_amount: string;
  status: 'open' | 'won' | 'lost' | 'settled';
}

// DeepBook Predict event types
interface OracleSettledEvent {
  oracle_id: string;
  expiry: string;
  settlement_price: string;
  timestamp: string;
}

interface PositionRedeemedEvent {
  predict_id: string;
  manager_id: string;
  trader: string;
  oracle_id: string;
  expiry: string;
  strike: string;
  is_up: boolean;
  quantity: string;
  payout: string;
  bid_price: string;
  is_settled: boolean;
}

/**
 * Watch for DeepBook Predict oracle settlement events
 * 
 * Event: OracleSettled (from deepbook_predict::oracle)
 * Fields: oracle_id, expiry, settlement_price, timestamp
 */
async function watchOracleEvents() {
  console.log('🏃 Starting Settlement Keeper...');
  console.log(`   DeepBook Predict package: ${DEEPBOOK_PREDICT_PACKAGE}`);
  
  // Subscribe to OracleSettled events
  // This event is emitted when an oracle reaches its expiry
  const unsubscribe = await client.subscribeEvent({
    filter: {
      MoveEventType: `${DEEPBOOK_PREDICT_PACKAGE}::oracle::OracleSettled`,
    },
    onMessage: async (event) => {
      try {
        const eventData = event.parsedJson as OracleSettledEvent;
        console.log(`📡 Oracle settled: ${eventData.oracle_id}`);
        console.log(`   Settlement price: ${eventData.settlement_price}`);
        await processSettlement(eventData);
      } catch (error) {
        console.error('❌ Error processing oracle event:', error);
      }
    },
  });

  console.log('👀 Watching for OracleSettled events...');
  console.log('   (Events: deepbook_predict::oracle::OracleSettled)\n');
  return unsubscribe;
}

/**
 * Process settlement for all slips containing the resolved market
 */
async function processSettlement(eventData: OracleSettledEvent) {
  const { oracle_id, expiry, settlement_price } = eventData;
  
  console.log(`\n🔄 Processing settlement for oracle ${oracle_id}`);
  
  // Get all open slips (from on-chain registry)
  const openSlips = await getOpenSlips();
  
  // Filter slips containing this oracle/expiry
  const affectedSlips = openSlips.filter(slip => 
    slip.legs.some(leg => leg.market_id === oracle_id && leg.expiry === expiry)
  );
  
  console.log(`📋 Found ${affectedSlips.length} slips to process`);
  
  for (const slip of affectedSlips) {
    await settleSlip(slip, settlement_price);
  }
}

/**
 * Settle a single slip
 * 
 * DeepBook Predict flow:
 * 1. Call predict::redeem() for each leg
 * 2. Check if all legs won (based on settlement price vs strike)
 * 3. If won: distribute payout to user
 * 4. If lost: release locked bonus to vault (LP pool)
 * 5. Credit any rewards from DeepBook to vault
 */
async function settleSlip(slip: SlipData, settlementPrice: string) {
  console.log(`\n💰 Settling slip ${slip.id} for ${slip.owner}`);
  console.log(`   Manager: ${slip.manager_id}`);
  console.log(`   Stake: ${slip.stake}`);
  console.log(`   Combined odds: ${slip.combined_odds}`);
  
  let allLegsWon = true;
  const totalRewards: bigint = 0n;
  
  // Redeem ALL positions in DeepBook Predict
  // This happens for BOTH won AND lost slips
  for (const leg of slip.legs) {
    const reward = await redeemDeepBookPosition(slip, leg, settlementPrice);
    const legWon = determineLegOutcome(leg, settlementPrice);
    
    if (!legWon) {
      allLegsWon = false;
    }
    
    console.log(`   Leg: ${leg.is_up ? 'UP' : 'DOWN'} @ ${leg.strike} - ${legWon ? 'WON' : 'LOST'}`);
  }
  
  if (allLegsWon) {
    // WON: Distribute payout to user
    await distributePayout(slip);
  } else {
    // LOST: Release locked bonus to vault (LP pool earns it)
    await releaseToVault(slip);
  }
  
  console.log(`✅ Slip ${slip.id} settled: ${allLegsWon ? 'WON' : 'LOST'}`);
}

/**
 * Redeem a position in DeepBook Predict
 * 
 * API: predict::redeem(predict, manager, oracle, key, quantity, clock, ctx)
 * 
 * Returns the payout from the redemption
 */
async function redeemDeepBookPosition(
  slip: SlipData,
  leg: MarketLeg,
  settlementPrice: string
): Promise<bigint> {
  console.log(`  📥 Redeeming: ${leg.is_up ? 'UP' : 'DOWN'} @ ${leg.strike}`);
  
  // Build PTB to call predict::redeem
  const tx = new Transaction();
  
  // Get clock for time-sensitive pricing
  const clockObj = await client.getObject({
    id: '0x6', // Sui Clock object ID
    options: { showContent: true },
  });
  
  // Build MarketKey for the leg
  // MarketKey = (oracle_id, expiry, strike, is_up)
  const marketKey = buildMarketKey(leg.market_id, leg.expiry, leg.strike, leg.is_up);
  
  tx.moveCall({
    target: `${DEEPBOOK_PREDICT_PACKAGE}::predict::redeem`,
    arguments: [
      tx.object(slip.legs[0].market_id), // Predict object
      tx.object(slip.manager_id),         // PredictManager
      tx.object(leg.market_id),          // OracleSVI
      tx.pure(MarketKey),                // MarketKey
      tx.pure.u64(BigInt(leg.quantity)), // quantity
      tx.object(clockObj.data.objectId), // Clock
    ],
  });
  
  // Sign and execute with keeper's keypair
  // const signer = new Ed25519Keypair(); // Keeper's keypair (from env)
  // const result = await signer.signAndExecuteTransaction({
  //   transaction: tx,
  //   client,
  //   options: { showEffects: true },
  // });
  
  // Extract payout from PositionRedeemed event
  // const redeemEvent = result.events?.find(e => e.type.includes('PositionRedeemed'));
  // const payout = BigInt(redeemEvent?.parsedJson?.payout || '0');
  
  // For now, return a placeholder
  console.log(`     Redeem tx would be submitted`);
  return 0n;
}

/**
 * Determine if a leg won based on settlement price
 * 
 * For UP position: wins if settlement_price > strike
 * For DOWN position: wins if settlement_price < strike
 */
function determineLegOutcome(leg: MarketLeg, settlementPrice: string): boolean {
  const strike = BigInt(leg.strike);
  const price = BigInt(settlementPrice);
  
  if (leg.is_up) {
    return price > strike;
  } else {
    return price < strike;
  }
}

/**
 * Build MarketKey tuple for DeepBook Predict
 */
function buildMarketKey(oracleId: string, expiry: string, strike: string, isUp: boolean): any {
  // In production, this would be the proper MarketKey struct
  // For now, return a tuple representation
  return { oracle_id: oracleId, expiry, strike, is_up: isUp };
}

/**
 * Distribute payout to winning user
 */
async function distributePayout(slip: SlipData) {
  console.log(`  🎉 Distributing payout to ${slip.owner}`);
  
  // Build PTB to call vault.distribute_payout
  const tx = new Transaction();
  
  tx.moveCall({
    target: `${PACKAGE_ID}::parlay_vault::distribute_payout`,
    arguments: [
      tx.object(VAULT_ID),
      tx.pure.address(slip.owner),
      tx.pure.u64(BigInt(slip.potential_payout)),
    ],
  });
  
  // Also release the locked amount back to vault
  tx.moveCall({
    target: `${PACKAGE_ID}::parlay_vault::release_payout`,
    arguments: [
      tx.object(VAULT_ID),
      tx.pure.u64(BigInt(slip.locked_amount)),
    ],
  });
  
  // Sign and execute
  // const signer = new Ed25519Keypair();
  // const result = await signer.signAndExecuteTransaction({
  //   transaction: tx,
  //   client,
  // });
  // console.log(`  ✅ Payout tx: ${result.digest}`);
  
  console.log(`  ✅ Would distribute ${slip.potential_payout} to ${slip.owner}`);
}

/**
 * Release locked amount to vault (for lost slips)
 * LP pool earns the locked bonus
 */
async function releaseToVault(slip: SlipData) {
  console.log(`  📈 Releasing locked amount to vault (LP pool earns it)`);
  
  // Build PTB to release locked amount back to vault
  const tx = new Transaction();
  
  tx.moveCall({
    target: `${PACKAGE_ID}::parlay_vault::release_payout`,
    arguments: [
      tx.object(VAULT_ID),
      tx.pure.u64(BigInt(slip.locked_amount)),
    ],
  });
  
  // Sign and execute
  // const signer = new Ed25519Keypair();
  // const result = await signer.signAndExecuteTransaction({
  //   transaction: tx,
  //   client,
  // });
  // console.log(`  ✅ Release tx: ${result.digest}`);
  
  console.log(`  ✅ Locked bonus ${slip.locked_amount} stays in vault for LPs`);
}

/**
 * Credit DeepBook Predict rewards to vault (for winning legs)
 * This is the "second yield source" for LPs
 */
async function creditRewardsToVault(rewards: bigint) {
  if (rewards > 0n) {
    console.log(`  💎 Crediting ${rewards} from DeepBook Predict to vault`);
    
    const tx = new Transaction();
    
    tx.moveCall({
      target: `${PACKAGE_ID}::parlay_vault::credit_rewards`,
      arguments: [
        tx.object(VAULT_ID),
        tx.pure.u64(rewards),
      ],
    });
    
    // Sign and execute
    // const signer = new Ed25519Keypair();
    // const result = await signer.signAndExecuteTransaction({
    //   transaction: tx,
    //   client,
    // });
    // console.log(`  ✅ Credit tx: ${result.digest}`);
    
    console.log(`  ✅ Rewards credited to vault (LP pool)`);
  }
}

/**
 * Get all open slips from the on-chain registry
 */
async function getOpenSlips(): Promise<SlipData[]> {
  // Query the OpenSlips shared object
  // const openSlipsId = '0x...'; // TODO: Set after deployment
  // const object = await client.getObject({
  //   id: openSlipsId,
  //   options: { showContent: true },
  // });
  
  // Parse slips from object content
  // return parseOpenSlips(object);
  
  // Placeholder for demo
  return [];
}

/**
 * Credit DeepBook Predict rewards to vault
 * Called after redeem_permissionless returns rewards
 */
async function creditRewards(rewards: bigint) {
  console.log(`  💎 Crediting ${rewards} to vault (LP pool)`);
  
  // Build PTB to credit rewards
  const tx = new Transaction();
  
  tx.moveCall({
    target: `${PACKAGE_ID}::parlay_vault::credit_rewards`,
    arguments: [
      tx.object(VAULT_ID),
      tx.pure.u64(rewards),
    ],
  });
  
  // Sign and execute
  // const signer = new Ed25519Keypair();
  // const result = await signer.signAndExecuteTransaction({
  //   transaction: tx,
  //   client,
  // });
  // console.log(`  ✅ Credit tx: ${result.digest}`);
  
  console.log(`  ✅ Rewards credited to vault`);
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log('🚀 Parlay Vault Settlement Keeper');
  console.log(`   Network: ${NETWORK}`);
  console.log(`   Package: ${PACKAGE_ID}`);
  console.log(`   Vault: ${VAULT_ID}`);
  
  // Start watching for oracle events
  const unsubscribe = await watchOracleEvents();
  
  // Keep process running
  console.log('\n⏳ Keeper is running. Press Ctrl+C to stop.\n');
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down keeper...');
    unsubscribe();
    process.exit(0);
  });
}

// Run keeper
main().catch(console.error);

// =============================================================================
// HELPERS FOR TESTING
// =============================================================================

/**
 * Simulate an oracle event for testing
 */
export async function simulateOracleEvent(marketId: string, result: boolean) {
  const event: OracleEvent = {
    market_id: marketId,
    result,
    timestamp: Date.now(),
  };
  await processSettlement(event);
}

/**
 * Manually trigger settlement for a specific slip
 */
export async function manualSettleSlip(slipId: string) {
  console.log(`\n🔧 Manual settlement for slip ${slipId}`);
  // Implementation for manual settlement trigger
}