# Parlay Vault Build Notes

## What We Built

This protocol is a Sui-native parlay vault built on top of DeepBook Predict.

The final model is:

- LPs deposit capital into a shared vault.
- Bettors place 2+ leg slips.
- The bettor stake is routed into DeepBook Predict positions.
- If all legs win, Predict redemption plus an LP-funded bonus pays the bettor.
- If not all legs win, redeemed value stays in the vault and accrues to LPs.

This is not a simple sportsbook contract. It is a structured flow across:

- `Vault<Q>` for LP accounting and escrow
- `SlipReceipt` for bettor proof of placement
- `PendingSlipData` / `ActiveSlipData` for protocol state
- DeepBook Predict `PredictManager` for custody and mint/redeem PTBs
- `OpenSlips` as the keeper-facing active-slip index

## Core Design Decisions

### 1. Predict is the execution layer, LP is the bonus layer

The vault does not price or settle bets in isolation.

- Predict handles the market-side mint/redeem path.
- The vault handles stake escrow, bonus reservation, LP accounting, and final routing.
- Settlement depends on actual redeemed `Coin<Q>`, not a user-supplied payout number.

This removed the earlier trust gap where settlement logic could be tricked with arbitrary payout inputs.

### 2. Bet placement is request-first, execution-second

We moved away from the earlier “place and activate immediately” idea.

The final flow is:

1. Bettor places a slip.
2. Slip is stored as pending in the vault.
3. Keeper releases stake, deposits to PredictManager, mints Predict legs, and finalizes the slip.
4. Only then is the slip registered in `OpenSlips`.

This solved the mismatch between vault state and keeper state.

### 3. LP deposits are epoch-aware, but bootstrap liquidity needed an escape hatch

The intended LP model is epoch-gated:

- deposits queue for the next epoch
- withdrawals unlock after the entry epoch settles
- rollover is supported at the contract level

That model is good for fairness, but it blocked full live testing. To solve that, we added:

- `seed_liquidity<Q>(vault, coin, &AdminCap, ctx): LPShare`

This is an admin-only bootstrap path that immediately activates LP liquidity without waiting for the next epoch.

## Major Issues We Hit

## 1. Privileged vault functions were not properly gated

### Problem

Several dangerous functions could be called without a root protocol capability. This exposed multiple downstream issues:

- reward inflation
- bonus reserve drain
- unguarded settlement

### Fix

We introduced `AdminCap` minted in `init` and required it on all privileged flows:

- `finalize_slip`
- `release_pending_stake`
- `settle_all_win`
- `settle_not_all_win`
- bonus cap updates
- reward crediting
- bootstrap liquidity

### What we learned

On Sui, capability discipline is the protocol boundary. If it is weak, every other correctness fix is fragile.

## 2. Settlement trusted a numeric payout instead of a real coin

### Problem

The original settlement path accepted payout-like values instead of consuming the actual redeemed asset from Predict. That meant the keeper could claim settlement amounts without the vault proving the money existed.

### Fix

We changed settlement to consume a real `Coin<Q>`:

- `settle_all_win(..., redeemed_coin, ...)`
- `settle_not_all_win(..., redeemed_coin, ...)`

Then:

- winner path transfers the real redeemed coin plus LP bonus
- non-all-win path routes the redeemed coin back into `lp_balance`

### What we learned

If an external protocol determines redemption value, the vault must settle from the redeemed coin object, not a scalar shadow of that value.

## 3. The vault and keeper had two conflicting slip lifecycles

### Problem

There used to be two parallel truths:

- vault pending/active slip tables
- `OpenSlips` tracking from the moment of placement

That meant a slip could appear active to the keeper while still being pending in the vault.

### Fix

We made the vault authoritative:

- `place_slip` only requests a pending slip
- keeper executes Predict mint
- keeper calls `finalize_slip`
- keeper then calls `register_active_slip`

`OpenSlips` is now populated only after finalization.

### What we learned

Sui object systems make state duplication expensive. Shared indexes should reflect canonical contract transitions, not invent parallel lifecycle stages.

## 4. Keeper-supplied leg data was a trust bug

### Problem

`finalize_slip` originally accepted leg bytes from the keeper. That allowed execution with data different from what the bettor originally placed.

### Fix

We changed the protocol so `finalize_slip` reads stored pending slip bytes from the vault itself.

We also added:

- `quantity` to `MarketLeg`
- `quantities_data` to pending and active slip state

This made keeper execution derive from canonical on-chain quote data.

### What we learned

If a user commits to a quote at placement time, the protocol must finalize from that stored commitment, not a fresh off-chain reconstruction.

## 5. `MarketLeg` was missing `quantity`

### Problem

DeepBook Predict mint requires quantity, but the stored leg data only had:

- oracle id
- expiry
- strike
- direction
- ask price

That meant keeper PTBs could not be rebuilt from chain state alone.

### Fix

We added `quantity` directly to `MarketLeg` and propagated it through:

- pricing
- BCS encoding
- pending slip storage
- active slip storage
- keeper PTB generation

### What we learned

If a PTB depends on a value, that value must be part of the on-chain commitment. “Off-chain memory” is not protocol state.

## 6. Arithmetic and share accounting had overflow/underflow risk

### Problem

We found multiple numerical correctness issues:

- `share_price` subtraction underflow risk
- `compute_shares` overflow risk
- `redeem_amount` overflow risk
- `mul_div_u64` overflow risk in slip pricing

### Fix

We moved the critical math to `u128` intermediates and added saturation-style guards where subtraction could underflow.

### What we learned

Even when values look “small” in tests, DeFi math should treat every multiply-then-divide path as high risk by default.

## 7. Bonus locking was semantically wrong

### Problem

The protocol was conceptually paying a bonus from LP capital, but the older lock semantics were aligned to payout in a confusing way.

### Fix

We normalized the vault to track `locked_bonus` rather than payout-like terminology and used:

- `available_bonus_capacity()`
- `reserve_bonus()`
- `release_bonus()`

This matched the real economic promise: LPs are insuring only the bonus layer.

### What we learned

Economic language in code matters. If names imply the wrong invariant, later implementations drift.

## 8. Epoch withdrawal gating needed per-epoch slip tracking

### Problem

A single current slip count was not enough to know whether shares from an older epoch were actually safe to withdraw.

### Fix

We added `epoch_slip_counts: Table<u64, u64>` and used it in:

- `advance_epoch`
- `withdraw`
- `roll_over`
- `note_slip_settled`

### What we learned

Epoch accounting cannot be reduced to “current status” if capital from old epochs remains economically exposed.

## 9. Move-specific build issues kept surfacing

### Problem

We hit several Move correctness constraints during implementation:

- `Balance<T>` without `drop` could not be ignored
- cross-module struct construction was restricted
- cross-module test teardown caused dependency cycles
- PTB-visible custom struct args were awkward from TypeScript

### Fixes

- rewrote control flow to only create/consume `Balance<T>` on valid branches
- used public constructors like `new_market_leg`
- kept teardown tests in the owning module
- added `place_slip_bcs` so the frontend/keeper can pass `vector<u8>` instead of custom `vector<MarketLeg>` PTB args

### What we learned

Sui Move is extremely explicit about ownership and module boundaries. Many of the “annoying” errors were actually forcing better protocol hygiene.

## 10. DeepBook Predict integration was harder than the docs-first design suggested

### Problems

The real integration issues were:

- `PredictManager` is shared, not owned
- manager balances live in dynamic fields, not a flat field
- upgraded package ids do not change original object type anchors
- TypeScript PTBs could not safely pass `vector<MarketLeg>` as a pure arg directly
- “active” oracles could still include stale expiries in practice

### Fixes

- discovered manager ids from creation events / tx object changes
- read manager balances from `balance_manager.balances`
- matched created object types by suffix, not latest package id
- added `place_slip_bcs`
- filtered stale active oracles by expiry time

### What we learned

Integration bugs were mostly object-model bugs, not business-logic bugs. Understanding how DeepBook stores state on Sui mattered more than just knowing the function names.

## 11. The first smoke flow was not protocol-correct

### Problem

The first successful live smoke test redeemed immediately after mint. That proved the PTBs and accounting, but it was not the true intended flow.

### Fix

We updated keeper behavior so it now:

- waits for all slip legs to be Predict-settled
- derives all-win vs not-all-win from settled leg outcomes
- redeems only after full resolution
- then chooses `settle_all_win` or `settle_not_all_win`

### What we learned

A smoke test can be technically successful and still economically wrong. For protocol work, flow correctness matters as much as transaction success.

## 12. Permissionless redemption made keeper redemption non-idempotent

### Problem

DeepBook Predict allows a third-party executor to call `redeem_permissionless` after an oracle settles. This happened to a live four-leg slip:

- the keeper minted all four positions successfully
- DeepBook executors redeemed the first three losing positions
- a DeepBook executor later redeemed the winning position and credited `1 DUSDC` to the protocol PredictManager
- our keeper then attempted to redeem every leg again
- `predict_manager::decrease_position` aborted because the first position quantity was already zero

The relevant transactions were:

- mint and finalize: `9nBAykhWCVfgv7P7LzDZ4CuwK18y2NWjnaqQXg8k6UhG`
- first three permissionless redemptions: `7LEV1jEkGLAruQzk14gMfqgPtCxjLJMYy7r55UijcNbY`
- final winning-leg redemption: `5fYhQgzRjanAUpcP3MdR4qsYQBF1PSpGnnbFnJAdMuPg`
- duplicate keeper redemption failure: `4iKAaUyMfiPvN6WgQ6w4k43gMNiZs8czTJgKsUb2YbYM`

### Fix

The continuous keeper now:

- reads the PredictManager position table before building a redemption PTB
- allocates available position quantity across legs sharing the same market key
- redeems only quantities that remain non-zero
- treats already-zero positions as already redeemed rather than as an error
- computes the slip proceeds from settled winning-leg quantities
- verifies the PredictManager contains enough quote balance
- withdraws the exact slip proceeds inside the vault settlement PTB
- refuses to execute a pending slip after its latest leg expiry, avoiding repeated `assert_live_oracle` failures while the bettor cancels it

### Settlement routing

- If every leg wins, the Predict proceeds are withdrawn and sent to the bettor together with the LP-funded bonus.
- If any leg loses, the Predict proceeds from the winning legs are withdrawn and joined into `lp_balance`.
- Settled slip proceeds are not intentionally left in the PredictManager.

### What we learned

Oracle settlement and position redemption are separate state transitions. A keeper must assume another actor can redeem first and make its own work idempotent.

The PredictManager is also pooled across slips. Balance deltas are therefore not reliable payout attribution when third parties can redeem asynchronously. The keeper uses binary winning quantity as the expected settled payout, but production accounting should eventually record each slip's mint cost, unused quote balance, and redemption attribution explicitly.

### Live verification

The updated keeper recovered and settled the affected four-leg slip in transaction:

- settlement: `BtYbbcbwtjLdKz11vkZ1FXFzowRjL4zyMix6gDqeb9Pa`

The slip had one winning leg, so the keeper withdrew `1 DUSDC` from the PredictManager and called `settle_not_all_win`. After settlement:

- `OpenSlips.size = 0`
- `active_slips.size = 0`
- `epoch_settled = true`
- LP balance increased from `302.421324 DUSDC` to `303.421324 DUSDC`

## Final On-Chain State Reached

Latest testnet package:

- `0xc4874d9d95044d9e1658211fbccc4cd36982628b28d3056c02b41eb6f488bca4`

Shared runtime objects:

- vault: `0xc5b7d6189e77c87381a0a80ab7826ec2cb3ff9f15c904ac7d1a3885a2f4aa0f1`
- open slips: `0xe0411a8957e3e72e9408086652b891e49a49f38a70e5eb2160f4a7656f019930`
- predict manager used in smoke flow: `0x65f26499d13a3bde34a703dad2782d13b55b2aec650a9a7115fe94e6adfdea47`

Successful live flow already proven:

- seed liquidity
- place slip
- execute pending slip into Predict
- redeem Predict legs
- settle back to LP

Later, keeper logic was tightened again so the intended production flow now waits on oracle settlement before redeeming.

## What Still Matters Before Frontend

These are the remaining practical items:

- run one real LP withdrawal on testnet after epoch rollover
- verify the updated idempotent keeper settles the currently redeemed open slip
- decide whether to add an admin cleanup path for bootstrap-seeded LP shares
- decide whether `SlipReceipt` should be explicitly consumed/burned at final settlement
- add per-slip accounting for unused PredictManager quote balance after mint

## Main Lessons

The biggest lessons from this build were:

- Sui capability design is the first security layer, not a detail.
- Shared objects and owned objects must each represent exactly one truth.
- PTB ergonomics shape contract interface design more than expected.
- DeepBook Predict integration is mostly about understanding object layout and lifecycle.
- If a protocol depends on real external settlement, the vault must consume real redeemed coins and real settled oracle state.
- Good smoke tests can still hide bad protocol assumptions.

## Bottom Line

The protocol is now materially better than the original design.

It moved from:

- stubbed Predict integration
- parallel slip systems
- unsafe settlement trust assumptions
- incomplete LP/bettor accounting

to:

- real Predict PTB execution
- capability-gated privileged paths
- canonical pending-to-active slip flow
- epoch-aware LP model plus bootstrap testing path
- settlement based on real redeemed assets
- keeper logic aligned with real oracle finalization

That is the right base to start frontend work, while keeping LP withdrawal verification and final real-time settlement verification as the next protocol checks.
