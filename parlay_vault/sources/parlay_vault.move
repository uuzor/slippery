/// Parlay Vault — LP deposit/withdraw with pro-rata share tokens
module parlay_vault::parlay_vault {

    use sui::balance::{Balance, zero, join, split, value};
    use sui::coin::{Coin, into_balance, from_balance};
    use sui::object::{UID, ID};
    use sui::table::Table;
    use sui::transfer;
    use sui::tx_context::TxContext;
    use sui::event::emit;

    const E_INSUFFICIENT_SHARES: u64 = 1;
    const E_ZERO_SHARES: u64 = 2;
    const E_VAULT_EMPTY: u64 = 3;
    const E_INSUFFICIENT_BALANCE: u64 = 4;
    const E_BELOW_MIN_DEPOSIT: u64 = 5;
    const E_NOT_OWNER: u64 = 6;
    const E_SLIP_NOT_PENDING: u64 = 7;

    const SHARE_PRICE_SCALE: u64 = 1_000_000;
    const MIN_DEPOSIT: u64 = 1_000_000;

    // Events
    public struct SlipPending has copy, drop { slip_id: ID, owner: address, stake: u64 }
    public struct SlipExecuted has copy, drop { slip_id: ID, owner: address }
    public struct SlipSettled has copy, drop { slip_id: ID, owner: address, won: bool, payout: u64 }
    public struct SlipCancelled has copy, drop { slip_id: ID, owner: address, stake: u64 }

    // Vault uses generic coin type Q (DUSDC on testnet)
    public struct Vault<phantom Q> has key {
        id: UID,
        total_deposits: u64,
        total_shares: u64,
        locked_payouts: u64,
        accrued_yield: u64,
        bonus_cap_pct: u64,
        lp_balance: Balance<Q>,
        escrow: Balance<Q>,
        pending_slips: Table<ID, PendingSlipData>,
        active_slips: Table<ID, ActiveSlipData>,
    }

    public struct LPShare has store, drop { value: u64 }

    public struct PendingSlipData has store, copy, drop {
        owner: address,
        legs_data: vector<u8>,
        stake: u64,
    }

    public struct ActiveSlipData has store, copy, drop {
        owner: address,
        legs_data: vector<u8>,
        stake: u64,
    }

    fun init(ctx: &mut TxContext) {
        // Note: Generic vault initialization requires separate functions per coin type
        // Use parlay_vault::init_vault<DUSDC>(ctx) after deployment
        let _ = ctx;
    }

    // LP FUNCTIONS

    public fun deposit<Q>(vault: &mut Vault<Q>, coin: Coin<Q>, _ctx: &mut TxContext): LPShare {
        let amount = coin.value();
        assert!(amount >= MIN_DEPOSIT, E_BELOW_MIN_DEPOSIT);
        let deposited = into_balance(coin);
        join(&mut vault.lp_balance, deposited);
        let shares_to_mint = if (vault.total_shares == 0) { amount } else {
            let share_price = share_price(vault);
            (amount * SHARE_PRICE_SCALE) / share_price
        };
        vault.total_deposits = vault.total_deposits + amount;
        vault.total_shares = vault.total_shares + shares_to_mint;
        LPShare { value: shares_to_mint }
    }

    public fun withdraw<Q>(vault: &mut Vault<Q>, shares: LPShare, ctx: &mut TxContext): Coin<Q> {
        let shares_burned = shares.value;
        assert!(shares_burned > 0, E_ZERO_SHARES);
        assert!(vault.total_shares > 0, E_VAULT_EMPTY);
        let share_price = share_price(vault);
        let withdraw_amount = (shares_burned * share_price) / SHARE_PRICE_SCALE;
        vault.total_deposits = vault.total_deposits - withdraw_amount;
        vault.total_shares = vault.total_shares - shares_burned;
        let withdrawn = split(&mut vault.lp_balance, withdraw_amount);
        from_balance(withdrawn, ctx)
    }

    // VIEW FUNCTIONS

    public fun share_price<Q>(vault: &Vault<Q>): u64 {
        if (vault.total_shares == 0) { return SHARE_PRICE_SCALE };
        let available = value(&vault.lp_balance) + vault.accrued_yield - vault.locked_payouts;
        (available * SHARE_PRICE_SCALE) / vault.total_shares
    }

    public fun bonus_reserve<Q>(vault: &Vault<Q>): u64 {
        (value(&vault.lp_balance) * vault.bonus_cap_pct) / 10000
    }

    public fun get_vault_stats<Q>(vault: &Vault<Q>): (u64, u64, u64, u64, u64) {
        (value(&vault.lp_balance), vault.total_shares, vault.locked_payouts, vault.accrued_yield, bonus_reserve(vault))
    }

    // SLIP MANAGEMENT

    public fun add_pending_slip<Q>(
        vault: &mut Vault<Q>,
        slip_id: ID,
        owner: address,
        legs_data: vector<u8>,
        stake: u64
    ) {
        let data = PendingSlipData { owner, legs_data, stake };
        vault.pending_slips.add(slip_id, data);
        emit(SlipPending { slip_id, owner, stake });
    }

    public fun deposit_to_escrow<Q>(vault: &mut Vault<Q>, coin: Coin<Q>) {
        let deposited = into_balance(coin);
        join(&mut vault.escrow, deposited);
    }

    public fun release_pending_stake<Q>(vault: &mut Vault<Q>, slip_id: ID, ctx: &mut TxContext): Coin<Q> {
        assert!(vault.pending_slips.contains(slip_id), E_SLIP_NOT_PENDING);
        let data = *vault.pending_slips.borrow(slip_id);
        vault.pending_slips.remove(slip_id);
        from_balance(split(&mut vault.escrow, data.stake), ctx)
    }

    public fun get_pending_slip<Q>(vault: &Vault<Q>, slip_id: ID): (address, vector<u8>, u64) {
        assert!(vault.pending_slips.contains(slip_id), E_SLIP_NOT_PENDING);
        let data = vault.pending_slips.borrow(slip_id);
        (data.owner, data.legs_data, data.stake)
    }

    public fun finalize_slip<Q>(
        vault: &mut Vault<Q>,
        slip_id: ID,
        legs_data: vector<u8>,
        _ctx: &mut TxContext
    ) {
        assert!(vault.pending_slips.contains(slip_id), E_SLIP_NOT_PENDING);
        let pending = *vault.pending_slips.borrow(slip_id);
        vault.pending_slips.remove(slip_id);
        
        let active = ActiveSlipData {
            owner: pending.owner,
            legs_data,
            stake: pending.stake,
        };
        vault.active_slips.add(slip_id, active);
        emit(SlipExecuted { slip_id, owner: pending.owner });
    }

    public fun cancel_pending_slip<Q>(vault: &mut Vault<Q>, slip_id: ID, ctx: &mut TxContext): Coin<Q> {
        assert!(vault.pending_slips.contains(slip_id), E_SLIP_NOT_PENDING);
        let data = *vault.pending_slips.borrow(slip_id);
        assert!(data.owner == ctx.sender(), E_NOT_OWNER);
        vault.pending_slips.remove(slip_id);
        emit(SlipCancelled { slip_id, owner: data.owner, stake: data.stake });
        from_balance(split(&mut vault.escrow, data.stake), ctx)
    }

    // SETTLEMENT

    public fun settle_won_slip<Q>(vault: &mut Vault<Q>, slip_id: ID, payout: u64) {
        assert!(vault.active_slips.contains(slip_id), E_INSUFFICIENT_BALANCE);
        let active = *vault.active_slips.borrow(slip_id);
        vault.active_slips.remove(slip_id);
        vault.locked_payouts = vault.locked_payouts - payout;
        emit(SlipSettled { slip_id, owner: active.owner, won: true, payout });
    }

    public fun settle_lost_slip<Q>(vault: &mut Vault<Q>, slip_id: ID) {
        assert!(vault.active_slips.contains(slip_id), E_INSUFFICIENT_BALANCE);
        let active = *vault.active_slips.borrow(slip_id);
        vault.active_slips.remove(slip_id);
        emit(SlipSettled { slip_id, owner: active.owner, won: false, payout: 0 });
    }

    // INTERNAL

    public fun lock_payout<Q>(vault: &mut Vault<Q>, amount: u64) {
        let available = value(&vault.lp_balance) + vault.accrued_yield - vault.locked_payouts;
        assert!(amount <= available, E_INSUFFICIENT_BALANCE);
        vault.locked_payouts = vault.locked_payouts + amount;
    }

    public fun release_payout<Q>(vault: &mut Vault<Q>, amount: u64) {
        assert!(amount <= vault.locked_payouts, E_INSUFFICIENT_SHARES);
        vault.locked_payouts = vault.locked_payouts - amount;
    }

    public fun credit_rewards<Q>(vault: &mut Vault<Q>, amount: u64) {
        vault.accrued_yield = vault.accrued_yield + amount;
    }

    public fun set_bonus_cap<Q>(vault: &mut Vault<Q>, new_cap_pct: u64) {
        vault.bonus_cap_pct = new_cap_pct;
    }

    // DEEPBOOK INTEGRATION PLACEHOLDERS
    public fun supply_to_plp<Q>(_vault: &mut Vault<Q>, _amount: u64, _ctx: &mut TxContext) { }
    public fun claim_plp_yield<Q>(_vault: &mut Vault<Q>, _amount: u64, _ctx: &mut TxContext) { }
}
