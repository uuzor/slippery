# Build plan, 2026-06-17

## Linked intent
No `.suiperpower/intent.md` exists yet.
Plan derived from the approved conversation intent:
build a **DeepBook Predict-backed multi-leg protocol** where user stake buys Predict positions, LPs fund an all-win bonus, and partial-win redeemed value is routed to LPs.

## Package layout

- Package name: `parlay_vault`
- Single package or multi-package: single Move package plus keeper TypeScript workspace
- Move.toml dependencies:
  - Sui framework
  - DeepBook Predict package references at integration boundaries
  - no extra package split until canonical slip semantics are stable

## Object model (per Object, forced ability decisions)

- `Vault<Q>`:
  - Ownership: shared
  - Abilities: `key`
  - Purpose: LP accounting, bonus reserve, slip accounting, epoch state
  - Created by: `create_vault`
  - Mutated by: LP functions, slip request/cancel/finalize/settle functions
  - Destroyed by: never

- `OpenSlips`:
  - Ownership: shared
  - Abilities: `key`
  - Purpose: canonical keeper-facing index of pending and active slips
  - Created by: `create_open_slips`
  - Mutated by: slip request, execute, settle, cancel
  - Destroyed by: never

- `LPShare`:
  - Ownership: owned
  - Abilities: `key, store`
  - Purpose: LP claim over epoch-locked vault position
  - Created by: `queue_deposit`
  - Mutated by: `advance_epoch`, `roll_over`
  - Destroyed by: `withdraw`, `cancel_queued_deposit`

- `SlipReceipt`:
  - Ownership: owned
  - Abilities: `key, store`
  - Purpose: bettor proof of requested structured slip
  - Created by: `request_slip`
  - Mutated by: never
  - Destroyed by: `cancel_pending_slip`, settlement path

- `PendingSlipData`:
  - Ownership: nested in shared state
  - Abilities: `store, copy, drop`
  - Purpose: user-requested slip waiting for keeper execution into Predict
  - Created by: `request_slip`
  - Mutated by: `finalize_slip`
  - Destroyed by: `cancel_pending_slip`, `finalize_slip`

- `ActiveSlipData`:
  - Ownership: nested in shared state
  - Abilities: `store, copy, drop`
  - Purpose: executed Predict-backed slip awaiting settlement
  - Created by: `finalize_slip`
  - Mutated by: settlement path only
  - Destroyed by: settlement path

## Capabilities

- `AdminCap`:
  - Holder at init: deployer, then moved to keeper-controlled address or multisig
  - Gates: finalize slip execution, release pending stake, settlement, parameter changes, treasury controls
  - Transferability: transferable, but should end at multisig before public rollout

## Modules

- `parlay_vault`:
  - Purpose: vault balances, epoch LP model, pending/active slip state, settlement accounting
  - Public entry functions: `create_vault`, `queue_deposit`, `advance_epoch`, `cancel_queued_deposit`, `withdraw`, `roll_over`, slip request/cancel/finalize/settle functions
  - Friend modules: none
  - Stdlib dependencies: `sui::coin`, `sui::balance`, `sui::object`, `sui::table`, `sui::transfer`, `sui::event`

- `slip_executor`:
  - Purpose: user-facing slip creation surface and keeper-facing settlement helpers
  - Public entry functions: request/place preview, open-slip queries, settle helpers
  - Friend modules: none
  - Stdlib dependencies: `sui::coin`, `sui::object`, `sui::table`, `sui::tx_context`

- `slip_pricer`:
  - Purpose: quote verification helpers and payout math
  - Public entry functions: quote preview and leg accessors
  - Friend modules: none
  - Stdlib dependencies: `std::vector`

- `keeper/predict_ptb.ts`:
  - Purpose: PTB composition for Predict manager deposit/mint/redeem/supply/withdraw

- `keeper/settle_slip.ts`:
  - Purpose: keeper orchestration, event polling, pending execution, settlement PTBs

## Public entry points

- `parlay_vault::queue_deposit(coin, auto_roll) -> LPShare`
- `parlay_vault::advance_epoch(vault) -> ()`
- `parlay_vault::withdraw(vault, share) -> Coin<Q>`
- `slip_executor::request_slip(vault, open_slips, stake_coin, legs, quote) -> SlipReceipt`
- `parlay_vault::cancel_pending_slip(vault, slip_id) -> Coin<Q>`
- `parlay_vault::release_pending_stake(vault, slip_id, &AdminCap) -> Coin<Q>`
- `parlay_vault::finalize_slip(vault, slip_id, legs_data, quantities_data, bonus_amount, &AdminCap) -> ()`
- `slip_executor::settle_all_win(vault, open_slips, slip_id, redeemed_coin, &AdminCap) -> ()`
- `slip_executor::settle_not_all_win(vault, open_slips, slip_id, redeemed_coin, &AdminCap) -> ()`

## PTB shape

- Composability: keeper-side PTB chain across Move modules and DeepBook Predict
- Canonical placement PTB:
  1. `release_pending_stake`
  2. `predict_manager::deposit`
  3. `predict::mint` x N legs
  4. `finalize_slip`
- Canonical settlement PTB:
  1. `predict::redeem_permissionless` x N legs
  2. `predict_manager::withdraw`
  3. protocol settlement with `Coin<Q>` input
- Gas envelope expected (rough): medium, explicit gas budget required for keeper PTBs

## Tests (mapped to protocol success criteria)

- `test_queue_deposit_and_activate_epoch`: LP deposit activates only next epoch
- `test_withdraw_locked_until_epoch_end`: LP cannot exit before epoch unlock
- `test_request_slip_escrows_stake_and_locks_bonus_only`: stake and bonus semantics are correct
- `test_cancel_pending_slip_refunds_stake_and_unlocks_bonus`: user safety before keeper execution
- `test_finalize_slip_persists_leg_bytes_and_quantities`: keeper execution stores canonical state
- `test_settle_all_win_transfers_redeemed_plus_bonus`: all-win user payoff path
- `test_settle_not_all_win_routes_redeemed_value_to_lp_pool`: partial-win/loss LP capture path
- `test_unauthorized_finalize_aborts`: `AdminCap` gating
- `test_unauthorized_settlement_aborts`: `AdminCap` gating

## Frontend or off-chain pieces

- Stack: frontend plus keeper
- Auth: wallet for users, keeper key or multisig for privileged execution
- Calls to chain:
  - user: deposit, request slip, cancel slip, withdraw, rollover
  - keeper: release pending stake, Predict PTBs, finalize, settle

## Sponsor integrations (load-bearing, with verification commitment)

- DeepBook Predict:
  - Surface: `predict::mint`, `predict::redeem_permissionless`, `predict_manager::deposit`, `predict_manager::withdraw`, later `predict::supply` / `predict::withdraw`
  - Load-bearing test: a testnet keeper tx digest that mints into Predict manager on placement and a digest that redeems and withdraws on settlement
  - Reference: official DeepBook Predict contract docs and deployed testnet signatures

## Network rollout

- Order: local build -> testnet keeper dry-run -> testnet funded execution
- Per-network exit criterion:
  - local: Move build and keeper TypeScript build pass
  - testnet phase 1: manager creation and pending-slip execution PTB succeeds
  - testnet phase 2: settlement PTB succeeds with actual redeemed coin input

## Upgrade authority

- Strategy: keep with multisig after initial testing
- Where the upgrade cap lives after publish: deployer first, then multisig
- Package id capture: record in env/config for keeper and later docs updates

## Risks and unknowns

- PredictManager custody requires keeper participation:
  - severity: high
  - resolution: make staged pending flow canonical

- Current vault-native active placement path conflicts with keeper-owned Predict positions:
  - severity: high
  - resolution: refactor `place_slip` back into `request_slip`

- Settlement currently cannot verify redeemed proceeds from protocol state alone:
  - severity: high
  - resolution: settlement takes real `Coin<Q>` withdrawn from Predict manager

- Quote semantics are still simplistic:
  - severity: medium
  - resolution: add off-chain quote engine with quantity sizing and bonus calculation

- PLP strategy accounting can interfere with active liability accounting:
  - severity: medium
  - resolution: separate idle LP strategy phase after slip semantics are correct

## Order of build

1. Refactor slip semantics so pending slips are canonical and bonus-only lock semantics replace full-payout locks.
2. Add canonical active slip state: `legs_data`, `quantities_data`, `bonus_amount`.
3. Rewrite settlement to accept actual redeemed `Coin<Q>` and route outcomes correctly.
4. Update keeper PTBs to the canonical request -> execute -> finalize -> redeem -> settle flow.
5. Add quote verification and testnet execution coverage.
6. Add PLP idle-liquidity strategy.

## What "done" looks like for this plan

- A user can request a multi-leg slip on testnet.
- A keeper can execute it into DeepBook Predict with one PTB.
- On oracle resolution, a keeper can redeem positions, withdraw actual proceeds, and settle the slip:
  - all-win pays `redeemed_value + bonus`
  - otherwise redeemed value accrues to LPs
- LP positions remain epoch-gated and build cleanly with the updated vault semantics.
