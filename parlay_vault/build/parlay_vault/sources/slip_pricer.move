/// Slip Pricer — Odds calculation for parlay bets
module parlay_vault::slip_pricer {

    const FLOAT_SCALING: u64 = 1_000_000_000;
    const HOUSE_MARGIN_FACTOR: u64 = 970_000_000;
    const MULT_2_LEG: u64 = 1_000_000_000;
    const MULT_3_LEG: u64 = 1_050_000_000;
    const MULT_4_LEG: u64 = 1_100_000_000;
    const MIN_LEGS: u64 = 2;
    const MAX_LEGS: u64 = 4;

    public struct MarketLeg has copy, drop, store {
        oracle_id: vector<u8>,
        expiry: u64,
        strike: u64,
        is_up: bool,
        ask_price: u64,
    }

    public fun new_market_leg(o: vector<u8>, e: u64, s: u64, u: bool, p: u64): MarketLeg {
        MarketLeg { oracle_id: o, expiry: e, strike: s, is_up: u, ask_price: p }
    }
    public fun min_legs(): u64 { MIN_LEGS }
    public fun max_legs(): u64 { MAX_LEGS }
    public fun float_scaling(): u64 { FLOAT_SCALING }
    public fun get_oracle_id(l: &MarketLeg): vector<u8> { l.oracle_id }
    public fun get_expiry(l: &MarketLeg): u64 { l.expiry }
    public fun get_strike(l: &MarketLeg): u64 { l.strike }
    public fun is_up(l: &MarketLeg): bool { l.is_up }
    public fun get_ask_price(l: &MarketLeg): u64 { l.ask_price }

    fun joint_prob(l: &vector<MarketLeg>): u64 {
        use std::vector;
        let n = vector::length(l);
        if (n == 0) return 0;
        let mut j = FLOAT_SCALING;
        let mut i = 0;
        while (i < n) {
            let leg = vector::borrow(l, i);
            j = (j * leg.ask_price) / FLOAT_SCALING;
            i = i + 1;
        };
        j
    }

    public fun get_combined_odds(l: &vector<MarketLeg>): u64 {
        use std::vector;
        let n = vector::length(l);
        if (n < MIN_LEGS || n > MAX_LEGS) return 0;
        let j = joint_prob(l);
        let adj = (j * HOUSE_MARGIN_FACTOR) / FLOAT_SCALING;
        if (adj == 0) return 0;
        FLOAT_SCALING / adj
    }

    public fun compute_bonus_multiplier(n: u64): u64 {
        if (n == 3) return MULT_3_LEG;
        if (n == 4) return MULT_4_LEG;
        MULT_2_LEG
    }

    public fun calculate_payout(stake: u64, odds: u64, mult: u64): u64 {
        (stake * odds * mult) / (FLOAT_SCALING * FLOAT_SCALING)
    }

    public fun calculate_bonus(stake: u64, odds: u64, mult: u64): u64 {
        let base = (stake * odds) / FLOAT_SCALING;
        let bonus = (stake * odds * mult) / (FLOAT_SCALING * FLOAT_SCALING);
        bonus - base
    }

    public fun preview_slip(l: &vector<MarketLeg>, stake: u64): (u64, u64, u64, u64) {
        use std::vector;
        let n = vector::length(l);
        if (n < MIN_LEGS || n > MAX_LEGS) return (0, 0, 0, 0);
        let odds = get_combined_odds(l);
        if (odds == 0) return (0, 0, 0, 0);
        let mult = compute_bonus_multiplier(n);
        let payout = calculate_payout(stake, odds, mult);
        let bonus = calculate_bonus(stake, odds, mult);
        (odds, mult, payout, bonus)
    }
}
