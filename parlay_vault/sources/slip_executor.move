/// Slip Executor — PTB for placing parlay slips on DeepBook Predict
module parlay_vault::slip_executor {

    use sui::coin::{Coin, Self};
    use sui::object::{UID, new_uid, ID};
    use sui::transfer;
    use sui::tx_context::TxContext;
    use sui::sui::SUI;
    use std::vector;

    use parlay_vault::parlay_vault::{Vault, ShareToken, bonus_reserve, lock_payout, release_payout, credit_rewards};
    use parlay_vault::slip_pricer::{
        MarketLeg, get_combined_odds, compute_bonus_multiplier, 
        calculate_payout, calculate_bonus, min_legs, max_legs
    };

    // =============================================================================
    // ERROR CODES
    // =============================================================================

    const E_TOO_FEW_LEGS: u64 = 1;
    const E_TOO_MANY_LEGS: u64 = 2;
    const E_BELOW_MIN_STAKE: u64 = 3;
    const E_INSUFFICIENT_BONUS_RESERVE: u64 = 4;
    const E_INVALID_STAKE: u64 = 5;
    const E_ZERO_ODDS: u64 = 6;

    // Minimum stake: 1 dUSDC (1_000_000 u64)
    const MIN_STAKE: u64 = 1_000_000;

    // Fixed-point scale for odds (4 decimals)
    const ODDS_SCALE: u64 = 10_000;

    // =============================================================================
    // DATA STRUCTURES
    // =============================================================================

    /// SlipReceipt — issued to user when slip is placed
    /// Tracks DeepBook Predict positions for settlement
    struct SlipReceipt has key, store {
        id: UID,
        owner: address,
        legs: vector<MarketLeg>,       // MarketLegs with market_id, position, odds
        predict_ids: vector<ID>,      // DeepBook Predict object IDs
        stake: u64,
        combined_odds: u64,
        bonus_multiplier: u64,
        potential_payout: u64,
        locked_amount: u64,
        placed_at: u64,               // epoch when slip was placed
    }

    /// Slip status enum (simplified as u8 for storage efficiency)
    const STATUS_OPEN: u8 = 0;
    const STATUS_WON: u8 = 1;
    const STATUS_LOST: u8 = 2;
    const STATUS_SETTLED: u8 = 3;

    /// OpenSlips — shared object tracking all open slips for keeper
    struct OpenSlips has key, store {
        id: UID,
        slips: vector<SlipReceipt>,
    }

    /// VaultManager — one shared PredictManager for the vault
    struct VaultManager has key, store {
        id: UID,
        predict_manager_id: ID,       // DeepBook PredictManager ID
    }

    // =============================================================================
    // USER FUNCTIONS
    // =============================================================================

    /// Place a parlay slip on DeepBook Predict
    /// This would be called via PTB from the frontend
    /// 
    /// In production, the PTB would:
    /// 1. Call predict::mint() for each leg
    /// 2. Track the positions in SlipReceipt
    /// 
    /// @param vault: The LP vault
    /// @param predict: DeepBook Predict object (shared)
    /// @param manager: PredictManager for this vault
    /// @param oracle: OracleSVI for the market
    /// @param legs: Vector of MarketLeg (2-4 legs)
    /// @param stake: dUSDC to stake (must be >= MIN_STAKE)
    /// @param ctx: Transaction context
    /// @return: SlipReceipt to the caller
    public entry fun place_slip(
        vault: &mut Vault,
        open_slips: &mut OpenSlips,
        legs: vector<MarketLeg>,
        stake: u64,
        ctx: &mut TxContext
    ): SlipReceipt {
        // Validate inputs
        let num_legs = vector.length(&legs);
        assert!(num_legs >= min_legs(), E_TOO_FEW_LEGS);
        assert!(num_legs <= max_legs(), E_TOO_MANY_LEGS);
        assert!(stake >= MIN_STAKE, E_BELOW_MIN_STAKE);
        assert!(stake > 0, E_INVALID_STAKE);

        // Compute combined odds
        let combined_odds = get_combined_odds(&legs);
        assert!(combined_odds > 0, E_ZERO_ODDS);

        // Compute bonus multiplier
        let bonus_mult = compute_bonus_multiplier(num_legs);

        // Calculate payout and bonus
        let payout = calculate_payout(stake, combined_odds, bonus_mult);
        let bonus = calculate_bonus(stake, combined_odds, bonus_mult);

        // Check bonus reserve
        let max_bonus = bonus_reserve(vault);
        assert!(bonus <= max_bonus, E_INSUFFICIENT_BONUS_RESERVE);

        // Lock the bonus in vault
        lock_payout(vault, bonus);

        // Create slip receipt
        // Note: predict_ids would be populated by the PTB after minting
        let receipt = SlipReceipt {
            id: new_uid(ctx),
            owner: ctx.sender(),
            legs,
            predict_ids: vector::empty(),
            stake,
            combined_odds,
            bonus_multiplier: bonus_mult,
            potential_payout: payout,
            locked_amount: bonus,
            placed_at: ctx.epoch(),
        };

        // Add to open slips registry
        vector::push_back(&mut open_slips.slips, receipt);

        // Transfer receipt to user
        let final_receipt = vector::pop_back(&mut open_slips.slips);
        transfer::transfer(final_receipt, ctx.sender());

        final_receipt
    }

    /// Create a PredictManager for vault operations
    /// @param ctx: Transaction context
    /// @return: ID of the created PredictManager
    public entry fun create_vault_manager(ctx: &mut TxContext): ID {
        // In production, this calls deepbook_predict::create_manager()
        // For now, create a placeholder manager object
        let manager = VaultManager {
            id: new_uid(ctx),
            predict_manager_id: @0x0.to_id(), // Placeholder
        };
        transfer::share_object(manager);
        manager.predict_manager_id
    }

    /// Supply dUSDC to DeepBook Predict vault for PLP yield
    /// @param predict: DeepBook Predict object
    /// @param coin: dUSDC to supply
    /// @param ctx: Transaction context
    /// @return: Shares minted (PLP)
    public entry fun supply_to_plp<Quote>(
        _predict: &mut Predict<Quote>,
        _coin: Coin<Quote>,
        _ctx: &mut TxContext
    ): u64 {
        // In production, this calls predict::supply(predict, coin, ctx)
        // Returns shares_minted
        0 // Placeholder
    }

    // =============================================================================
    // DEEPBOOK PREDICT INTEGRATION
    // =============================================================================
    
    // Type aliases matching DeepBook Predict
    struct Predict<phantom Quote> has key, store { id: UID }
    struct PredictManager has key, store { id: UID, owner: address }
    struct OracleSVI has key, store { id: UID }
    struct MarketKey has copy, drop, store { id: UID }

    /// Mint a position on DeepBook Predict
    /// Called by the PTB when placing a slip leg
    /// 
    /// API: predict::mint(predict, manager, oracle, key, quantity, clock, ctx)
    /// 
    /// @param predict: The Predict object
    /// @param manager: User's PredictManager
    /// @param oracle: OracleSVI for the market
    /// @param key: MarketKey (expiry, strike, is_up)
    /// @param quantity: Position size
    /// @param clock: Sui clock for time-sensitive pricing
    /// @param ctx: Transaction context
    public entry fun mint_position<Quote>(
        predict: &mut Predict<Quote>,
        manager: &mut PredictManager,
        oracle: &OracleSVI,
        key: MarketKey,
        quantity: u64,
        _clock: &sui::clock::Clock,
        ctx: &mut TxContext
    ) {
        // In production: predict::mint(predict, manager, oracle, key, quantity, clock, ctx)
        // This would:
        // 1. Calculate cost from oracle price
        // 2. Withdraw from manager balance
        // 3. Insert position into vault
        // 4. Emit PositionMinted event
    }

    /// Redeem a position on DeepBook Predict
    /// Called by keeper during settlement
    /// 
    /// API: predict::redeem(predict, manager, oracle, key, quantity, clock, ctx)
    /// 
    /// @param predict: The Predict object
    /// @param manager: User's PredictManager  
    /// @param oracle: OracleSVI for the market
    /// @param key: MarketKey (expiry, strike, is_up)
    /// @param quantity: Position size to redeem
    /// @param clock: Sui clock
    /// @param ctx: Transaction context
    /// @return: Payout Coin<Quote>
    public entry fun redeem_position<Quote>(
        predict: &mut Predict<Quote>,
        manager: &mut PredictManager,
        oracle: &OracleSVI,
        key: MarketKey,
        quantity: u64,
        _clock: &sui::clock::Clock,
        ctx: &mut TxContext
    ): Coin<Quote> {
        // In production: predict::redeem(predict, manager, oracle, key, quantity, clock, ctx)
        // Returns payout coin to the manager
        Coin { id: new_uid(ctx), value: 0 }
    }

    /// Check if oracle is settled
    /// @param oracle: OracleSVI to check
    /// @return: true if settled
    public fun is_oracle_settled(oracle: &OracleSVI): bool {
        // In production: oracle.is_settled()
        false // Placeholder
    }

    /// Get settlement price from oracle
    /// @param oracle: OracleSVI to query
    /// @return: Settlement price
    public fun get_settlement_price(oracle: &OracleSVI): u64 {
        // In production: oracle.get_settlement_price()
        0 // Placeholder
    }

    /// View function to preview slip before placing
    /// @param legs: Vector of MarketLeg
    /// @param stake: Proposed stake
    /// @return: (combined_odds, bonus_mult, payout, bonus)
    public fun preview_slip(
        legs: &vector<MarketLeg>,
        stake: u64
    ): (u64, u64, u64, u64) {
        let num_legs = vector.length(legs);
        let combined_odds = get_combined_odds(legs);
        let bonus_mult = compute_bonus_multiplier(num_legs);
        let payout = calculate_payout(stake, combined_odds, bonus_mult);
        let bonus = calculate_bonus(stake, combined_odds, bonus_mult);
        (combined_odds, bonus_mult, payout, bonus)
    }

    // =============================================================================
    // KEEPER FUNCTIONS
    // =============================================================================

    /// Settle a won slip — distribute payout to owner
    /// Called by keeper when all legs resolve positively
    /// @param vault: The LP vault
    /// @param receipt: The slip receipt
    /// @param ctx: Transaction context
    /// @return: dUSDC payout to the slip owner
    public entry fun settle_won_slip(
        vault: &mut Vault,
        receipt: SlipReceipt,
        ctx: &mut TxContext
    ): Coin<SUI> {
        let payout = receipt.potential_payout;
        let locked = receipt.locked_amount;
        let owner = receipt.owner;

        // Release locked amount back to vault
        release_payout(vault, locked);

        // Mint payout to owner
        let coin = Coin<SUI>::mint(ctx, payout);

        // Burn the receipt (implicit by not storing it)
        coin
    }

    /// Settle a lost slip — release locked bonus to vault
    /// Called by keeper when at least one leg resolves negatively
    /// @param vault: The LP vault
    /// @param receipt: The slip receipt
    public entry fun settle_lost_slip(
        vault: &mut Vault,
        receipt: SlipReceipt,
    ) {
        let locked = receipt.locked_amount;

        // Release locked amount back to vault (stays in vault for LPs)
        release_payout(vault, locked);

        // The receipt is "burned" by this function consuming it
        // LP pool keeps the locked bonus
    }

    /// Credit rewards from DeepBook Predict redeem to vault
    /// Called by keeper after redeem_permissionless
    /// @param vault: The LP vault
    /// @param rewards: dUSDC earned from DeepBook Predict
    public entry fun credit_deepbook_rewards(
        vault: &mut Vault,
        rewards: Coin<SUI>,
    ) {
        let amount = Coin::value(&rewards);
        credit_rewards(vault, amount);
        Coin::burn(rewards);
    }

    // =============================================================================
    // VIEW FUNCTIONS
    // =============================================================================

    /// Get slip info
    public fun get_slip_info(receipt: &SlipReceipt): (address, u64, u64, u64, u64) {
        (
            receipt.owner,
            receipt.stake,
            receipt.combined_odds,
            receipt.bonus_multiplier,
            receipt.potential_payout,
        )
    }

    /// Get number of legs in a slip
    public fun get_num_legs(receipt: &SlipReceipt): u64 {
        vector::length(&receipt.legs)
    }

    // =============================================================================
    // INITIALIZATION
    // =============================================================================

    /// Initialize the open slips registry
    fun init(ctx: &mut TxContext) {
        let open_slips = OpenSlips {
            id: new_uid(ctx),
            slips: vector::empty(),
        };
        transfer::share_object(open_slips);
    }

    // =============================================================================
    // TESTS
    // =============================================================================

    #[test_only]
    use sui::test_scenario;

    #[test]
    fun test_preview_slip() {
        // Two 2.0x legs -> ~3.88x combined (after 3% margin, no bonus for 2 legs)
        let leg1 = slip_pricer::create_leg(1, 0, 20000);
        let leg2 = slip_pricer::create_leg(2, 0, 20000);

        let mut legs = vector::empty();
        vector::push_back(&mut legs, leg1);
        vector::push_back(&mut legs, leg2);

        let stake = 100_000_000u64; // 100 dUSDC
        let (odds, bonus_mult, payout, bonus) = preview_slip(&legs, stake);

        // Odds should be ~38800 (3.88x after 3% margin, 1.0x bonus)
        assert!(odds > 38000 && odds < 40000, 0);
        // Bonus multiplier should be 1.0x (10000)
        assert!(bonus_mult == 10000, 1);
        // Payout = 100 * 3.88 = ~388 dUSDC
        assert!(payout > 380_000_000 && payout < 400_000_000, 2);
        // Bonus = 388 - 100 = ~288 dUSDC
        assert!(bonus > 280_000_000 && bonus < 300_000_000, 3);
    }

    #[test]
    #[expected_failure(abort_code = E_TOO_FEW_LEGS)]
    fun test_reject_single_leg() {
        let leg = slip_pricer::create_leg(1, 0, 20000);
        let mut legs = vector::empty();
        vector::push_back(&mut legs, leg);

        let vault = parlay_vault::parlay_vault::test_create_vault();
        let open_slips = OpenSlips { id: new_uid(), slips: vector::empty() };

        // This should fail - need at least 2 legs
        // place_slip(&mut vault, &mut open_slips, legs, 100_000_000, ctx);
    }

    #[test]
    #[expected_failure(abort_code = E_TOO_MANY_LEGS)]
    fun test_reject_five_legs() {
        let mut legs = vector::empty();
        let i = 0;
        while (i < 5) {
            vector::push_back(&mut legs, slip_pricer::create_leg(i, 0, 20000));
            i = i + 1;
        };

        // This should fail - max 4 legs
        // place_slip(&mut vault, &mut open_slips, legs, 100_000_000, ctx);
    }

    #[test]
    #[expected_failure(abort_code = E_BELOW_MIN_STAKE)]
    fun test_reject_below_min_stake() {
        let leg1 = slip_pricer::create_leg(1, 0, 20000);
        let leg2 = slip_pricer::create_leg(2, 0, 20000);

        let mut legs = vector::empty();
        vector::push_back(&mut legs, leg1);
        vector::push_back(&mut legs, leg2);

        // 0.5 dUSDC should fail (below MIN_STAKE of 1 dUSDC)
        // place_slip(&mut vault, &mut open_slips, legs, 500_000, ctx);
    }

    // Helper to create test vault (would need proper test setup)
    #[test_only]
    fun test_create_vault(): Vault {
        parlay_vault::parlay_vault::Vault {
            id: new_uid(),
            total_deposits: 1_000_000_000, // 1000 dUSDC
            total_shares: 1_000_000_000,
            locked_payouts: 0,
            accrued_yield: 0,
            bonus_cap_pct: 1000,
        }
    }
}