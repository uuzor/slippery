# Build Summary — Parlay Vault on DeepBook Predict

**Date:** 2026-06-11  
**Status:** Core modules written, ready for testnet deployment

---

## What Was Built

### Move Modules (3 files, ~35KB)

| Module | Lines | Purpose |
|--------|-------|---------|
| `parlay_vault.move` | 340 | LP vault, deposit/withdraw, share math, liquidity management |
| `slip_pricer.move` | 360 | Joint probability, house margin (3%), bonus multipliers |
| `slip_executor.move` | 280 | Slip placement, preview, settlement handlers |

### Keeper (1 file)

| File | Purpose |
|------|---------|
| `keeper/settle_slip.ts` | Off-chain oracle watcher, redeems all positions, settles slips |

---

## Module Breakdown

### parlay_vault.move

**Data Structures:**
- `Vault` — shared object with total_deposits, total_shares, locked_payouts, accrued_yield, bonus_cap_pct
- `ShareToken` — transferable LP ownership token
- `VaultManager` — shared PredictManager placeholder

**Functions:**
- `deposit(amount)` → ShareToken (entry function)
- `withdraw(shares)` → dUSDC (entry function)
- `share_price()` → current price (view)
- `bonus_reserve()` → max bonus for new slips (view)
- `lock_payout(amount)` → internal
- `release_payout(amount)` → internal
- `credit_rewards(amount)` → internal
- `supply_to_plp()` → placeholder for PLP integration
- `claim_plp_yield()` → placeholder for PLP integration

**Tests:** 5 tests covering share price, deposit, bonus reserve, lock/release, accrued yield

---

### slip_pricer.move

**Data Structures:**
- `MarketLeg` — market_id, position, odds
- `Slip` — owner, legs, stake, combined_odds, bonus_multiplier, potential_payout, locked_amount
- `SlipStatus` — enum (Open, Won, Lost, Settled)

**Functions:**
- `get_market_odds(market_id, position)` → current odds (placeholder)
- `compute_joint_probability(legs)` → product of individual probabilities
- `apply_house_margin(odds)` → 3% reduction
- `compute_bonus_multiplier(num_legs)` → 2→1.0x, 3→1.05x, 4→1.10x
- `get_combined_odds(legs)` → final odds with margin + bonus
- `calculate_payout(stake, odds, bonus_mult)` → potential payout
- `calculate_bonus(stake, odds, bonus_mult)` → payout - stake
- `create_leg()` / `create_slip()` — helpers

**Tests:** 10 tests covering odds conversion, joint probability, margin, bonus, combined odds, payout calculation

---

### slip_executor.move

**Data Structures:**
- `SlipReceipt` — issued to user on place_slip
- `OpenSlips` — shared registry for keeper to scan

**Functions:**
- `place_slip(vault, open_slips, legs, stake)` → SlipReceipt (entry)
  - Validates 2-4 legs, stake ≥ 1 dUSDC
  - Checks bonus ≤ vault.bonus_reserve
  - Locks bonus in vault
  - Issues SlipReceipt to user
- `preview_slip(legs, stake)` → (odds, bonus_mult, payout, bonus) (view)
- `settle_won_slip(vault, receipt)` → mint payout to owner (entry)
- `settle_lost_slip(vault, receipt)` → release locked to vault (entry)
- `credit_deepbook_rewards(vault, rewards)` → LP pool earns (entry)

**Validation:**
- E_TOO_FEW_LEGS (1) — minimum 2 legs
- E_TOO_MANY_LEGS (2) — maximum 4 legs
- E_BELOW_MIN_STAKE (3) — minimum 1 dUSDC
- E_INSUFFICIENT_BONUS_RESERVE (4) — protects LPs

---

### keeper/settle_slip.ts

**Flow:**
1. Subscribe to `OracleResolved` events from DeepBook Predict
2. On event: scan OpenSlips for affected slips
3. For each slip: redeem ALL positions via `predict::redeem_permissionless`
4. If all legs won → distribute payout to user
5. If any leg lost → release locked bonus to vault (LP pool earns it)

**Key insight:** Even "lost" slips generate LP revenue — winning legs are redeemed and rewards go to vault.

---

## Design Decisions Implemented

| Decision | Implementation |
|----------|----------------|
| One shared PredictManager | `VaultManager` struct (placeholder) |
| Fees at settlement | Not charged at mint time |
| House margin 3% | `apply_house_margin()` → 300 bps |
| Bonus schedule | 2→10000, 3→10500, 4→11000 (4-decimal fixed point) |
| Max slip size | bonus ≤ bonus_reserve (10% of deposits) |
| Min slip size | 1_000_000 (1 dUSDC) |
| Redeem on all slips | Keeper calls redeem for BOTH won AND lost |

---

## Share Price Formula

```
share_price = (total_deposits + accrued_yield - locked_payouts) / total_shares

Initial: 1 share per 1 dUSDC (price = 1.0)
Later: shares = dUSDC / current_price
```

---

## Fixed-Point Conventions

| Value | Scale | Example |
|-------|-------|---------|
| Odds | 10,000 (4 decimals) | 15000 = 1.50x |
| Bonus multiplier | 10,000 (4 decimals) | 10500 = 1.05x |
| Share price | 1,000,000 (6 decimals) | 1_050_000 = 1.05 |
| dUSDC | 1 (1 = 1e-6 dUSDC) | 1_000_000 = 1 dUSDC |

---

## Next Steps

### Day 1 (if not already done)
- [ ] Request dUSDC from testnet faucet
- [ ] Deploy to testnet
- [ ] Test LP deposit/withdraw

### Day 2-3
- [ ] Test slip placement with 2, 3, 4 legs
- [ ] Verify bonus_reserve cap works
- [ ] Test slip cancellation (optional)

### Day 4
- [ ] Connect keeper to testnet oracle events
- [ ] Test settlement flow
- [ ] Verify LP earns from losing slips

### Day 5-7
- [ ] Build frontend (market picker, odds display, slip placement)
- [ ] Polish UI
- [ ] Write submission writeup

---

## Integration Points (Need Real Addresses)

| Component | Address | Status |
|-----------|---------|--------|
| DeepBook Predict package | `0x9ae0e853e7f39f893dc2d64386c12bb1d570f4f0bb3d3d63b40fd1b3ddf6b3f8` | Testnet |
| Parlay Vault package | `0x...` | Need deployment |
| Vault object | `0x...` | Need deployment |
| OpenSlips object | `0x...` | Need deployment |

Update these in `keeper/settle_slip.ts` after deployment.

---

## Testing Strategy

1. **Unit tests** — All modules have inline tests
2. **Integration tests** — Mock DeepBook Predict calls
3. **Testnet flow** — Real deployment + dUSDC

Run with: `sui move test`

---

*Built following PARLAY_VAULT_DESIGN.md as source of truth*