# Parlay Vault Keeper

The keeper is the continuously running off-chain executor for Parlay Vault.

It performs two protocol operations:

1. Execute pending slips by moving escrowed stake into DeepBook Predict and minting every leg.
2. Settle active slips after all Predict oracles resolve.

The Move contracts remain authoritative for ownership, bonus reservation, active-slip state, and payout routing. The keeper holds the `AdminCap` and controls the protocol `PredictManager`.

## Runtime Flow

### Pending slip execution

When a bettor places a slip, the contract emits `SlipPending` and stores the stake and leg data in `Vault.pending_slips`.

The keeper:

1. Watches `SlipPending` events and periodically scans pending state.
2. Reads the canonical `SlipReceipt` leg data.
3. Rejects execution if any leg has already expired.
4. Calls `release_pending_stake`.
5. Deposits the released stake into the PredictManager.
6. Calls `predict::mint` for every leg.
7. Calls `finalize_slip`.
8. Calls `register_active_slip`.

These calls are submitted in one PTB. Either the full execution succeeds or the slip remains pending.

If a slip expires before execution, the keeper leaves it pending for the bettor to cancel and recover the stake. It does not repeatedly submit mint transactions against expired oracles.

### Active slip settlement

For active slips, the keeper calculates the latest leg expiry and waits until that time plus the configured settlement grace period.

It then:

1. Reads every oracle's `settlement_price`.
2. Waits if any oracle is not settled.
3. Calculates which legs won.
4. Reads the PredictManager position table.
5. Redeems only position quantities that remain non-zero.
6. Calculates the expected Predict proceeds from winning leg quantities.
7. Verifies the PredictManager has enough quote balance.
8. Withdraws the exact proceeds into the vault settlement PTB.
9. Calls `settle_all_win` or `settle_not_all_win`.

Settlement routing:

- All legs win: Predict proceeds plus the LP-funded bonus are transferred to the bettor.
- Any leg loses: proceeds from winning legs are added to `lp_balance`.

Settled slip proceeds should not remain in the PredictManager.

## Permissionless DeepBook Redemption

DeepBook Predict allows external executors to call `redeem_permissionless`. A third party can therefore redeem the protocol's settled positions before this keeper does.

The keeper must treat redemption as idempotent:

- A zero manager position means it was already redeemed.
- Already-redeemed positions are skipped.
- Partially remaining positions are redeemed only up to their available quantity.
- Available quantity is allocated across legs sharing the same market key.

This behavior fixed a live failure where `predict_manager::decrease_position` aborted because the keeper attempted to redeem a position whose quantity was already zero.

Live recovery transaction:

```text
BtYbbcbwtjLdKz11vkZ1FXFzowRjL4zyMix6gDqeb9Pa
```

That settlement withdrew `1 DUSDC` from the PredictManager and routed it to LP liquidity through `settle_not_all_win`.

## Configuration

The bot loads `keeper/.env.local` through Node's `--env-file` option.

Required variables:

```dotenv
SUI_NETWORK=testnet
SUI_RPC_UPSTREAM_URL=https://sui-testnet-rpc.publicnode.com

KEEPER_PRIVATE_KEY=suiprivkey...

VAULT_PKG=0x...
VAULT_ID=0x...
OPEN_SLIPS_ID=0x...
ADMIN_CAP_ID=0x...

DEEPBOOK_PKG=0x...
DEEPBOOK_OBJ=0x...
DEEPBOOK_QUOTE_TYPE=0x...::dusdc::DUSDC
PREDICT_MANAGER_ID=0x...
```

Optional variables:

```dotenv
CLOCK_OBJECT_ID=0x6
KEEPER_POLL_INTERVAL_MS=5000
KEEPER_RESYNC_INTERVAL_MS=30000
KEEPER_SETTLEMENT_GRACE_MS=30000
KEEPER_SETTLEMENT_RETRY_MS=60000
KEEPER_ENABLE_ORACLE_EVENT_POLLING=false
```

Keep `.env.local` private. It contains the keeper signing key.

## Running

Install dependencies:

```powershell
npm install
```

Build:

```powershell
npm run build
```

Run the continuous bot:

```powershell
npm run bot
```

The `bot` script compiles TypeScript and starts:

```powershell
node --env-file=.env.local ./dist/bot.js
```

The process is expected to remain running. Use a process supervisor for long-lived deployments.

## Other Scripts

```powershell
npm run place-open
```

Places and executes a test slip using live Predict markets.

```powershell
npm run smoke
```

Runs the testnet smoke flow.

```powershell
npm run start
```

Runs the older manual settlement utility. The continuous `bot` command is the normal runtime.

`admin_reclaim_liquidity.ts` is a recovery utility for manually inspecting and settling stranded positions. It is not the normal keeper loop.

## Persistent State

The keeper stores event cursors in:

```text
keeper/.state/bot-state.json
```

The cursors reduce repeated event processing after a restart. The bot also resynchronizes pending and active slips directly from shared objects, so event cursors are not its only source of truth.

## Operational Notes

- Only one active keeper should normally use the same signer and `AdminCap`.
- The keeper wallet needs enough SUI for transaction gas.
- The PredictManager is shared across slips. Its quote balance is pooled.
- Balance deltas alone are unsafe for payout attribution because permissionless executors may redeem asynchronously.
- Current binary Predict payout is derived from settled winning quantities.
- Production accounting should eventually record per-slip mint cost, unused quote balance, and redemption attribution explicitly.
- An expired pending slip must be cancelled by its bettor to recover escrowed stake and release its reserved bonus.

## Main Files

- `bot.ts`: continuous execution and settlement service.
- `predict_ptb.ts`: PredictManager, mint, redeem, supply, and withdraw PTB helpers.
- `settle_slip.ts`: manual/event-driven settlement utilities.
- `place_open_slip.ts`: live placement and execution helper.
- `smoke_flow.ts`: end-to-end testnet flow.
- `admin_reclaim_liquidity.ts`: manual recovery utility.
