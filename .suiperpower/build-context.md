### debug-move session, 2026-06-17

- Command: `sui move build`
- Package: `parlay_vault`
- Root cause: `advance_epoch` bound a fallback `Balance<Q>` via `zero()` and only consumed it on one control-flow path. Because `Balance<T>` does not have `drop`, Move rejected the function with `unused value without 'drop'`.
- Fix: rewrote the pending-deposit activation branch so the removed `Balance<Q>` is created and consumed only when a queued balance exists, while still updating `total_deposits` for the activated epoch.
- Follow-up: restored the `zero` import because `create_vault` still initializes `lp_balance` and `escrow` with it.
- Result: `sui move build` now succeeds.

## ptb-composer session, 2026-06-17
- ptb name: DeepBook Predict keeper integration
- command count: 4 core Move calls wired (`predict_manager::deposit`, `predict::mint`, `predict::redeem_permissionless`, `predict::supply` / `predict::withdraw`)
- input count: 6 required config inputs (`DEEPBOOK_QUOTE_TYPE`, `VAULT_PKG`, `VAULT_ID`, `ADMIN_CAP_ID`, optional `OPEN_SLIPS_ID`, optional `PREDICT_MANAGER_ID`)
- first executed digest: not executed in this environment
- gas budget: explicit budgets added to manager creation, pending-slip execution, redemption, and vault-settlement PTBs
- open issues: pending-slip events do not carry leg quantities, and vault settlement still does not consume redeemed Predict proceeds on-chain

## object-model-design session, 2026-06-17

### Objects
| Object | Abilities | Ownership | Mutation gate | Why |
|---|---|---|---|---|
| `Vault<Q>` | `key` | shared | mixed public + `AdminCap` | global LP and slip accounting |
| `OpenSlips` | `key` | shared | mixed public + `AdminCap` | keeper needs canonical shared index |
| `LPShare` | `key, store` | owned | self | per-LP epoch position |
| `SlipReceipt` | `key, store` | owned | self until settlement | user proof of requested structured slip |
| `PendingSlipData` | `store, copy, drop` | nested in shared state | `AdminCap` for execution | protocol-held slip request before Predict mint |
| `ActiveSlipData` | `store, copy, drop` | nested in shared state | `AdminCap` for settlement | executed Predict-backed slip awaiting settlement |

### Capabilities
- `AdminCap`: created in init, transferred to keeper or multisig, required by finalize and settlement paths.
- `PredictManager`: not a Move capability in this package, but an off-chain custody object controlled by the keeper address and required for Predict mint/redeem PTBs.

### Open issues
- Protocol-owned Predict custody implies staged keeper execution is canonical; active-at-placement path should be removed from the main flow.
- Settlement should consume real redeemed `Coin<Q>` from Predict manager rather than trusting numeric payout input.
- Current README still describes the older active-at-placement model and is stale against the new protocol spec.

## build-with-move session, 2026-06-17
- module: `parlay_vault::parlay_vault`
- functions added: `available_bonus_capacity`, `request_slip`, `get_active_slip`, `settle_all_win`, `settle_not_all_win`
- functions modified: `advance_epoch`, `share_price`, `get_vault_stats`, `release_pending_stake`, `get_pending_slip`, `finalize_slip`, `cancel_pending_slip`
- module: `parlay_vault::slip_executor`
- functions modified: `place_slip`, `get_open_slip`
- functions added: `settle_all_win`, `settle_not_all_win`
- module: keeper TypeScript
- functions modified: `executePendingSlip`, `settleSlip`
- helpers added: `serializeLegQuantities`
- tests added: none yet
- dependencies added: none
- open issues:
  - keeper settlement still needs a real resolution engine that knows when all slip legs are settled and what total manager-withdraw amount to use
  - `SlipReceipt` remains a proof object but is not yet burned on settlement
  - Move unit tests are still missing for the new pending/finalize/settle flow

## build-with-move session, 2026-06-17 follow-up
- module: `parlay_vault::slip_pricer`
- functions modified: `new_market_leg`
- functions added: `get_quantity`
- protocol change: `MarketLeg` now carries `quantity`, so pending slips can be executed from canonical on-chain quote data
- module: `parlay_vault::parlay_vault`
- functions modified: `request_slip`, `get_pending_slip`, `finalize_slip`, `withdraw`, `roll_over`
- state change: added `PendingSlipData.quantities_data` and `Vault.epoch_slip_counts`
- security change: `request_slip` is now `public(package)` and derives owner from `TxContext`
- correctness change: `finalize_slip` now reads stored pending leg and quantity bytes instead of accepting keeper-supplied values
- module: `parlay_vault::slip_executor`
- functions modified: `place_slip`, `get_open_slip`
- functions added: `register_active_slip`
- indexing change: `OpenSlips` now tracks active slips only
- keeper changes:
  - `predict_ptb.ts` BCS `MarketLeg` now includes `quantity`
  - `settle_slip.ts` finalize flow now calls `register_active_slip` after `finalize_slip`
- tests added: none yet
- open issues:
  - keeper still relies on off-chain tracked slip payloads instead of reading pending slip bytes back from chain before execution
  - `SlipReceipt` burn / settlement consumption is still not implemented
  - Move tests are still missing for the per-epoch slip count logic and active-slip registration path

## build-with-move session, 2026-06-17 pricing fix
- module: `parlay_vault::slip_pricer`
- functions modified: `get_combined_odds`
- helpers added: `scale_div_u64`
- tests added: `preview_slip_keeps_odds_scaled`
- on-chain upgrade: testnet package upgraded from `0x9f896cde3ab09755fe02a1cb5a4e2a982bb71e8be60792cfc59a021b81260d34` to `0xfe72f950be380f34cd65fbefb362b9cab8638b663dd70a44b42be8264244a37a`
- verification:
  - `sui move build` succeeded
  - `sui move test` passed the new regression test
  - live dev-inspect against old package still returned `(4, 1_000_000_000, 0, 0)`
  - live dev-inspect against upgraded package returned `(4_165_364_990, 1_000_000_000, 41_653_649, 0)`
- keeper config updated: `keeper/.env.local` now points `VAULT_PKG` at the upgraded package

## build-with-move session, 2026-06-17 bootstrap + live smoke
- module: `parlay_vault::parlay_vault`
- functions added: `seed_liquidity`
- events added: `LiquiditySeeded`
- tests added: `seed_liquidity_activates_immediately`
- module: `parlay_vault::slip_executor`
- functions added: `place_slip_bcs`, `decode_market_legs`
- keeper changes:
  - fixed shared `PredictManager` discovery via creation events / tx object changes
  - fixed manager balance reading from `balance_manager.balances` dynamic fields
  - fixed upgraded-package object detection by matching type suffixes instead of latest package id
  - switched live slip placement to `place_slip_bcs` with `vector<u8>` payloads
- testnet upgrades:
  - `0x781a22c5f2b2f8dbf4e72dcd2ab65263bd15c8b8466359d0ee40763e00785e0d` digest `6qMpzTad6QnDY1QEZ5bnjnwz9zYUWgvenqyPUWkryi6P`
  - `0xc4874d9d95044d9e1658211fbccc4cd36982628b28d3056c02b41eb6f488bca4` digest `HMVmphUd1upsiCQd7Zv5kDFzsfAP5LckBVvK7nMnfMXn`
- live smoke verification:
  - seed tx digest `3xfRMFzWYWAv6Y6VmhSBpaK35zGTjwqL9gkp8mWiPFWf`
  - place tx digest `Gsm41p1j5N1pr8Wyb5WeicPPtP7A3ww68kbf2iduJjaq`
  - execute tx digest `EErtyakuiJKXmuNzQ2eXroYzno9BumS328jaAzSJkqBY`
  - redeem tx digest `5EomfKSXSGCzmSP7PWNboc4pn1T3BRG3kBvSHbTp3mNE`
  - settle tx digest `D6LJh6WbehYU7WvDk2eGD1LieyKiG1NzSn9XQmWkGNrK`
  - final vault state: `pending_slips = 0`, `active_slips = 0`, `OpenSlips.size = 0`, `lp_balance = 401228424`
- open issues:
  - repeated smoke runs currently add new seeded LP positions and grow `total_deposits`; there is no admin test-only unwind path yet
  - keeper execution currently runs reliably from source via `node --env-file=.env.local --loader ts-node/esm smoke_flow.ts`; the compiled `dist` runner still needs ESM import cleanup if you want a plain `node dist/...` flow

## build-with-move session, 2026-06-17 settlement gating
- keeper modules updated: `keeper/smoke_flow.ts`, `keeper/settle_slip.ts`
- protocol change:
  - keeper no longer redeems immediately after mint in the intended flow
  - settlement is now gated on all oracle legs reaching a real Predict-settled state
  - vault outcome is derived from settled leg results before `settle_all_win` or `settle_not_all_win`
- smoke-flow change:
  - uses two complementary legs on the same soonest-future oracle so one real oracle settlement resolves the whole slip
  - logs leg count and waits for settled `settlement_price` on-chain before redeeming
  - filters out stale active oracles whose expiry is already in the past
- keeper change:
  - on each `OracleSettled` event, only tracked slips touching that oracle are re-checked
  - if not all legs are settled yet, the keeper waits instead of redeeming
  - once all legs are settled, keeper redeems the full slip, computes the winning-leg count, and calls the correct vault settlement path
- residual note:
  - I did not rerun the new wait-based smoke flow in this turn because the next clean future BTC oracle expiry on testnet was still roughly 90 minutes out, so a real rerun would mostly idle waiting on Predict resolution
