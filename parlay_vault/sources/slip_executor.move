/// Slip Executor - user-facing slip requests and active-slip indexing
module parlay_vault::slip_executor {

    use std::bcs;
    use std::vector;
    use sui::bcs::{Self as sui_bcs, BCS};
    use sui::coin::Coin;
    use sui::object::{Self as object, ID, UID};
    use sui::table::{Self as table, Table};
    use sui::transfer;
    use sui::tx_context::TxContext;

    use parlay_vault::parlay_vault::{AdminCap, Vault, available_bonus_capacity};
    use parlay_vault::slip_pricer::{
        MarketLeg,
        calculate_bonus,
        calculate_payout,
        compute_bonus_multiplier,
        get_combined_odds,
        get_quantity,
        max_legs,
        min_legs,
        new_market_leg,
    };

    const DEEPBOOK_PREDICT_PKG: address = @0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138;

    const E_TOO_FEW_LEGS: u64 = 1;
    const E_TOO_MANY_LEGS: u64 = 2;
    const E_BELOW_MIN_STAKE: u64 = 3;
    const E_INSUFFICIENT_BONUS_RESERVE: u64 = 4;
    const E_INVALID_STAKE: u64 = 5;
    const E_ZERO_ODDS: u64 = 6;
    const E_SLIP_NOT_FOUND: u64 = 7;
    const MIN_STAKE: u64 = 1_000_000;

    public struct SlipReceipt has key, store {
        id: UID,
        owner: address,
        legs: vector<MarketLeg>,
        stake: u64,
        combined_odds: u64,
        bonus_multiplier: u64,
        potential_payout: u64,
        bonus_amount: u64,
        placed_at: u64,
    }

    public struct OpenSlips has key {
        id: UID,
        slip_ids: vector<ID>,
        slips: Table<ID, OpenSlipData>,
    }

    public struct OpenSlipData has store, copy, drop {
        owner: address,
        legs_data: vector<u8>,
        quantities_data: vector<u8>,
        stake: u64,
        bonus_amount: u64,
        entry_epoch: u64,
    }

    public fun create_open_slips(ctx: &mut TxContext): OpenSlips {
        OpenSlips {
            id: object::new(ctx),
            slip_ids: vector[],
            slips: table::new(ctx),
        }
    }

    public fun create_shared_open_slips(ctx: &mut TxContext) {
        transfer::share_object(create_open_slips(ctx));
    }

    public fun place_slip<Q>(
        vault: &mut Vault<Q>,
        stake_coin: Coin<Q>,
        legs: vector<MarketLeg>,
        ctx: &mut TxContext,
    ): SlipReceipt {
        let stake = stake_coin.value();
        let num_legs = vector::length(&legs);
        assert!(num_legs >= min_legs(), E_TOO_FEW_LEGS);
        assert!(num_legs <= max_legs(), E_TOO_MANY_LEGS);
        assert!(stake >= MIN_STAKE, E_BELOW_MIN_STAKE);
        assert!(stake > 0, E_INVALID_STAKE);

        let combined_odds = get_combined_odds(&legs);
        assert!(combined_odds > 0, E_ZERO_ODDS);

        let bonus_mult = compute_bonus_multiplier(num_legs);
        let payout = calculate_payout(stake, combined_odds, bonus_mult);
        let bonus = calculate_bonus(stake, combined_odds, bonus_mult);
        let remaining_bonus_capacity = available_bonus_capacity(vault);
        assert!(bonus <= remaining_bonus_capacity, E_INSUFFICIENT_BONUS_RESERVE);

        let stored_legs = copy_legs(&legs);
        let receipt = SlipReceipt {
            id: object::new(ctx),
            owner: ctx.sender(),
            legs,
            stake,
            combined_odds,
            bonus_multiplier: bonus_mult,
            potential_payout: payout,
            bonus_amount: bonus,
            placed_at: ctx.epoch(),
        };

        let slip_id = object::id(&receipt);
        parlay_vault::parlay_vault::request_slip(
            vault,
            slip_id,
            stake_coin,
            bcs::to_bytes(&stored_legs),
            bcs::to_bytes(&leg_quantities(&stored_legs)),
            bonus,
            ctx,
        );
        receipt
    }

    public fun place_slip_bcs<Q>(
        vault: &mut Vault<Q>,
        stake_coin: Coin<Q>,
        legs_data: vector<u8>,
        ctx: &mut TxContext,
    ): SlipReceipt {
        let legs = decode_market_legs(legs_data);
        place_slip(vault, stake_coin, legs, ctx)
    }

    public fun register_active_slip<Q>(
        vault: &Vault<Q>,
        open_slips: &mut OpenSlips,
        slip_id: ID,
        _: &AdminCap,
    ) {
        if (open_slips.slips.contains(slip_id)) {
            return
        };

        let (owner, legs_data, quantities_data, stake, bonus_amount, entry_epoch) =
            parlay_vault::parlay_vault::get_active_slip(vault, slip_id);
        vector::push_back(&mut open_slips.slip_ids, slip_id);
        open_slips.slips.add(slip_id, OpenSlipData {
            owner,
            legs_data,
            quantities_data,
            stake,
            bonus_amount,
            entry_epoch,
        });
    }

    public fun settle_all_win<Q>(
        vault: &mut Vault<Q>,
        open_slips: &mut OpenSlips,
        slip_id: ID,
        redeemed_coin: Coin<Q>,
        admin_cap: &AdminCap,
        ctx: &mut TxContext,
    ) {
        assert!(open_slips.slips.contains(slip_id), E_SLIP_NOT_FOUND);
        remove_open_slip(open_slips, slip_id);
        parlay_vault::parlay_vault::settle_all_win(vault, slip_id, redeemed_coin, admin_cap, ctx);
    }

    public fun settle_not_all_win<Q>(
        vault: &mut Vault<Q>,
        open_slips: &mut OpenSlips,
        slip_id: ID,
        redeemed_coin: Coin<Q>,
        admin_cap: &AdminCap,
    ) {
        assert!(open_slips.slips.contains(slip_id), E_SLIP_NOT_FOUND);
        remove_open_slip(open_slips, slip_id);
        parlay_vault::parlay_vault::settle_not_all_win(vault, slip_id, redeemed_coin, admin_cap);
    }

    public fun preview_slip(legs: &vector<MarketLeg>, stake: u64): (u64, u64, u64, u64) {
        let num_legs = vector::length(legs);
        if (num_legs < min_legs() || num_legs > max_legs()) {
            return (0, 0, 0, 0)
        };

        let odds = get_combined_odds(legs);
        if (odds == 0) {
            return (0, 0, 0, 0)
        };

        let mult = compute_bonus_multiplier(num_legs);
        let payout = calculate_payout(stake, odds, mult);
        let bonus = calculate_bonus(stake, odds, mult);
        (odds, mult, payout, bonus)
    }

    public fun get_open_slip_count(open_slips: &OpenSlips): u64 {
        vector::length(&open_slips.slip_ids)
    }

    public fun get_open_slip(
        open_slips: &OpenSlips,
        slip_id: ID,
    ): (address, vector<u8>, vector<u8>, u64, u64, u64) {
        let slip = open_slips.slips.borrow(slip_id);
        (
            slip.owner,
            slip.legs_data,
            slip.quantities_data,
            slip.stake,
            slip.bonus_amount,
            slip.entry_epoch,
        )
    }

    public fun deepbook_predict_package(): address {
        DEEPBOOK_PREDICT_PKG
    }

    fun remove_open_slip(open_slips: &mut OpenSlips, slip_id: ID) {
        let len = vector::length(&open_slips.slip_ids);
        let mut i = 0;
        while (i < len) {
            if (*vector::borrow(&open_slips.slip_ids, i) == slip_id) {
                vector::remove(&mut open_slips.slip_ids, i);
                open_slips.slips.remove(slip_id);
                return
            };
            i = i + 1;
        };
    }

    fun copy_legs(legs: &vector<MarketLeg>): vector<MarketLeg> {
        let len = vector::length(legs);
        let mut copied = vector[];
        let mut i = 0;
        while (i < len) {
            vector::push_back(&mut copied, *vector::borrow(legs, i));
            i = i + 1;
        };
        copied
    }

    fun leg_quantities(legs: &vector<MarketLeg>): vector<u64> {
        let len = vector::length(legs);
        let mut quantities = vector[];
        let mut i = 0;
        while (i < len) {
            vector::push_back(&mut quantities, get_quantity(vector::borrow(legs, i)));
            i = i + 1;
        };
        quantities
    }

    fun decode_market_legs(legs_data: vector<u8>): vector<MarketLeg> {
        let mut prepared: BCS = sui_bcs::new(legs_data);
        let leg_count = sui_bcs::peel_vec_length(&mut prepared);
        let mut decoded = vector[];
        let mut i = 0;
        while (i < leg_count) {
            vector::push_back(&mut decoded, new_market_leg(
                prepared.peel_vec_u8(),
                prepared.peel_u64(),
                prepared.peel_u64(),
                prepared.peel_bool(),
                prepared.peel_u64(),
                prepared.peel_u64(),
            ));
            i = i + 1;
        };
        decoded
    }

}
