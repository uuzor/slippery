// Generic coin-transfer utility. Sends an exact amount of a given coin type
// from the keeper to a destination address. Uses splitCoins so the full
// source coin isn't moved (unlike transferObjects([coinId], dest)).
//
// Usage (env-driven, no CLI args so it matches the keeper's other scripts):
//   DEST=0x... COIN_TYPE=0x2::sui::SUI  AMOUNT=100000000  npx ts-node --esm transfer.ts
//   DEST=0x... COIN_TYPE=0xe9504...::dusdc::DUSDC  AMOUNT=5000000  npx ts-node --esm transfer.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Load keeper env from the same dir as this script.
for (const line of readFileSync(join(import.meta.dirname, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function parsePrivateKey(): Uint8Array {
  const raw = mustEnv('KEEPER_PRIVATE_KEY');
  if (raw.startsWith('suiprivkey')) return decodeSuiPrivateKey(raw).secretKey;
  const normalized = raw.startsWith('0x') ? raw.slice(2) : raw;
  return Buffer.from(normalized, 'hex');
}

function decimalsFor(coinType: string): number {
  // USDC / dUSDC standard: 6 decimals. SUI: 9. Other: assume 9.
  if (coinType.endsWith('::sui::SUI') || coinType === '0x2::sui::SUI') return 9;
  if (coinType.includes('::usdc::') || coinType.includes('::dusdc::')) return 6;
  return 9;
}

async function main() {
  const dest = mustEnv('DEST');
  const coinType = mustEnv('COIN_TYPE');
  const amount = BigInt(mustEnv('AMOUNT'));
  const decimals = decimalsFor(coinType);
  const rpc = process.env.SUI_RPC_UPSTREAM_URL ?? 'https://sui-testnet-rpc.publicnode.com';

  const kp = Ed25519Keypair.fromSecretKey(parsePrivateKey());
  const sender = kp.toSuiAddress();
  const humanAmount = Number(amount) / 10 ** decimals;

  console.log(`sender:   ${sender}`);
  console.log(`dest:     ${dest}`);
  console.log(`coin:     ${coinType}`);
  console.log(`amount:   ${amount} base units  (${humanAmount.toFixed(decimals)})`);
  console.log(`rpc:      ${rpc}`);

  const client = new SuiJsonRpcClient({ network: 'testnet', url: rpc });

  const coins = await client.getCoins({ owner: sender, coinType });
  const sorted = [...coins.data].sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));
  const primary = sorted[0];
  if (!primary) throw new Error(`no coins of type ${coinType} in keeper`);
  console.log(`primary coin: ${primary.coinObjectId}  balance=${primary.balance}`);

  if (BigInt(primary.balance) < amount) {
    throw new Error(
      `largest single coin (${primary.balance}) < amount (${amount}). ` +
      `Merge coins first via admin script, then re-run.`,
    );
  }

  const tx = new Transaction();
  // For SUI transfers, split from tx.gas (the gas-coin reference). Splitting
  // from a hand-picked SUI coin makes it unavailable for gas payment, which
  // trips "No valid gas coins found" in the SDK. For non-SUI coins, the
  // primary coin object is fine because it isn't the gas coin.
  if (coinType === '0x2::sui::SUI') {
    const [split] = tx.splitCoins(tx.gas, [amount]);
    tx.transferObjects([split], dest);
  } else {
    const [split] = tx.splitCoins(tx.object(primary.coinObjectId), [amount]);
    tx.transferObjects([split], dest);
  }
  tx.setGasBudget(50_000_000);

  const result = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showBalanceChanges: true },
  });

  console.log('\n--- result ---');
  console.log('digest:', result.digest);
  console.log('status:', result.effects?.status);
  for (const b of result.balanceChanges ?? []) {
    if (b.coinType !== coinType) continue;
    const amt = BigInt(b.amount);
    const human = Number(amt) / 10 ** decimals;
    const sign = amt > 0n ? '+' : '';
    const owner = typeof b.owner === 'string' ? b.owner : JSON.stringify(b.owner);
    console.log(`  ${sign}${amt}  (${sign}${human.toFixed(decimals)})  owner=${owner}`);
  }
  console.log(`\nfull txn: https://suiscan.xyz/testnet/tx/${result.digest}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
