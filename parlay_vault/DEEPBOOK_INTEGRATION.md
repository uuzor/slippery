# DeepBook Predict Integration Summary

## Status

✅ **Sandbox analyzed** — DeepBook Predict source code reviewed  
✅ **API understood** — predict::mint(), predict::redeem(), predict::supply() documented  
✅ **Integration points updated** — Move modules and keeper aligned with actual API  
⚠️ **Sandbox not run** — Docker not available in current environment

---

## DeepBook Predict API (from packages/predict/)

### Core Functions

```move
// Create a PredictManager for a user
predict::create_manager(ctx) -> ID

// Get trade amounts for UI preview
predict::get_trade_amounts(predict, oracle, key, quantity, clock) -> (mint_cost, redeem_payout)

// Buy a position (UP or DOWN)
predict::mint(predict, manager, oracle, key, quantity, clock, ctx)

// Sell a position
predict::redeem(predict, manager, oracle, key, quantity, clock, ctx) -> payout

// Supply to vault (PLP yield)
predict::supply(predict, coin, ctx) -> shares_minted

// Withdraw from vault
predict::withdraw(predict, amount, ctx) -> Coin
predict::withdraw_all(predict, ctx) -> Coin
```

### Key Types

```move
// Main protocol object (shared)
struct Predict<phantom Quote> has key {
    id: UID,
    vault: Vault<Quote>,
    supply_manager: SupplyManager,
    pricing_config: PricingConfig,
    risk_config: RiskConfig,
    trading_paused: bool,
}

// User's position manager
struct PredictManager has key {
    id: UID,
    owner: address,
    balance_manager: BalanceManager,
    positions: Table<MarketKey, UserPosition>,
}

// Volatility surface oracle
struct OracleSVI has key {
    id: UID,
    // SVI params: a, b, rho, m, sigma
    // Spot, forward, expiry
    // Settlement price
}

// Market key for a position
struct MarketKey has copy, drop, store {
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
}
```

### Events

```move
// Position lifecycle
PositionMinted { predict_id, manager_id, trader, oracle_id, expiry, strike, is_up, quantity, cost, ask_price }
PositionRedeemed { predict_id, manager_id, trader, oracle_id, expiry, strike, is_up, quantity, payout, bid_price, is_settled }

// Oracle lifecycle
OracleActivated { oracle_id, expiry, timestamp }
OracleSettled { oracle_id, expiry, settlement_price, timestamp }
OraclePricesUpdated { oracle_id, spot, forward, timestamp }
OracleSVIUpdated { oracle_id, a, b, rho, m, sigma, risk_free_rate, timestamp }

// Supply/Withdraw
Supplied { predict_id, supplier, amount, shares_minted }
Withdrawn { predict_id, supplier, amount, shares_burned }
```

---

## Parlay Vault Integration Points

### 1. Slip Placement (PTB)

For each leg in a parlay:
```typescript
// In TypeScript PTB
tx.moveCall({
    target: `${DEEPBOOK_PREDICT}::predict::mint`,
    arguments: [
        tx.object(predictId),      // Predict object
        tx.object(managerId),        // PredictManager
        tx.object(oracleId),         // OracleSVI
        tx.pure(MarketKey),          // MarketKey struct
        tx.pure.u64(quantity),       // position size
        tx.object(clockId),          // Clock
    ],
});
```

### 2. Settlement (Keeper)

For each leg, call redeem:
```typescript
tx.moveCall({
    target: `${DEEPBOOK_PREDICT}::predict::redeem`,
    arguments: [
        tx.object(predictId),
        tx.object(managerId),
        tx.object(oracleId),
        tx.pure(MarketKey),
        tx.pure.u64(quantity),
        tx.object(clockId),
    ],
});
```

### 3. PLP Supply

```typescript
tx.moveCall({
    target: `${DEEPBOOK_PREDICT}::predict::supply`,
    arguments: [
        tx.object(predictId),
        tx.object(coin),  // dUSDC Coin
    ],
});
```

---

## Fixed-Point Conventions

From DeepBook Predict source (`constants.move`):

```move
FLOAT_SCALING: u64 = 1_000_000_000  // 1e9 for prices
DECIMAL_SCALING: u64 = 1_000_000      // 1e6 for USDC
```

**Note:** Our parlay vault uses different scales:
- Odds: 4 decimals (10,000)
- Share price: 6 decimals (1,000,000)

Must convert when interfacing with DeepBook Predict.

---

## Deployment Addresses (Testnet)

```
DeepBook Predict package: 0x9ae0e853e7f39f893dc2d64386c12bb1d570f4f0bb3d3d63b40fd1b3ddf6b3f8
dUSDC token: (from dusdc package)
Predict objects: (deployed per market)
```

---

## Running the Sandbox

From `deepbook-sandbox/external/deepbook/packages/predict/simulations/`:

```bash
# Install dependencies
npm install

# Run full simulation
bash run.sh

# Setup only (publish + create objects)
bash run.sh --setup

# List existing runs
bash run.sh --list

# Resume a run
bash run.sh --resume <run-id>
```

---

## Next Steps for Testnet Deployment

1. **Deploy parlay_vault package to testnet**
2. **Get dUSDC** from DeepBook Predict faucet
3. **Create PredictManager** via predict::create_manager
4. **Deposit dUSDC** to manager
5. **Test slip placement** with 2-4 legs
6. **Connect keeper** to OracleSettled events
7. **Test settlement** flow

---

## Files Updated

| File | Changes |
|------|---------|
| `slip_executor.move` | Added DeepBook Predict type aliases, mint/redeem entry points |
| `keeper/settle_slip.ts` | Updated to use OracleSettled events, correct redeem API |
| `DEEPBOOK_INTEGRATION.md` | This file — API documentation |

---

*Last updated: 2026-06-11*