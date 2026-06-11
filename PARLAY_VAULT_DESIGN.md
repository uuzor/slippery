# Parlay Vault on DeepBook Predict — Design Document

**Version:** 1.1  
**Date:** 2026-06-11  
**Status:** Draft — Awaiting Approval

---

## Overview

A composable parlay vault that:
1. LPs deposit dUSDC -> earn PLP baseline yield + losing slip stakes
2. Users combine 2-4 DeepBook Predict markets -> pay stake -> get combined odds
3. All legs win -> user gets bonus payout
4. Any leg loses -> stake stays in vault -> LPs earn it

---

## Architecture

```
USER FLOW:
-----------
User picks 2-4 markets
       |
       v
Frontend calls vault.get_combined_odds(legs)
       |
       v
Frontend displays: "Combined odds: 3.2x" (correct joint prob)
       |
       v
User stakes 100 dUSDC
       |
       v
vault.place_slip(legs, stake)
       |
       v
PTB: predict::mint() x N legs (atomic)
       |
       v
SlipReceipt issued to user
       |
       v
Oracle settles -> Keeper triggers settlement
       |
       v
Win: payout transferred to user
Lose: stake stays in vault -> LPs earn it

LP FLOW:
--------
LP calls vault.deposit(dUSDC)
       |
       v
LP receives ShareToken (pro-rata ownership)
       |
       v
Vault supplies dUSDC to predict::supply -> earns PLP yield
       |
       v
LP can withdraw anytime (no lock, no queue)
       |
       v
On withdraw: burn shares -> receive dUSDC + accrued value

Accrued value = proportional share of:
  - PLP yields earned
  - Losing slip stakes (including winning legs in partial losses)
  - minus any unclosed slip liabilities (locked_payouts)
```

---

## Core Components

### 1. LP Vault Module (parlay_vault.move)

#### Data Structures

```move
/// The Vault — shared object owned by the module
struct Vault has key, store {
    id: UID,
    total_deposits: u64,        // total dUSDC deposited
    total_shares: u64,          // total LP shares outstanding
    locked_payouts: u64,        // dUSDC locked for open slip payouts
    accrued_yield: u64,         // accumulated PLP yield + slip premiums
    bonus_cap_pct: u64,         // max bonus as % of deposits (e.g., 1000 = 10%)
}

/// LP Share Token — transferable object representing pro-rata vault ownership
struct ShareToken has key, store {
    id: UID,
    shares: u64,                // number of shares this token represents
}

/// One shared PredictManager for the vault
struct VaultManager has key, store {
    id: UID,
    predict_manager_id: ID,     // DeepBook Predict PredictManager ID
}
```

#### Core Functions

```move
/// LP deposits dUSDC into vault
/// @param amount: dUSDC to deposit
/// @return: ShareToken object representing pro-rata vault ownership
public entry fun deposit(amount: Coin<dUSDC>, ctx: &mut TxContext): ShareToken

/// LP withdraws dUSDC from vault
/// @param shares: ShareToken to burn
/// @return: dUSDC (pro-rata share of deposits + accrued value)
public entry fun withdraw(shares: ShareToken, ctx: &mut TxContext): Coin<dUSDC>

/// Calculate current share price
/// @return: u64 representing dUSDC per share (fixed-point, 6 decimals)
public fun share_price(vault: &Vault): u64

/// Get available bonus reserve (for slip sizing)
/// @return: max bonus that can be locked for new slips
public fun bonus_reserve(vault: &Vault): u64

/// Lock dUSDC for a pending slip payout (called before mint)
/// @param amount: dUSDC to lock
fun lock_payout(vault: &mut Vault, amount: u64)

/// Release locked dUSDC back to available (slip settled)
/// @param amount: dUSDC to release
fun release_payout(vault: &mut Vault, amount: u64)

/// Distribute payout to winning user
/// @param to: recipient address
/// @param amount: payout amount
fun distribute_payout(vault: &mut Vault, to: address, amount: u64)

/// Credit rewards to vault (from redeem_permissionless)
/// @param amount: dUSDC to credit
fun credit_rewards(vault: &mut Vault, amount: u64)

/// Supply available dUSDC to DeepBook PLP for baseline yield
public fun supply_to_plp(vault: &mut Vault)

/// Redeem PLP yield and credit to accrued_yield
public fun claim_plp_yield(vault: &mut Vault)
```

#### Share Price Calculation

```
share_price = (total_deposits + accrued_yield - locked_payouts) / total_shares

Initial deposit: 1 share per 1 dUSDC (price = 1.0)
Later deposits: shares = dUSDC / current_share_price

bonus_reserve = total_deposits * bonus_cap_pct / 10000
```

---

### 2. Slip Pricer Module (slip_pricer.move)

#### Data Structures

```move
/// A leg in a parlay slip
struct MarketLeg has copy, drop, store {
    market_id: ID,             // DeepBook Predict market ID
    position: u8,              // 0 = first outcome, 1 = second, etc.
}

/// A slip placed by a user
struct Slip has key, store {
    id: UID,
    owner: address,
    legs: vector<MarketLeg>,   // 2-4 markets
    stake: u64,                // dUSDC staked
    combined_odds: u64,        // computed combined odds (fixed-point)
    bonus_multiplier: u64,     // multiplier for multi-leg
    potential_payout: u64,     // stake x odds x bonus
    locked_amount: u64,        // vault locks (payout - stake)
    status: SlipStatus,
}

enum SlipStatus {
    Open,          // legs active, awaiting settlement
    Won,           // all legs resolved YES, payout due
    Lost,          // at least one leg resolved NO
    Settled,       // payout distributed or stake released
}
```

#### Pricing Functions

```move
/// Get current odds for a single market
/// @param market_id: DeepBook Predict market ID
/// @param position: outcome position (0, 1, 2...)
/// @return: odds as u64 (e.g., 150 = 1.50x)
public fun get_market_odds(market_id: ID, position: u8): u64

/// Compute joint probability for independent markets
/// Uses state_mask intersection
/// @param markets: vector of (market_id, position) tuples
/// @return: joint probability as u64
public fun compute_joint_probability(
    markets: vector<(ID, u8)>
): u64

/// Apply house margin to combined odds (3%)
/// @param combined_odds: raw joint probability odds
/// @return: adjusted odds after 3% margin
public fun apply_house_margin(combined_odds: u64): u64

/// Compute bonus multiplier for multi-leg parlays
/// @param num_legs: 2, 3, or 4
/// @return: multiplier (e.g., 10500 = 1.05x for 3 legs, fixed-point 4 decimals)
public fun compute_bonus_multiplier(num_legs: u8): u64

/// Get combined odds for a slip
/// @param legs: vector of market legs
/// @return: final combined odds with margin + bonus applied
public fun get_combined_odds(legs: vector<MarketLeg>): u64

/// Calculate bonus (payout - stake)
/// @param stake: user stake amount
/// @param odds: combined odds
/// @param bonus_mult: bonus multiplier
/// @return: bonus amount
public fun calculate_bonus(stake: u64, odds: u64, bonus_mult: u64): u64
```

#### Bonus Multiplier Schedule

| Legs | Multiplier | Rationale |
|------|------------|-----------|
| 2 | 1.00x (10000) | Base case — encourage 2-leg to start |
| 3 | 1.05x (10500) | +5% bonus — harder to hit |
| 4 | 1.10x (11000) | +10% bonus — hardest to hit |

---

### 3. Slip Executor (PTB)

#### Placement Flow

```
User's frontend:
1. Display 2-4 market checkboxes
2. Call vault.get_combined_odds(legs) -> show "3.2x combined"
3. User enters stake amount (e.g., 100 dUSDC)
4. Call vault.place_slip(legs, stake)

Vault.place_slip() executes PTB:

Step 1: Compute combined odds
  -> slip_pricer.get_combined_odds(legs)

Step 2: Calculate payout parameters
  -> payout = stake x odds x bonus
  -> bonus = payout - stake
  -> Check bonus <= vault.bonus_reserve (reject if not)

Step 3: Lock vault liquidity
  -> vault.lock_payout(bonus)

Step 4: Mint positions on each market (atomic)
  -> predict::mint(market_1, position_1, stake_fraction)
  -> predict::mint(market_2, position_2, stake_fraction)
  -> predict::mint(market_3, position_3, stake_fraction)
  -> predict::mint(market_4, position_4, stake_fraction)

Step 5: Issue SlipReceipt to user
  -> transfer SlipReceipt to user

Gas budget: ~300k (estimate for 4 markets)
Atomic: all steps succeed or none
```

#### Slip Sizing Constraints

```
max_bonus = vault.bonus_reserve
bonus = stake x odds x bonus_mult - stake

If bonus > max_bonus -> REJECT

This protects LPs from outsized payouts.
```

#### Edge Cases

| Scenario | Handling |
|----------|----------|
| Vault has insufficient bonus reserve | Reject — return error to frontend |
| Market odds changed between display and placement | Use odds at placement time (PTB snapshot) |
| PTB fails mid-execution | Atomic rollback — vault lock released |
| User tries to place single-leg slip | Reject — minimum 2 legs required |
| User tries to place 5+ leg slip | Reject — maximum 4 legs |
| User tries to stake < 1 dUSDC | Reject — minimum 1 dUSDC |

---

### 4. Settlement Keeper (Off-chain)

#### Flow

Keeper runs continuously, watching DeepBook Predict oracle events:

1. DETECT: OracleEvent { market_id, resolved: true, result: ... }
2. SCAN: Query all open slips containing this market_id
3. UPDATE: For each slip:
   - If all legs resolved YES -> mark Won
   - If any leg resolved NO -> mark Lost (partial wins possible)
4. PROCESS ALL SLIPS (same PTB for won and lost):

   **PTB: settle_slip**

   **Step 1: Redeem ALL positions in DeepBook Predict**
   - predict::redeem_permissionless() for EACH leg
   - Rewards from winning legs go to vault (LP pool)
   - This happens for BOTH won AND lost slips

   **Step 2: Determine slip outcome**
   - If all legs won -> Won
   - If any leg lost -> Lost

   **Step 3a: IF WON**
   - vault.distribute_payout(to: slip.owner, amount)
   - Release locked_amount back to vault
   - Credit user with stake x odds x bonus

   **Step 3b: IF LOST**
   - Release locked_amount back to vault
   - Stake stays in vault -> LPs earn it (from bonus pool)
   - Winning leg rewards also credit to LP pool

   **Step 4: Mark slip Settled**

#### Key Insight: Lost Slips Still Generate LP Revenue

Even when a slip is marked "lost" (because at least one leg failed), the **winning legs still generate rewards** from DeepBook Predict. These rewards go to the LP pool, not the user.

**Example:**
- User bets 3-leg parlay: [Market A WIN, Market B LOSE, Market C WIN]
- Slip is "lost" (Market B failed)
- BUT: Market A and Market C positions are redeemed
- Those rewards -> LP pool
- User's original stake -> LP pool (from the locked bonus)

**LP earns from losing slips:**
1. The bonus (payout - stake) that was locked
2. Plus rewards from any winning legs in that slip

This is the "two yield sources" value proposition — LPs earn even from losing bets.

---

#### Keeper Trigger Conditions

| Event | Action |
|-------|--------|
| Oracle resolves market | Process all slips with that market |
| Market settles (oracle event) | Finalize all pending positions |
| Vault bonus reserve approaches limit | Pause new slip placements |

---

## Design Decisions (Finalized)

| Decision | Value | Rationale |
|----------|-------|-----------|
| **PredictManager** | One shared manager for vault | Simpler, LP pool shares risk/reward |
| **Fees** | Paid at settlement | Reduces upfront cost to users |
| **House margin** | 3% | Competitive with sportsbooks |
| **Bonus schedule** | 2->1.0x, 3->1.05x, 4->1.10x | Encourages multi-leg |
| **Max slip size** | Capped so bonus <= vault bonus reserve | Protects LPs from outsized payouts |
| **Min slip size** | 1 dUSDC | Prevent dust |
| **No withdrawal queue** | Instant redemption | Hackathon scope |
| **Redeem on all slips** | Both won AND lost | LP pool earns from all market positions |

---

## Module Structure

```
sources/
├── parlay_vault.move      # LP vault, share tokens, PLP integration
├── slip_pricer.move       # Joint probability, margin, bonus
├── slip_receipt.move      # SlipReceipt object, status tracking
└── deepbook_predict.move  # Interface to DeepBook Predict

tests/
├── vault_tests.move       # deposit/withdraw/share math
├── pricer_tests.move      # joint probability, odds calculation
└── integration_tests.move # full flow (mock DeepBook)
```

---

## Security Considerations

| Risk | Mitigation |
|------|-----------|
| **Race condition on vault liquidity** | Lock before mint (PTB atomic) |
| **Oracle manipulation** | Trust DeepBook Predict oracle |
| **Front-running odds change** | Odds snapshotted at PTB execution time |
| **Insufficient vault liquidity** | Check bonus_reserve before place_slip |
| **Share price manipulation** | Locked payouts excluded from share price calc |
| **Slip sizing exploits** | bonus_reserve cap prevents outsized payouts |

---

## Approval Checklist

- [x] LP Vault flow approved
- [x] Slip Pricer math approved  
- [x] Slip Executor PTB approved
- [x] Settlement Keeper flow approved (with redeem for all slips)
- [x] Module structure approved
- [x] Design decisions finalized
- [ ] Ready to build

---

*This document is the source of truth. Code must match this design.*
