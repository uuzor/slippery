/// Slip Pricer — Joint probability calculation for parlay bets using DeepBook Predict
/// 
/// Uses DeepBook's FLOAT_SCALING (1e9) for probability calculations to match
/// the oracle pricing model. The house margin and bonuses are applied on top.
/// 
/// NOTE: For actual pricing, use predict::get_trade_amounts() to get real
/// binary position prices (ask/bid) from DeepBook. This module provides
/// helper calculations for parlay combinations.
module parlay_vault::slip_pricer {

    use std::vector::{Self, length, borrow};

    // DeepBook FLOAT_SCALING (must match deepbook_predict::constants)
    const FLOAT_SCALING: u64 = 1_000_000_000;

    /// 3% house margin (applied to joint probability)
    /// Using basis points: 300 bps = 3% = 0.03
    /// In FLOAT_SCALING terms: 0.03 * 1e9 = 30_000_000
    const HOUSE_MARGIN_BPS: u64 = 300;
    
    /// House margin in FLOAT_SCALING terms (3% = 0.97 factor)
    /// Calculated as: (10000 - 300) / 10000 = 0.97
    /// In FLOAT_SCALING: 970_000_000
    const HOUSE_MARGIN_FACTOR: u64 = 970_000_000;

    /// Bonus multiplier for 2-leg parlays (1.0x, no bonus)
    const MULTIPLIER_2_LEG: u64 = 1_000_000_000; // 1.0x in FLOAT_SCALING

    /// Bonus multiplier for 3-leg parlays (1.05x)
    const MULTIPLIER_3_LEG: u64 = 1_050_000_000; // 1.05x in FLOAT_SCALING

    /// Bonus multiplier for 4-leg parlays (1.10x)
    const MULTIPLIER_4_LEG: u64 = 1_100_000_000; // 1.10x in FLOAT_SCALING

    /// Minimum legs required for a parlay
    const MIN_LEGS: u64 = 2;

    /// Maximum legs allowed in a parlay
    const MAX_LEGS: u64 = 4;

    /// One leg of a parlay market
    /// The `ask_price` field should contain the DeepBook binary position price
    /// (returned by predict::get_trade_amounts), NOT the raw strike level.
    /// 
    /// DeepBook prices are in FLOAT_SCALING (1e9) representing probabilities:
    /// - 500_000_000 = 50% probability (even odds)
    /// - 600_000_000 = 60% probability
    /// - etc.
    public struct MarketLeg has copy, drop, store {
        oracle_id: vector<u8>,   // ID of the OracleSVI (as bytes)
        expiry: u64,             // Expiry timestamp in milliseconds
        strike: u64,             // Strike price (in FLOAT_SCALING)
        is_up: bool,             // true = UP position, false = DOWN position
        ask_price: u64,          // DeepBook ask price for this leg (probability in 1e9)
    }

    /// Get minimum number of legs
    public fun min_legs(): u64 { MIN_LEGS }

    /// Get maximum number of legs
    public fun max_legs(): u64 { MAX_LEGS }

    /// Get the float scaling constant (matches DeepBook)
    public fun float_scaling(): u64 { FLOAT_SCALING }

    /// Get probability scale for odds conversion
    public fun probability_scale(): u64 { FLOAT_SCALING }

    /// Create a MarketLeg from individual components
    public fun new_market_leg(
        oracle_id: vector<u8>,
        expiry: u64,
        strike: u64,
        is_up: bool,
        ask_price: u64
    ): MarketLeg {
        MarketLeg {
            oracle_id,
            expiry,
            strike,
            is_up,
            ask_price,
        }
    }

    /// Get oracle ID from a leg
    public fun get_oracle_id(leg: &MarketLeg): vector<u8> {
        leg.oracle_id
    }

    /// Get expiry from a leg
    public fun get_expiry(leg: &MarketLeg): u64 {
        leg.expiry
    }

    /// Get strike from a leg
    public fun get_strike(leg: &MarketLeg): u64 {
        leg.strike
    }

    /// Check if leg is UP
    public fun is_up(leg: &MarketLeg): bool {
        leg.is_up
    }

    /// Get ask price from a leg (DeepBook binary position price)
    public fun get_ask_price(leg: &MarketLeg): u64 {
        leg.ask_price
    }

    /// Convert DeepBook price (FLOAT_SCALING) to probability
    /// DeepBook returns prices directly as probabilities (0 to 1e9)
    public fun price_to_probability(price: u64): u64 {
        price
    }

    /// Convert probability to odds representation
    /// Returns odds as FLOAT_SCALING (e.g., 2.0x = 2_000_000_000)
    public fun probability_to_odds(prob: u64): u64 {
        if (prob == 0) return 0;
        FLOAT_SCALING / prob
    }

    /// Calculate joint probability of multiple independent events
    /// 
    /// IMPORTANT: This uses the ask_price field which should be the actual
    /// DeepBook binary position price (probability), NOT the raw strike level.
    /// 
    /// Probabilities are in FLOAT_SCALING (1e9)
    public fun compute_joint_probability(legs: &vector<MarketLeg>): u64 {
        let num_legs = length(legs);
        if (num_legs == 0) return 0;

        // For parlays, we multiply probabilities
        // Each leg ask_price represents probability of winning
        let mut joint_prob = FLOAT_SCALING;
        let mut i = 0;
        while (i < num_legs) {
            let leg = borrow(legs, i);
            // joint_prob = joint_prob * ask_price / FLOAT_SCALING
            joint_prob = (joint_prob * leg.ask_price) / FLOAT_SCALING;
            i = i + 1;
        };
        joint_prob
    }

    /// Apply house margin to joint probability
    /// 
    /// FIXED: Now uses the correct basis points calculation.
    /// The margin_factor is 970_000_000 (97% = 100% - 3% margin)
    /// This means: adjusted_prob = joint_prob * 0.97
    public fun apply_house_margin(joint_prob: u64): u64 {
        (joint_prob * HOUSE_MARGIN_FACTOR) / FLOAT_SCALING
    }

    /// Calculate combined odds from legs
    /// Returns odds in FLOAT_SCALING (e.g., 4.0x = 4_000_000_000)
    public fun get_combined_odds(legs: &vector<MarketLeg>): u64 {
        let num_legs = length(legs);
        if (num_legs < MIN_LEGS || num_legs > MAX_LEGS) return 0;
        let joint_prob = compute_joint_probability(legs);
        let adjusted_prob = apply_house_margin(joint_prob);
        probability_to_odds(adjusted_prob)
    }

    /// Compute bonus multiplier based on number of legs
    /// Returns multiplier in FLOAT_SCALING
    public fun compute_bonus_multiplier(num_legs: u64): u64 {
        if (num_legs == 3) {
            MULTIPLIER_3_LEG
        } else if (num_legs == 4) {
            MULTIPLIER_4_LEG
        } else {
            MULTIPLIER_2_LEG
        }
    }

    /// Calculate payout for a winning parlay
    /// payout = stake * odds * bonus_mult / FLOAT_SCALING^2
    public fun calculate_payout(stake: u64, odds: u64, bonus_mult: u64): u64 {
        (stake * odds * bonus_mult) / (FLOAT_SCALING * FLOAT_SCALING)
    }

    /// Calculate bonus amount (extra payout from multiplier)
    public fun calculate_bonus(stake: u64, odds: u64, bonus_mult: u64): u64 {
        let base_payout = (stake * odds) / FLOAT_SCALING;
        let bonus_payout = (stake * odds * bonus_mult) / (FLOAT_SCALING * FLOAT_SCALING);
        bonus_payout - base_payout
    }
}
