/// Slip Pricer — Joint probability, house margin, and bonus multiplier
module parlay_vault::slip_pricer {

    use sui::object::{UID, new_uid};
    use std::vector;

    // =============================================================================
    // ERROR CODES
    // =============================================================================

    const E_INVALID_LEGS: u64 = 1;
    const E_TOO_FEW_LEGS: u64 = 2;
    const E_TOO_MANY_LEGS: u64 = 3;
    const E_INVALID_MARKET: u64 = 4;

    // Fixed-point decimals (4 decimals for odds)
    const ODDS_SCALE: u64 = 10_000;

    // House margin: 3% (300 basis points)
    const HOUSE_MARGIN_BPS: u64 = 300;

    // Bonus multipliers (fixed-point 4 decimals)
    const BONUS_2_LEGS: u64 = 10_000;   // 1.00x
    const BONUS_3_LEGS: u64 = 10_500;   // 1.05x
    const BONUS_4_LEGS: u64 = 11_000;   // 1.10x

    // =============================================================================
    // DATA STRUCTURES
    // =============================================================================

    /// A leg in a parlay slip
    struct MarketLeg has copy, drop, store {
        market_id: u64,           // DeepBook Predict market ID
        position: u8,             // 0 = first outcome, 1 = second, etc.
        odds: u64,                // Current odds for this position (fixed-point 4 decimals)
    }

    /// A slip placed by a user
    struct Slip has key, store {
        id: UID,
        owner: address,
        legs: vector<MarketLeg>,
        stake: u64,               // dUSDC staked
        combined_odds: u64,       // computed combined odds (fixed-point)
        bonus_multiplier: u64,    // multiplier for multi-leg
        potential_payout: u64,    // stake x odds x bonus
        locked_amount: u64,       // vault locks (payout - stake)
    }

    /// Slip status
    struct SlipStatus has copy, drop, store {
        status: u8, // 0=Open, 1=Won, 2=Lost, 3=Settled
    }

    // =============================================================================
    // ODDS FUNCTIONS
    // =============================================================================

    /// Get current odds for a single market
    /// In production, this would query DeepBook Predict for current odds
    /// @param market_id: DeepBook Predict market ID
    /// @param position: outcome position (0, 1, 2...)
    /// @return: odds as u64 (e.g., 15000 = 1.50x, fixed-point 4 decimals)
    public fun get_market_odds(market_id: u64, position: u8): u64 {
        // Placeholder: In production, query DeepBook Predict oracle
        // For testing, return some default odds based on market_id
        // This simulates odds ranging from 1.2x to 3.0x
        let base = 12000 + ((market_id % 18) * 1000); // 1.2x to 3.0x
        if (position == 0) base else base - 2000 // First position slightly favored
    }

    /// Compute joint probability for independent markets
    /// Uses state_mask intersection logic from Rust codebase
    /// For independent markets, joint probability = product of individual probabilities
    /// @param legs: vector of MarketLeg
    /// @return: joint probability as u64 (e.g., 2500 = 0.25 = 25%, fixed-point 4 decimals)
    public fun compute_joint_probability(legs: &vector<MarketLeg>): u64 {
        let num_legs = vector.length(legs);
        assert!(num_legs >= 2, E_TOO_FEW_LEGS);
        assert!(num_legs <= 4, E_TOO_MANY_LEGS);

        // Joint probability = product of individual probabilities
        // odds = 1 / probability, so probability = 1 / odds
        // We work with probabilities directly
        let result: u64 = ODDS_SCALE; // Start at 1.0 (100%)

        let i = 0;
        while (i < num_legs) {
            let leg = vector.borrow(legs, i);
            let probability = odds_to_probability(leg.odds);
            // Multiply probabilities (both in 4-decimal fixed point)
            result = (result * probability) / ODDS_SCALE;
            i = i + 1;
        };

        result
    }

    /// Convert odds to probability
    /// odds = 1 / probability, so probability = ODDS_SCALE / odds
    fun odds_to_probability(odds: u64): u64 {
        if (odds == 0) return 0;
        (ODDS_SCALE * ODDS_SCALE) / odds
    }

    /// Apply house margin to combined odds (3%)
    /// margin reduces the odds the user receives
    /// @param combined_odds: raw joint probability odds
    /// @return: adjusted odds after 3% margin
    public fun apply_house_margin(combined_odds: u64): u64 {
        // 3% margin means user gets 97% of fair odds
        // adjusted = combined_odds * (10000 - 300) / 10000
        // = combined_odds * 9700 / 10000
        (combined_odds * (ODDS_SCALE - HOUSE_MARGIN_BPS)) / ODDS_SCALE
    }

    /// Compute bonus multiplier for multi-leg parlays
    /// @param num_legs: 2, 3, or 4
    /// @return: multiplier (e.g., 10500 = 1.05x, fixed-point 4 decimals)
    public fun compute_bonus_multiplier(num_legs: u64): u64 {
        if (num_legs == 2) {
            BONUS_2_LEGS // 1.00x
        } else if (num_legs == 3) {
            BONUS_3_LEGS // 1.05x
        } else if (num_legs == 4) {
            BONUS_4_LEGS // 1.10x
        } else {
            BONUS_2_LEGS // Default to 2-leg bonus
        }
    }

    /// Get combined odds for a slip
    /// @param legs: vector of market legs
    /// @return: final combined odds with margin + bonus applied
    public fun get_combined_odds(legs: &vector<MarketLeg>): u64 {
        let num_legs = vector.length(legs);
        assert!(num_legs >= 2, E_TOO_FEW_LEGS);
        assert!(num_legs <= 4, E_TOO_MANY_LEGS);

        // Step 1: Compute joint probability
        let joint_prob = compute_joint_probability(legs);

        // Step 2: Convert to odds (1 / probability)
        let fair_odds = probability_to_odds(joint_prob);

        // Step 3: Apply house margin (3%)
        let odds_after_margin = apply_house_margin(fair_odds);

        // Step 4: Apply bonus multiplier
        let bonus_mult = compute_bonus_multiplier(num_legs);
        let final_odds = (odds_after_margin * bonus_mult) / ODDS_SCALE;

        final_odds
    }

    /// Convert probability to odds
    /// probability = ODDS_SCALE / odds, so odds = ODDS_SCALE / probability
    fun probability_to_odds(probability: u64): u64 {
        if (probability == 0) return 0;
        (ODDS_SCALE * ODDS_SCALE) / probability
    }

    /// Calculate bonus (payout - stake)
    /// @param stake: user stake amount
    /// @param odds: combined odds
    /// @param bonus_mult: bonus multiplier
    /// @return: bonus amount
    public fun calculate_bonus(stake: u64, odds: u64, bonus_mult: u64): u64 {
        // payout = stake * odds / ODDS_SCALE
        let payout = (stake * odds) / ODDS_SCALE;
        // bonus = payout - stake
        if (payout > stake) {
            payout - stake
        } else {
            0
        }
    }

    /// Calculate potential payout
    /// @param stake: user stake amount
    /// @param odds: combined odds
    /// @param bonus_mult: bonus multiplier
    /// @return: potential payout
    public fun calculate_payout(stake: u64, odds: u64, bonus_mult: u64): u64 {
        (stake * odds * bonus_mult) / (ODDS_SCALE * ODDS_SCALE)
    }

    /// Get minimum and maximum number of legs
    public fun min_legs(): u64 { 2 }
    public fun max_legs(): u64 { 4 }

    /// Get house margin in basis points
    public fun house_margin_bps(): u64 { HOUSE_MARGIN_BPS }

    // =============================================================================
    // LEG CREATION HELPERS
    // =============================================================================

    /// Create a new market leg
    public fun create_leg(market_id: u64, position: u8, odds: u64): MarketLeg {
        MarketLeg {
            market_id,
            position,
            odds,
        }
    }

    /// Create a slip with calculated odds
    public fun create_slip(
        owner: address,
        legs: vector<MarketLeg>,
        stake: u64,
    ): Slip {
        let num_legs = vector.length(&legs);
        assert!(num_legs >= 2, E_TOO_FEW_LEGS);
        assert!(num_legs <= 4, E_TOO_MANY_LEGS);

        let combined_odds = get_combined_odds(&legs);
        let bonus_mult = compute_bonus_multiplier(num_legs);
        let payout = calculate_payout(stake, combined_odds, bonus_mult);
        let bonus = calculate_bonus(stake, combined_odds, bonus_mult);

        Slip {
            id: new_uid(),
            owner,
            legs,
            stake,
            combined_odds,
            bonus_multiplier: bonus_mult,
            potential_payout: payout,
            locked_amount: bonus,
        }
    }

    // =============================================================================
    // TESTS
    // =============================================================================

    #[test]
    fun test_odds_to_probability() {
        // 2.0x odds = 50% probability
        let odds = 20000u64;
        let prob = odds_to_probability(odds);
        assert!(prob == 5000, 0); // 0.50 in 4-decimal

        // 1.5x odds = 66.67% probability
        let odds = 15000u64;
        let prob = odds_to_probability(odds);
        assert!(prob == 6667, 1); // ~0.6667
    }

    #[test]
    fun test_joint_probability_two_legs() {
        // Two independent 50% events -> 25% joint probability
        let leg1 = MarketLeg { market_id: 1, position: 0, odds: 20000 }; // 2.0x = 50%
        let leg2 = MarketLeg { market_id: 2, position: 0, odds: 20000 }; // 2.0x = 50%

        let mut legs = vector::empty();
        vector::push_back(&mut legs, leg1);
        vector::push_back(&mut legs, leg2);

        let joint = compute_joint_probability(&legs);
        // 0.5 * 0.5 = 0.25 = 2500 in 4-decimal
        assert!(joint == 2500, 0);
    }

    #[test]
    fun test_joint_probability_three_legs() {
        // Three independent 50% events -> 12.5% joint probability
        let leg1 = MarketLeg { market_id: 1, position: 0, odds: 20000 };
        let leg2 = MarketLeg { market_id: 2, position: 0, odds: 20000 };
        let leg3 = MarketLeg { market_id: 3, position: 0, odds: 20000 };

        let mut legs = vector::empty();
        vector::push_back(&mut legs, leg1);
        vector::push_back(&mut legs, leg2);
        vector::push_back(&mut legs, leg3);

        let joint = compute_joint_probability(&legs);
        // 0.5 * 0.5 * 0.5 = 0.125 = 1250 in 4-decimal
        assert!(joint == 1250, 0);
    }

    #[test]
    fun test_house_margin() {
        // 2.0x fair odds -> 1.94x after 3% margin
        let fair_odds = 20000u64;
        let adjusted = apply_house_margin(fair_odds);
        // 20000 * 9700 / 10000 = 19400
        assert!(adjusted == 19400, 0);
    }

    #[test]
    fun test_bonus_multiplier() {
        assert!(compute_bonus_multiplier(2) == 10000, 0); // 1.00x
        assert!(compute_bonus_multiplier(3) == 10500, 1); // 1.05x
        assert!(compute_bonus_multiplier(4) == 11000, 2); // 1.10x
    }

    #[test]
    fun test_combined_odds_simple() {
        // Two 2.0x odds (50% each) -> 0.25 joint prob -> 4.0x fair odds
        let leg1 = MarketLeg { market_id: 1, position: 0, odds: 20000 };
        let leg2 = MarketLeg { market_id: 2, position: 0, odds: 20000 };

        let mut legs = vector::empty();
        vector::push_back(&mut legs, leg1);
        vector::push_back(&mut legs, leg2);

        let odds = get_combined_odds(&legs);
        // fair = 4.0x = 40000, after 3% margin = 38800, after 1.00x bonus = 38800
        assert!(odds == 38800, 0);
    }

    #[test]
    fun test_combined_odds_three_legs_with_bonus() {
        // Three 2.0x odds (50% each) -> 0.125 joint prob -> 8.0x fair odds
        let leg1 = MarketLeg { market_id: 1, position: 0, odds: 20000 };
        let leg2 = MarketLeg { market_id: 2, position: 0, odds: 20000 };
        let leg3 = MarketLeg { market_id: 3, position: 0, odds: 20000 };

        let mut legs = vector::empty();
        vector::push_back(&mut legs, leg1);
        vector::push_back(&mut legs, leg2);
        vector::push_back(&mut legs, leg3);

        let odds = get_combined_odds(&legs);
        // fair = 8.0x = 80000, after 3% margin = 77600, after 1.05x bonus = 81480
        // Rounded to nearest integer
        assert!(odds >= 81000 && odds <= 82000, 0);
    }

    #[test]
    fun test_calculate_payout_and_bonus() {
        let stake = 100_000_000u64; // 100 dUSDC
        let odds = 40000u64; // 4.0x
        let bonus_mult = 10000u64; // 1.00x

        let payout = calculate_payout(stake, odds, bonus_mult);
        // 100 * 4.0 = 400 dUSDC
        assert!(payout == 400_000_000, 0);

        let bonus = calculate_bonus(stake, odds, bonus_mult);
        // 400 - 100 = 300 dUSDC
        assert!(bonus == 300_000_000, 0);
    }

    #[test]
    fun test_calculate_payout_with_bonus_multiplier() {
        let stake = 100_000_000u64; // 100 dUSDC
        let odds = 80000u64; // 8.0x
        let bonus_mult = 10500u64; // 1.05x (3-leg bonus)

        let payout = calculate_payout(stake, odds, bonus_mult);
        // 100 * 8.0 * 1.05 = 840 dUSDC
        assert!(payout == 840_000_000, 0);

        let bonus = calculate_bonus(stake, odds, bonus_mult);
        // 840 - 100 = 740 dUSDC
        assert!(bonus == 740_000_000, 0);
    }
}