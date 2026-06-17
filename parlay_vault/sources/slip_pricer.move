/// Slip Pricer - odds calculation for parlay bets
module parlay_vault::slip_pricer {

    const FLOAT_SCALING: u64 = 1_000_000_000;
    const HOUSE_MARGIN_FACTOR: u64 = 970_000_000;
    const MULT_2_LEG: u64 = 1_030_000_000;
    const MULT_3_LEG: u64 = 1_080_000_000;
    const MULT_4_LEG: u64 = 1_150_000_000;
    const MULT_5_LEG: u64 = 1_230_000_000;
    const MULT_6_LEG: u64 = 1_320_000_000;
    const MULT_7_LEG: u64 = 1_420_000_000;
    const MULT_8_LEG: u64 = 1_530_000_000;
    const MULT_9_LEG: u64 = 1_650_000_000;
    const MULT_10_LEG: u64 = 1_800_000_000;
    const MIN_LEGS: u64 = 2;
    const MAX_LEGS: u64 = 10;

    public struct MarketLeg has copy, drop, store {
        oracle_id: vector<u8>,
        expiry: u64,
        strike: u64,
        is_up: bool,
        ask_price: u64,
        quantity: u64,
    }

    public fun new_market_leg(
        oracle_id: vector<u8>,
        expiry: u64,
        strike: u64,
        is_up: bool,
        ask_price: u64,
        quantity: u64,
    ): MarketLeg {
        MarketLeg {
            oracle_id,
            expiry,
            strike,
            is_up,
            ask_price,
            quantity,
        }
    }

    public fun min_legs(): u64 { MIN_LEGS }
    public fun max_legs(): u64 { MAX_LEGS }
    public fun float_scaling(): u64 { FLOAT_SCALING }
    public fun get_oracle_id(leg: &MarketLeg): vector<u8> { leg.oracle_id }
    public fun get_expiry(leg: &MarketLeg): u64 { leg.expiry }
    public fun get_strike(leg: &MarketLeg): u64 { leg.strike }
    public fun is_up(leg: &MarketLeg): bool { leg.is_up }
    public fun get_ask_price(leg: &MarketLeg): u64 { leg.ask_price }
    public fun get_quantity(leg: &MarketLeg): u64 { leg.quantity }

    fun joint_prob(legs: &vector<MarketLeg>): u64 {
        use std::vector;
        let leg_count = vector::length(legs);
        if (leg_count == 0) return 0;

        let mut joint_probability = FLOAT_SCALING;
        let mut i = 0;
        while (i < leg_count) {
            let leg = vector::borrow(legs, i);
            joint_probability = mul_div_u64(joint_probability, leg.ask_price, FLOAT_SCALING);
            i = i + 1;
        };
        joint_probability
    }

    public fun get_combined_odds(legs: &vector<MarketLeg>): u64 {
        use std::vector;
        let leg_count = vector::length(legs);
        if (leg_count < MIN_LEGS || leg_count > MAX_LEGS) return 0;

        let joint_probability = joint_prob(legs);
        let adjusted_probability = mul_div_u64(joint_probability, HOUSE_MARGIN_FACTOR, FLOAT_SCALING);
        if (adjusted_probability == 0) return 0;
        scale_div_u64(FLOAT_SCALING, adjusted_probability)
    }

    public fun compute_bonus_multiplier(leg_count: u64): u64 {
        if (leg_count == 10) return MULT_10_LEG;
        if (leg_count == 9) return MULT_9_LEG;
        if (leg_count == 8) return MULT_8_LEG;
        if (leg_count == 7) return MULT_7_LEG;
        if (leg_count == 6) return MULT_6_LEG;
        if (leg_count == 5) return MULT_5_LEG;
        if (leg_count == 4) return MULT_4_LEG;
        if (leg_count == 3) return MULT_3_LEG;
        MULT_2_LEG
    }

    public fun calculate_payout(stake: u64, odds: u64, mult: u64): u64 {
        let intermediate = mul_div_u64(stake, odds, FLOAT_SCALING);
        mul_div_u64(intermediate, mult, FLOAT_SCALING)
    }

    public fun calculate_bonus(stake: u64, odds: u64, mult: u64): u64 {
        let base = mul_div_u64(stake, odds, FLOAT_SCALING);
        let payout = mul_div_u64(base, mult, FLOAT_SCALING);
        if (payout > base) payout - base else 0
    }

    public fun preview_slip(legs: &vector<MarketLeg>, stake: u64): (u64, u64, u64, u64) {
        use std::vector;
        let leg_count = vector::length(legs);
        if (leg_count < MIN_LEGS || leg_count > MAX_LEGS) return (0, 0, 0, 0);

        let odds = get_combined_odds(legs);
        if (odds == 0) return (0, 0, 0, 0);

        let mult = compute_bonus_multiplier(leg_count);
        let payout = calculate_payout(stake, odds, mult);
        let bonus = calculate_bonus(stake, odds, mult);
        (odds, mult, payout, bonus)
    }

    fun mul_div_u64(a: u64, b: u64, scale: u64): u64 {
        let wide = ((a as u128) * (b as u128)) / (scale as u128);
        wide as u64
    }

    fun scale_div_u64(numerator: u64, denominator: u64): u64 {
        let wide = ((numerator as u128) * (FLOAT_SCALING as u128)) / (denominator as u128);
        wide as u64
    }

    #[test]
    fun preview_slip_keeps_odds_scaled() {
        let legs = vector[
            new_market_leg(vector[1], 1, 100_000_000, true, 550_000_000, 1_000_000),
            new_market_leg(vector[2], 1, 110_000_000, false, 450_000_000, 1_000_000),
        ];

        let (odds, mult, payout, bonus) = preview_slip(&legs, 10_000_000);
        assert!(odds == 4_165_364_990, 0);
        assert!(mult == MULT_2_LEG, 1);
        assert!(payout == 42_903_258, 2);
        assert!(bonus == 1_249_609, 3);
    }

    #[test]
    fun supports_ten_leg_slips() {
        let legs = vector[
            new_market_leg(vector[1], 1, 100_000_000, true, 550_000_000, 1_000_000),
            new_market_leg(vector[2], 1, 110_000_000, false, 450_000_000, 1_000_000),
            new_market_leg(vector[3], 1, 120_000_000, true, 600_000_000, 1_000_000),
            new_market_leg(vector[4], 1, 130_000_000, false, 480_000_000, 1_000_000),
            new_market_leg(vector[5], 1, 140_000_000, true, 530_000_000, 1_000_000),
            new_market_leg(vector[6], 1, 150_000_000, false, 470_000_000, 1_000_000),
            new_market_leg(vector[7], 1, 160_000_000, true, 520_000_000, 1_000_000),
            new_market_leg(vector[8], 1, 170_000_000, false, 490_000_000, 1_000_000),
            new_market_leg(vector[9], 1, 180_000_000, true, 510_000_000, 1_000_000),
            new_market_leg(vector[10], 1, 190_000_000, false, 460_000_000, 1_000_000),
        ];

        let (_odds, mult, payout, bonus) = preview_slip(&legs, 10_000_000);
        assert!(mult == MULT_10_LEG, 0);
        assert!(payout > 0, 1);
        assert!(bonus > 0, 2);
    }
}
