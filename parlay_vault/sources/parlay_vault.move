/// Parlay Vault — LP deposit/withdraw with pro-rata share tokens
module parlay_vault::parlay_vault {

    use sui::coin::{Coin, Self};
    use sui::sui::SUI;
    use sui::object::{UID, new_uid};
    use sui::transfer;
    use sui::tx_context::TxContext;

    // =============================================================================
    // ERROR CODES
    // =============================================================================

    const E_INSUFFICIENT_SHARES: u64 = 1;
    const E_ZERO_SHARES: u64 = 2;
    const E_VAULT_EMPTY: u64 = 3;
    const E_BELOW_MIN_STAKE: u64 = 4;

    // Fixed-point decimals for share price (6 decimals)
    const SHARE_PRICE_SCALE: u64 = 1_000_000;

    // Minimum stake in dUSDC (1 dUSDC = 1_000_000 u64)
    const MIN_STAKE: u64 = 1_000_000;

    // =============================================================================
    // DATA STRUCTURES
    // =============================================================================

    /// The Vault — shared object owned by the module
    /// Tracks total deposits, shares outstanding, and accrued yield
    struct Vault has key, store {
        id: UID,
        total_deposits: u64,        // total dUSDC deposited by LPs
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

    /// One shared PredictManager for the vault (placeholder for DeepBook integration)
    struct VaultManager has key, store {
        id: UID,
        manager_id: vector<u8>,     // DeepBook Predict PredictManager ID as bytes
    }

    // =============================================================================
    // INITIALIZATION
    // =============================================================================

    /// Initialize the vault with default parameters
    /// Called once on module publish
    fun init(ctx: &mut TxContext) {
        let vault = Vault {
            id: new_uid(ctx),
            total_deposits: 0,
            total_shares: 0,
            locked_payouts: 0,
            accrued_yield: 0,
            bonus_cap_pct: 1000, // 10% default
        };
        transfer::share_object(vault);
    }

    // =============================================================================
    // LP FUNCTIONS (User-facing)
    // =============================================================================

    /// LP deposits dUSDC into vault
    /// @param amount: dUSDC to deposit (in smallest unit, e.g., 1_000_000 = 1 dUSDC)
    /// @return: ShareToken object representing pro-rata vault ownership
    public entry fun deposit(
        vault: &mut Vault,
        amount: u64,
        ctx: &mut TxContext
    ): ShareToken {
        assert!(amount > 0, E_INSUFFICIENT_SHARES);

        let shares_to_mint = if (vault.total_shares == 0) {
            // First depositor: 1 share per 1 dUSDC
            amount
        } else {
            // Subsequent depositors: shares based on current share price
            // shares = amount / share_price
            // share_price = (total_deposits + accrued_yield - locked_payouts) / total_shares
            let share_price = share_price(vault);
            (amount * SHARE_PRICE_SCALE) / share_price
        };

        // Update vault totals
        vault.total_deposits = vault.total_deposits + amount;
        vault.total_shares = vault.total_shares + shares_to_mint;

        // Mint share token to caller
        ShareToken {
            id: new_uid(ctx),
            shares: shares_to_mint,
        }
    }

    /// LP withdraws dUSDC from vault
    /// @param shares: ShareToken to burn
    /// @return: dUSDC (pro-rata share of deposits + accrued value)
    public entry fun withdraw(
        vault: &mut Vault,
        shares: ShareToken,
        ctx: &mut TxContext
    ): Coin<SUI> {
        let shares_burned = shares.shares;
        assert!(shares_burned > 0, E_ZERO_SHARES);
        assert!(vault.total_shares > 0, E_VAULT_EMPTY);

        // Calculate withdrawal amount
        // amount = shares * share_price
        let share_price = share_price(vault);
        let withdraw_amount = (shares_burned * share_price) / SHARE_PRICE_SCALE;

        // Update vault totals
        vault.total_deposits = vault.total_deposits - withdraw_amount;
        vault.total_shares = vault.total_shares - shares_burned;

        // Burn the share token (implicit by not returning it)
        // Return dUSDC to caller
        coin::mint<SUI>(ctx, withdraw_amount)
    }

    // =============================================================================
    // VIEW FUNCTIONS
    // =============================================================================

    /// Calculate current share price
    /// @return: dUSDC per share (fixed-point, 6 decimals)
    public fun share_price(vault: &Vault): u64 {
        if (vault.total_shares == 0) {
            return SHARE_PRICE_SCALE // 1.0 by default
        };

        let available = vault.total_deposits + vault.accrued_yield - vault.locked_payouts;
        (available * SHARE_PRICE_SCALE) / vault.total_shares
    }

    /// Get available bonus reserve for slip sizing
    /// @return: max bonus that can be locked for new slips
    public fun bonus_reserve(vault: &Vault): u64 {
        (vault.total_deposits * vault.bonus_cap_pct) / 10000
    }

    /// Get vault statistics
    public fun get_vault_stats(vault: &Vault): (u64, u64, u64, u64, u64) {
        (
            vault.total_deposits,
            vault.total_shares,
            vault.locked_payouts,
            vault.accrued_yield,
            bonus_reserve(vault),
        )
    }

    // =============================================================================
    // INTERNAL FUNCTIONS (Called by slip executor / keeper)
    // =============================================================================

    /// Lock dUSDC for a pending slip payout
    /// Called before placing orders to ensure liquidity
    /// @param amount: dUSDC to lock
    public fun lock_payout(vault: &mut Vault, amount: u64) {
        let available = vault.total_deposits + vault.accrued_yield - vault.locked_payouts;
        assert!(amount <= available, E_INSUFFICIENT_SHARES);
        vault.locked_payouts = vault.locked_payouts + amount;
    }

    /// Release locked dUSDC back to available (slip settled)
    /// @param amount: dUSDC to release
    public fun release_payout(vault: &mut Vault, amount: u64) {
        assert!(amount <= vault.locked_payouts, E_INSUFFICIENT_SHARES);
        vault.locked_payouts = vault.locked_payouts - amount;
    }

    /// Credit rewards to vault (from redeem_permissionless)
    /// @param amount: dUSDC to credit
    public fun credit_rewards(vault: &mut Vault, amount: u64) {
        vault.accrued_yield = vault.accrued_yield + amount;
    }

    /// Supply available dUSDC to DeepBook PLP for baseline yield
    /// Note: This is a placeholder — actual implementation requires DeepBook integration
    public fun supply_to_plp(_vault: &mut Vault) {
        // TODO: Integrate with DeepBook predict::supply
        // Implementation will call the DeepBook PLP contract
    }

    /// Redeem PLP yield and credit to accrued_yield
    /// Note: This is a placeholder — actual implementation requires DeepBook integration
    public fun claim_plp_yield(_vault: &mut Vault) {
        // TODO: Integrate with DeepBook predict::redeem_plp
        // Implementation will claim PLP rewards and credit to accrued_yield
    }

    /// Update bonus cap percentage (admin function)
    public fun set_bonus_cap(vault: &mut Vault, new_cap_pct: u64) {
        vault.bonus_cap_pct = new_cap_pct;
    }

    // =============================================================================
    // TESTS
    // =============================================================================

    #[test_only]
    use sui::test_scenario;

    #[test]
    fun test_share_price_initial() {
        let scenario = test_scenario::begin(@0x1);
        let ctx = test_scenario::ctx(scenario);

        // Create vault directly for testing
        let vault = Vault {
            id: new_uid(ctx),
            total_deposits: 0,
            total_shares: 0,
            locked_payouts: 0,
            accrued_yield: 0,
            bonus_cap_pct: 1000,
        };

        // Initial share price should be 1.0 (1_000_000)
        assert!(share_price(&vault) == SHARE_PRICE_SCALE, 0);

        test_scenario::end(scenario);
    }

    #[test]
    fun test_deposit_and_share_price() {
        let scenario = test_scenario::begin(@0x1);
        let ctx = test_scenario::ctx(scenario);

        let mut vault = Vault {
            id: new_uid(ctx),
            total_deposits: 0,
            total_shares: 0,
            locked_payouts: 0,
            accrued_yield: 0,
            bonus_cap_pct: 1000,
        };

        // First deposit: 100 dUSDC -> 100 shares
        let shares = deposit(&mut vault, 100_000_000, ctx); // 100 dUSDC
        assert!(shares.shares == 100_000_000, 0);

        // Share price should still be 1.0
        assert!(share_price(&vault) == SHARE_PRICE_SCALE, 0);

        // Second deposit: 100 dUSDC -> 100 shares (price unchanged)
        let shares2 = deposit(&mut vault, 100_000_000, ctx);
        assert!(shares2.shares == 100_000_000, 0);

        // Total: 200 dUSDC, 200 shares, price = 1.0
        assert!(vault.total_deposits == 200_000_000, 0);
        assert!(vault.total_shares == 200_000_000, 0);
        assert!(share_price(&vault) == SHARE_PRICE_SCALE, 0);

        test_scenario::end(scenario);
    }

    #[test]
    fun test_bonus_reserve() {
        let scenario = test_scenario::begin(@0x1);
        let ctx = test_scenario::ctx(scenario);

        let vault = Vault {
            id: new_uid(ctx),
            total_deposits: 1_000_000_000, // 1000 dUSDC
            total_shares: 1_000_000_000,
            locked_payouts: 0,
            accrued_yield: 0,
            bonus_cap_pct: 1000, // 10%
        };

        // Bonus reserve = 1000 * 10% = 100 dUSDC
        assert!(bonus_reserve(&vault) == 100_000_000, 0);

        test_scenario::end(scenario);
    }

    #[test]
    fun test_lock_and_release() {
        let scenario = test_scenario::begin(@0x1);
        let ctx = test_scenario::ctx(scenario);

        let mut vault = Vault {
            id: new_uid(ctx),
            total_deposits: 1_000_000_000, // 1000 dUSDC
            total_shares: 1_000_000_000,
            locked_payouts: 0,
            accrued_yield: 0,
            bonus_cap_pct: 1000,
        };

        // Lock 100 dUSDC
        lock_payout(&mut vault, 100_000_000);
        assert!(vault.locked_payouts == 100_000_000, 0);

        // Share price should reflect locked amount
        // available = 1000 - 100 = 900 dUSDC
        // share_price = 900 * 1_000_000 / 1000 = 900_000
        assert!(share_price(&vault) == 900_000, 0);

        // Release the locked amount
        release_payout(&mut vault, 100_000_000);
        assert!(vault.locked_payouts == 0, 0);

        // Share price back to 1.0
        assert!(share_price(&vault) == SHARE_PRICE_SCALE, 0);

        test_scenario::end(scenario);
    }

    #[test]
    fun test_accrued_yield() {
        let scenario = test_scenario::begin(@0x1);
        let ctx = test_scenario::ctx(scenario);

        let mut vault = Vault {
            id: new_uid(ctx),
            total_deposits: 1_000_000_000, // 1000 dUSDC
            total_shares: 1_000_000_000,
            locked_payouts: 0,
            accrued_yield: 0,
            bonus_cap_pct: 1000,
        };

        // Credit 50 dUSDC yield
        credit_rewards(&mut vault, 50_000_000);

        // Share price should increase
        // available = 1000 + 50 = 1050
        // share_price = 1050 * 1_000_000 / 1000 = 1_050_000
        assert!(share_price(&vault) == 1_050_000, 0);

        test_scenario::end(scenario);
    }
}