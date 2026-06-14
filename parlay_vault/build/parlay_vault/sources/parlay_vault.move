/// Parlay Vault — LP deposit/withdraw with pro-rata share tokens
module parlay_vault::parlay_vault {

    use sui::balance::{Balance, zero, join, split, value};
    use sui::coin::{Coin, into_balance, from_balance};
    use sui::object::{UID, new, delete, ID};
    use sui::table::{Table, new as table_new};
    use sui::transfer;
    use sui::tx_context::TxContext;
    use sui::sui::SUI;
    use sui::event::emit;

    const DEEPBOOK_PREDICT_PKG: address = @0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138;
    const DEEPBOOK_PREDICT_OBJ: address = @0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a;

    const E_INSUFFICIENT_SHARES: u64 = 1;
    const E_ZERO_SHARES: u64 = 2;
    const E_VAULT_EMPTY: u64 = 3;
    const E_INSUFFICIENT_BALANCE: u64 = 4;
    const E_BELOW_MIN_DEPOSIT: u64 = 5;

    const SHARE_PRICE_SCALE: u64 = 1_000_000;
    const MIN_DEPOSIT: u64 = 1_000_000;

    public struct SlipPending has copy, drop { slip_id: ID, owner: address, stake: u64 }
    public struct SlipExecuted has copy, drop { slip_id: ID, owner: address }
    public struct SlipSettled has copy, drop { slip_id: ID, owner: address, won: bool, payout: u64 }

    public struct Vault has key {
        id: UID,
        total_deposits: u64,
        total_shares: u64,
        locked_payouts: u64,
        accrued_yield: u64,
        bonus_cap_pct: u64,
        lp_balance: Balance<SUI>,
        escrow: Balance<SUI>,
        pending_stakes: Table<ID, u64>,
        active_slips: Table<ID, address>,
    }

    public struct LPShare has store, drop { value: u64 }

    fun init(ctx: &mut TxContext) {
        let vault = Vault {
            id: new(ctx),
            total_deposits: 0,
            total_shares: 0,
            locked_payouts: 0,
            accrued_yield: 0,
            bonus_cap_pct: 1000,
            lp_balance: zero<SUI>(),
            escrow: zero<SUI>(),
            pending_stakes: table_new(ctx),
            active_slips: table_new(ctx),
        };
        transfer::share_object(vault);
    }

    public fun deposit(vault: &mut Vault, coin: Coin<SUI>, _ctx: &mut TxContext): LPShare {
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

    public fun withdraw(vault: &mut Vault, shares: LPShare, ctx: &mut TxContext): Coin<SUI> {
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

    public fun share_price(vault: &Vault): u64 {
        if (vault.total_shares == 0) { return SHARE_PRICE_SCALE };
        let available = value(&vault.lp_balance) + vault.accrued_yield - vault.locked_payouts;
        (available * SHARE_PRICE_SCALE) / vault.total_shares
    }

    public fun bonus_reserve(vault: &Vault): u64 {
        (value(&vault.lp_balance) * vault.bonus_cap_pct) / 10000
    }

    public fun get_vault_stats(vault: &Vault): (u64, u64, u64, u64, u64) {
        (value(&vault.lp_balance), vault.total_shares, vault.locked_payouts, vault.accrued_yield, bonus_reserve(vault))
    }

    public fun deposit_pending_stake(vault: &mut Vault, slip_id: ID, stake: u64, _ctx: &mut TxContext) {
        vault.pending_stakes.add(slip_id, stake);
        emit(SlipPending { slip_id, owner: @0x0, stake });
    }

    public fun release_pending_stake(vault: &mut Vault, slip_id: ID, ctx: &mut TxContext): Coin<SUI> {
        assert!(vault.pending_stakes.contains(slip_id), E_INSUFFICIENT_BALANCE);
        let stake_amount = *vault.pending_stakes.borrow(slip_id);
        vault.pending_stakes.remove(slip_id);
        let coin = from_balance(split(&mut vault.escrow, stake_amount), ctx);
        coin
    }

    public fun finalize_slip(vault: &mut Vault, slip_id: ID, owner: address, _ctx: &mut TxContext) {
        vault.active_slips.add(slip_id, owner);
        emit(SlipExecuted { slip_id, owner });
    }

    public fun settle_won_slip(vault: &mut Vault, slip_id: ID, payout: u64, _ctx: &mut TxContext) {
        assert!(vault.active_slips.contains(slip_id), E_INSUFFICIENT_BALANCE);
        let owner = *vault.active_slips.borrow(slip_id);
        vault.active_slips.remove(slip_id);
        vault.locked_payouts = vault.locked_payouts - payout;
        emit(SlipSettled { slip_id, owner, won: true, payout });
    }

    public fun settle_lost_slip(vault: &mut Vault, slip_id: ID, won_amount: u64) {
        assert!(vault.active_slips.contains(slip_id), E_INSUFFICIENT_BALANCE);
        let owner = *vault.active_slips.borrow(slip_id);
        vault.active_slips.remove(slip_id);
        emit(SlipSettled { slip_id, owner, won: false, payout: won_amount });
    }

    public fun lock_payout(vault: &mut Vault, amount: u64) {
        let available = value(&vault.lp_balance) + vault.accrued_yield - vault.locked_payouts;
        assert!(amount <= available, E_INSUFFICIENT_BALANCE);
        vault.locked_payouts = vault.locked_payouts + amount;
    }

    public fun release_payout(vault: &mut Vault, amount: u64) {
        assert!(amount <= vault.locked_payouts, E_INSUFFICIENT_SHARES);
        vault.locked_payouts = vault.locked_payouts - amount;
    }

    public fun credit_rewards(vault: &mut Vault, amount: u64) {
        vault.accrued_yield = vault.accrued_yield + amount;
    }

    public fun set_bonus_cap(vault: &mut Vault, new_cap_pct: u64) {
        vault.bonus_cap_pct = new_cap_pct;
    }

    public fun supply_to_plp(_vault: &mut Vault, _amount: u64, _ctx: &mut TxContext) { }
    public fun claim_plp_yield(_vault: &mut Vault, _amount: u64, _ctx: &mut TxContext) { }
}
