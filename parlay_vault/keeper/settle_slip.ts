/**
 * Parlay Vault Settlement Keeper
 * 
 * Architecture: Keeper-owned manager pattern
 * - Keeper creates PredictManager on startup
 * - Keeper executes slip placements via PTB
 * - Keeper settles via redeem_permissionless
 * 
 * Events watched:
 * - SlipPending (user deposited stake, ready for execution)
 * - OracleSettled (oracle expired, ready for settlement)
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

const NETWORK = 'testnet';

// DeepBook Predict package (testnet)
const DEEPBOOK_PKG = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
const DEEPBOOK_OBJ = '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';

// Parlay Vault package (set after deployment)
const VAULT_PKG = '0xYourPackageId';
const VAULT_ID = '0xYourVaultId';

const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

interface MarketLeg {
  oracle_id: string;
  expiry: number;
  strike: number;
  is_up: boolean;
  ask_price: number;
}

interface PendingSlipEvent {
  slip_id: string;
  owner: string;
  stake: number;
}

interface OracleSettledEvent {
  oracle_id: string;
  expiry: number;
  settlement_price: number;
  timestamp: number;
}

// Keeper state
let keeperKeypair: Ed25519Keypair | null = null;
let keeperAddress: string = '';
let managerId: string | null = null;

async function initKeeper() {
  if (!process.env.KEEPER_PRIVATE_KEY) {
    console.log('⚠️  No KEEPER_PRIVATE_KEY set - running in read-only mode');
    return;
  }
  
  keeperKeypair = Ed25519Keypair.fromSecretKey(
    Buffer.from(process.env.KEEPER_PRIVATE_KEY, 'hex')
  );
  keeperAddress = keeperKeypair.toSuiAddress();
  console.log(`✅ Keeper keypair loaded: ${keeperAddress}`);
  
  // Check if manager exists, create if not
  await ensureManager();
}

async function ensureManager() {
  // TODO: Query on-chain to check if manager exists for keeper
  // For now, create on first startup if not set
  if (!managerId) {
    console.log('📝 Creating PredictManager...');
    const tx = new Transaction();
    tx.moveCall({
      target: `${DEEPBOOK_PKG}::predict::create_manager`,
    });
    
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keeperKeypair!,
      options: { showEffects: true },
    });
    
    // Extract manager ID from effects
    // In production, parse the created object
    console.log('⚠️  Manual manager ID setup required');
    console.log('Transaction effects:', JSON.stringify(result.effects, null, 2));
  }
}

/**
 * Execute a pending slip - builds PTB to:
 * 1. Release SUI from vault escrow
 * 2. Deposit into keeper's manager
 * 3. Mint positions on DeepBook
 */
async function executePendingSlip(slipId: string, legs: MarketLeg[]) {
  if (!keeperKeypair) {
    console.log('⚠️  No keeper keypair, skipping execution');
    return;
  }
  
  console.log(`\n🚀 Executing slip ${slipId}`);
  
  const tx = new Transaction();
  
  // Step 1: Release SUI from vault escrow
  // const [suiCoin] = tx.moveCall({
  //   target: `${VAULT_PKG}::parlay_vault::release_pending_stake`,
  //   arguments: [tx.object(VAULT_ID), tx.pure(slipId)],
  // });
  
  // Step 2: Deposit into keeper's manager
  // tx.moveCall({
  //   target: `${DEEPBOOK_PKG}::predict_manager::deposit`,
  //   arguments: [tx.object(managerId!), suiCoin],
  // });
  
  // Step 3: Mint each leg
  // for (const leg of legs) {
  //   const marketKey = buildMarketKey(leg);
  //   tx.moveCall({
  //     target: `${DEEPBOOK_PKG}::predict::mint`,
  //     arguments: [
  //       tx.object(DEEPBOOK_OBJ),
  //       tx.object(managerId!),
  //       tx.pure(marketKey),
  //       tx.pure(leg.ask_price),
  //       tx.object('0x5'), // Clock
  //     ],
  //   });
  // }
  
  // Step 4: Finalize slip
  // tx.moveCall({
  //   target: `${VAULT_PKG}::parlay_vault::finalize_slip`,
  //   arguments: [tx.object(VAULT_ID), tx.pure(slipId)],
  // });
  
  console.log('   PTB constructed (not submitted - implement actual calls)');
  
  // const result = await client.signAndExecuteTransaction({
  //   transaction: tx,
  //   signer: keeperKeypair,
  // });
  // console.log(`   ✅ Executed: ${result.digest}`);
}

/**
 * Settle a slip after oracle settlement
 */
async function settleSlip(slipId: string, oracleEvent: OracleSettledEvent) {
  if (!keeperKeypair) {
    console.log('⚠️  No keeper keypair, skipping settlement');
    return;
  }
  
  console.log(`\n💰 Settling slip ${slipId}`);
  
  // Step 1: Redeem all positions for this oracle
  // for (const leg of slip.legs) {
  //   if (leg.oracle_id === oracleEvent.oracle_id) {
  //     const tx = new Transaction();
  //     tx.moveCall({
  //       target: `${DEEPBOOK_PKG}::predict::redeem_permissionless`,
  //       arguments: [
  //         tx.object(DEEPBOOK_OBJ),
  //         tx.object(managerId!),
  //         tx.pure(leg.oracle_id),
  //         tx.pure(leg.expiry),
  //         tx.pure(leg.strike),
  //         tx.pure(leg.is_up),
  //         tx.pure(leg.ask_price),
  //         tx.object('0x5'),
  //       ],
  //     });
  //     await client.signAndExecuteTransaction({
  //       transaction: tx,
  //       signer: keeperKeypair,
  //     });
  //   }
  // }
  
  // Step 2: Withdraw from manager
  // const withdrawTx = new Transaction();
  // withdrawTx.moveCall({
  //   target: `${DEEPBOOK_PKG}::predict_manager::withdraw`,
  //   arguments: [tx.object(managerId!), tx.pure(amount)],
  // });
  
  // Step 3: Call vault settle
  // const settleTx = new Transaction();
  // settleTx.moveCall({
  //   target: `${VAULT_PKG}::parlay_vault::settle_won_slip`,
  //   arguments: [tx.object(VAULT_ID), tx.pure(slipId), tx.pure(payout)],
  // });
  
  console.log('   Settlement PTB constructed (not submitted)');
}

/**
 * Subscribe to SlipPending events
 */
async function subscribeToPendingSlips() {
  console.log('👀 Subscribing to SlipPending events...');
  
  const unsubscribe = await client.subscribeEvent({
    filter: {
      MoveEventModule: {
        module: 'parlay_vault',
        package: VAULT_PKG,
      },
    },
    onMessage: async (event: any) => {
      if (event.type.includes('SlipPending')) {
        const slipEvent = event.parsedJson as PendingSlipEvent;
        console.log(`\n📋 New pending slip: ${slipEvent.slip_id}`);
        console.log(`   Owner: ${slipEvent.owner}`);
        console.log(`   Stake: ${slipEvent.stake}`);
        
        // TODO: Fetch slip details and execute
        // const legs = await fetchSlipLegs(slipEvent.slip_id);
        // await executePendingSlip(slipEvent.slip_id, legs);
      }
    },
  });
  
  return unsubscribe;
}

/**
 * Subscribe to OracleSettled events
 */
async function subscribeToOracleEvents() {
  console.log('👀 Subscribing to OracleSettled events...');
  
  const unsubscribe = await client.subscribeEvent({
    filter: {
      MoveEventModule: {
        module: 'oracle',
        package: DEEPBOOK_PKG,
      },
    },
    onMessage: async (event: any) => {
      if (event.type.includes('OracleSettled')) {
        const oracleEvent = event.parsedJson as OracleSettledEvent;
        console.log(`\n📡 Oracle settled: ${oracleEvent.oracle_id}`);
        console.log(`   Price: ${oracleEvent.settlement_price} (${(oracleEvent.settlement_price / 1e9).toFixed(4)}x)`);
        
        // Find and settle affected slips
        // await settleAffectedSlips(oracleEvent);
      }
    },
  });
  
  return unsubscribe;
}

async function main() {
  console.log('🚀 Parlay Vault Keeper');
  console.log(`   Network: ${NETWORK}`);
  console.log(`   Vault: ${VAULT_ID}`);
  console.log(`   DeepBook: ${DEEPBOOK_PKG}`);
  
  await initKeeper();
  
  const unsubPending = await subscribeToPendingSlips();
  const unsubOracle = await subscribeToOracleEvents();
  
  console.log('\n⏳ Keeper running. Press Ctrl+C to stop.\n');
  
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    unsubPending();
    unsubOracle();
    process.exit(0);
  });
}

main().catch(console.error);
