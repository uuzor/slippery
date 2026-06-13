/// Parlay Vault — LP deposit/withdraw with pro-rata share tokens
module parlay_vault::parlay_vault {

    use sui::coin::{Coin, TreasuryCap, mint};
    use sui::object::{UID, new};
    use sui::sui::SUI;
    use sui::transfer;
    use sui::tx_context::TxContext;

    // =============================================================================
    // ERROR CODES
    // =============================================================================

    const E_INSUFFICIENT_SHARES: u64 = 1;
    const E_ZERO_SHARES: u64 = 2;
    const E_VAULT_EMPTY: u64 = 3;
    const E_INSUFFICIENT_BALANCE: u64 = 4;

    // Fixed-point decimals for share price (6 decimals)
    const SHARE_PRICE_SCALE: u64 = 1_000_000;

    // =============================================================================
    // DATA STRUCTURES
    // =============================================================================

    /// The Vault — shared object owned by the module
    /// Tracks total deposits, shares outstanding, and accrued yield
    public struct Vault has key, store {
        id: UID,
        total_deposits: u64,        // total dUSDC deposited by LPs
        total_shares: u64,          // total LP shares outstanding
        locked_payouts: u64,        // dUSDC locked for open slip payouts
        accrued_yield: u64,         // accumulated PLP yield + slip premiums
        bonus_cap_pct: u64,         // max bonus as % of deposits (e.g., 1000 = 10%)
    }

    /// LP Share Token — transferable object representing pro-rata vault ownership
    /// Note: Uses store but not key since it's held directly by users
    public struct ShareToken has store, drop {
        shares: u64,                // number of shares this token represents
    }

    /// One shared PredictManager for the vault (placeholder for DeepBook integration)
    public struct VaultManager has key, store {
        id: UID,
        manager_id: vector<u8>,     // DeepBook Predict PredictManager ID as bytes
    }

    // =============================================================================
    // INITIALIZATION
    // =============================================================================

    /// Initialize the vault with default parameters
    fun init(ctx: &mut TxContext) {
        let vault = Vault {
            id: new(ctx),
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
    public fun deposit(
        vault: &mut Vault,
        amount: u64,
        _ctx: &mut TxContext
    ): ShareToken {
        assert!(amount > 0, E_INSUFFICIENT_SHARES);

        let shares_to_mint = if (vault.total_shares == 0) {
            // First depositor: 1 share per 1 dUSDC
            amount
        } else {
            // Subsequent depositors: shares based on current share price
            let share_price = share_price(vault);
            (amount * SHARE_PRICE_SCALE) / share_price
        };

        // Update vault totals
        vault.total_deposits = vault.total_deposits + amount;
        vault.total_shares = vault.total_shares + shares_to_mint;

        // Mint share token to caller
        ShareToken {
            shares: shares_to_mint,
        }
    }

    /// LP withdraws dUSDC from vault
    /// @param cap: TreasuryCap for minting SUI
    /// @param shares: ShareToken to burn
    /// @return: SUI (pro-rata share of deposits + accrued value)
    public fun withdraw(
        cap: &mut TreasuryCap<SUI>,
        vault: &mut Vault,
        shares: ShareToken,
        ctx: &mut TxContext
    ): Coin<SUI> {
        let shares_burned = shares.shares;
        assert!(shares_burned > 0, E_ZERO_SHARES);
        assert!(vault.total_shares > 0, E_VAULT_EMPTY);

        // Calculate withdrawal amount
        let share_price = share_price(vault);
        let withdraw_amount = (shares_burned * share_price) / SHARE_PRICE_SCALE;

        // Update vault totals
        vault.total_deposits = vault.total_deposits - withdraw_amount;
        vault.total_shares = vault.total_shares - shares_burned;

        // Return SUI to caller
        mint(cap, withdraw_amount, ctx)
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
        assert!(amount <= available, E_INSUFFICIENT_BALANCE);
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
    }

    /// Redeem PLP yield and credit to accrued_yield
    /// Note: This is a placeholder — actual implementation requires DeepBook integration
    public fun claim_plp_yield(_vault: &mut Vault) {
        // TODO: Integrate with DeepBook predict::redeem_plp
    }

    /// Update bonus cap percentage (admin function)
    public fun set_bonus_cap(vault: &mut Vault, new_cap_pct: u64) {
        vault.bonus_cap_pct = new_cap_pct;
    }
}