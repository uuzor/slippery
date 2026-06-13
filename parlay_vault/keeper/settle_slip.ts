/**
 * Settlement Keeper — Watches DeepBook Predict oracle events and settles slips
 * 
 * Based on DeepBook Predict API:
 * - predict::mint() - buy position (ask price)
 * - predict::redeem() - sell position (bid price)
 * - predict::supply() - supply to vault (PLP)
 * - OracleSVI - volatility surface oracle
 */

import { SuiClient } from '@mysten/sui.js/client';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';

// TODO: Import Transaction when ready for transaction building
// import { Transaction } from '@mysten/sui.js/transactions';

// Configuration
const NETWORK = 'testnet';
const PACKAGE_ID = '0xYourPackageId'; // TODO: Set after deployment
const VAULT_ID = '0xYourVaultId'; // TODO: Set after deployment

// DeepBook Predict package (from predict-testnet-4-16 branch)
const DEEPBOOK_PREDICT_PACKAGE = '0x9ae0e853e7f39f893dc2d64386c12bb1d570f4f0bb3d3d63b40fd1b3ddf6b3f8';

// Network URLs
const TESTNET_URL = 'https://fullnode.testnet.sui.io:443';

// Initialize Sui client
const client = new SuiClient({ 
  url: TESTNET_URL,
});

interface MarketLeg {
  market_id: string;
  expiry: string;
  strike: string;
  is_up: boolean;
  quantity: string;
}

interface SlipData {
  id: string;
  owner: string;
  manager_id: string;
  legs: MarketLeg[];
  stake: string;
  combined_odds: string;
  bonus_multiplier: string;
  potential_payout: string;
  locked_amount: string;
  status: 'open' | 'won' | 'lost' | 'settled';
}

interface OracleEvent {
  type: string;
  oracle_id: string;
  settlement_price: string;
  timestamp: string;
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

async function getOpenSlips(): Promise<SlipData[]> {
  // TODO: Query on-chain data for open slips
  // This would use sui client to query the vault's open slips
  return [];
}

async function processSettlement(oracleId: string, settlementPrice: string): Promise<void> {
  console.log(`\n🔄 Processing settlement for oracle ${oracleId}`);
  console.log(`   Settlement price: ${settlementPrice}`);

  const affectedSlips = await getOpenSlips();
  console.log(`📋 Found ${affectedSlips.length} slips to process`);

  for (const slip of affectedSlips) {
    await settleSlip(slip, oracleId, settlementPrice);
  }
}

async function settleSlip(slip: SlipData, oracleId: string, settlementPrice: string): Promise<void> {
  console.log(`\n💰 Settling slip ${slip.id} for ${slip.owner}`);
  console.log(`   Manager: ${slip.manager_id}`);
  console.log(`   Stake: ${slip.stake}`);
  console.log(`   Combined odds: ${slip.combined_odds}`);

  // Check if all legs are won
  const allLegsWon = slip.legs.every(leg => {
    const legWon = parseFloat(settlementPrice) > parseFloat(leg.strike);
    console.log(`   Leg: ${leg.is_up ? 'UP' : 'DOWN'} @ ${leg.strike} - ${legWon ? 'WON' : 'LOST'}`);
    return leg.is_up ? legWon : !legWon;
  });

  if (allLegsWon) {
    console.log(`✅ Slip ${slip.id} settled: WON`);
    await settleWonSlip(slip);
  } else {
    console.log(`❌ Slip ${slip.id} settled: LOST`);
    await settleLostSlip(slip);
  }
}

async function settleWonSlip(slip: SlipData): Promise<void> {
  // Redeem positions
  for (const leg of slip.legs) {
    console.log(`  📥 Redeeming: ${leg.is_up ? 'UP' : 'DOWN'} @ ${leg.strike}`);
    
    // TODO: Create redeem transaction
    // tx.moveCall({
    //   target: `${DEEPBOOK_PREDICT_PACKAGE}::predict::redeem`,
    //   arguments: [/* market object */, /* quantity */]
    // });
  }

  // Distribute payout
  console.log(`  🎉 Distributing payout to ${slip.owner}`);
  
  // TODO: Create payout transaction
  // const tx = new Transaction();
  // tx.moveCall({
  //   target: `${PACKAGE_ID}::parlay_vault::distribute_payout`,
  //   arguments: [tx.object(VAULT_ID), tx.object(slip.id)]
  // });
  
  console.log(`  ✅ Would distribute ${slip.potential_payout} to ${slip.owner}`);
}

async function settleLostSlip(slip: SlipData): Promise<void> {
  // Release locked bonus to vault for LPs
  console.log(`  📈 Releasing locked amount to vault (LP pool earns it)`);
  
  // TODO: Create release transaction
  // const tx = new Transaction();
  // tx.moveCall({
  //   target: `${PACKAGE_ID}::parlay_vault::release_payout`,
  //   arguments: [tx.object(VAULT_ID), tx.pure.u64(slip.locked_amount)]
  // });
  
  console.log(`  ✅ Locked bonus ${slip.locked_amount} stays in vault for LPs`);
}

async function subscribeToOracleEvents(): Promise<void> {
  console.log('🏃 Starting Settlement Keeper...');
  console.log(`   DeepBook Predict package: ${DEEPBOOK_PREDICT_PACKAGE}`);

  // TODO: Subscribe to DeepBook Predict oracle events
  // const unsubscribe = await client.subscribeEvent({
  //   filter: {
  //     MoveEventModule: {
  //       module: 'oracle',
  //       package: DEEPBOOK_PREDICT_PACKAGE,
  //     },
  //   },
  //   onMessage: async (event: any) => {
  //     const eventData = event.parsedJson as OracleEvent;
  //     console.log(`📡 Oracle settled: ${eventData.oracle_id}`);
  //     console.log(`   Settlement price: ${eventData.settlement_price}`);
  //     
  //     try {
  //       await processSettlement(eventData.oracle_id, eventData.settlement_price);
  //     } catch (error) {
  //       console.error('❌ Error processing oracle event:', error);
  //     }
  //   },
  // });

  console.log('👀 Watching for OracleSettled events...');
  console.log('   (Events: deepbook_predict::oracle::OracleSettled)\n');
}

async function main(): Promise<void> {
  console.log('🚀 Parlay Vault Settlement Keeper');
  console.log(`   Network: ${NETWORK}`);
  console.log(`   Package: ${PACKAGE_ID}`);
  console.log(`   Vault: ${VAULT_ID}`);
  console.log('\n⏳ Keeper is running. Press Ctrl+C to stop.\n');

  await subscribeToOracleEvents();

  // Keep process running
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down keeper...');
    process.exit(0);
  });
}

main().catch(console.error);
