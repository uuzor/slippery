/// Parlay Vault - LP deposit/withdraw with Predict-backed slip accounting
module parlay_vault::parlay_vault {

    use std::vector;
    use sui::balance::{Balance, join, split, value, zero};
    use sui::coin::{Coin, from_balance, into_balance};
    use sui::event::emit;
    use sui::object::{Self as object, ID, UID};
    use sui::table::{Self as table, Table};
    use sui::transfer;
    use sui::tx_context::TxContext;

    const E_INSUFFICIENT_SHARES: u64 = 1;
    const E_ZERO_SHARES: u64 = 2;
    const E_INSUFFICIENT_BALANCE: u64 = 4;
    const E_BELOW_MIN_DEPOSIT: u64 = 5;
    const E_NOT_OWNER: u64 = 6;
    const E_SLIP_NOT_PENDING: u64 = 7;
    const E_EPOCH_NOT_ADVANCED: u64 = 8;
    const E_EPOCH_NOT_SETTLED: u64 = 9;
    const E_SHARE_NOT_ACTIVE: u64 = 10;
    const E_SHARE_STILL_LOCKED: u64 = 11;
    const E_SHARE_NOT_FOUND: u64 = 12;
    const E_STAKE_ALREADY_RELEASED: u64 = 13;
    const E_STAKE_NOT_RELEASED: u64 = 14;
    const E_SLIP_NOT_ACTIVE: u64 = 15;

    const SHARE_PRICE_SCALE: u64 = 1_000_000;
    const MIN_DEPOSIT: u64 = 1_000_000;

    public struct SlipPending has copy, drop {
        slip_id: ID,
        owner: address,
        stake: u64,
    }

    public struct SlipExecuted has copy, drop {
        slip_id: ID,
        owner: address,
    }

    public struct SlipSettled has copy, drop {
        slip_id: ID,
        owner: address,
        won: bool,
        payout: u64,
    }

    public struct SlipCancelled has copy, drop {
        slip_id: ID,
        owner: address,
        stake: u64,
    }

    public struct DepositQueued has copy, drop {
        share_id: ID,
        queued_epoch: u64,
        amount: u64,
    }

    public struct EpochAdvanced has copy, drop {
        previous_epoch: u64,
        new_epoch: u64,
    }

    public struct ShareRolledOver has copy, drop {
        share_id: ID,
        from_epoch: u64,
        to_epoch: u64,
        amount: u64,
    }

    public struct LiquiditySeeded has copy, drop {
        share_id: ID,
        amount: u64,
        shares: u64,
        epoch: u64,
    }

    public struct AdminCap has key, store {
        id: UID,
    }

    public struct Vault<phantom Q> has key {
        id: UID,
        current_epoch: u64,
        epoch_settled: bool,
        total_deposits: u64,
        total_shares: u64,
        locked_bonus: u64,
        accrued_yield: u64,
        bonus_cap_pct: u64,
        lp_balance: Balance<Q>,
        escrow: Balance<Q>,
        pending_deposits: Table<u64, Balance<Q>>,
        pending_share_ids: Table<u64, vector<ID>>,
        lp_positions: Table<ID, LPPosition>,
        pending_slips: Table<ID, PendingSlipData>,
        active_slips: Table<ID, ActiveSlipData>,
        epoch_slip_counts: Table<u64, u64>,
    }

    public struct LPShare has key, store {
        id: UID,
    }

    public struct LPPosition has store, copy, drop {
        principal: u64,
        shares: u64,
        activation_epoch: u64,
        auto_roll: bool,
        is_active: bool,
    }

    public struct PendingSlipData has store, copy, drop {
        owner: address,
        legs_data: vector<u8>,
        quantities_data: vector<u8>,
        stake: u64,
        bonus_amount: u64,
        stake_released: bool,
    }

    public struct ActiveSlipData has store, copy, drop {
        owner: address,
        legs_data: vector<u8>,
        quantities_data: vector<u8>,
        stake: u64,
        bonus_amount: u64,
        entry_epoch: u64,
    }

    fun init(ctx: &mut TxContext) {
        transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
    }

    public fun create_vault<Q>(bonus_cap_pct: u64, ctx: &mut TxContext): Vault<Q> {
        Vault {
            id: object::new(ctx),
            current_epoch: ctx.epoch(),
            epoch_settled: true,
            total_deposits: 0,
            total_shares: 0,
            locked_bonus: 0,
            accrued_yield: 0,
            bonus_cap_pct,
            lp_balance: zero(),
            escrow: zero(),
            pending_deposits: table::new(ctx),
            pending_share_ids: table::new(ctx),
            lp_positions: table::new(ctx),
            pending_slips: table::new(ctx),
            active_slips: table::new(ctx),
            epoch_slip_counts: table::new(ctx),
        }
    }

    public fun create_shared_vault<Q>(bonus_cap_pct: u64, ctx: &mut TxContext) {
        transfer::share_object(create_vault<Q>(bonus_cap_pct, ctx));
    }

    public fun deposit<Q>(vault: &mut Vault<Q>, coin: Coin<Q>, ctx: &mut TxContext): LPShare {
        queue_deposit(vault, coin, false, ctx)
    }

    public fun seed_liquidity<Q>(
        vault: &mut Vault<Q>,
        coin: Coin<Q>,
        _: &AdminCap,
        ctx: &mut TxContext,
    ): LPShare {
        let amount = coin.value();
        assert!(amount >= MIN_DEPOSIT, E_BELOW_MIN_DEPOSIT);

        let entry_price = share_price(vault);
        let minted_shares = compute_shares(amount, entry_price);
        assert!(minted_shares > 0, E_ZERO_SHARES);

        let share = LPShare { id: object::new(ctx) };
        let share_id = object::id(&share);
        join(&mut vault.lp_balance, into_balance(coin));
        vault.total_deposits = vault.total_deposits + amount;
        vault.total_shares = vault.total_shares + minted_shares;
        vault.lp_positions.add(share_id, LPPosition {
            principal: amount,
            shares: minted_shares,
            activation_epoch: vault.current_epoch,
            auto_roll: false,
            is_active: true,
        });
        emit(LiquiditySeeded {
            share_id,
            amount,
            shares: minted_shares,
            epoch: vault.current_epoch,
        });
        share
    }

    public fun queue_deposit<Q>(
        vault: &mut Vault<Q>,
        coin: Coin<Q>,
        auto_roll: bool,
        ctx: &mut TxContext,
    ): LPShare {
        let amount = coin.value();
        assert!(amount >= MIN_DEPOSIT, E_BELOW_MIN_DEPOSIT);

        let queued_epoch = vault.current_epoch + 1;
        let share = LPShare { id: object::new(ctx) };
        let share_id = object::id(&share);

        queue_pending_balance(vault, queued_epoch, into_balance(coin));
        queue_pending_share_id(vault, queued_epoch, share_id);
        vault.lp_positions.add(share_id, LPPosition {
            principal: amount,
            shares: 0,
            activation_epoch: queued_epoch,
            auto_roll,
            is_active: false,
        });
        emit(DepositQueued { share_id, queued_epoch, amount });
        share
    }

    public fun advance_epoch<Q>(vault: &mut Vault<Q>, ctx: &mut TxContext) {
        assert!(ctx.epoch() > vault.current_epoch, E_EPOCH_NOT_ADVANCED);
        assert!(epoch_slip_count(vault, vault.current_epoch) == 0, E_EPOCH_NOT_SETTLED);

        let previous_epoch = vault.current_epoch;
        let next_epoch = previous_epoch + 1;
        let entry_price = share_price(vault);

        if (vault.pending_share_ids.contains(next_epoch)) {
            let queued_share_ids = vault.pending_share_ids.remove(next_epoch);
            if (vault.pending_deposits.contains(next_epoch)) {
                let pending_balance = vault.pending_deposits.remove(next_epoch);
                let pending_amount = value(&pending_balance);
                join(&mut vault.lp_balance, pending_balance);
                vault.total_deposits = vault.total_deposits + pending_amount;
            };

            let mut minted_total = 0;
            let len = vector::length(&queued_share_ids);
            let mut i = 0;
            while (i < len) {
                let share_id = *vector::borrow(&queued_share_ids, i);
                let position = vault.lp_positions.borrow_mut(share_id);
                let minted_shares = compute_shares(position.principal, entry_price);
                position.shares = minted_shares;
                position.activation_epoch = next_epoch;
                position.is_active = true;
                minted_total = minted_total + minted_shares;
                i = i + 1;
            };
            vault.total_shares = vault.total_shares + minted_total;
        };

        vault.current_epoch = next_epoch;
        vault.epoch_settled = epoch_slip_count(vault, next_epoch) == 0;
        emit(EpochAdvanced {
            previous_epoch,
            new_epoch: next_epoch,
        });
    }

    public fun cancel_queued_deposit<Q>(
        vault: &mut Vault<Q>,
        share: LPShare,
        ctx: &mut TxContext,
    ): Coin<Q> {
        let share_id = object::id(&share);
        assert!(vault.lp_positions.contains(share_id), E_SHARE_NOT_FOUND);

        let position = *vault.lp_positions.borrow(share_id);
        assert!(!position.is_active, E_SHARE_NOT_ACTIVE);

        let pending_epoch = position.activation_epoch;
        let pending_amount = value(vault.pending_deposits.borrow(pending_epoch));
        let refunded = if (pending_amount == position.principal) {
            vault.pending_deposits.remove(pending_epoch)
        } else {
            let pending_balance = vault.pending_deposits.borrow_mut(pending_epoch);
            split(pending_balance, position.principal)
        };

        remove_pending_share_id(vault, pending_epoch, share_id);
        vault.lp_positions.remove(share_id);

        let LPShare { id } = share;
        object::delete(id);
        from_balance(refunded, ctx)
    }

    public fun withdraw<Q>(vault: &mut Vault<Q>, share: LPShare, ctx: &mut TxContext): Coin<Q> {
        let share_id = object::id(&share);
        assert!(vault.lp_positions.contains(share_id), E_SHARE_NOT_FOUND);

        let position = *vault.lp_positions.borrow(share_id);
        assert!(position.is_active, E_SHARE_NOT_ACTIVE);
        assert!(position.activation_epoch < vault.current_epoch, E_SHARE_STILL_LOCKED);
        assert!(epoch_slip_count(vault, position.activation_epoch) == 0, E_EPOCH_NOT_SETTLED);
        assert!(position.shares > 0, E_ZERO_SHARES);

        let withdraw_amount = redeem_amount(vault, position.shares);
        vault.total_deposits = vault.total_deposits - withdraw_amount;
        vault.total_shares = vault.total_shares - position.shares;
        vault.lp_positions.remove(share_id);

        let withdrawn = split(&mut vault.lp_balance, withdraw_amount);
        let LPShare { id } = share;
        object::delete(id);
        from_balance(withdrawn, ctx)
    }

    public fun roll_over<Q>(vault: &mut Vault<Q>, share: LPShare): LPShare {
        let share_id = object::id(&share);
        assert!(vault.lp_positions.contains(share_id), E_SHARE_NOT_FOUND);

        let position = *vault.lp_positions.borrow(share_id);
        assert!(position.is_active, E_SHARE_NOT_ACTIVE);
        assert!(position.activation_epoch < vault.current_epoch, E_SHARE_STILL_LOCKED);
        assert!(epoch_slip_count(vault, position.activation_epoch) == 0, E_EPOCH_NOT_SETTLED);
        assert!(position.shares > 0, E_ZERO_SHARES);

        let rolled_amount = redeem_amount(vault, position.shares);
        vault.total_deposits = vault.total_deposits - rolled_amount;
        vault.total_shares = vault.total_shares - position.shares;

        let rolled_balance = split(&mut vault.lp_balance, rolled_amount);
        let next_epoch = vault.current_epoch + 1;
        queue_pending_balance(vault, next_epoch, rolled_balance);
        queue_pending_share_id(vault, next_epoch, share_id);

        let position_mut = vault.lp_positions.borrow_mut(share_id);
        position_mut.principal = rolled_amount;
        position_mut.shares = 0;
        position_mut.activation_epoch = next_epoch;
        position_mut.auto_roll = true;
        position_mut.is_active = false;

        emit(ShareRolledOver {
            share_id,
            from_epoch: vault.current_epoch,
            to_epoch: next_epoch,
            amount: rolled_amount,
        });
        share
    }

    public fun share_price<Q>(vault: &Vault<Q>): u64 {
        if (vault.total_shares == 0) {
            return SHARE_PRICE_SCALE
        };

        let available = available_liquidity(vault);
        (available * SHARE_PRICE_SCALE) / vault.total_shares
    }

    public fun bonus_reserve<Q>(vault: &Vault<Q>): u64 {
        (value(&vault.lp_balance) * vault.bonus_cap_pct) / 10000
    }

    public fun available_bonus_capacity<Q>(vault: &Vault<Q>): u64 {
        let reserve = bonus_reserve(vault);
        if (reserve > vault.locked_bonus) reserve - vault.locked_bonus else 0
    }

    public fun get_vault_stats<Q>(vault: &Vault<Q>): (u64, u64, u64, u64, u64) {
        (
            value(&vault.lp_balance),
            vault.total_shares,
            vault.locked_bonus,
            vault.accrued_yield,
            bonus_reserve(vault),
        )
    }

    public(package) fun request_slip<Q>(
        vault: &mut Vault<Q>,
        slip_id: ID,
        stake_coin: Coin<Q>,
        legs_data: vector<u8>,
        quantities_data: vector<u8>,
        bonus_amount: u64,
        ctx: &TxContext,
    ) {
        let owner = ctx.sender();
        let stake = stake_coin.value();
        deposit_to_escrow(vault, stake_coin);
        reserve_bonus(vault, bonus_amount);

        vault.pending_slips.add(slip_id, PendingSlipData {
            owner,
            legs_data,
            quantities_data,
            stake,
            bonus_amount,
            stake_released: false,
        });
        emit(SlipPending { slip_id, owner, stake });
    }

    public fun deposit_to_escrow<Q>(vault: &mut Vault<Q>, coin: Coin<Q>) {
        join(&mut vault.escrow, into_balance(coin));
    }

    public fun release_pending_stake<Q>(
        vault: &mut Vault<Q>,
        slip_id: ID,
        _: &AdminCap,
        ctx: &mut TxContext,
    ): Coin<Q> {
        assert!(vault.pending_slips.contains(slip_id), E_SLIP_NOT_PENDING);
        let data = vault.pending_slips.borrow_mut(slip_id);
        assert!(!data.stake_released, E_STAKE_ALREADY_RELEASED);
        data.stake_released = true;
        from_balance(split(&mut vault.escrow, data.stake), ctx)
    }

    public fun get_pending_slip<Q>(
        vault: &Vault<Q>,
        slip_id: ID,
    ): (address, vector<u8>, vector<u8>, u64, u64, bool) {
        assert!(vault.pending_slips.contains(slip_id), E_SLIP_NOT_PENDING);
        let data = vault.pending_slips.borrow(slip_id);
        (
            data.owner,
            data.legs_data,
            data.quantities_data,
            data.stake,
            data.bonus_amount,
            data.stake_released,
        )
    }

    public fun finalize_slip<Q>(
        vault: &mut Vault<Q>,
        slip_id: ID,
        _: &AdminCap,
        _ctx: &mut TxContext,
    ) {
        assert!(vault.pending_slips.contains(slip_id), E_SLIP_NOT_PENDING);
        let pending = *vault.pending_slips.borrow(slip_id);
        assert!(pending.stake_released, E_STAKE_NOT_RELEASED);
        vault.pending_slips.remove(slip_id);

        let entry_epoch = vault.current_epoch;
        vault.active_slips.add(slip_id, ActiveSlipData {
            owner: pending.owner,
            legs_data: pending.legs_data,
            quantities_data: pending.quantities_data,
            stake: pending.stake,
            bonus_amount: pending.bonus_amount,
            entry_epoch,
        });
        increment_epoch_slip_count(vault, entry_epoch);
        emit(SlipExecuted {
            slip_id,
            owner: pending.owner,
        });
    }

    public fun cancel_pending_slip<Q>(vault: &mut Vault<Q>, slip_id: ID, ctx: &mut TxContext): Coin<Q> {
        assert!(vault.pending_slips.contains(slip_id), E_SLIP_NOT_PENDING);

        let data = *vault.pending_slips.borrow(slip_id);
        assert!(data.owner == ctx.sender(), E_NOT_OWNER);
        assert!(!data.stake_released, E_STAKE_ALREADY_RELEASED);
        vault.pending_slips.remove(slip_id);
        release_bonus(vault, data.bonus_amount);
        emit(SlipCancelled {
            slip_id,
            owner: data.owner,
            stake: data.stake,
        });
        from_balance(split(&mut vault.escrow, data.stake), ctx)
    }

    public fun get_active_slip<Q>(
        vault: &Vault<Q>,
        slip_id: ID,
    ): (address, vector<u8>, vector<u8>, u64, u64, u64) {
        assert!(vault.active_slips.contains(slip_id), E_SLIP_NOT_ACTIVE);
        let data = vault.active_slips.borrow(slip_id);
        (
            data.owner,
            data.legs_data,
            data.quantities_data,
            data.stake,
            data.bonus_amount,
            data.entry_epoch,
        )
    }

    public fun settle_all_win<Q>(
        vault: &mut Vault<Q>,
        slip_id: ID,
        redeemed_coin: Coin<Q>,
        _: &AdminCap,
        ctx: &mut TxContext,
    ) {
        assert!(vault.active_slips.contains(slip_id), E_SLIP_NOT_ACTIVE);

        let active = *vault.active_slips.borrow(slip_id);
        vault.active_slips.remove(slip_id);

        let mut payout_balance = into_balance(redeemed_coin);
        if (active.bonus_amount > 0) {
            let top_up = split(&mut vault.lp_balance, active.bonus_amount);
            join(&mut payout_balance, top_up);
        };
        release_bonus(vault, active.bonus_amount);
        note_slip_settled(vault, active.entry_epoch);

        let payout_amount = value(&payout_balance);
        let payout_coin = from_balance(payout_balance, ctx);
        transfer::public_transfer(payout_coin, active.owner);
        emit(SlipSettled {
            slip_id,
            owner: active.owner,
            won: true,
            payout: payout_amount,
        });
    }

    public fun settle_not_all_win<Q>(
        vault: &mut Vault<Q>,
        slip_id: ID,
        redeemed_coin: Coin<Q>,
        _: &AdminCap,
    ) {
        assert!(vault.active_slips.contains(slip_id), E_SLIP_NOT_ACTIVE);

        let active = *vault.active_slips.borrow(slip_id);
        vault.active_slips.remove(slip_id);
        join(&mut vault.lp_balance, into_balance(redeemed_coin));
        release_bonus(vault, active.bonus_amount);
        note_slip_settled(vault, active.entry_epoch);
        emit(SlipSettled {
            slip_id,
            owner: active.owner,
            won: false,
            payout: 0,
        });
    }

    public fun credit_rewards<Q>(vault: &mut Vault<Q>, amount: u64, _: &AdminCap) {
        vault.accrued_yield = vault.accrued_yield + amount;
    }

    public fun set_bonus_cap<Q>(vault: &mut Vault<Q>, new_cap_pct: u64, _: &AdminCap) {
        vault.bonus_cap_pct = new_cap_pct;
    }

    public fun supply_to_plp<Q>(_vault: &mut Vault<Q>, _amount: u64, _: &AdminCap, _ctx: &mut TxContext) {}
    public fun claim_plp_yield<Q>(_vault: &mut Vault<Q>, _amount: u64, _: &AdminCap, _ctx: &mut TxContext) {}

    fun reserve_bonus<Q>(vault: &mut Vault<Q>, amount: u64) {
        let available = available_bonus_capacity(vault);
        assert!(amount <= available, E_INSUFFICIENT_BALANCE);
        vault.locked_bonus = vault.locked_bonus + amount;
    }

    fun release_bonus<Q>(vault: &mut Vault<Q>, amount: u64) {
        assert!(amount <= vault.locked_bonus, E_INSUFFICIENT_SHARES);
        vault.locked_bonus = vault.locked_bonus - amount;
    }

    fun available_liquidity<Q>(vault: &Vault<Q>): u64 {
        let gross = value(&vault.lp_balance) + vault.accrued_yield;
        if (gross > vault.locked_bonus) gross - vault.locked_bonus else 0
    }

    fun compute_shares(amount: u64, entry_price: u64): u64 {
        if (entry_price == 0) {
            0
        } else {
            (((amount as u128) * (SHARE_PRICE_SCALE as u128)) / (entry_price as u128)) as u64
        }
    }

    fun redeem_amount<Q>(vault: &Vault<Q>, shares: u64): u64 {
        (((shares as u128) * (share_price(vault) as u128)) / (SHARE_PRICE_SCALE as u128)) as u64
    }

    fun queue_pending_balance<Q>(vault: &mut Vault<Q>, epoch: u64, balance: Balance<Q>) {
        if (vault.pending_deposits.contains(epoch)) {
            let pending = vault.pending_deposits.borrow_mut(epoch);
            join(pending, balance);
        } else {
            vault.pending_deposits.add(epoch, balance);
        };
    }

    fun queue_pending_share_id<Q>(vault: &mut Vault<Q>, epoch: u64, share_id: ID) {
        if (vault.pending_share_ids.contains(epoch)) {
            let share_ids = vault.pending_share_ids.borrow_mut(epoch);
            vector::push_back(share_ids, share_id);
        } else {
            vault.pending_share_ids.add(epoch, vector[share_id]);
        };
    }

    fun remove_pending_share_id<Q>(vault: &mut Vault<Q>, epoch: u64, share_id: ID) {
        if (!vault.pending_share_ids.contains(epoch)) {
            return
        };

        let share_ids = vault.pending_share_ids.remove(epoch);
        let len = vector::length(&share_ids);
        let mut filtered = vector[];
        let mut i = 0;
        while (i < len) {
            let current_share_id = *vector::borrow(&share_ids, i);
            if (current_share_id != share_id) {
                vector::push_back(&mut filtered, current_share_id);
            };
            i = i + 1;
        };
        if (vector::length(&filtered) > 0) {
            vault.pending_share_ids.add(epoch, filtered);
        };
    }

    fun epoch_slip_count<Q>(vault: &Vault<Q>, epoch: u64): u64 {
        if (vault.epoch_slip_counts.contains(epoch)) {
            *vault.epoch_slip_counts.borrow(epoch)
        } else {
            0
        }
    }

    fun increment_epoch_slip_count<Q>(vault: &mut Vault<Q>, epoch: u64) {
        if (vault.epoch_slip_counts.contains(epoch)) {
            let count = vault.epoch_slip_counts.borrow_mut(epoch);
            *count = *count + 1;
        } else {
            vault.epoch_slip_counts.add(epoch, 1);
        };
        vault.epoch_settled = epoch_slip_count(vault, vault.current_epoch) == 0;
    }

    fun note_slip_settled<Q>(vault: &mut Vault<Q>, epoch: u64) {
        if (!vault.epoch_slip_counts.contains(epoch)) {
            vault.epoch_settled = epoch_slip_count(vault, vault.current_epoch) == 0;
            return
        };

        let current = *vault.epoch_slip_counts.borrow(epoch);
        if (current <= 1) {
            vault.epoch_slip_counts.remove(epoch);
        } else {
            let count = vault.epoch_slip_counts.borrow_mut(epoch);
            *count = current - 1;
        };
        vault.epoch_settled = epoch_slip_count(vault, vault.current_epoch) == 0;
    }

    #[test]
    fun seed_liquidity_activates_immediately() {
        use sui::balance;
        use sui::coin;
        use sui::table;

        let mut ctx = tx_context::dummy();

        let admin_cap = AdminCap { id: object::new(&mut ctx) };
        let mut vault = create_vault<0x2::sui::SUI>(1_000, &mut ctx);
        let coin = coin::mint_for_testing<0x2::sui::SUI>(50_000_000, &mut ctx);
        let share = seed_liquidity(&mut vault, coin, &admin_cap, &mut ctx);
        let share_id = object::id(&share);
        let position = *vault.lp_positions.borrow(share_id);

        assert!(position.is_active, 0);
        assert!(position.activation_epoch == vault.current_epoch, 1);
        assert!(position.principal == 50_000_000, 2);
        assert!(position.shares == 50_000_000, 3);
        assert!(value(&vault.lp_balance) == 50_000_000, 4);
        assert!(vault.total_deposits == 50_000_000, 5);
        assert!(vault.total_shares == 50_000_000, 6);

        vault.current_epoch = vault.current_epoch + 1;
        let withdrawn = withdraw(&mut vault, share, &mut ctx);
        assert!(coin::value(&withdrawn) == 50_000_000, 7);
        assert!(vault.total_deposits == 0, 8);
        assert!(vault.total_shares == 0, 9);
        assert!(value(&vault.lp_balance) == 0, 10);
        assert!(vault.lp_positions.length() == 0, 11);

        let burned = coin::burn_for_testing(withdrawn);
        assert!(burned == 50_000_000, 12);

        let Vault {
            id,
            current_epoch: _,
            epoch_settled: _,
            total_deposits: _,
            total_shares: _,
            locked_bonus: _,
            accrued_yield: _,
            bonus_cap_pct: _,
            lp_balance,
            escrow,
            pending_deposits,
            pending_share_ids,
            lp_positions,
            pending_slips,
            active_slips,
            epoch_slip_counts,
        } = vault;
        object::delete(id);
        balance::destroy_zero(lp_balance);
        balance::destroy_zero(escrow);
        table::destroy_empty(pending_deposits);
        table::destroy_empty(pending_share_ids);
        table::destroy_empty(lp_positions);
        table::destroy_empty(pending_slips);
        table::destroy_empty(active_slips);
        table::destroy_empty(epoch_slip_counts);

        let AdminCap { id } = admin_cap;
        object::delete(id);
    }

}
