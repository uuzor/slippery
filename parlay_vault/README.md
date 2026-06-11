# Parlay Vault on DeepBook Predict

A composable parlay vault for Sui — LPs earn yield from DeepBook PLP + losing slip stakes, users combine 2-4 prediction markets with correct joint-probability pricing.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER FLOW                                │
│                                                                  │
│  User picks 2-4 markets                                          │
│         ↓                                                        │
│  Frontend calls vault.get_combined_odds(legs)                   │
│         ↓                                                        │
│  User stakes dUSDC → vault.place_slip(legs, stake)              │
│         ↓                                                        │
│  PTB: predict::mint() × N legs (atomic)                        │
│         ↓                                                        │
│  SlipReceipt issued to user                                     │
│         ↓                                                        │
│  Oracle settles → Keeper triggers settlement                     │
│         ↓                                                        │
│  Win: payout to user | Lose: stake to LP pool                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         LP FLOW                                  │
│                                                                  │
│  LP deposits dUSDC → receives ShareToken                       │
│         ↓                                                        │
│  Vault supplies to PLP → earns baseline yield                   │
│         ↓                                                        │
│  Losing slip stakes → LP pool earns them                         │
│         ↓                                                        │
│  LP withdraws anytime → burn shares, get pro-rata value          │
└─────────────────────────────────────────────────────────────────┘
```

## Modules

### 1. `parlay_vault.move` — LP Vault
- `deposit(amount)` → LP ShareToken
- `withdraw(shares)` → dUSDC (pro-rata)
- `share_price()` → current vault share price
- `bonus_reserve()` → max bonus for new slips
- `lock_payout()` / `release_payout()` — internal liquidity management
- `credit_rewards()` — LP pool earns from DeepBook Predict

### 2. `slip_pricer.move` — Pricing Engine
- `get_combined_odds(legs)` → correct joint probability with margin + bonus
- `compute_joint_probability()` — state_mask intersection logic
- `apply_house_margin()` — 3% margin
- `compute_bonus_multiplier()` — 2→1.0x, 3→1.05x, 4→1.10x
- `calculate_payout()` / `calculate_bonus()`

### 3. `slip_executor.move` — Slip Placement
- `place_slip(legs, stake)` → SlipReceipt
- `preview_slip(legs, stake)` → see odds before committing
- `settle_won_slip()` → distribute payout to user
- `settle_lost_slip()` → release locked bonus to vault (LP pool)
- `credit_deepbook_rewards()` → LP pool earns from winning legs

### 4. `keeper/settle_slip.ts` — Settlement Keeper
- Watches DeepBook Predict oracle events
- Redeems ALL positions (both won AND lost slips)
- Distributes payouts / releases locked amounts
- LP pool earns from both losing slips AND winning legs

## Key Design Decisions

| Decision | Value |
|----------|-------|
| **PredictManager** | One shared for vault |
| **Fees** | Paid at settlement |
| **House margin** | 3% |
| **Bonus schedule** | 2→1.0x, 3→1.05x, 4→1.10x |
| **Max slip size** | bonus ≤ vault bonus reserve (10% of deposits) |
| **Min slip size** | 1 dUSDC |
| **No withdrawal queue** | Instant redemption |

## Building

### Prerequisites
- Sui CLI (`cargo install --git https://github.com/MystenLabs/sui.git --branch testnet`)
- Node.js 18+ (for keeper)

### Build Move modules
```bash
cd parlay_vault
sui move build
```

### Run tests
```bash
sui move test
```

### Deploy to testnet
```bash
sui client publish --gas-budget 100000000
```

### Install keeper dependencies
```bash
cd keeper
npm install @mysten/sui @mysten/wallet-kit
```

### Run keeper
```bash
npx ts-node settle_slip.ts
```

## Testing the Flow

1. **Get dUSDC** — Request from [DeepBook Predict testnet faucet](https://docs.sui.io/onchain-finance/deepbook-predict/)

2. **LP deposits** — Call `parlay_vault::deposit` with dUSDC

3. **User places slip** — Call `slip_executor::place_slip` with 2-4 legs

4. **Watch oracle** — Keeper detects resolution event

5. **Settlement** — Keeper redeems positions, distributes payouts

## File Structure

```
parlay_vault/
├── Move.toml              # Package manifest
├── sources/
│   ├── parlay_vault.move  # LP vault, share tokens
│   ├── slip_pricer.move   # Joint probability pricing
│   └── slip_executor.move # Slip placement, settlement
├── keeper/
│   └── settle_slip.ts     # Off-chain settlement keeper
└── README.md
```

## Alignment with DeepBook Predict Problem Statement

✅ **Vault strategies** — LP vault composes with PLP
✅ **Composable** — Uses DeepBook Predict infrastructure
✅ **Keeper services** — Settled-redeem keeper implemented
✅ **Tokenized shares** — LP ShareToken for pro-rata ownership
✅ **End-to-end flow** — deposit → place → settle → withdraw

## Next Steps

1. Deploy to testnet
2. Get dUSDC from faucet
3. Test LP deposit/withdraw
4. Test slip placement with 2-4 legs
5. Test keeper settlement
6. Build frontend

## References

- [DeepBook Predict docs](https://docs.sui.io/onchain-finance/deepbook-predict/)
- [DeepBook v3 docs](https://docs.sui.io/onchain-finance/deepbookv3/deepbook)
- [Sui Move book](https://move-book.com/)