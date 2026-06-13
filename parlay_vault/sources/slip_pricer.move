/// Slip Pricer — Joint probability calculation for parlay bets
module parlay_vault::slip_pricer {

    use std::vector::{Self, length, borrow};

    /// 3% house margin (applied to joint probability)
    const HOUSE_MARGIN_BPS: u64 = 300;

    /// Bonus multiplier for 2-leg parlays (1.0x, no bonus)
    const MULTIPLIER_2_LEG: u64 = 10_000;

    /// Bonus multiplier for 3-leg parlays (1.05x)
    const MULTIPLIER_3_LEG: u64 = 10_500;

    /// Bonus multiplier for 4-leg parlays (1.10x)
    const MULTIPLIER_4_LEG: u64 = 11_000;

    /// Minimum legs required for a parlay
    const MIN_LEGS: u64 = 2;

    /// Maximum legs allowed in a parlay
    const MAX_LEGS: u64 = 4;

    /// Odds scale (4 decimal places)
    const ODDS_SCALE: u64 = 10_000;

    /// Probability scale (9 decimal places, matches DeepBook)
    const PROB_SCALE: u64 = 1_000_000_000;

    /// One leg of a parlay market
    public struct MarketLeg has copy, drop, store {
        market_id: vector<u8>,
        is_up: bool,
        odds: u64,
        expiry: u64,
        strike: u64,
    }

    /// Get minimum number of legs
    public fun min_legs(): u64 { MIN_LEGS }

    /// Get maximum number of legs
    public fun max_legs(): u64 { MAX_LEGS }

    /// Convert odds to probability
    public fun odds_to_probability(odds: u64): u64 {
        if (odds == 0) return 0;
        PROB_SCALE / odds
    }

    /// Convert probability to odds
    public fun probability_to_odds(prob: u64): u64 {
        if (prob == 0) return 0;
        (PROB_SCALE * ODDS_SCALE) / prob
    }

    /// Calculate joint probability of multiple independent events
    public fun compute_joint_probability(legs: &vector<MarketLeg>): u64 {
        let num_legs = length(legs);
        if (num_legs == 0) return 0;

        let mut joint_prob = PROB_SCALE;
        let mut i = 0;
        while (i < num_legs) {
            let leg = borrow(legs, i);
            let leg_prob = odds_to_probability(leg.odds);
            joint_prob = (joint_prob * leg_prob) / PROB_SCALE;
            i = i + 1;
        };
        joint_prob
    }

    /// Apply house margin to joint probability
    public fun apply_house_margin(joint_prob: u64): u64 {
        let margin_factor = ODDS_SCALE - HOUSE_MARGIN_BPS;
        (joint_prob * margin_factor) / ODDS_SCALE
    }

    /// Calculate combined odds from legs
    public fun get_combined_odds(legs: &vector<MarketLeg>): u64 {
        let num_legs = length(legs);
        if (num_legs < MIN_LEGS || num_legs > MAX_LEGS) return 0;
        let joint_prob = compute_joint_probability(legs);
        let adjusted_prob = apply_house_margin(joint_prob);
        probability_to_odds(adjusted_prob)
    }

    /// Compute bonus multiplier based on number of legs
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
    public fun calculate_payout(stake: u64, odds: u64, bonus_mult: u64): u64 {
        (stake * odds * bonus_mult) / (ODDS_SCALE * ODDS_SCALE)
    }

    /// Calculate bonus amount
    public fun calculate_bonus(stake: u64, odds: u64, bonus_mult: u64): u64 {
        let base_payout = (stake * odds) / ODDS_SCALE;
        let bonus_payout = (stake * odds * bonus_mult) / (ODDS_SCALE * ODDS_SCALE);
        bonus_payout - base_payout
    }
}