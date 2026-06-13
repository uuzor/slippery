/// Slip Executor — Place parlay slips on DeepBook Predict
module parlay_vault::slip_executor {

    use std::vector::{Self, length, push_back};
    use sui::object::{UID, ID, new, delete};
    use sui::transfer;
    use sui::tx_context::TxContext;

    use parlay_vault::parlay_vault::{Vault, bonus_reserve, lock_payout, release_payout};
    use parlay_vault::slip_pricer::{
        MarketLeg, get_combined_odds, compute_bonus_multiplier, 
        calculate_payout, calculate_bonus, min_legs, max_legs
    };

    const DEEPBOOK_PREDICT_PACKAGE: address = @0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138;

    const E_TOO_FEW_LEGS: u64 = 1;
    const E_TOO_MANY_LEGS: u64 = 2;
    const E_BELOW_MIN_STAKE: u64 = 3;
    const E_INSUFFICIENT_BONUS_RESERVE: u64 = 4;
    const E_INVALID_STAKE: u64 = 5;
    const E_ZERO_ODDS: u64 = 6;

    const MIN_STAKE: u64 = 1_000_000;

    public struct SlipReceipt has key, store {
        id: UID,
        owner: address,
        legs: vector<MarketLeg>,
        predict_ids: vector<ID>,
        stake: u64,
        combined_odds: u64,
        bonus_multiplier: u64,
        potential_payout: u64,
        locked_amount: u64,
        placed_at: u64,
    }

    public struct OpenSlips has key {
        id: UID,
        slips: vector<ID>,
    }

    public fun place_slip(
        vault: &mut Vault,
        open_slips: &mut OpenSlips,
        legs: vector<MarketLeg>,
        stake: u64,
        ctx: &mut TxContext
    ): SlipReceipt {
        let num_legs = length(&legs);
        assert!(num_legs >= min_legs(), E_TOO_FEW_LEGS);
        assert!(num_legs <= max_legs(), E_TOO_MANY_LEGS);
        assert!(stake >= MIN_STAKE, E_BELOW_MIN_STAKE);
        assert!(stake > 0, E_INVALID_STAKE);

        let combined_odds = get_combined_odds(&legs);
        assert!(combined_odds > 0, E_ZERO_ODDS);

        let bonus_mult = compute_bonus_multiplier(num_legs);
        let payout = calculate_payout(stake, combined_odds, bonus_mult);
        let bonus = calculate_bonus(stake, combined_odds, bonus_mult);

        let max_bonus = bonus_reserve(vault);
        assert!(bonus <= max_bonus, E_INSUFFICIENT_BONUS_RESERVE);

        lock_payout(vault, bonus);

        let receipt_id = new(ctx);
        let receipt = SlipReceipt {
            id: receipt_id,
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

        push_back(&mut open_slips.slips, object::id(&receipt));
        receipt
    }

    public fun create_open_slips(ctx: &mut TxContext): OpenSlips {
        OpenSlips { id: new(ctx), slips: vector[] }
    }

    public fun settle_won_slip(
        vault: &mut Vault,
        receipt: SlipReceipt,
        _ctx: &mut TxContext
    ) {
        let SlipReceipt {
            id: receipt_id,
            owner: _,
            legs: _,
            predict_ids: _,
            stake: _,
            combined_odds: _,
            bonus_multiplier: _,
            potential_payout: _,
            locked_amount: locked,
            placed_at: _,
        } = receipt;

        release_payout(vault, locked);
        delete(receipt_id);
    }

    public fun settle_lost_slip(vault: &mut Vault, receipt: SlipReceipt) {
        let SlipReceipt {
            id: receipt_id,
            owner: _,
            legs: _,
            predict_ids: _,
            stake: _,
            combined_odds: _,
            bonus_multiplier: _,
            potential_payout: _,
            locked_amount: locked,
            placed_at: _,
        } = receipt;

        release_payout(vault, locked);
        delete(receipt_id);
    }

    public fun preview_slip(legs: &vector<MarketLeg>, stake: u64): (u64, u64, u64, u64) {
        let num_legs = length(legs);
        if (num_legs < min_legs() || num_legs > max_legs()) { return (0, 0, 0, 0) };
        let combined_odds = get_combined_odds(legs);
        let bonus_mult = compute_bonus_multiplier(num_legs);
        let payout = calculate_payout(stake, combined_odds, bonus_mult);
        let bonus = calculate_bonus(stake, combined_odds, bonus_mult);
        (combined_odds, bonus_mult, payout, bonus)
    }

    public fun deepbook_predict_package(): address { DEEPBOOK_PREDICT_PACKAGE }
    public fun get_open_slip_count(open_slips: &OpenSlips): u64 { length(&open_slips.slips) }
}
