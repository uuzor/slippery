/**
 * Settlement Keeper — Watches DeepBook Predict oracle events and settles slips
 * 
 * DeepBook Predict Integration:
 * - Subscribes to OracleSettled events from deepbook_predict::oracle
 * - Queries PositionRedeemed events for keeper's positions
 * - Settles parlay slips based on oracle settlement prices
 * - Distributes payouts or releases locked bonuses to vault
 * 
 * Events to watch:
 * - deepbook_predict::oracle::OracleSettled - oracle price finalized
 * - deepbook_predict::predict::PositionRedeemed - position settled
 */

import { SuiClient } from '@mysten/sui.js/client';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';

// Configuration
const NETWORK = 'testnet';
const PACKAGE_ID = '0xYourPackageId'; // TODO: Set after deployment
const VAULT_ID = '0xYourVaultId'; // TODO: Set after deployment

// DeepBook Predict package (testnet deployment)
const DEEPBOOK_PREDICT_PACKAGE = '0x9ae0e853e7f39f893dc2d64386c12bb1d570f4f0bb3d3d63b40fd1b3ddf6b3f8';

// Network URLs
const TESTNET_URL = 'https://fullnode.testnet.sui.io:443';

// Initialize Sui client
const client = new SuiClient({ 
  url: TESTNET_URL,
});

interface MarketLeg {
  oracle_id: string;   // ID of the OracleSVI
  expiry: number;      // Expiry timestamp in milliseconds
  strike: number;      // Strike price (in FLOAT_SCALING = 1e9)
  is_up: boolean;      // true = UP position, false = DOWN position
}

interface SlipData {
  id: string;
  owner: string;
  legs: MarketLeg[];
  predict_ids: string[];
  stake: number;
  combined_odds: number;
  bonus_multiplier: number;
  potential_payout: number;
  locked_amount: number;
  status: 'open' | 'won' | 'lost' | 'settled';
}

interface OracleSettledEvent {
  oracle_id: string;
  expiry: number;
  settlement_price: number;
  timestamp: number;
}

interface PositionRedeemedEvent {
  predict_id: string;
  manager_id: string;
  trader: string;
  oracle_id: string;
  expiry: number;
  strike: number;
  is_up: boolean;
  quantity: number;
  payout: number;
  bid_price: number;
  is_settled: boolean;
}

// Keeper keypair (from environment or config)
let keeperKeypair: Ed25519Keypair | null = null;
if (process.env.KEEPER_PRIVATE_KEY) {
  keeperKeypair = Ed25519Keypair.fromSecretKey(
    Buffer.from(process.env.KEEPER_PRIVATE_KEY, 'hex')
  );
  console.log('✅ Keeper keypair loaded from KEEPER_PRIVATE_KEY');
} else {
  console.log('⚠️  No KEEPER_PRIVATE_KEY set - running in read-only mode');
}

/**
 * Subscribe to OracleSettled events from DeepBook Predict
 * This is the trigger for settling parlay slips
 */
async function subscribeToOracleEvents(): Promise<() => void> {
  console.log('🏃 Starting Settlement Keeper...');
  console.log(`   DeepBook Predict package: ${DEEPBOOK_PREDICT_PACKAGE}`);

  // Subscribe to OracleSettled events
  // Filter: module = "oracle" from DEEPBOOK_PREDICT_PACKAGE
  const unsubscribe = await client.subscribeEvent({
    filter: {
      MoveEventModule: {
        module: 'oracle',
        package: DEEPBOOK_PREDICT_PACKAGE,
      },
    },
    onMessage: async (event: any) => {
      try {
        const eventData = event.parsedJson as OracleSettledEvent;
        console.log(`\n📡 OracleSettled event detected:`);
        console.log(`   Oracle ID: ${eventData.oracle_id}`);
        console.log(`   Settlement price: ${eventData.settlement_price} (${(eventData.settlement_price / 1e9).toFixed(4)}x)`);
        console.log(`   Timestamp: ${new Date(eventData.timestamp).toISOString()}`);
        
        await processOracleSettlement(eventData);
      } catch (error) {
        console.error('❌ Error processing oracle event:', error);
      }
    },
  });

  console.log('👀 Subscribed to OracleSettled events...');
  console.log('   Module: deepbook_predict::oracle\n');

  return unsubscribe;
}

/**
 * Process an oracle settlement:
 * 1. Find all open slips containing this oracle
 * 2. For each slip, determine if all legs won/lost
 * 3. Execute settle_won_slip or settle_lost_slip
 */
async function processOracleSettlement(oracleEvent: OracleSettledEvent): Promise<void> {
  console.log(`\n🔄 Processing settlement for oracle ${oracleEvent.oracle_id}`);

  const affectedSlips = await getSlipsForOracle(oracleEvent.oracle_id);
  console.log(`📋 Found ${affectedSlips.length} slips to process`);

  for (const slip of affectedSlips) {
    await settleSlip(slip, oracleEvent);
  }
}

/**
 * Query on-chain data for slips containing a specific oracle
 * TODO: Implement actual on-chain query
 */
async function getSlipsForOracle(oracleId: string): Promise<SlipData[]> {
  // TODO: Query the vault or OpenSlips object for slips with this oracle
  // This would use sui client to query the vault's open slips
  // Example query structure:
  // const result = await client.query({
  //   filter: { MatchAny: [...] },
  //   type: `${PACKAGE_ID}::slip_executor::SlipReceipt`,
  // });
  return [];
}

/**
 * Determine if a slip won based on oracle settlement
 */
function determineSlipOutcome(slip: SlipData, oracleEvent: OracleSettledEvent): boolean {
  // Find the leg for this oracle
  const leg = slip.legs.find(l => l.oracle_id === oracleEvent.oracle_id);
  if (!leg) return false;

  // Settlement price is in FLOAT_SCALING (1e9)
  // Strike is also in FLOAT_SCALING
  const settlementPrice = oracleEvent.settlement_price;
  const strike = leg.strike;

  // UP wins if settlement > strike
  // DOWN wins if settlement <= strike
  const legWon = leg.is_up 
    ? settlementPrice > strike 
    : settlementPrice <= strike;

  console.log(`   Leg: ${leg.is_up ? 'UP' : 'DOWN'} @ strike ${(strike / 1e9).toFixed(4)}`);
  console.log(`   Settlement: ${(settlementPrice / 1e9).toFixed(4)}`);
  console.log(`   Result: ${legWon ? 'WON' : 'LOST'}`);

  return legWon;
}

/**
 * Settle a single slip
 */
async function settleSlip(slip: SlipData, oracleEvent: OracleSettledEvent): Promise<void> {
  console.log(`\n💰 Settling slip ${slip.id} for ${slip.owner}`);

  const legWon = determineSlipOutcome(slip, oracleEvent);
  
  // Check if all legs are resolved (we need all oracles to settle)
  const allLegsResolved = slip.legs.every(leg => {
    // In real implementation, check if oracle is settled
    return true; // TODO: Check oracle settlement status
  });

  if (!allLegsResolved) {
    console.log(`   ⏳ Not all legs resolved yet, skipping...`);
    return;
  }

  // Check if all legs won
  // For a parlay, ALL legs must win
  // TODO: Implement actual win/loss determination
  const allLegsWon = true; // TODO: Check all legs

  if (allLegsWon) {
    console.log(`✅ Slip ${slip.id} settled: WON`);
    await settleWonSlip(slip);
  } else {
    console.log(`❌ Slip ${slip.id} settled: LOST`);
    await settleLostSlip(slip);
  }
}

/**
 * Execute settle_won_slip on-chain
 * This releases the locked bonus and distributes payout
 */
async function settleWonSlip(slip: SlipData): Promise<void> {
  if (!keeperKeypair) {
    console.log(`   ⚠️  No keeper keypair, skipping on-chain settlement`);
    return;
  }

  console.log(`  🎉 Distributing payout to ${slip.owner}`);
  console.log(`     Payout: ${slip.potential_payout}`);

  // TODO: Build and execute transaction
  // const tx = new Transaction();
  // tx.moveCall({
  //   target: `${PACKAGE_ID}::slip_executor::settle_won_slip`,
  //   arguments: [
  //     tx.object(VAULT_ID),
  //     tx.object(slip.id),
  //   ],
  // });
  // await client.signAndExecuteTransaction({
  //   transaction: tx,
  //   signer: keeperKeypair,
  // });
  
  console.log(`  ✅ Transaction would be submitted`);
}

/**
 * Execute settle_lost_slip on-chain
 * This releases the locked bonus to the vault for LPs
 */
async function settleLostSlip(slip: SlipData): Promise<void> {
  if (!keeperKeypair) {
    console.log(`   ⚠️  No keeper keypair, skipping on-chain settlement`);
    return;
  }

  console.log(`  📈 Releasing locked bonus to vault`);
  console.log(`     Locked amount: ${slip.locked_amount}`);

  // TODO: Build and execute transaction
  // const tx = new Transaction();
  // tx.moveCall({
  //   target: `${PACKAGE_ID}::slip_executor::settle_lost_slip`,
  //   arguments: [
  //     tx.object(VAULT_ID),
  //     tx.object(slip.id),
  //   ],
  // });
  // await client.signAndExecuteTransaction({
  //   transaction: tx,
  //   signer: keeperKeypair,
  // });
  
  console.log(`  ✅ Transaction would be submitted`);
}

/**
 * Query historical PositionRedeemed events for keeper's positions
 * This is an alternative approach to settle positions
 */
async function queryPositionRedemptions(): Promise<PositionRedeemedEvent[]> {
  console.log(`🔍 Querying PositionRedeemed events...`);

  try {
    const events = await client.queryEvents({
      query: {
        MoveEventModule: {
          module: 'predict',
          package: DEEPBOOK_PREDICT_PACKAGE,
        },
      },
      order: 'descending',
      limit: 100,
    });

    return events.data
      .filter(e => e.type.includes('PositionRedeemed'))
      .map(e => e.parsedJson as PositionRedeemedEvent);
  } catch (error) {
    console.error('❌ Error querying position redemptions:', error);
    return [];
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('🚀 Parlay Vault Settlement Keeper');
  console.log(`   Network: ${NETWORK}`);
  console.log(`   Package: ${PACKAGE_ID}`);
  console.log(`   Vault: ${VAULT_ID}`);
  console.log('\n⏳ Keeper is running. Press Ctrl+C to stop.\n');

  const unsubscribe = await subscribeToOracleEvents();

  // Keep process running
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down keeper...');
    unsubscribe();
    process.exit(0);
  });
}

main().catch(console.error);
