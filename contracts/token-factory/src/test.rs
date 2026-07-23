#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Map, String,
};
use std::panic::{catch_unwind, AssertUnwindSafe};

// ── Test setup helper ─────────────────────────────────────────────────────────

fn dummy_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

struct Setup {
    env: Env,
    client: TokenFactoryClient<'static>,
    admin: Address,
    treasury: Address,
    fee_token: Address,
}

impl Setup {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let fee_token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register(
            TokenFactory,
            TokenFactoryArgs::__constructor(
                &admin,
                &treasury,
                &fee_token,
                &dummy_hash(&env),
                &1_000,
                &500,
            ),
        );
        // SAFETY: the client borrows `env` which lives for the duration of the test.
        let client = TokenFactoryClient::new(&env, &contract_id);
        let client: TokenFactoryClient<'static> = unsafe { core::mem::transmute(client) };

        Setup {
            env,
            client,
            admin,
            treasury,
            fee_token,
        }
    }

    /// Mint `amount` of the fee token to `recipient`.
    fn fund(&self, recipient: &Address, amount: i128) {
        StellarAssetClient::new(&self.env, &self.fee_token).mint(recipient, &amount);
    }

    /// Register a fresh Stellar asset contract owned by `issuer`.
    fn new_token(&self, issuer: &Address) -> Address {
        self.env
            .register_stellar_asset_contract_v2(issuer.clone())
            .address()
    }

    fn salt(&self, n: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[n; 32])
    }

    /// A dummy wasm hash — only used in error-path tests that fail before deploy.
    fn dummy_hash(&self) -> BytesN<32> {
        BytesN::from_array(&self.env, &[0u8; 32])
    }
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

/// Register a token in factory storage as if `create_token` had run.
/// Returns the token contract address.
fn seed_token(
    s: &Setup,
    creator: &Address,
    burn_enabled: bool,
    max_supply: Option<i128>,
) -> Address {
    let token_addr = s.new_token(creator);
    let info = TokenInfo {
        name: String::from_str(&s.env, "T"),
        symbol: String::from_str(&s.env, "T"),
        decimals: 7,
        creator: creator.clone(),
        created_at: 0,
        burn_enabled,
        max_supply,
    };
    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.token_count = state.token_count.checked_add(1).unwrap();
        let index = state.token_count;
        TokenFactory::set_persistent(&s.env, &DataKey::TokenInfo(index), &info);
        s.env.storage().instance().set(&DataKey::State, &state);
        TokenFactory::set_persistent(&s.env, &DataKey::TokenIndex(token_addr.clone()), &index);
        TokenFactory::append_creator_token(&s.env, creator, index).unwrap();
        TokenFactory::set_persistent(&s.env, &(&token_addr, symbol_short!("owner")), creator);
    });
    token_addr
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize() {
    let s = Setup::new();
    let state = s.client.get_state();
    assert_eq!(state.admin, s.admin);
    assert_eq!(state.treasury, s.treasury);
    assert_eq!(state.fee_token, s.fee_token);
    assert_eq!(state.base_fee, 1_000);
    assert_eq!(state.metadata_fee, 500);
    assert!(!state.paused);
    assert_eq!(state.token_count, 0);
}

#[test]
fn test_initialize_already_initialized() {
    // The constructor now runs atomically with deployment, so it can no
    // longer be invoked as a second, separate call against a live contract.
    // The only way to exercise the `AlreadyInitialized` guard is the
    // test-only re-registration path (re-running the constructor against an
    // address whose instance storage was already populated) — the doc
    // comment on `Env::register_at` notes this isn't reproducible on-chain,
    // but the guard is kept as defense in depth.
    let s = Setup::new();
    let result = catch_unwind(AssertUnwindSafe(|| {
        s.env.register_at(
            &s.client.address,
            TokenFactory,
            TokenFactoryArgs::__constructor(
                &s.admin,
                &s.treasury,
                &s.fee_token,
                &s.dummy_hash(),
                &1_000,
                &500,
            ),
        )
    }));
    assert!(result.is_err());
}

// ── supply boundary tests (issue #909) ───────────────────────────────────────

/// u128 value just above i128::MAX wraps to a negative i128 without a guard.
/// The fix must reject this with InvalidParameters before any mint occurs.
#[test]
fn test_create_token_supply_above_i128_max_rejected() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 1_000);
    let overflow_supply: u128 = (i128::MAX as u128).saturating_add(1); // i128::MAX + 1
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "MyToken"),
        &String::from_str(&s.env, "MTK"),
        &7,
        &overflow_supply,
        &1_000,
    );
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

/// u128::MAX is the largest possible overflow value — must also be rejected.
#[test]
fn test_create_token_supply_u128_max_rejected() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 1_000);
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "MyToken"),
        &String::from_str(&s.env, "MTK"),
        &7,
        &u128::MAX,
        &1_000,
    );
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

/// i128::MAX is the largest value that fits exactly — must pass validation.
/// The test will reach the deploy step and fail there because the hash is a
/// dummy, but the error must NOT be InvalidParameters (supply is valid).
#[test]
fn test_create_token_supply_i128_max_passes_validation() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 1_000);
    let max_valid: u128 = i128::MAX as u128;
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "MyToken"),
        &String::from_str(&s.env, "MTK"),
        &7,
        &max_valid,
        &1_000,
    );
    // Supply is valid, so we must not get InvalidParameters.
    // The call may fail for other reasons (dummy wasm hash), but not supply.
    assert_ne!(result, Err(Ok(Error::InvalidParameters)));
}

/// Zero supply is explicitly allowed — token is created without minting.
/// The call will fail at the deploy step (dummy hash) but not at supply
/// validation, confirming zero is accepted.
#[test]
fn test_create_token_supply_zero_passes_validation() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 1_000);
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "MyToken"),
        &String::from_str(&s.env, "MTK"),
        &7,
        &0_u128,
        &1_000,
    );
    // Must not be rejected for supply reasons.
    assert_ne!(result, Err(Ok(Error::InvalidParameters)));
}

// ── create_token (error paths only — deploy requires real wasm) ───────────────

/// Regression test for initial_supply overflow when casting u128 → i128.
/// Discovered via fuzz_targets::fuzz_create_token.
///
/// The `create_token` function accepts `initial_supply: u128` but internally
/// casts it to `i128` with `as`. Values > i128::MAX silently wrap to negative
/// numbers, which would then be passed to `token::mint`. This test locks in
/// the fix: the contract MUST reject initial_supply > i128::MAX before the
/// cast.
#[test]
fn test_create_token_initial_supply_exceeds_i128_max() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 1_000);
    // i128::MAX = 170141183460469231731687303715884105727
    // u128 value one greater than i128::MAX
    let overflow_supply = (i128::MAX as u128).checked_add(1).unwrap();
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "Token"),
        &String::from_str(&s.env, "TKN"),
        &7,
        &overflow_supply,
        &1_000,
    );
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

/// Value exactly at i128::MAX must be accepted.
#[test]
fn test_create_token_initial_supply_at_i128_max() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 1_000);
    // i128::MAX is the largest safe u128 → i128 value.
    // The contract cannot deploy real WASM in tests, so inner deployment
    // will fail with a host error — but the overflow guard must pass first.
    let max_supply = i128::MAX as u128;
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "Token"),
        &String::from_str(&s.env, "TKN"),
        &7,
        &max_supply,
        &1_000,
    );
    // The overflow guard should NOT trigger — the error should be something
    // other than InvalidParameters (deploy failure).
    assert!(result != Err(Ok(Error::InvalidParameters)));
}

#[test]
fn test_set_metadata_fee_goes_to_treasury() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 500);

    let token_addr = seed_token(&s, &admin, true, None);
    s.client.set_metadata(
        &token_addr,
        &admin,
        &String::from_str(&s.env, "ipfs://Qm123"),
        &500,
    );

    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&s.treasury),
        500
    );
}

// ── exact-fee charging (issue #1008) ────────────────────────────────────────
//
// `fee_payment` is the caller's authorized upper bound, not the amount to
// charge — the contract must transfer exactly the currently configured
// required fee (`base_fee` / `metadata_fee`) and leave any surplus in the
// caller's balance. `create_token` and `create_tokens_batch` share the exact
// same `distribute_fee(..., state.base_fee)` call as `mint_tokens` and are
// covered by the same fix, but can't be balance-tested directly here since a
// successful deploy needs a real token WASM (see "create_token (error paths
// only — deploy requires real wasm)" above) — `mint_tokens` and
// `set_metadata` exercise the identical charging logic without that
// limitation.

#[test]
fn test_set_metadata_overpayment_charges_exact_fee_only() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    // Fund well above 2x metadata_fee (500) so a leftover balance proves
    // only the exact fee was taken, not the full fee_payment.
    s.fund(&admin, 10_000);

    let token_addr = seed_token(&s, &admin, true, None);
    // Pass fee_payment = 2 * metadata_fee (1_000 vs. required 500).
    s.client.set_metadata(
        &token_addr,
        &admin,
        &String::from_str(&s.env, "ipfs://QmOverpay"),
        &1_000,
    );

    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&s.treasury),
        500,
        "treasury must receive exactly metadata_fee, not fee_payment"
    );
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&admin),
        10_000 - 500,
        "caller must keep the surplus above metadata_fee"
    );
}

#[test]
fn test_mint_tokens_overpayment_charges_exact_fee_only() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    // Fund well above 2x base_fee (1_000) so a leftover balance proves only
    // the exact fee was taken.
    s.fund(&admin, 10_000);

    let token_addr = seed_token(&s, &admin, true, None);
    let recipient = Address::generate(&s.env);
    // Pass fee_payment = 2 * base_fee (2_000 vs. required 1_000).
    s.client
        .mint_tokens(&token_addr, &admin, &recipient, &5_000, &2_000);

    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&s.treasury),
        1_000,
        "treasury must receive exactly base_fee, not fee_payment"
    );
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&admin),
        10_000 - 1_000,
        "caller must keep the surplus above base_fee"
    );
    // The mint itself still uses the caller-specified `amount`, independent
    // of the fee overpayment.
    assert_eq!(
        TokenClient::new(&s.env, &token_addr).balance(&recipient),
        5_000
    );
}

#[test]
fn test_mint_tokens_fee_split_sums_to_charged_fee_not_payment() {
    let s = Setup::new();
    let recipient_a = Address::generate(&s.env);
    let recipient_b = Address::generate(&s.env);
    let splits = make_split(&s, &[(&recipient_a, 6_000), (&recipient_b, 4_000)]);
    s.client.set_fee_split(&s.admin, &splits);

    let admin = Address::generate(&s.env);
    s.fund(&admin, 10_000);
    let token_addr = seed_token(&s, &admin, true, None);
    let mint_to = Address::generate(&s.env);

    // fee_payment (5_000) is 5x base_fee (1_000).
    s.client
        .mint_tokens(&token_addr, &admin, &mint_to, &1, &5_000);

    let a_balance = TokenClient::new(&s.env, &s.fee_token).balance(&recipient_a);
    let b_balance = TokenClient::new(&s.env, &s.fee_token).balance(&recipient_b);
    let treasury_balance = TokenClient::new(&s.env, &s.fee_token).balance(&s.treasury);

    // 60% / 40% of the *charged* base_fee (1_000), not the fee_payment (5_000).
    assert_eq!(a_balance, 600);
    assert_eq!(b_balance, 400);
    assert_eq!(treasury_balance, 0);

    // Conservation against the charged amount, not the passed fee_payment.
    assert_eq!(
        a_balance + b_balance + treasury_balance,
        1_000,
        "fee-split recipients must sum to exactly the charged base_fee"
    );
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&admin),
        10_000 - 1_000,
        "caller must keep the surplus above base_fee even with a fee split configured"
    );
}

/// Fee-update race: a caller submits `fee_payment` sized for the fee that was
/// current when they built the transaction. If the admin raises the fee
/// before the transaction lands, the call must fail cleanly with
/// `InsufficientFee` and leave every balance untouched — no partial charge
/// at the old rate, and no charge at all at the new rate.
#[test]
fn test_fee_update_race_rejects_with_no_partial_transfer() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 10_000);
    let token_addr = seed_token(&s, &admin, true, None);
    let recipient = Address::generate(&s.env);

    // Admin raises base_fee from 1_000 to 2_000 after the caller already
    // decided on a fee_payment sized for the old fee (with a little
    // headroom: 1_500).
    s.client.update_fees(&s.admin, &Some(2_000), &None);

    let result = s
        .client
        .try_mint_tokens(&token_addr, &admin, &recipient, &5_000, &1_500);
    assert_eq!(result, Err(Ok(Error::InsufficientFee)));

    // No balance may have moved: the fee-gate check happens before any
    // transfer or mint.
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&admin),
        10_000
    );
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&s.treasury),
        0
    );
    assert_eq!(TokenClient::new(&s.env, &token_addr).balance(&recipient), 0);
}

#[test]
fn test_create_token_insufficient_fee() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "MyToken"),
        &String::from_str(&s.env, "MTK"),
        &7,
        &0_u128,
        &999,
    );

    assert_eq!(result, Err(Ok(Error::InsufficientFee)));
}

#[test]
fn test_create_token_blocked_when_paused() {
    let s = Setup::new();
    s.client.pause(&s.admin);
    let creator = Address::generate(&s.env);
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "T"),
        &String::from_str(&s.env, "T"),
        &7,
        &0_u128,
        &1_000,
    );
    assert_eq!(result, Err(Ok(Error::ContractPaused)));
}

#[test]
fn test_create_token_invalid_decimals() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 1_000);
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "MyToken"),
        &String::from_str(&s.env, "MTK"),
        &19,
        &0_u128,
        &1_000,
    );
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

#[test]
fn test_create_token_invalid_decimals_large() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 1_000);
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "MyToken"),
        &String::from_str(&s.env, "MTK"),
        &255,
        &0_u128,
        &1_000,
    );
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

#[test]
fn test_create_token_invalid_name_empty() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 1_000);
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, ""),
        &String::from_str(&s.env, "MTK"),
        &7,
        &0_u128,
        &1_000,
    );
    assert_eq!(result, Err(Ok(Error::InvalidTokenParams)));
}

#[test]
fn test_create_token_invalid_symbol_empty() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 1_000);
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "MyToken"),
        &String::from_str(&s.env, ""),
        &7,
        &0_u128,
        &1_000,
    );
    assert_eq!(result, Err(Ok(Error::InvalidTokenParams)));
}

#[test]
fn test_create_token_reentrancy_guard() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.locked = true;
        s.env.storage().instance().set(&DataKey::State, &state);
    });
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "T"),
        &String::from_str(&s.env, "T"),
        &7,
        &0_u128,
        &1_000,
    );
    assert_eq!(result, Err(Ok(Error::Reentrancy)));
}

#[test]
fn test_create_token_overflow_protection() {
    let s = Setup::new();
    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.token_count = u32::MAX;
        s.env.storage().instance().set(&DataKey::State, &state);
    });
    let creator = Address::generate(&s.env);
    s.fund(&creator, 1_000);
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "T"),
        &String::from_str(&s.env, "T"),
        &7,
        &0_u128,
        &1_000,
    );
    assert_eq!(result, Err(Ok(Error::ArithmeticOverflow)));
}

#[test]
fn test_reentrancy_lock_released_after_error() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    // Trigger InsufficientFee — lock must be released afterwards.
    let _ = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "T"),
        &String::from_str(&s.env, "T"),
        &7,
        &0_u128,
        &1,
    );
    s.env.as_contract(&s.client.address, || {
        let state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        assert!(!state.locked, "lock must be released after an error");
    });
}

#[test]
fn test_create_tokens_batch_overflow_protection_upfront() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 10_000);

    // Set token_count to u32::MAX - 1 so a batch of 2 tokens would overflow token_count.
    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.token_count = u32::MAX - 1;
        s.env.storage().instance().set(&DataKey::State, &state);
    });

    let mut tokens: Vec<BatchTokenParams> = vec![&s.env];
    tokens.push_back(BatchTokenParams {
        salt: s.salt(1),
        name: String::from_str(&s.env, "TokenOne"),
        symbol: String::from_str(&s.env, "TK1"),
        decimals: 7,
        initial_supply: 0,
        max_supply: None,
    });
    tokens.push_back(BatchTokenParams {
        salt: s.salt(2),
        name: String::from_str(&s.env, "TokenTwo"),
        symbol: String::from_str(&s.env, "TK2"),
        decimals: 7,
        initial_supply: 0,
        max_supply: None,
    });

    // Front-loaded validation catches token_count overflow for the entire batch before any deploy calls or lock writes execute.
    let result = s.client.try_create_tokens_batch(&creator, &tokens, &2_000);
    assert_eq!(result, Err(Ok(Error::ArithmeticOverflow)));

    // State is preserved and lock is released.
    assert_eq!(s.client.get_state().token_count, u32::MAX - 1);
    assert!(!s.client.get_state().locked);
}

// ── set_metadata ──────────────────────────────────────────────────────────────

#[test]
fn test_set_metadata() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 500);
    let token_addr = seed_token(&s, &admin, true, None);
    s.client.set_metadata(
        &token_addr,
        &admin,
        &String::from_str(&s.env, "ipfs://QmTest"),
        &500,
    );
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&s.treasury),
        500
    );
}

#[test]
fn test_set_metadata_insufficient_fee() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    let token_addr = s.new_token(&admin);
    let result = s.client.try_set_metadata(
        &token_addr,
        &admin,
        &String::from_str(&s.env, "ipfs://QmTest"),
        &100,
    );
    assert_eq!(result, Err(Ok(Error::InsufficientFee)));
}

#[test]
fn test_set_metadata_unauthorized() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let stranger = Address::generate(&s.env);
    s.fund(&stranger, 500);
    let token_addr = seed_token(&s, &creator, true, None);
    let result = s.client.try_set_metadata(
        &token_addr,
        &stranger,
        &String::from_str(&s.env, "ipfs://QmTest"),
        &500,
    );
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_set_metadata_already_set() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 1_000);
    let token_addr = seed_token(&s, &admin, true, None);
    s.client.set_metadata(
        &token_addr,
        &admin,
        &String::from_str(&s.env, "ipfs://QmFirst"),
        &500,
    );
    let result = s.client.try_set_metadata(
        &token_addr,
        &admin,
        &String::from_str(&s.env, "ipfs://QmSecond"),
        &500,
    );
    assert_eq!(result, Err(Ok(Error::MetadataAlreadySet)));
}

#[test]
fn test_set_metadata_different_tokens_independent() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 1_000);
    let token_a = seed_token(&s, &admin, true, None);
    let token_b = seed_token(&s, &admin, true, None);
    s.client.set_metadata(
        &token_a,
        &admin,
        &String::from_str(&s.env, "ipfs://QmA"),
        &500,
    );
    s.client.set_metadata(
        &token_b,
        &admin,
        &String::from_str(&s.env, "ipfs://QmB"),
        &500,
    );
}

// ── mint_tokens ───────────────────────────────────────────────────────────────

#[test]
fn test_mint_tokens() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 1_000);
    let token_addr = seed_token(&s, &admin, true, None);
    let recipient = Address::generate(&s.env);
    s.client
        .mint_tokens(&token_addr, &admin, &recipient, &5_000, &1_000);
    assert_eq!(
        TokenClient::new(&s.env, &token_addr).balance(&recipient),
        5_000
    );
}

#[test]
fn test_mint_tokens_unauthorized() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let stranger = Address::generate(&s.env);
    s.fund(&stranger, 1_000);
    let token_addr = seed_token(&s, &creator, true, None);
    let recipient = Address::generate(&s.env);
    let result = s
        .client
        .try_mint_tokens(&token_addr, &stranger, &recipient, &5_000, &1_000);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_mint_tokens_insufficient_fee() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 500);
    let token_addr = seed_token(&s, &admin, true, None);
    let recipient = Address::generate(&s.env);
    let result = s
        .client
        .try_mint_tokens(&token_addr, &admin, &recipient, &100, &999);
    assert_eq!(result, Err(Ok(Error::InsufficientFee)));
}

#[test]
fn test_mint_tokens_zero_amount_rejected() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 1_000);
    let token_addr = seed_token(&s, &admin, true, None);
    let recipient = Address::generate(&s.env);
    let result = s
        .client
        .try_mint_tokens(&token_addr, &admin, &recipient, &0, &1_000);
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

// ── max supply cap ────────────────────────────────────────────────────────────

#[test]
fn test_mint_tokens_within_cap() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 1_000);
    let token_addr = seed_token(&s, &admin, true, Some(1_000));
    let recipient = Address::generate(&s.env);
    s.client
        .mint_tokens(&token_addr, &admin, &recipient, &1_000, &1_000);
    assert_eq!(
        TokenClient::new(&s.env, &token_addr).balance(&recipient),
        1_000
    );
}

#[test]
fn test_mint_tokens_exceeds_cap() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 1_000);
    let token_addr = seed_token(&s, &admin, true, Some(500));
    let recipient = Address::generate(&s.env);
    let result = s
        .client
        .try_mint_tokens(&token_addr, &admin, &recipient, &501, &1_000);
    assert_eq!(result, Err(Ok(Error::MaxSupplyExceeded)));
}

#[test]
fn test_mint_tokens_exactly_at_cap() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 2_000);
    let token_addr = seed_token(&s, &admin, true, Some(1_000));
    let recipient = Address::generate(&s.env);
    s.client
        .mint_tokens(&token_addr, &admin, &recipient, &600, &1_000);
    s.client
        .mint_tokens(&token_addr, &admin, &recipient, &400, &1_000);
    assert_eq!(
        TokenClient::new(&s.env, &token_addr).balance(&recipient),
        1_000
    );
}

#[test]
fn test_mint_tokens_one_over_cap() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 2_000);
    let token_addr = seed_token(&s, &admin, true, Some(1_000));
    let recipient = Address::generate(&s.env);
    s.client
        .mint_tokens(&token_addr, &admin, &recipient, &600, &1_000);
    let result = s
        .client
        .try_mint_tokens(&token_addr, &admin, &recipient, &401, &1_000);
    assert_eq!(result, Err(Ok(Error::MaxSupplyExceeded)));
}

// ── burn ──────────────────────────────────────────────────────────────────────

#[test]
fn test_burn() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, true, None);
    let burner = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &token_addr).mint(&burner, &1_000);
    s.client.burn(&token_addr, &burner, &400);
    assert_eq!(TokenClient::new(&s.env, &token_addr).balance(&burner), 600);
}

#[test]
fn test_burn_invalid_amount_zero() {
    let s = Setup::new();
    let user = Address::generate(&s.env);
    let token_addr = s.new_token(&user);
    assert_eq!(
        s.client.try_burn(&token_addr, &user, &0),
        Err(Ok(Error::InvalidBurnAmount))
    );
}

#[test]
fn test_burn_amount_exceeds_balance() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, true, None);
    let burner = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &token_addr).mint(&burner, &100);
    assert_eq!(
        s.client.try_burn(&token_addr, &burner, &101),
        Err(Ok(Error::BurnAmountExceedsBalance))
    );
}

#[test]
fn test_burn_exact_balance() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, true, None);
    let burner = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &token_addr).mint(&burner, &100);
    s.client.burn(&token_addr, &burner, &100);
    assert_eq!(TokenClient::new(&s.env, &token_addr).balance(&burner), 0);
}

#[test]
fn test_burn_disabled() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, false, None);
    let burner = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &token_addr).mint(&burner, &100);
    assert_eq!(
        s.client.try_burn(&token_addr, &burner, &100),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn test_set_burn_enabled_disables_then_reenables() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, true, None);
    let burner = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &token_addr).mint(&burner, &500);

    s.client.set_burn_enabled(&token_addr, &creator, &false);
    assert_eq!(
        s.client.try_burn(&token_addr, &burner, &100),
        Err(Ok(Error::Unauthorized))
    );

    s.client.set_burn_enabled(&token_addr, &creator, &true);
    s.client.burn(&token_addr, &burner, &200);
    assert_eq!(TokenClient::new(&s.env, &token_addr).balance(&burner), 300);
}

#[test]
fn test_set_burn_enabled_unauthorized() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let stranger = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, true, None);
    assert_eq!(
        s.client
            .try_set_burn_enabled(&token_addr, &stranger, &false),
        Err(Ok(Error::Unauthorized))
    );
}

// ── update_fees ───────────────────────────────────────────────────────────────

#[test]
fn test_update_fees() {
    let s = Setup::new();
    s.client
        .update_fees(&s.admin, &Some(2_000_i128), &Some(1_000_i128));
    let state = s.client.get_state();
    assert_eq!(state.base_fee, 2_000);
    assert_eq!(state.metadata_fee, 1_000);
}

#[test]
fn test_update_fees_partial() {
    let s = Setup::new();
    s.client.update_fees(&s.admin, &Some(3_000_i128), &None);
    let state = s.client.get_state();
    assert_eq!(state.base_fee, 3_000);
    assert_eq!(state.metadata_fee, 500); // unchanged
}

#[test]
fn test_update_fees_unauthorized() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.client
            .try_update_fees(&stranger, &Some(2_000_i128), &None),
        Err(Ok(Error::Unauthorized))
    );
}

// ── fee sign constraint (negative fee validation) ─────────────────────────────
//
// Policy: fees must be >= 0. Zero is explicitly allowed (free token creation
// is a legitimate use-case). Negative values are rejected because:
//   1. A negative required_fee satisfies every `fee_payment < required_fee`
//      guard trivially (making the fee gate a no-op).
//   2. A negative amount passed to distribute_fee → token::transfer is
//      implementation-defined on the SEP-41 token contract side and has
//      not been tested or audited for this factory.

/// Registers a fresh `TokenFactory` with the given fees and returns whether
/// the constructor rejected them. A constructor is invoked atomically during
/// registration/deployment and has no client-callable `try_*` form, so an
/// `Err` return surfaces as a host trap — caught here via `catch_unwind`
/// instead of an `assert_eq!` on a `Result` value.
fn init_rejects(base_fee: i128, metadata_fee: i128) -> bool {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let fee_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let result = catch_unwind(AssertUnwindSafe(|| {
        env.register(
            TokenFactory,
            TokenFactoryArgs::__constructor(
                &admin,
                &treasury,
                &fee_token,
                &BytesN::from_array(&env, &[0u8; 32]),
                &base_fee,
                &metadata_fee,
            ),
        )
    }));
    result.is_err()
}

#[test]
fn test_initialize_negative_base_fee_rejected() {
    assert!(init_rejects(-1_i128, 500_i128));
}

#[test]
fn test_initialize_negative_metadata_fee_rejected() {
    assert!(init_rejects(1_000_i128, -1_i128));
}

#[test]
fn test_initialize_both_fees_negative_rejected() {
    assert!(init_rejects(-100_i128, -200_i128));
}

#[test]
fn test_initialize_i128_min_fee_rejected() {
    // i128::MIN is the most dangerous negative: saturating_abs() of it is
    // still i128::MAX, so any code that tries to normalise it before checking
    // would still fail. Ensure the raw sign check fires first.
    assert!(init_rejects(i128::MIN, 0_i128));
}

#[test]
fn test_initialize_zero_fees_allowed() {
    // Zero fee is valid — free token creation is a legitimate use-case.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let fee_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(
        TokenFactory,
        TokenFactoryArgs::__constructor(
            &admin,
            &treasury,
            &fee_token,
            &BytesN::from_array(&env, &[0u8; 32]),
            &0_i128,
            &0_i128,
        ),
    );
    let client = TokenFactoryClient::new(&env, &contract_id);
    let state = client.get_state();
    assert_eq!(state.base_fee, 0);
    assert_eq!(state.metadata_fee, 0);
}

#[test]
fn test_update_fees_negative_base_fee_rejected() {
    let s = Setup::new();
    assert_eq!(
        s.client.try_update_fees(&s.admin, &Some(-1_i128), &None),
        Err(Ok(Error::InvalidParameters))
    );
    // State must be unchanged
    assert_eq!(s.client.get_state().base_fee, 1_000);
}

#[test]
fn test_update_fees_negative_metadata_fee_rejected() {
    let s = Setup::new();
    assert_eq!(
        s.client.try_update_fees(&s.admin, &None, &Some(-1_i128)),
        Err(Ok(Error::InvalidParameters))
    );
    // State must be unchanged
    assert_eq!(s.client.get_state().metadata_fee, 500);
}

#[test]
fn test_update_fees_i128_min_rejected() {
    let s = Setup::new();
    assert_eq!(
        s.client.try_update_fees(&s.admin, &Some(i128::MIN), &None),
        Err(Ok(Error::InvalidParameters))
    );
}

#[test]
fn test_update_fees_zero_allowed() {
    // Reducing to zero fee is valid — admin may want to offer free operations.
    let s = Setup::new();
    s.client.update_fees(&s.admin, &Some(0_i128), &Some(0_i128));
    let state = s.client.get_state();
    assert_eq!(state.base_fee, 0);
    assert_eq!(state.metadata_fee, 0);
}

#[test]
fn test_update_fees_negative_does_not_corrupt_state() {
    // A rejected update must leave both fees at their original values.
    let s = Setup::new();
    let _ = s
        .client
        .try_update_fees(&s.admin, &Some(-999_i128), &Some(-1_i128));
    let state = s.client.get_state();
    assert_eq!(
        state.base_fee, 1_000,
        "base_fee must be unchanged after rejection"
    );
    assert_eq!(
        state.metadata_fee, 500,
        "metadata_fee must be unchanged after rejection"
    );
}

// ── pause / unpause ───────────────────────────────────────────────────────────

#[test]
fn test_admin_can_pause_and_unpause() {
    let s = Setup::new();
    s.client.pause(&s.admin);
    assert!(s.client.get_state().paused);
    s.client.unpause(&s.admin);
    assert!(!s.client.get_state().paused);
}

#[test]
fn test_non_admin_cannot_pause() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    assert_eq!(s.client.try_pause(&stranger), Err(Ok(Error::Unauthorized)));
}

// ── reentrancy guard ──────────────────────────────────────────────────────────

#[test]
fn test_burn_allowed_when_factory_paused() {
    // burn() does not call require_not_paused — it must work even when paused.
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, true, None);
    let burner = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &token_addr).mint(&burner, &500);
    s.client.pause(&s.admin);
    s.client.burn(&token_addr, &burner, &200);
    assert_eq!(TokenClient::new(&s.env, &token_addr).balance(&burner), 300);
}

// ── transfer_admin / update_admin ─────────────────────────────────────────────

#[test]
fn test_transfer_admin() {
    let s = Setup::new();
    let new_admin = Address::generate(&s.env);
    s.client.transfer_admin(&s.admin, &new_admin);
    assert_eq!(s.client.get_state().admin, new_admin);
}

#[test]
fn test_transfer_admin_unauthorized() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    let new_admin = Address::generate(&s.env);
    assert_eq!(
        s.client.try_transfer_admin(&stranger, &new_admin),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn test_transfer_admin_same_address_rejected() {
    let s = Setup::new();
    assert_eq!(
        s.client.try_transfer_admin(&s.admin, &s.admin),
        Err(Ok(Error::InvalidParameters))
    );
}

#[test]
fn test_update_admin_old_loses_access() {
    let s = Setup::new();
    let new_admin = Address::generate(&s.env);
    s.client.update_admin(&s.admin, &new_admin);
    assert_eq!(s.client.try_pause(&s.admin), Err(Ok(Error::Unauthorized)));
    s.client.pause(&new_admin);
    assert!(s.client.get_state().paused);
}

// ── get_token_info / get_tokens_by_creator ────────────────────────────────────

#[test]
fn test_get_token_info() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let info = TokenInfo {
        name: String::from_str(&s.env, "MyToken"),
        symbol: String::from_str(&s.env, "MTK"),
        decimals: 7,
        creator: creator.clone(),
        created_at: 0,
        burn_enabled: true,
        max_supply: None,
    };
    s.env.as_contract(&s.client.address, || {
        s.env
            .storage()
            .instance()
            .set(&DataKey::TokenInfo(1), &info);
    });
    let result = s.client.get_token_info(&1);
    assert_eq!(result.name, String::from_str(&s.env, "MyToken"));
    assert_eq!(result.symbol, String::from_str(&s.env, "MTK"));
    assert_eq!(result.decimals, 7);
    assert_eq!(result.creator, creator);
}

#[test]
fn test_get_token_info_not_found() {
    let s = Setup::new();
    assert_eq!(
        s.client.try_get_token_info(&99),
        Err(Ok(Error::TokenNotFound))
    );
}

// ── get_token_index / get_token_info_by_address / get_metadata ────────────────

#[test]
fn test_get_token_index_resolves_registered_address() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, true, None);
    // seed_token increments token_count starting from 1, so this is index 1.
    assert_eq!(s.client.get_token_index(&token_addr), 1);
}

#[test]
fn test_get_token_index_not_found_for_unregistered_address() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.client.try_get_token_index(&stranger),
        Err(Ok(Error::TokenNotFound))
    );
}

/// Regression for #1018: a token's identity must resolve from its address via
/// the contract regardless of how old it is or how many events came after it.
/// Event-derived lookups dropped tokens created beyond the first event page and
/// fabricated placeholder data (address-as-name, guessed decimals); the on-chain
/// index has no such window.
#[test]
fn test_get_token_info_by_address_returns_authoritative_identity() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = s.new_token(&creator);
    let info = TokenInfo {
        name: String::from_str(&s.env, "AncientToken"),
        symbol: String::from_str(&s.env, "OLD"),
        decimals: 12,
        creator: creator.clone(),
        created_at: 42,
        burn_enabled: false,
        max_supply: Some(1_000_000),
    };
    s.env.as_contract(&s.client.address, || {
        s.env
            .storage()
            .instance()
            .set(&DataKey::TokenInfo(7), &info);
        s.env
            .storage()
            .instance()
            .set(&DataKey::TokenIndex(token_addr.clone()), &7u32);
    });

    let resolved = s.client.get_token_info_by_address(&token_addr);
    assert_eq!(resolved.name, String::from_str(&s.env, "AncientToken"));
    assert_eq!(resolved.symbol, String::from_str(&s.env, "OLD"));
    assert_eq!(resolved.decimals, 12);
    assert_eq!(resolved.creator, creator);
    assert_eq!(resolved.created_at, 42);
    assert_eq!(resolved.max_supply, Some(1_000_000));
}

#[test]
fn test_get_token_info_by_address_not_found() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.client.try_get_token_info_by_address(&stranger),
        Err(Ok(Error::TokenNotFound))
    );
}

/// A registered `TokenIndex` whose `TokenInfo` entry is missing must surface
/// as `TokenNotFound` rather than trapping.
#[test]
fn test_get_token_info_by_address_missing_info_entry() {
    let s = Setup::new();
    let token_addr = s.new_token(&Address::generate(&s.env));
    s.env.as_contract(&s.client.address, || {
        s.env
            .storage()
            .instance()
            .set(&DataKey::TokenIndex(token_addr.clone()), &99u32);
    });
    assert_eq!(
        s.client.try_get_token_info_by_address(&token_addr),
        Err(Ok(Error::TokenNotFound))
    );
}

#[test]
fn test_get_metadata_none_before_set_then_some_after() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, true, None);

    assert_eq!(s.client.get_metadata(&token_addr), None);

    let uri = String::from_str(&s.env, "ipfs://QmMeta");
    s.env.as_contract(&s.client.address, || {
        s.env
            .storage()
            .instance()
            .set(&DataKey::Metadata(token_addr.clone()), &uri);
    });

    assert_eq!(s.client.get_metadata(&token_addr), Some(uri));
}

#[test]
fn test_get_tokens_by_creator() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    seed_token(&s, &creator, true, None);
    seed_token(&s, &creator, true, None);
    let indices = s.client.get_tokens_by_creator(&creator, &0_u32, &10_u32);
    assert_eq!(indices.len(), 2);
}

#[test]
fn test_get_tokens_by_creator_empty_for_unknown() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.client
            .get_tokens_by_creator(&stranger, &0_u32, &10_u32)
            .len(),
        0
    );
}

// ── get_tokens_by_creator pagination ─────────────────────────────────────────

/// Helper that seeds `n` tokens owned by `creator`, returning their indices
/// in storage order. Indices are computed locally from a baseline read of
/// `FactoryState.token_count` rather than re-reading `DataKey::TokenIndex`
/// for each seed — re-reading would require entering the contract context
/// for every seed, which conflicts with `seed_token`'s own `as_contract`
/// wrapping.
fn seed_many(s: &Setup, creator: &Address, n: u32) -> Vec<u32> {
    let mut expected: Vec<u32> = Vec::new(&s.env);
    let mut base: u32 = 0;
    s.env.as_contract(&s.client.address, || {
        let state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        base = state.token_count;
    });
    for i in 0..n {
        seed_token(s, creator, true, None);
        expected.push_back(base.saturating_add(i).saturating_add(1));
    }
    expected
}

#[test]
fn test_get_tokens_by_creator_first_page() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let expected = seed_many(&s, &creator, 15);
    let page = s.client.get_tokens_by_creator(&creator, &0_u32, &10_u32);
    assert_eq!(page.len(), 10);
    for i in 0..10 {
        assert_eq!(page.get(i).unwrap(), expected.get(i).unwrap());
    }
}

#[test]
fn test_get_tokens_by_creator_second_page() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let expected = seed_many(&s, &creator, 15);
    let page = s.client.get_tokens_by_creator(&creator, &10_u32, &10_u32);
    assert_eq!(page.len(), 5);
    for i in 0..5 {
        assert_eq!(page.get(i).unwrap(), expected.get(10 + i).unwrap());
    }
}

#[test]
fn test_get_tokens_by_creator_offset_past_end() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    seed_many(&s, &creator, 5);
    // offset >= total → empty result
    let page = s.client.get_tokens_by_creator(&creator, &5_u32, &10_u32);
    assert_eq!(page.len(), 0);
    let page_far = s.client.get_tokens_by_creator(&creator, &u32::MAX, &10_u32);
    assert_eq!(page_far.len(), 0);
}

#[test]
fn test_get_tokens_by_creator_zero_limit() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    seed_many(&s, &creator, 3);
    let page = s.client.get_tokens_by_creator(&creator, &0_u32, &0_u32);
    assert_eq!(page.len(), 0);
}

#[test]
fn test_get_tokens_by_creator_clamps_oversized_limit() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    // Seed just enough tokens to exceed the configured cap so the clamping
    // path is exercised. Seeding too many tokens would exceed the test
    // runtime's per-instance storage budget — 60 fits comfortably while
    // being > MAX_TOKENS_BY_CREATOR_PAGE (50).
    seed_many(&s, &creator, 60);
    // Requesting a limit larger than the configured cap must not return more
    // than the cap. This guards against callers asking for arbitrarily large
    // pages that could exceed ledger entry size limits on mainnet.
    let page = s.client.get_tokens_by_creator(&creator, &0_u32, &u32::MAX);
    assert!(
        page.len() <= super::MAX_TOKENS_BY_CREATOR_PAGE,
        "page size ({}) must be ≤ the contract-level cap ({})",
        page.len(),
        super::MAX_TOKENS_BY_CREATOR_PAGE,
    );
    // The first page should be filled to the cap (we have 60 tokens, the
    // contract requested 50). This is the load-bearing assertion: the page
    // actually clamps down to MAX rather than silently truncating at offset
    // + u32::MAX.
    assert_eq!(page.len(), super::MAX_TOKENS_BY_CREATOR_PAGE);
}

#[test]
fn test_get_tokens_by_creator_isolated_per_creator() {
    let s = Setup::new();
    let creator_a = Address::generate(&s.env);
    let creator_b = Address::generate(&s.env);
    seed_many(&s, &creator_a, 4);
    seed_many(&s, &creator_b, 7);

    let a = s.client.get_tokens_by_creator(&creator_a, &0_u32, &10_u32);
    let b = s.client.get_tokens_by_creator(&creator_b, &0_u32, &10_u32);

    assert_eq!(a.len(), 4);
    assert_eq!(b.len(), 7);

    // None of A's indices should appear in B's slice.
    for idx in a.iter() {
        for other in b.iter() {
            assert_ne!(idx, other);
        }
    }
}

#[test]
fn test_get_tokens_by_creator_partial_last_page() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    seed_many(&s, &creator, 7);
    // Page of exactly 7 splits into [3, 4] for limit=3, offset=0 / 3.
    let p1 = s.client.get_tokens_by_creator(&creator, &0_u32, &3_u32);
    assert_eq!(p1.len(), 3);
    let p2 = s.client.get_tokens_by_creator(&creator, &3_u32, &3_u32);
    assert_eq!(p2.len(), 3);
    let p3 = s.client.get_tokens_by_creator(&creator, &6_u32, &3_u32);
    assert_eq!(p3.len(), 1);
    let p4 = s.client.get_tokens_by_creator(&creator, &7_u32, &3_u32);
    assert_eq!(p4.len(), 0);
}

// ── storage architecture (issue #1007) ─────────────────────────────────────────

/// Several hundred tokens for one creator must not make the single
/// `instance` ledger entry (`FactoryState` + fee split) grow, and per-token
/// records must actually live in `persistent` storage rather than
/// `instance` storage.
///
/// This is the regression test for issue #1007: before the migration to
/// persistent storage, `TokenInfo`, `TokenIndex`, the per-token `owner` key,
/// and the monolithic `CreatorTokens` `Vec<u32>` all lived in `instance`
/// storage, so this same workload would have made every `instance` read/write
/// — including on entrypoints unrelated to the seeded tokens, like
/// `mint_tokens` on an unrelated token — progressively more expensive as
/// `token_count` grew, eventually bricking the factory outright once the
/// ~64 KiB ledger-entry limit was reached.
#[test]
fn test_instance_storage_size_stays_flat_under_load() {
    use soroban_sdk::xdr::ToXdr;

    let s = Setup::new();

    // The exact serialized size of the `DataKey::State` entry — the only
    // per-token-count-dependent thing left in `instance` storage. Its only
    // field that changes as tokens are created is `token_count: u32`, and
    // XDR encodes `u32` as a fixed 4 bytes regardless of value, so this size
    // must be identical before and after — a precise, deterministic
    // measurement rather than a resource-cost heuristic.
    let state_size = |s: &Setup| -> u32 {
        let state: FactoryState = s.env.as_contract(&s.client.address, || {
            s.env.storage().instance().get(&DataKey::State).unwrap()
        });
        state.to_xdr(&s.env).len()
    };
    let baseline_size = state_size(&s);

    // Several hundred tokens for one creator — enough to span multiple
    // `CreatorTokens` pages (`MAX_TOKENS_BY_CREATOR_PAGE` = 50) and,
    // pre-migration, to have made the monolithic `CreatorTokens` `Vec<u32>`
    // and the shared `instance` ledger entry meaningfully bigger.
    const N: u32 = 300;
    let creator = Address::generate(&s.env);
    let expected = seed_many(&s, &creator, N);
    assert_eq!(expected.len(), N);

    assert_eq!(
        state_size(&s),
        baseline_size,
        "the instance-stored FactoryState entry must not grow after seeding {N} tokens"
    );

    // Per-token records must actually live in `persistent` storage, not
    // `instance` storage — sampled across the range, not just the first and
    // last entry.
    s.env.as_contract(&s.client.address, || {
        for i in [0u32, N / 2, N - 1] {
            let idx = expected.get(i).unwrap();
            assert!(
                s.env.storage().persistent().has(&DataKey::TokenInfo(idx)),
                "TokenInfo({idx}) must live in persistent storage"
            );
            assert!(
                !s.env.storage().instance().has(&DataKey::TokenInfo(idx)),
                "TokenInfo({idx}) must not live in instance storage"
            );
        }
        assert!(
            !s.env
                .storage()
                .instance()
                .has(&LegacyDataKey::CreatorTokens(creator.clone())),
            "the monolithic legacy CreatorTokens list must not exist for a \
             creator whose tokens were all created after the migration"
        );
    });

    // Pagination correctness across multiple pages: request a window that
    // straddles a page boundary (page size 50, so local offset 45..55 spans
    // pages 0 and 1) and confirm it matches the recorded creation order.
    let straddle = s.client.get_tokens_by_creator(&creator, &45_u32, &10_u32);
    assert_eq!(straddle.len(), 10);
    for (i, val) in straddle.iter().enumerate() {
        assert_eq!(val, expected.get(45 + i as u32).unwrap());
    }
}

// ── TTL ───────────────────────────────────────────────────────────────────────

#[test]
fn test_ttl_extended_after_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let fee_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(
        TokenFactory,
        TokenFactoryArgs::__constructor(
            &admin,
            &treasury,
            &fee_token,
            &BytesN::from_array(&env, &[0u8; 32]),
            &1_000,
            &500,
        ),
    );
    env.as_contract(&contract_id, || {
        use soroban_sdk::testutils::storage::Instance;
        let ttl = env.storage().instance().get_ttl();
        assert!(
            ttl >= MIN_TTL,
            "TTL after initialize ({ttl}) must be >= MIN_TTL ({MIN_TTL})"
        );
    });
}

// ── fee split ─────────────────────────────────────────────────────────────────

fn make_split(s: &Setup, pairs: &[(&Address, u32)]) -> Map<Address, u32> {
    let mut m = Map::new(&s.env);
    for (addr, bps) in pairs {
        m.set((*addr).clone(), *bps);
    }
    m
}

/// Build a fee-split map with `n` distinct recipients whose basis points sum
/// to exactly 10_000, for boundary-testing `MAX_FEE_SPLIT_RECIPIENTS`.
fn make_split_n(s: &Setup, n: u32) -> Map<Address, u32> {
    let mut m = Map::new(&s.env);
    let share = 10_000 / n;
    let mut distributed: u32 = 0;
    for i in 0..n {
        // The last recipient absorbs the rounding remainder so the total is
        // always exactly 10_000, matching `set_fee_split`'s validation.
        let bps = if i == n - 1 {
            10_000 - distributed
        } else {
            share
        };
        m.set(Address::generate(&s.env), bps);
        distributed += bps;
    }
    m
}

#[test]
fn test_set_fee_split_valid() {
    let s = Setup::new();
    let referral = Address::generate(&s.env);
    let splits = make_split(&s, &[(&s.treasury, 7_000), (&referral, 3_000)]);
    s.client.set_fee_split(&s.admin, &splits);
    let stored = s.client.get_fee_split();
    assert_eq!(stored.get(s.treasury.clone()).unwrap(), 7_000);
    assert_eq!(stored.get(referral).unwrap(), 3_000);
}

#[test]
fn test_set_fee_split_invalid_sum_rejected() {
    let s = Setup::new();
    let referral = Address::generate(&s.env);
    let splits = make_split(&s, &[(&s.treasury, 6_000), (&referral, 3_000)]);
    assert_eq!(
        s.client.try_set_fee_split(&s.admin, &splits),
        Err(Ok(Error::InvalidFeeSplit))
    );
}

#[test]
fn test_set_fee_split_unauthorized() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    let splits = make_split(&s, &[(&s.treasury, 10_000)]);
    assert_eq!(
        s.client.try_set_fee_split(&stranger, &splits),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn test_set_fee_split_empty_clears_split() {
    let s = Setup::new();
    let referral = Address::generate(&s.env);
    let splits = make_split(&s, &[(&s.treasury, 7_000), (&referral, 3_000)]);
    s.client.set_fee_split(&s.admin, &splits);
    s.client.set_fee_split(&s.admin, &Map::new(&s.env));
    assert!(s.client.get_fee_split().is_empty());
}

#[test]
fn test_set_fee_split_at_max_recipients_accepted() {
    let s = Setup::new();
    let splits = make_split_n(&s, MAX_FEE_SPLIT_RECIPIENTS);
    s.client.set_fee_split(&s.admin, &splits);
    assert_eq!(s.client.get_fee_split().len(), MAX_FEE_SPLIT_RECIPIENTS);
}

#[test]
fn test_set_fee_split_over_max_recipients_rejected() {
    let s = Setup::new();
    let splits = make_split_n(&s, MAX_FEE_SPLIT_RECIPIENTS + 1);
    assert_eq!(
        s.client.try_set_fee_split(&s.admin, &splits),
        Err(Ok(Error::TooManyFeeSplitRecipients))
    );
}

#[test]
fn test_fee_distributed_according_to_split() {
    let s = Setup::new();
    let referral = Address::generate(&s.env);
    let splits = make_split(&s, &[(&s.treasury, 7_000), (&referral, 3_000)]);
    s.client.set_fee_split(&s.admin, &splits);

    let admin = Address::generate(&s.env);
    s.fund(&admin, 1_000);
    let token_addr = seed_token(&s, &admin, true, None);
    let recipient = Address::generate(&s.env);
    s.client
        .mint_tokens(&token_addr, &admin, &recipient, &100, &1_000);

    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&s.treasury),
        700
    );
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&referral),
        300
    );
}

#[test]
fn test_fee_goes_to_treasury_when_no_split() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 1_000);
    let token_addr = seed_token(&s, &admin, true, None);
    let recipient = Address::generate(&s.env);
    s.client
        .mint_tokens(&token_addr, &admin, &recipient, &100, &1_000);
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&s.treasury),
        1_000
    );
}

/// Issue #918 — Task 1: 50/50 split on an odd fee amount.
///
/// When a fee is split evenly between two recipients but the amount is odd,
/// integer division floors each share by 1 unit. The total of the two floor
/// values is `amount - 1`, so the 1-unit remainder must land on `treasury`.
///
/// Concrete example (fee = 1_001, two recipients at 5_000 bps each):
///   share_a = 1_001 * 5_000 / 10_000 = 5_005_000 / 10_000 = 500  (floor)
///   share_b = 1_001 * 5_000 / 10_000 = 500  (floor)
///   distributed = 1_000
///   remainder   = 1_001 - 1_000 = 1  → goes to treasury
///
/// This test verifies:
/// 1. Each split recipient receives exactly `floor(amount / 2)`.
/// 2. The 1-unit remainder is credited to treasury, not lost or double-counted.
/// 3. The conservation law holds: share_a + share_b + treasury_delta == fee.
#[test]
fn test_fee_split_odd_amount_remainder_goes_to_treasury() {
    let s = Setup::new();
    let recipient_a = Address::generate(&s.env);
    let recipient_b = Address::generate(&s.env);

    // 50 / 50 split — must sum to exactly 10_000 bps.
    let splits = make_split(&s, &[(&recipient_a, 5_000), (&recipient_b, 5_000)]);
    s.client.set_fee_split(&s.admin, &splits);

    // Use an odd fee amount so floor division leaves a 1-unit remainder.
    let fee: i128 = 1_001;
    let admin = Address::generate(&s.env);
    s.fund(&admin, fee);
    let token_addr = seed_token(&s, &admin, true, None);
    let mint_to = Address::generate(&s.env);
    // set base_fee = fee so the exact amount is distributed
    s.client.update_fees(&s.admin, &Some(fee), &None);
    s.client
        .mint_tokens(&token_addr, &admin, &mint_to, &1, &fee);

    // Each recipient gets floor(1_001 * 5_000 / 10_000) = floor(500.5) = 500.
    let expected_each: i128 = fee * 5_000 / 10_000; // = 500
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&recipient_a),
        expected_each,
        "recipient_a must receive floor(fee/2)"
    );
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&recipient_b),
        expected_each,
        "recipient_b must receive floor(fee/2)"
    );

    // remainder = fee − (expected_each + expected_each) = 1_001 − 1_000 = 1
    let remainder = fee - expected_each * 2;
    assert_eq!(
        remainder, 1,
        "odd-amount split must leave a 1-unit remainder"
    );
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&s.treasury),
        remainder,
        "the 1-unit remainder must land on treasury"
    );

    // Conservation: every stroop accounted for.
    assert_eq!(
        expected_each + expected_each + remainder,
        fee,
        "total distributed must equal the fee exactly (no leaked or double-counted stroops)"
    );
}

/// Issue #918 — Task 2: recipient whose bps is so small that their computed
/// share floors to zero.
///
/// The `distribute_fee` function skips the `token::transfer` call for any
/// recipient whose `share == 0` (the `if share > 0` guard).  When a
/// recipient is skipped their notional share is silently folded into the
/// remainder that is sent to `treasury`.
///
/// This is the correct product behaviour — it prevents zero-value transfer
/// calls (which some SEP-41 implementations may reject) — but it means a
/// very-low-bps recipient configured alongside a small fee payment will
/// receive nothing for that particular call.  This test locks in that
/// behaviour explicitly so any future change is intentional.
///
/// Concrete example (fee = 99, three recipients: 9_999 bps, 1 bps, treasury):
///   Wait — `set_fee_split` requires the map to sum to exactly 10_000.
///   Use a simpler setup: one big recipient at 9_999 bps and one tiny
///   recipient at 1 bps.
///   share_big  = 99 * 9_999 / 10_000 = 989_901 / 10_000 = 98  (floor)
///   share_tiny = 99 * 1    / 10_000 = 99     / 10_000 = 0   (floor → skip)
///   distributed = 98
///   remainder   = 99 − 98 = 1 → goes to treasury
///   tiny_recipient balance = 0  (transfer was skipped)
///
/// This test verifies:
/// 1. The tiny recipient receives 0 (transfer correctly skipped).
/// 2. Treasury receives the full remainder (big share's rounding loss + tiny share's notional 0).
/// 3. Conservation: big_share + tiny_balance + treasury_delta == fee.
#[test]
fn test_fee_split_zero_share_recipient_skipped_remainder_to_treasury() {
    let s = Setup::new();
    let big_recipient = Address::generate(&s.env);
    let tiny_recipient = Address::generate(&s.env);

    // tiny_recipient gets 1 bps; big_recipient gets 9_999 bps.
    // Sum = 10_000 — valid split.
    let splits = make_split(&s, &[(&big_recipient, 9_999), (&tiny_recipient, 1)]);
    s.client.set_fee_split(&s.admin, &splits);

    // fee = 99: tiny share = 99 * 1 / 10_000 = 0 (floors to zero → skipped).
    let fee: i128 = 99;
    let admin = Address::generate(&s.env);
    s.fund(&admin, fee);
    let token_addr = seed_token(&s, &admin, true, None);
    let mint_to = Address::generate(&s.env);
    s.client.update_fees(&s.admin, &Some(fee), &None);
    s.client
        .mint_tokens(&token_addr, &admin, &mint_to, &1, &fee);

    let big_share: i128 = fee * 9_999 / 10_000; // = 98
    let tiny_share: i128 = fee * 1 / 10_000; //    = 0  (floors to zero)

    // The tiny recipient's share computes to 0 — the transfer is skipped.
    assert_eq!(
        tiny_share, 0,
        "precondition: tiny_share must be 0 for this test to exercise the skip path"
    );
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&tiny_recipient),
        0,
        "tiny_recipient must receive 0 — transfer must be skipped when share == 0"
    );

    // big_recipient receives their floored share.
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&big_recipient),
        big_share,
        "big_recipient must receive floor(fee * 9_999 / 10_000)"
    );

    // Treasury receives the full remainder (includes tiny_recipient's notional share).
    let remainder = fee - big_share - tiny_share;
    assert_eq!(
        TokenClient::new(&s.env, &s.fee_token).balance(&s.treasury),
        remainder,
        "treasury must receive the remainder (big-share rounding loss + tiny-share notional 0)"
    );

    // Conservation: every stroop accounted for.
    assert_eq!(
        big_share + tiny_share + remainder,
        fee,
        "total distributed must equal the fee exactly"
    );
}

/// Issue #918 — Task 3: fee conservation at MAX_FEE_SPLIT_RECIPIENTS.
///
/// Configure exactly `MAX_FEE_SPLIT_RECIPIENTS` recipients and verify that
/// the sum of all recipient balance deltas plus any treasury remainder equals
/// `fee_payment` exactly — no stroop is leaked or double-counted.
///
/// The split is intentionally uneven: one recipient gets 1_000 bps and nine
/// recipients get 1_000 bps each (10 × 1_000 = 10_000), making this a clean
/// split.  We then verify the sum invariant with a fee that is NOT evenly
/// divisible by 10 (fee = 10_001) to expose any rounding-accumulation bug in
/// the loop.
///
/// Checks:
/// 1. Exactly `MAX_FEE_SPLIT_RECIPIENTS` recipients can be configured
///    (regression guard: `set_fee_split` must not reject the cap itself).
/// 2. sum(recipient balances) + treasury_balance == fee_payment (conservation).
/// 3. No individual recipient receives more than `ceil(fee / num_recipients)`.
#[test]
fn test_fee_split_max_recipients_conservation() {
    let s = Setup::new();

    // Build MAX_FEE_SPLIT_RECIPIENTS recipients, each with equal bps.
    // 10_000 bps / 10 recipients = 1_000 bps each — exact.
    let n = super::MAX_FEE_SPLIT_RECIPIENTS;
    assert_eq!(n, 10, "test assumes MAX_FEE_SPLIT_RECIPIENTS == 10");
    let bps_each: u32 = 10_000 / n; // = 1_000

    let mut recipients: soroban_sdk::Vec<Address> = soroban_sdk::vec![&s.env];
    let mut splits_map = Map::new(&s.env);
    for _ in 0..n {
        let addr = Address::generate(&s.env);
        splits_map.set(addr.clone(), bps_each);
        recipients.push_back(addr);
    }

    // Must succeed — configuring exactly the cap is allowed.
    s.client.set_fee_split(&s.admin, &splits_map);

    // Use a fee amount that does NOT divide evenly by 10 so rounding edge
    // cases are exercised (10_001 / 10 = 1_000 remainder 1).
    let fee: i128 = 10_001;
    let admin = Address::generate(&s.env);
    s.fund(&admin, fee);
    let token_addr = seed_token(&s, &admin, true, None);
    let mint_to = Address::generate(&s.env);
    s.client.update_fees(&s.admin, &Some(fee), &None);
    s.client
        .mint_tokens(&token_addr, &admin, &mint_to, &1, &fee);

    // Sum up what each recipient actually received.
    let mut total_to_recipients: i128 = 0;
    let fee_token_client = TokenClient::new(&s.env, &s.fee_token);
    for i in 0..n {
        let balance = fee_token_client.balance(&recipients.get(i).unwrap());
        // No recipient should receive more than ceil(fee / n).
        let max_per_recipient = fee / n as i128 + 1; // generous upper bound
        assert!(
            balance <= max_per_recipient,
            "recipient {i} balance {balance} exceeds max per-recipient ceiling {max_per_recipient}"
        );
        total_to_recipients += balance;
    }

    // Treasury receives any rounding remainder.
    let treasury_balance = fee_token_client.balance(&s.treasury);

    // Conservation invariant: not a single stroop lost or double-counted.
    assert_eq!(
        total_to_recipients + treasury_balance,
        fee,
        "conservation violated: sum(recipients)={total_to_recipients} + \
         treasury={treasury_balance} != fee={fee}"
    );
}

/// Issue #918 — cap enforcement: configuring more than MAX_FEE_SPLIT_RECIPIENTS
/// is rejected with TooManyFeeSplitRecipients.
///
/// This prevents transaction-budget exhaustion and ledger-entry size overflow
/// in `distribute_fee` (see `MAX_FEE_SPLIT_RECIPIENTS` doc comment in lib.rs).
#[test]
fn test_set_fee_split_too_many_recipients_rejected() {
    let s = Setup::new();

    // Build MAX_FEE_SPLIT_RECIPIENTS + 1 recipients.  To keep the bps sum
    // valid we give the last recipient 0 bps — the map len check fires before
    // the bps-sum check, so the 0-bps entry only needs to exist in the map.
    // Actually, the simplest approach: use 11 recipients each at 909 bps
    // (sum = 9_999 ≠ 10_000) — but that also fails the sum check, which could
    // mask the cap check.  Instead: 10 recipients at 1_000 bps + 1 recipient
    // at 0 bps (sum still = 10_000).  We want the cap check to fire, so we
    // need the map to have 11 entries regardless of their values.
    //
    // The actual implementation checks `splits.len() > MAX_FEE_SPLIT_RECIPIENTS`
    // BEFORE the bps-sum check, so an 11-entry map with a valid bps sum still
    // triggers the cap error.  Use 10 × 909 bps + 1 × 910 bps = 10_000 bps
    // to construct a 11-entry map that would pass the sum check if the cap
    // check were absent.
    let n = super::MAX_FEE_SPLIT_RECIPIENTS as usize + 1; // 11
                                                          // Distribute 10_000 bps across 11 recipients: 10 get 909, 1 gets 910
                                                          // (10 * 909 + 910 = 9_090 + 910 = 10_000).
    let mut splits_map = Map::new(&s.env);
    for i in 0..n {
        let addr = Address::generate(&s.env);
        let bps: u32 = if i < n - 1 { 909 } else { 910 };
        splits_map.set(addr, bps);
    }
    assert_eq!(splits_map.len(), 11);

    assert_eq!(
        s.client.try_set_fee_split(&s.admin, &splits_map),
        Err(Ok(Error::TooManyFeeSplitRecipients)),
        "configuring more than MAX_FEE_SPLIT_RECIPIENTS recipients must be rejected"
    );
}

// ── batch token creation ──────────────────────────────────────────────────────

fn batch_param(s: &Setup, n: u8, name: &str, symbol: &str) -> BatchTokenParams {
    BatchTokenParams {
        salt: BytesN::from_array(&s.env, &[n; 32]),
        name: String::from_str(&s.env, name),
        symbol: String::from_str(&s.env, symbol),
        decimals: 7,
        initial_supply: 0,
        max_supply: None,
    }
}

fn batch_vec(s: &Setup, params: &[BatchTokenParams]) -> soroban_sdk::Vec<BatchTokenParams> {
    let mut v = soroban_sdk::vec![&s.env];
    for p in params {
        v.push_back(p.clone());
    }
    v
}

#[test]
fn test_batch_empty_rejected() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let result = s
        .client
        .try_create_tokens_batch(&creator, &soroban_sdk::vec![&s.env], &0);
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

#[test]
fn test_batch_insufficient_fee_rejected() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 500);
    let params = batch_vec(
        &s,
        &[
            batch_param(&s, 1, "TokenA", "TKA"),
            batch_param(&s, 2, "TokenB", "TKB"),
        ],
    );
    // base_fee=1_000 × 2 = 2_000; paying 1_999
    let result = s.client.try_create_tokens_batch(&creator, &params, &1_999);
    assert_eq!(result, Err(Ok(Error::InsufficientFee)));
}

#[test]
fn test_batch_invalid_name_rejects_entire_batch() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 3_000);
    let mut bad = batch_param(&s, 2, "TokenB", "TKB");
    bad.name = String::from_str(&s.env, "");
    let params = batch_vec(&s, &[batch_param(&s, 1, "TokenA", "TKA"), bad]);
    let result = s.client.try_create_tokens_batch(&creator, &params, &2_000);
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
    assert_eq!(s.client.get_state().token_count, 0);
}

#[test]
fn test_batch_blocked_when_paused() {
    let s = Setup::new();
    s.client.pause(&s.admin);
    let creator = Address::generate(&s.env);
    let params = batch_vec(&s, &[batch_param(&s, 1, "T", "T")]);
    assert_eq!(
        s.client.try_create_tokens_batch(&creator, &params, &1_000),
        Err(Ok(Error::ContractPaused))
    );
}

#[test]
fn test_batch_reentrancy_guard() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.locked = true;
        s.env.storage().instance().set(&DataKey::State, &state);
    });
    let params = batch_vec(&s, &[batch_param(&s, 1, "T", "T")]);
    assert_eq!(
        s.client.try_create_tokens_batch(&creator, &params, &1_000),
        Err(Ok(Error::Reentrancy))
    );
}

// ── reentrancy guard — all guarded entrypoints ────────────────────────────────
//
// These tests verify that every state-mutating, cross-contract-calling
// entrypoint rejects a call when `locked == true`. Because Soroban's test
// environment does not support running a malicious re-entrant WASM in-process,
// we simulate the mid-execution state by injecting `locked = true` directly
// into storage (the same mechanism used for `create_token` above). This proves
// that the guard is present and wired up correctly for each entrypoint.
//
// The cross-function reentrancy test additionally verifies that a lock set by
// *one* entrypoint (mint_tokens) also blocks a concurrent call to a *different*
// entrypoint (burn), matching the threat model of a single shared factory lock.

#[test]
fn test_mint_tokens_reentrancy_guard() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 1_000);
    let token_addr = seed_token(&s, &admin, true, None);
    let recipient = Address::generate(&s.env);

    // Simulate re-entrant state: factory is mid-execution (locked = true)
    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.locked = true;
        s.env.storage().instance().set(&DataKey::State, &state);
    });

    let result = s
        .client
        .try_mint_tokens(&token_addr, &admin, &recipient, &100, &1_000);
    assert_eq!(result, Err(Ok(Error::Reentrancy)));
}

#[test]
fn test_mint_tokens_lock_released_after_success() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 1_000);
    let token_addr = seed_token(&s, &admin, true, None);
    let recipient = Address::generate(&s.env);

    s.client
        .mint_tokens(&token_addr, &admin, &recipient, &100, &1_000);

    // Lock must be released after a successful call
    s.env.as_contract(&s.client.address, || {
        let state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        assert!(
            !state.locked,
            "lock must be released after mint_tokens succeeds"
        );
    });
}

#[test]
fn test_mint_tokens_lock_released_after_error() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    let token_addr = seed_token(&s, &admin, true, None);
    let recipient = Address::generate(&s.env);

    // InsufficientFee is caught before the lock is set, so lock stays false
    let _ = s
        .client
        .try_mint_tokens(&token_addr, &admin, &recipient, &100, &1);

    s.env.as_contract(&s.client.address, || {
        let state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        assert!(
            !state.locked,
            "lock must be released after mint_tokens error"
        );
    });
}

#[test]
fn test_burn_reentrancy_guard() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, true, None);
    let burner = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &token_addr).mint(&burner, &1_000);

    // Simulate re-entrant state
    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.locked = true;
        s.env.storage().instance().set(&DataKey::State, &state);
    });

    let result = s.client.try_burn(&token_addr, &burner, &100);
    assert_eq!(result, Err(Ok(Error::Reentrancy)));
}

#[test]
fn test_burn_lock_released_after_success() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, true, None);
    let burner = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &token_addr).mint(&burner, &1_000);

    s.client.burn(&token_addr, &burner, &100);

    s.env.as_contract(&s.client.address, || {
        let state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        assert!(!state.locked, "lock must be released after burn succeeds");
    });
}

#[test]
fn test_set_metadata_reentrancy_guard() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 500);
    let token_addr = seed_token(&s, &admin, true, None);

    // Simulate re-entrant state
    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.locked = true;
        s.env.storage().instance().set(&DataKey::State, &state);
    });

    let result = s.client.try_set_metadata(
        &token_addr,
        &admin,
        &String::from_str(&s.env, "ipfs://QmTest"),
        &500,
    );
    assert_eq!(result, Err(Ok(Error::Reentrancy)));
}

#[test]
fn test_set_metadata_lock_released_after_success() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    s.fund(&admin, 500);
    let token_addr = seed_token(&s, &admin, true, None);

    s.client.set_metadata(
        &token_addr,
        &admin,
        &String::from_str(&s.env, "ipfs://QmTest"),
        &500,
    );

    s.env.as_contract(&s.client.address, || {
        let state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        assert!(
            !state.locked,
            "lock must be released after set_metadata succeeds"
        );
    });
}

#[test]
fn test_set_burn_enabled_reentrancy_guard() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, true, None);

    // Simulate re-entrant state
    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.locked = true;
        s.env.storage().instance().set(&DataKey::State, &state);
    });

    let result = s.client.try_set_burn_enabled(&token_addr, &creator, &false);
    assert_eq!(result, Err(Ok(Error::Reentrancy)));
}

#[test]
fn test_set_burn_enabled_lock_released_after_success() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    let token_addr = seed_token(&s, &creator, true, None);

    s.client.set_burn_enabled(&token_addr, &creator, &false);

    s.env.as_contract(&s.client.address, || {
        let state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        assert!(
            !state.locked,
            "lock must be released after set_burn_enabled succeeds"
        );
    });
}

/// Cross-function reentrancy: a lock held by one entrypoint must also block
/// all other guarded entrypoints. This tests the factory-level shared lock
/// invariant — the same `locked` flag is shared across all six entrypoints,
/// so a re-entrant call from *any* external call site is blocked regardless
/// of which entrypoint is currently executing.
#[test]
fn test_cross_function_reentrancy_lock_blocks_all_entrypoints() {
    let s = Setup::new();
    let creator = Address::generate(&s.env);
    s.fund(&creator, 2_000);
    let token_addr = seed_token(&s, &creator, true, None);
    let recipient = Address::generate(&s.env);
    let burner = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &token_addr).mint(&burner, &1_000);

    // Inject locked = true to simulate mid-execution state of any entrypoint
    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.locked = true;
        s.env.storage().instance().set(&DataKey::State, &state);
    });

    // Every guarded entrypoint must be blocked
    assert_eq!(
        s.client.try_create_token(
            &creator,
            &s.salt(0),
            &String::from_str(&s.env, "T"),
            &String::from_str(&s.env, "T"),
            &7,
            &0_u128,
            &1_000,
        ),
        Err(Ok(Error::Reentrancy)),
        "create_token must be blocked"
    );

    let params = {
        let mut v = soroban_sdk::vec![&s.env];
        v.push_back(BatchTokenParams {
            salt: s.salt(1),
            name: String::from_str(&s.env, "T"),
            symbol: String::from_str(&s.env, "T"),
            decimals: 7,
            initial_supply: 0,
            max_supply: None,
        });
        v
    };
    assert_eq!(
        s.client.try_create_tokens_batch(&creator, &params, &1_000),
        Err(Ok(Error::Reentrancy)),
        "create_tokens_batch must be blocked"
    );

    assert_eq!(
        s.client
            .try_mint_tokens(&token_addr, &creator, &recipient, &100, &1_000),
        Err(Ok(Error::Reentrancy)),
        "mint_tokens must be blocked"
    );

    assert_eq!(
        s.client.try_burn(&token_addr, &burner, &100),
        Err(Ok(Error::Reentrancy)),
        "burn must be blocked"
    );

    assert_eq!(
        s.client.try_set_metadata(
            &token_addr,
            &creator,
            &String::from_str(&s.env, "ipfs://Qm"),
            &500,
        ),
        Err(Ok(Error::Reentrancy)),
        "set_metadata must be blocked"
    );

    assert_eq!(
        s.client.try_set_burn_enabled(&token_addr, &creator, &false),
        Err(Ok(Error::Reentrancy)),
        "set_burn_enabled must be blocked"
    );
}

// ── upgrade ───────────────────────────────────────────────────────────────────

#[test]
fn test_upgrade_unauthorized() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    let new_hash = s.salt(1);
    assert_eq!(
        s.client.try_upgrade(&stranger, &new_hash),
        Err(Ok(Error::Unauthorized))
    );
}

// ── migrate / schema versioning ───────────────────────────────────────────────

#[test]
fn test_initialize_sets_schema_version() {
    let s = Setup::new();
    assert_eq!(s.client.get_state().schema_version, CURRENT_SCHEMA_VERSION);
    // Standalone "sv" key must also be set
    s.env.as_contract(&s.client.address, || {
        let sv: u32 = s
            .env
            .storage()
            .instance()
            .get(&symbol_short!("sv"))
            .unwrap();
        assert_eq!(sv, CURRENT_SCHEMA_VERSION);
    });
}

#[test]
fn test_migrate_is_idempotent() {
    let s = Setup::new();
    // Calling migrate twice must not corrupt state or change the version
    s.client.migrate(&s.admin);
    s.client.migrate(&s.admin);
    assert_eq!(s.client.get_state().schema_version, CURRENT_SCHEMA_VERSION);
}

#[test]
fn test_migrate_unauthorized() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.client.try_migrate(&stranger),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn test_migrate_upgrades_pre_versioned_state() {
    let s = Setup::new();

    // Simulate a pre-versioned deployment: set sv = 0 and schema_version = 0
    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.schema_version = 0;
        s.env.storage().instance().set(&DataKey::State, &state);
        s.env.storage().instance().set(&symbol_short!("sv"), &0u32);
    });

    s.client.migrate(&s.admin);

    // A single `migrate` call walks through every pending step, so a
    // contract starting at sv = 0 lands directly on CURRENT_SCHEMA_VERSION.
    assert_eq!(s.client.get_state().schema_version, CURRENT_SCHEMA_VERSION);
    s.env.as_contract(&s.client.address, || {
        let sv: u32 = s
            .env
            .storage()
            .instance()
            .get(&symbol_short!("sv"))
            .unwrap();
        assert_eq!(sv, CURRENT_SCHEMA_VERSION);
    });
}

#[test]
fn test_migrate_preserves_state_fields() {
    let s = Setup::new();
    s.client.migrate(&s.admin);
    let state = s.client.get_state();
    // Core fields must survive migration unchanged
    assert_eq!(state.admin, s.admin);
    assert_eq!(state.treasury, s.treasury);
    assert_eq!(state.base_fee, 1_000);
    assert_eq!(state.metadata_fee, 500);
    assert!(!state.paused);
}

// ── Issue #1006: real version-2 migration (max-supply accounting fix) ─────────
//
// `CURRENT_SCHEMA_VERSION` is now 2. These tests exercise the real `migrate`
// v2 step (superseding the synthetic scaffolding this section used to carry
// while version 2 was still hypothetical) and the `backfill_capped_supply`
// entrypoint it documents.

/// Helper: read the "sv" storage key directly from contract storage.
#[cfg(test)]
fn read_sv(s: &Setup) -> u32 {
    s.env.as_contract(&s.client.address, || {
        s.env
            .storage()
            .instance()
            .get(&symbol_short!("sv"))
            .unwrap_or(0)
    })
}

/// A contract starting two versions behind (sv = 0) must walk through both
/// the 0→1 and 1→2 steps in a single `migrate` call, landing directly on
/// `CURRENT_SCHEMA_VERSION`.
#[test]
fn test_migrate_from_version_0_walks_all_steps() {
    let s = Setup::new();

    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.schema_version = 0;
        s.env.storage().instance().set(&DataKey::State, &state);
        s.env.storage().instance().set(&symbol_short!("sv"), &0u32);
    });
    assert_eq!(read_sv(&s), 0, "precondition: sv must be 0 before migrate");

    s.client.migrate(&s.admin);

    assert_eq!(read_sv(&s), CURRENT_SCHEMA_VERSION);
    assert_eq!(s.client.get_state().schema_version, CURRENT_SCHEMA_VERSION);
}

/// A contract already at version 1 must only run the 1→2 and 2→3 steps — the
/// 0→1 block must not re-run or otherwise disturb state. With no tokens
/// created (`token_count == 0`), the 2→3 step's chunked walk completes in
/// this same call, landing on `CURRENT_SCHEMA_VERSION`.
#[test]
fn test_migrate_from_version_1_only_runs_v2_step() {
    let s = Setup::new();

    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.schema_version = 1;
        s.env.storage().instance().set(&DataKey::State, &state);
        s.env.storage().instance().set(&symbol_short!("sv"), &1u32);
    });

    s.client.migrate(&s.admin);

    assert_eq!(read_sv(&s), CURRENT_SCHEMA_VERSION);
    assert_eq!(s.client.get_state().schema_version, CURRENT_SCHEMA_VERSION);
}

/// Calling `migrate` again once already at `CURRENT_SCHEMA_VERSION` must be a
/// complete no-op.
#[test]
fn test_migrate_v2_idempotent_at_current_version() {
    let s = Setup::new();

    s.client.migrate(&s.admin);
    let state_before = s.client.get_state();

    s.client.migrate(&s.admin);
    let state_after = s.client.get_state();

    assert_eq!(read_sv(&s), CURRENT_SCHEMA_VERSION);
    assert_eq!(state_after.schema_version, state_before.schema_version);
    assert_eq!(state_after.admin, state_before.admin);
    assert_eq!(state_after.base_fee, state_before.base_fee);
}

// ── backfill_capped_supply ──────────────────────────────────────────────────

#[test]
fn test_backfill_capped_supply_seeds_untracked_cap() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    // `seed_token` simulates a pre-fix capped token: `max_supply` is set but
    // no `supply` key was ever written, exactly as `deploy_one` left it
    // before the issue #1006 fix.
    let token_addr = seed_token(&s, &admin, true, Some(1_000));

    s.client
        .backfill_capped_supply(&s.admin, &token_addr, &1_000);

    // A backfilled token at its cap must reject any further mint.
    s.fund(&admin, 1_000);
    let recipient = Address::generate(&s.env);
    let result = s
        .client
        .try_mint_tokens(&token_addr, &admin, &recipient, &1, &1_000);
    assert_eq!(result, Err(Ok(Error::MaxSupplyExceeded)));
}

#[test]
fn test_backfill_capped_supply_allows_headroom_mint() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    let token_addr = seed_token(&s, &admin, true, Some(1_000));

    // initial_supply = cap - 10, reconstructed off-chain.
    s.client.backfill_capped_supply(&s.admin, &token_addr, &990);

    s.fund(&admin, 2_000);
    let recipient = Address::generate(&s.env);
    // Exactly the remaining headroom succeeds.
    s.client
        .mint_tokens(&token_addr, &admin, &recipient, &10, &1_000);
    // One more must fail.
    let result = s
        .client
        .try_mint_tokens(&token_addr, &admin, &recipient, &1, &1_000);
    assert_eq!(result, Err(Ok(Error::MaxSupplyExceeded)));
}

#[test]
fn test_backfill_capped_supply_unauthorized() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    let token_addr = seed_token(&s, &admin, true, Some(1_000));
    let stranger = Address::generate(&s.env);

    let result = s
        .client
        .try_backfill_capped_supply(&stranger, &token_addr, &500);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_backfill_capped_supply_rejects_token_without_cap() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    let token_addr = seed_token(&s, &admin, true, None);

    let result = s
        .client
        .try_backfill_capped_supply(&s.admin, &token_addr, &500);
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

#[test]
fn test_backfill_capped_supply_rejects_value_above_cap() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    let token_addr = seed_token(&s, &admin, true, Some(1_000));

    let result = s
        .client
        .try_backfill_capped_supply(&s.admin, &token_addr, &1_001);
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

#[test]
fn test_backfill_capped_supply_cannot_be_applied_twice() {
    let s = Setup::new();
    let admin = Address::generate(&s.env);
    let token_addr = seed_token(&s, &admin, true, Some(1_000));

    s.client.backfill_capped_supply(&s.admin, &token_addr, &500);
    let result = s
        .client
        .try_backfill_capped_supply(&s.admin, &token_addr, &600);
    assert_eq!(result, Err(Ok(Error::AlreadyBackfilled)));
}
