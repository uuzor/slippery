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

// Import from @mysten/sui (NOT @mysten/sui.js which is deprecated)
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// Configuration
const NETWORK = 'testnet';

// DeepBook Predict package (testnet)
const DEEPBOOK_PREDICT_PACKAGE = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';

// Parlay Vault package ID (set after deployment)
const PARLAY_VAULT_PACKAGE = '0xYourPackageId';
const VAULT_ID = '0xYourVaultId';
const OPEN_SLIPS_ID = '0xYourOpenSlipsId';

// Network URLs
const TESTNET_URL = getFullnodeUrl('testnet');

// Initialize Sui client with @mysten/sui (not @mysten/sui.js)
const client = new SuiClient({ 
  url: TESTNET_URL,
});

interface MarketLeg {
  oracle_id: string;   // ID of the OracleSVI
  expiry: number;      // Expiry timestamp in milliseconds
  strike: number;      // Strike price (in FLOAT_SCALING = 1e9)
  is_up: boolean;      // true = UP position, false = DOWN position
  ask_price: number;  // DeepBook ask price (probability in 1e9)
}

interface SlipReceipt {
  id: string;
  owner: string;
  legs: MarketLeg[];
  predict_ids: string[];
  stake: number;
  combined_odds: number;
  bonus_multiplier: number;
  potential_payout: number;
  locked_amount: number;
  placed_at: number;
}

interface OpenSlipsData {
  slips: string[];  // Vector of SlipReceipt IDs
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
 * Get the OpenSlips shared object and fetch all slip IDs
 */
async function getOpenSlipIds(): Promise<string[]> {
  try {
    const openSlips = await client.getObject({
      id: OPEN_SLIPS_ID,
      options: { showContent: true },
    });
    
    if (!openSlips.data?.content || openSlips.data.content.dataType !== 'moveObject') {
      return [];
    }
    
    const content = openSlips.data.content.fields as unknown as OpenSlipsData;
    return content.slips || [];
  } catch (error) {
    console.error('Error fetching OpenSlips:', error);
    return [];
  }
}

/**
 * Fetch a SlipReceipt by its ID
 */
async function getSlipReceipt(slipId: string): Promise<SlipReceipt | null> {
  try {
    const slip = await client.getObject({
      id: slipId,
      options: { showContent: true },
    });
    
    if (!slip.data?.content || slip.data.content.dataType !== 'moveObject') {
      return null;
    }
    
    return slip.data.content.fields as unknown as SlipReceipt;
  } catch (error) {
    console.error(`Error fetching slip ${slipId}:`, error);
    return null;
  }
}

/**
 * Process an oracle settlement:
 * 1. Get all open slip IDs from OpenSlips shared object
 * 2. Batch fetch all SlipReceipt objects
 * 3. Filter slips containing this oracle
 * 4. For each slip, determine if all legs won/lost
 * 5. Execute settle_won_slip or settle_lost_slip
 */
async function processOracleSettlement(oracleEvent: OracleSettledEvent): Promise<void> {
  console.log(`\n🔄 Processing settlement for oracle ${oracleEvent.oracle_id}`);

  // Get all open slip IDs
  const slipIds = await getOpenSlipIds();
  console.log(`📋 Found ${slipIds.length} open slips to check`);

  // Batch fetch all slip receipts
  const slips: SlipReceipt[] = [];
  for (const slipId of slipIds) {
    const slip = await getSlipReceipt(slipId);
    if (slip) {
      slips.push(slip);
    }
  }

  // Filter slips containing this oracle
  const affectedSlips = slips.filter(slip => 
    slip.legs.some(leg => leg.oracle_id === oracleEvent.oracle_id)
  );
  
  console.log(`🎯 ${affectedSlips.length} slips affected by this oracle`);

  for (const slip of affectedSlips) {
    await settleSlip(slip, oracleEvent);
  }
}

/**
 * Determine if a slip won based on oracle settlement
 */
function determineSlipOutcome(slip: SlipReceipt, oracleEvent: OracleSettledEvent): boolean {
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
 * Check if all legs of a slip have been resolved (oracles settled)
 */
async function checkAllLegsResolved(slip: SlipReceipt): Promise<boolean> {
  // For each leg, check if its oracle has settled
  for (const leg of slip.legs) {
    try {
      // Query OracleSettled events for this oracle
      const events = await client.queryEvents({
        query: {
          MoveEventType: `${DEEPBOOK_PREDICT_PACKAGE}::oracle::OracleSettled`,
        },
        order: 'descending',
        limit: 100,
      });
      
      const oracleSettled = events.data.some(e => {
        const data = e.parsedJson as OracleSettledEvent;
        return data.oracle_id === leg.oracle_id;
      });
      
      if (!oracleSettled) {
        return false;
      }
    } catch (error) {
      console.error(`Error checking oracle ${leg.oracle_id}:`, error);
      return false;
    }
  }
  return true;
}

/**
 * Settle a single slip
 */
async function settleSlip(slip: SlipReceipt, oracleEvent: OracleSettledEvent): Promise<void> {
  console.log(`\n💰 Settling slip ${slip.id} for ${slip.owner}`);

  // Check if all legs are resolved (we need all oracles to settle)
  const allLegsResolved = await checkAllLegsResolved(slip);
  
  if (!allLegsResolved) {
    console.log(`   ⏳ Not all legs resolved yet, skipping...`);
    return;
  }

  // Determine if all legs won (for a parlay, ALL must win)
  const legOutcome = determineSlipOutcome(slip, oracleEvent);
  
  // For parlays, all legs must be checked. For now, assume this oracle determines the outcome.
  // In a full implementation, you'd track each leg's outcome.
  const allLegsWon = legOutcome; // TODO: Check all legs

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
async function settleWonSlip(slip: SlipReceipt): Promise<void> {
  if (!keeperKeypair) {
    console.log(`   ⚠️  No keeper keypair, skipping on-chain settlement`);
    return;
  }

  console.log(`  🎉 Distributing payout to ${slip.owner}`);
  console.log(`     Payout: ${slip.potential_payout}`);

  // TODO: Build and execute transaction
  // import { Transaction } from '@mysten/sui/transactions';
  // const tx = new Transaction();
  // tx.moveCall({
  //   target: `${PARLAY_VAULT_PACKAGE}::slip_executor::settle_won_slip`,
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
async function settleLostSlip(slip: SlipReceipt): Promise<void> {
  if (!keeperKeypair) {
    console.log(`   ⚠️  No keeper keypair, skipping on-chain settlement`);
    return;
  }

  console.log(`  📈 Releasing locked bonus to vault`);
  console.log(`     Locked amount: ${slip.locked_amount}`);

  // TODO: Build and execute transaction
  // const tx = new Transaction();
  // tx.moveCall({
  //   target: `${PARLAY_VAULT_PACKAGE}::slip_executor::settle_lost_slip`,
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
  console.log(`   Parlay Vault package: ${PARLAY_VAULT_PACKAGE}`);
  console.log(`   Vault: ${VAULT_ID}`);
  console.log(`   OpenSlips: ${OPEN_SLIPS_ID}`);
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
