# Predict-Backed Parlay Bonus Vault

## Product Definition

This protocol is a **DeepBook Predict-backed multi-leg product** with an **LP-funded all-win bonus**.

- Users choose `2-4` Predict markets.
- User stake is used to mint the underlying Predict positions.
- The protocol custody-holds those positions in a protocol-owned `PredictManager`.
- If **all legs win**, the user receives:
  - redeemed Predict proceeds, and
  - a bonus funded from the LP vault.
- If **one or more legs lose**, the user receives nothing and any redeemed value from winning legs is routed to the LP pool.

This is not a pure LP-settled parlay and not a pure Predict basket. It is a **wrapper** over Predict positions with a custom payout rule.

## Core Economic Rule

For each slip:

- `stake`: user capital used to back the underlying Predict positions.
- `mint_quantities`: per-leg quantities minted on DeepBook Predict.
- `redeemed_value`: total coin value recovered from Predict after all redemptions and manager withdrawal.
- `bonus_amount`: LP-funded extra payout released only if all legs win.

Settlement rule:

- `all legs win`:
  - user receives `redeemed_value + bonus_amount`
  - LP vault releases `bonus_amount`
- `not all legs win`:
  - LP vault receives `redeemed_value`
  - user receives `0`
  - LP vault releases no bonus payout beyond unlocking the reserved amount

## Why The Flow Must Be Staged

The protocol must custody Predict positions to capture partial-win redeemed value for LPs.

DeepBook Predict positions live in a `PredictManager`, and a `PredictManager` is an owned object. That means a user cannot atomically place a self-signed bet into a keeper-owned manager without keeper participation.

Because of that, the canonical flow must be:

1. User creates a pending slip and escrows stake.
2. Keeper executes a PTB:
   - releases escrowed stake,
   - deposits into protocol `PredictManager`,
   - mints all Predict legs,
   - finalizes the slip as active.

This resolves the current mismatch between the active-at-placement Move path and the custody requirement of the Predict-backed design.

## Canonical Object Model

### Shared Objects

#### `Vault<Q>`

- Ownership: shared
- Purpose: LP liquidity, bonus reserve, epoch accounting, slip accounting
- Mutation gate:
  - public for user LP entry/exit and user slip requests
  - `AdminCap` for keeper-only or privileged functions

Key responsibilities:

- queue LP deposits by epoch
- manage LP balances and share supply
- reserve only **bonus liability**
- store pending and active slip data
- receive partial-win redeemed value into the LP pool

### `OpenSlips`

- Ownership: shared
- Purpose: keeper-facing index of slips requiring execution or settlement
- Mutation gate:
  - public for user placement
  - `AdminCap` for keeper execution/settlement cleanup

This remains shared because keeper settlement needs a canonical queryable set of open slips.

### Owned Objects

#### `LPShare`

- Ownership: owned by LP
- Purpose: epoch-locked LP claim ticket
- Lifecycle:
  - minted on deposit queue
  - activated at epoch transition
  - burned on withdraw or rollover

#### `SlipReceipt`

- Ownership: owned by bettor
- Purpose: user-facing proof of requested slip
- Lifecycle:
  - minted at slip request time
  - destroyed on cancel or settlement

### Capabilities

#### `AdminCap`

- Holder: deployer / multisig / keeper authority
- Gates:
  - keeper execution
  - settlement
  - config changes
  - treasury / strategy controls

`AdminCap` remains the privileged execution gate in MVP. Permissionless settlement can be introduced later if oracle verification moves fully on-chain.

### Off-Chain Custody Object

#### `PredictManager`

- Ownership: protocol keeper address
- Purpose:
  - custody minted Predict positions
  - receive stake deposits before mint
  - redeem positions at settlement

This object is not stored inside Move state. It is configured off-chain and referenced by keeper PTBs.

## Canonical Slip Lifecycle

### 1. Request Slip

User calls:

- `request_slip(vault, open_slips, stake_coin, legs, quote, ctx) -> SlipReceipt`

Effects:

- escrows user stake
- validates leg count and quote bounds
- computes or verifies `bonus_amount`
- locks only the **bonus**, not total payout
- stores `PendingSlipData`
- mints `SlipReceipt`

### 2. Execute Pending Slip

Keeper PTB:

1. `release_pending_stake`
2. `predict_manager::deposit`
3. `predict::mint` for each leg
4. `finalize_slip`

Effects:

- moves slip from pending to active
- stores canonical leg bytes
- stores canonical minted quantities
- marks stake as deployed into Predict

### 3. Cancel Pending Slip

User can cancel before keeper execution:

- refund stake from escrow
- unlock reserved bonus
- destroy receipt

### 4. Settle Active Slip

Keeper PTB:

1. `predict::redeem_permissionless` for each leg
2. `predict_manager::withdraw` recovered value
3. call protocol settlement function with the actual `Coin<Q>`

This is critical: settlement should take a **coin**, not a raw payout integer.

Recommended settlement functions:

- `settle_all_win(vault, open_slips, slip_id, redeemed_coin, admin_cap, ctx)`
- `settle_not_all_win(vault, open_slips, slip_id, redeemed_coin, admin_cap)`

Effects:

- all-win:
  - top up with `bonus_amount` from LP vault
  - transfer full payout to bettor
- not-all-win:
  - join `redeemed_coin` into LP pool
  - bettor receives nothing

## Canonical Slip State

### `PendingSlipData`

Should contain:

- `owner`
- `legs_data`
- `stake`
- `bonus_amount`
- `quote_timestamp`
- `quote_hash` or `quote_nonce`
- `expected_quantities_data`

### `ActiveSlipData`

Should contain:

- `owner`
- `legs_data`
- `stake`
- `bonus_amount`
- `minted_quantities_data`
- `entry_epoch`
- `manager_execution_digest` optional for auditability

## Critical Semantic Changes From Current Code

### 1. `locked_amount` must become `bonus_amount`

The vault is no longer underwriting the full payout.
It underwrites only the all-win bonus.

### 2. `place_active_slip` must store real `legs_data`

The current active path drops leg bytes. That makes settlement reconstruction impossible.

### 3. Pending flow becomes canonical again

For this product, staged execution is not a workaround. It is the natural consequence of protocol-held Predict custody.

### 4. Settlement must accept a `Coin<Q>`

Do not trust off-chain numeric payout declarations. The keeper should bring the actual withdrawn Predict proceeds into Move.

## Quote Model

Current `ask_price` multiplication is not sufficient.

The protocol needs an off-chain quote engine that computes:

- per-leg quantity sizing
- expected mint cost
- expected all-win redeemed value
- LP bonus
- total product payout if all legs win

MVP quote invariants enforced on-chain:

- legs count is valid
- quote is fresh
- bonus does not exceed vault reserve policy
- quantities and quote hash match stored request

## LP Model

LPs are not underwriting full binary payouts. They are underwriting:

- all-win bonus liability
- temporary liquidity imbalances

LPs earn from:

- partial-win and loss redeemed Predict value
- idle capital deployed to Predict `supply`
- any configured house margin

### Epoch Semantics

Keep the epoch model already started in `parlay_vault.move`:

- deposit queues into next epoch
- withdraw only after position epoch has ended
- rollover stays contract-native

## Predict Yield Strategy

Use Predict in two different ways:

### Betting Capital

- protocol `PredictManager`
- funded only for pending slip execution
- used for mint/redeem of user baskets

### Idle LP Strategy

- separate strategy path using `predict::supply` / `predict::withdraw`
- should not share accounting with user betting capital

This should be a separate implementation phase after slip semantics are correct.

## MVP Trust Model

MVP can remain keeper-administered:

- keeper controls `PredictManager`
- keeper executes and settles slips
- `AdminCap` gates privileged paths

Later hardening:

- multisig `AdminCap`
- on-chain oracle-object verification
- stronger quote attestation

## Build Sequence

### Phase 1: Contract Semantics

- make pending slips canonical
- rename payout lock to bonus lock
- store canonical leg bytes and quantity bytes
- add settlement functions that take `Coin<Q>`

### Phase 2: Keeper Alignment

- finalize keeper PTBs around the canonical pending flow
- track execution digests
- redeem and withdraw actual proceeds into settlement PTBs

### Phase 3: Quote Engine

- produce signed quotes
- compute real Predict-based quantities and bonus
- enforce freshness and bonus policy

### Phase 4: LP Strategy

- integrate `predict::supply` / `predict::withdraw`
- keep strategy inventory separate from active slip liabilities

## Immediate Refactor Target

The next refactor should remove the contradiction between these two ideas:

- current `slip_executor::place_slip` immediately activates a vault-native slip
- current keeper logic assumes a pending slip that is executed into Predict later

For this protocol, the keeper-backed pending path is the correct canonical model.
