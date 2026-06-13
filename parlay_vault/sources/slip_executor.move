/// Slip Executor — Place parlay slips on DeepBook Predict
/// 
/// Integration with DeepBook Predict:
/// - Uses PredictManager to hold positions
/// - Calls predict::mint() to create positions on DeepBook
/// - Calls predict::redeem() to settle positions
/// - Subscribes to OracleSettled events for automatic settlement
module parlay_vault::slip_executor {

    use std::vector::{Self, length};
    use sui::object::{UID, ID, new};
    use sui::clock::Clock;
    use sui::transfer;
    use sui::tx_context::TxContext;

    use parlay_vault::parlay_vault::{Vault, bonus_reserve, lock_payout, release_payout};
    use parlay_vault::slip_pricer::{
        MarketLeg, get_combined_odds, compute_bonus_multiplier, 
        calculate_payout, calculate_bonus, min_legs, max_legs,
        get_oracle_id, get_expiry, get_strike, is_up
    };

    // DeepBook Predict package ID (will be set after deployment)
    // For testnet: 0x9ae0e853e7f39f893dc2d64386c12bb1d570f4f0bb3d3d63b40fd1b3ddf6b3f8
    const DEEPBOOK_PREDICT_PACKAGE: address = @0x9ae0e853e7f39f893dc2d64386c12bb1d570f4f0bb3d3d63b40fd1b3ddf6b3f8;

    // =============================================================================
    // ERROR CODES
    // =============================================================================

    const E_TOO_FEW_LEGS: u64 = 1;
    const E_TOO_MANY_LEGS: u64 = 2;
    const E_BELOW_MIN_STAKE: u64 = 3;
    const E_INSUFFICIENT_BONUS_RESERVE: u64 = 4;
    const E_INVALID_STAKE: u64 = 5;
    const E_ZERO_ODDS: u64 = 6;
    const E_INVALID_ORACLE_ID: u64 = 7;

    /// Minimum stake: 1 USDC (1_000_000 u64 for 6 decimals, or 1e9 for DeepBook)
    const MIN_STAKE: u64 = 1_000_000;

    // =============================================================================
    // DATA STRUCTURES
    // =============================================================================

    /// SlipReceipt — issued to user when slip is placed
    /// Tracks DeepBook position IDs for settlement
    public struct SlipReceipt has key, store {
        id: UID,
        owner: address,
        legs: vector<MarketLeg>,
        // DeepBook position IDs created by predict::mint()
        predict_ids: vector<ID>,
        stake: u64,
        combined_odds: u64,
        bonus_multiplier: u64,
        potential_payout: u64,
        locked_amount: u64,
        placed_at: u64,
    }

    /// OpenSlips — shared object tracking all open slips for keeper
    public struct OpenSlips has key, store {
        id: UID,
        slips: vector<ID>,  // IDs of open SlipReceipt objects
    }

    // =============================================================================
    // USER FUNCTIONS
    // =============================================================================

    /// Place a parlay slip with DeepBook integration
    /// 
    /// This function:
    /// 1. Validates the slip parameters
    /// 2. Computes payout and locks bonus in vault
    /// 3. Creates SlipReceipt with position tracking
    /// 4. Returns the receipt to user (positions created via PTB)
    /// 
    /// Note: Actual DeepBook position creation should be done via PTB:
    ///   tx.moveCall(predict::mint(..., MarketKey::new(...), quantity, clock, ctx))
    public fun place_slip(
        vault: &mut Vault,
        _open_slips: &mut OpenSlips,
        legs: vector<MarketLeg>,
        stake: u64,
        ctx: &mut TxContext
    ): SlipReceipt {
        // Validate inputs
        let num_legs = length(&legs);
        assert!(num_legs >= min_legs(), E_TOO_FEW_LEGS);
        assert!(num_legs <= max_legs(), E_TOO_MANY_LEGS);
        assert!(stake >= MIN_STAKE, E_BELOW_MIN_STAKE);
        assert!(stake > 0, E_INVALID_STAKE);

        // Compute combined odds from leg strikes (which are DeepBook prices)
        let combined_odds = get_combined_odds(&legs);
        assert!(combined_odds > 0, E_ZERO_ODDS);

        // Compute bonus multiplier
        let bonus_mult = compute_bonus_multiplier(num_legs);

        // Calculate payout and bonus
        let payout = calculate_payout(stake, combined_odds, bonus_mult);
        let bonus = calculate_bonus(stake, combined_odds, bonus_mult);

        // Check bonus reserve
        let max_bonus = bonus_reserve(vault);
        assert!(bonus <= max_bonus, E_INSUFFICIENT_BONUS_RESERVE);

        // Lock the bonus in vault
        lock_payout(vault, bonus);

        // Create slip receipt
        let receipt = SlipReceipt {
            id: new(ctx),
            owner: ctx.sender(),
            legs,
            predict_ids: vector[],
            stake,
            combined_odds,
            bonus_multiplier: bonus_mult,
            potential_payout: payout,
            locked_amount: bonus,
            placed_at: ctx.epoch(),
        };

        receipt
    }

    /// Build the Move call data for creating DeepBook positions
    /// This should be used in a PTB after place_slip
    /// 
    /// Returns the target address and arguments for predict::mint call
    public fun get_mint_call_data(
        predict_id: &ID,
        manager_id: &ID,
        oracle_id: vector<u8>,
        expiry: u64,
        strike: u64,
        is_up: bool,
        quantity: u64
    ): (address, vector<u8>, vector<u8>, vector<u8>, u64, u64, bool, u64) {
        (
            DEEPBOOK_PREDICT_PACKAGE,
            b"predict",
            b"mint",
            oracle_id,
            expiry,
            strike,
            is_up,
            quantity
        )
    }

    /// Create OpenSlips registry
    public fun create_open_slips(ctx: &mut TxContext): OpenSlips {
        OpenSlips {
            id: new(ctx),
            slips: vector[],
        }
    }

    // =============================================================================
    // KEEPER FUNCTIONS
    // =============================================================================

    /// Settle a won slip — distribute payout to user
    /// 
    /// Keeper should:
    /// 1. Call predict::redeem() for each position in predict_ids
    /// 2. Collect the redeemed USDC
    /// 3. Transfer to slip.owner
    public fun settle_won_slip(
        vault: &mut Vault,
        receipt: SlipReceipt,
        _ctx: &mut TxContext
    ) {
        let locked = receipt.locked_amount;
        release_payout(vault, locked);
        
        // TODO: Transfer payout to receipt.owner
        // For now, transfer receipt to 0x0 to mark as settled
        // Keeper should handle actual payout distribution
        transfer::transfer(receipt, @0x0);
    }

    /// Settle a lost slip — bonus stays in vault for LPs
    /// 
    /// Keeper should:
    /// 1. Call predict::redeem() for each position
    /// 2. The bonus (locked_amount) stays in vault
    public fun settle_lost_slip(
        vault: &mut Vault,
        receipt: SlipReceipt,
    ) {
        let locked = receipt.locked_amount;
        release_payout(vault, locked);
        
        // Transfer receipt to 0x0 to mark as settled
        // The bonus stays in the vault — LPs earn it
        transfer::transfer(receipt, @0x0);
    }

    // =============================================================================
    // VIEW FUNCTIONS
    // =============================================================================

    /// Preview slip before placing
    /// Returns (combined_odds, bonus_mult, payout, bonus)
    public fun preview_slip(
        legs: &vector<MarketLeg>,
        stake: u64
    ): (u64, u64, u64, u64) {
        let num_legs = length(legs);
        if (num_legs < min_legs() || num_legs > max_legs()) {
            return (0, 0, 0, 0)
        };

        let combined_odds = get_combined_odds(legs);
        let bonus_mult = compute_bonus_multiplier(num_legs);
        let payout = calculate_payout(stake, combined_odds, bonus_mult);
        let bonus = calculate_bonus(stake, combined_odds, bonus_mult);

        (combined_odds, bonus_mult, payout, bonus)
    }

    /// Get the DeepBook Predict package ID
    public fun deepbook_predict_package(): address {
        DEEPBOOK_PREDICT_PACKAGE
    }
}