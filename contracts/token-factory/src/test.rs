#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Map, String,
};

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

        let contract_id = env.register_contract(None, TokenFactory);
        // SAFETY: the client borrows `env` which lives for the duration of the test.
        let client = TokenFactoryClient::new(&env, &contract_id);
        let client: TokenFactoryClient<'static> = unsafe { core::mem::transmute(client) };

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let fee_token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        client.initialize(
            &admin,
            &treasury,
            &fee_token,
            &dummy_hash(&env),
            &1_000,
            &500,
        );

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
        s.env
            .storage()
            .instance()
            .set(&DataKey::TokenInfo(index), &info);
        s.env.storage().instance().set(&DataKey::State, &state);
        s.env
            .storage()
            .instance()
            .set(&DataKey::TokenIndex(token_addr.clone()), &index);
        let creator_key = DataKey::CreatorTokens(creator.clone());
        let mut list: soroban_sdk::Vec<u32> = s
            .env
            .storage()
            .instance()
            .get(&creator_key)
            .unwrap_or_else(|| soroban_sdk::vec![&s.env]);
        list.push_back(index);
        s.env.storage().instance().set(&creator_key, &list);
        s.env
            .storage()
            .instance()
            .set(&(&token_addr, symbol_short!("owner")), creator);
        s.env
            .storage()
            .instance()
            .set(&(&token_addr, symbol_short!("idx")), &index);
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
    let s = Setup::new();
    let result = s.client.try_initialize(
        &s.admin,
        &s.treasury,
        &s.fee_token,
        &s.dummy_hash(),
        &1_000,
        &500,
    );
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
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

// ── TTL ───────────────────────────────────────────────────────────────────────

#[test]
fn test_ttl_extended_after_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let fee_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    client.initialize(
        &admin,
        &treasury,
        &fee_token,
        &BytesN::from_array(&env, &[0u8; 32]),
        &1_000,
        &500,
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

    assert_eq!(s.client.get_state().schema_version, 1);
    s.env.as_contract(&s.client.address, || {
        let sv: u32 = s
            .env
            .storage()
            .instance()
            .get(&symbol_short!("sv"))
            .unwrap();
        assert_eq!(sv, 1);
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

// ── whitelist enforcement ─────────────────────────────────────────────────────

/// Helper: enable whitelisting on the factory.
fn enable_whitelist(s: &Setup) {
    s.client.set_whitelist_enabled(&s.admin, &true);
}

/// Helper: add `addr` to the whitelist.
fn whitelist_add(s: &Setup, addr: &Address) {
    s.client.add_to_whitelist(&s.admin, addr);
}

#[test]
fn test_whitelist_disabled_by_default() {
    // Fresh factory must have whitelist_enabled = false so existing behaviour is unchanged.
    let s = Setup::new();
    assert!(!s.client.get_state().whitelist_enabled);
}

#[test]
fn test_set_whitelist_enabled_toggles_flag() {
    let s = Setup::new();
    s.client.set_whitelist_enabled(&s.admin, &true);
    assert!(s.client.get_state().whitelist_enabled);
    s.client.set_whitelist_enabled(&s.admin, &false);
    assert!(!s.client.get_state().whitelist_enabled);
}

#[test]
fn test_set_whitelist_enabled_unauthorized() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.client.try_set_whitelist_enabled(&stranger, &true),
        Err(Ok(Error::Unauthorized))
    );
}

/// With whitelisting disabled (default), any address can call create_token.
/// This test verifies the baseline still holds after the feature is merged.
#[test]
fn test_create_token_allowed_when_whitelist_disabled() {
    let s = Setup::new();
    // whitelisting is off; caller NOT on the whitelist must still be blocked only
    // by the fee guard — InsufficientFee, not NotWhitelisted.
    let creator = Address::generate(&s.env);
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "T"),
        &String::from_str(&s.env, "T"),
        &7,
        &0_u128,
        &1, // intentionally insufficient so the call fails predictably
    );
    assert_eq!(result, Err(Ok(Error::InsufficientFee)));
}

/// With whitelisting enabled, a non-whitelisted address receives NotWhitelisted.
#[test]
fn test_create_token_blocked_when_not_whitelisted() {
    let s = Setup::new();
    enable_whitelist(&s);

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
    assert_eq!(result, Err(Ok(Error::NotWhitelisted)));
}

/// After adding a creator to the whitelist, the fee check (not NotWhitelisted)
/// is the next gate — proving the whitelist check passed.
#[test]
fn test_create_token_whitelisted_creator_passes_whitelist_gate() {
    let s = Setup::new();
    enable_whitelist(&s);

    let creator = Address::generate(&s.env);
    whitelist_add(&s, &creator);

    // Underfund so InsufficientFee (not NotWhitelisted) is the rejection reason.
    let result = s.client.try_create_token(
        &creator,
        &s.salt(0),
        &String::from_str(&s.env, "T"),
        &String::from_str(&s.env, "T"),
        &7,
        &0_u128,
        &1, // insufficient
    );
    // If this were NotWhitelisted the whitelist gate would have fired first;
    // InsufficientFee means the creator cleared the whitelist gate.
    assert_eq!(result, Err(Ok(Error::InsufficientFee)));
}

/// add → create (via fee path) → remove → create fails: the full lifecycle.
/// Uses the insufficient-fee trick to confirm which gate fired.
#[test]
fn test_whitelist_add_remove_create_sequence() {
    let s = Setup::new();
    enable_whitelist(&s);
    let creator = Address::generate(&s.env);

    // Not whitelisted → NotWhitelisted.
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
        Err(Ok(Error::NotWhitelisted))
    );

    // Add to whitelist → passes whitelist gate (fails at fee because underfunded).
    whitelist_add(&s, &creator);
    assert_eq!(
        s.client.try_create_token(
            &creator,
            &s.salt(0),
            &String::from_str(&s.env, "T"),
            &String::from_str(&s.env, "T"),
            &7,
            &0_u128,
            &1, // insufficient on purpose
        ),
        Err(Ok(Error::InsufficientFee))
    );

    // Remove from whitelist → NotWhitelisted again.
    s.client.remove_from_whitelist(&s.admin, &creator);
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
        Err(Ok(Error::NotWhitelisted))
    );
}

/// Disabling whitelisting allows a previously un-whitelisted address to proceed.
#[test]
fn test_whitelist_disable_reopens_factory() {
    let s = Setup::new();
    enable_whitelist(&s);

    let creator = Address::generate(&s.env);
    s.fund(&creator, 1_000);

    // Blocked while enabled.
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
        Err(Ok(Error::NotWhitelisted))
    );

    // Disable — same call now fails at fee, not whitelist.
    s.client.set_whitelist_enabled(&s.admin, &false);
    assert_eq!(
        s.client.try_create_token(
            &creator,
            &s.salt(0),
            &String::from_str(&s.env, "T"),
            &String::from_str(&s.env, "T"),
            &7,
            &0_u128,
            &1, // underfunded
        ),
        Err(Ok(Error::InsufficientFee))
    );
}

// ── whitelist enforcement — batch path ───────────────────────────────────────

/// With whitelisting enabled, a non-whitelisted address is blocked on batch too.
#[test]
fn test_batch_blocked_when_not_whitelisted() {
    let s = Setup::new();
    enable_whitelist(&s);

    let creator = Address::generate(&s.env);
    s.fund(&creator, 2_000);

    let params = batch_vec(&s, &[batch_param(&s, 1, "TokenA", "TKA")]);
    let result = s.client.try_create_tokens_batch(&creator, &params, &1_000);
    assert_eq!(result, Err(Ok(Error::NotWhitelisted)));
}

/// A whitelisted creator clears the whitelist gate on batch (fails at next gate).
#[test]
fn test_batch_whitelisted_creator_passes_whitelist_gate() {
    let s = Setup::new();
    enable_whitelist(&s);

    let creator = Address::generate(&s.env);
    whitelist_add(&s, &creator);

    let params = batch_vec(&s, &[batch_param(&s, 1, "TokenA", "TKA")]);
    // Underfund so InsufficientFee (not NotWhitelisted) fires.
    let result = s.client.try_create_tokens_batch(&creator, &params, &1);
    assert_eq!(result, Err(Ok(Error::InsufficientFee)));
}

// ── whitelist events (behavioural smoke tests) ────────────────────────────────
// Note: soroban-sdk 26.x does not expose env.events().all() in test mode
// without a higher-level testutils harness.  We verify that each entrypoint
// that emits an event completes successfully (i.e. does not panic or return
// an error), which confirms the publish() call did not fail at runtime.

#[test]
fn test_add_to_whitelist_succeeds_and_persists() {
    let s = Setup::new();
    let addr = Address::generate(&s.env);
    // Must complete without error (implicitly tests event publish path too).
    s.client.add_to_whitelist(&s.admin, &addr);
    assert!(s.client.is_whitelisted(&addr));
}

#[test]
fn test_remove_from_whitelist_succeeds_and_clears() {
    let s = Setup::new();
    let addr = Address::generate(&s.env);
    s.client.add_to_whitelist(&s.admin, &addr);
    // Must complete without error.
    s.client.remove_from_whitelist(&s.admin, &addr);
    assert!(!s.client.is_whitelisted(&addr));
}

#[test]
fn test_set_whitelist_enabled_succeeds_and_updates_state() {
    let s = Setup::new();
    // Must complete without error.
    s.client.set_whitelist_enabled(&s.admin, &true);
    assert!(s.client.get_state().whitelist_enabled);
}

#[test]
fn test_add_to_whitelist_unauthorized() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    let addr = Address::generate(&s.env);
    assert_eq!(
        s.client.try_add_to_whitelist(&stranger, &addr),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn test_remove_from_whitelist_unauthorized() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    let addr = Address::generate(&s.env);
    assert_eq!(
        s.client.try_remove_from_whitelist(&stranger, &addr),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn test_is_whitelisted_returns_false_for_unknown() {
    let s = Setup::new();
    let addr = Address::generate(&s.env);
    assert!(!s.client.is_whitelisted(&addr));
}

#[test]
fn test_is_whitelisted_returns_true_after_add() {
    let s = Setup::new();
    let addr = Address::generate(&s.env);
    s.client.add_to_whitelist(&s.admin, &addr);
    assert!(s.client.is_whitelisted(&addr));
}

#[test]
fn test_is_whitelisted_returns_false_after_remove() {
    let s = Setup::new();
    let addr = Address::generate(&s.env);
    s.client.add_to_whitelist(&s.admin, &addr);
    s.client.remove_from_whitelist(&s.admin, &addr);
    assert!(!s.client.is_whitelisted(&addr));
}

// ── migrate to schema v2 ──────────────────────────────────────────────────────

#[test]
fn test_initialize_sets_whitelist_enabled_false() {
    let s = Setup::new();
    let state = s.client.get_state();
    assert!(!state.whitelist_enabled, "fresh factory must have whitelist disabled");
    assert_eq!(state.schema_version, CURRENT_SCHEMA_VERSION);
}

#[test]
fn test_migrate_v1_to_v2_sets_whitelist_enabled_false() {
    let s = Setup::new();
    // Simulate a v1 deployment: set sv = 1 and schema_version = 1.
    s.env.as_contract(&s.client.address, || {
        let mut state: FactoryState = s.env.storage().instance().get(&DataKey::State).unwrap();
        state.schema_version = 1;
        state.whitelist_enabled = false; // as it would exist after v1 migration
        s.env.storage().instance().set(&DataKey::State, &state);
        s.env.storage().instance().set(&symbol_short!("sv"), &1u32);
    });

    s.client.migrate(&s.admin);

    let state = s.client.get_state();
    assert_eq!(state.schema_version, 2);
    assert!(!state.whitelist_enabled);

    s.env.as_contract(&s.client.address, || {
        let sv: u32 = s
            .env
            .storage()
            .instance()
            .get(&symbol_short!("sv"))
            .unwrap();
        assert_eq!(sv, 2);
    });
}

#[test]
fn test_migrate_preserves_whitelist_enabled_flag() {
    let s = Setup::new();
    // Enable the flag, then migrate — it should be preserved.
    s.client.set_whitelist_enabled(&s.admin, &true);
    s.client.migrate(&s.admin);
    // migrate re-loads and writes the flag; it should not overwrite a live value.
    // (migrate v2 block sets whitelist_enabled = false when upgrading FROM v1 → v2.
    //  When already on v2, the block is skipped entirely.)
    assert!(s.client.get_state().whitelist_enabled);
}

#[test]
fn test_migrate_v2_is_idempotent() {
    let s = Setup::new();
    s.client.migrate(&s.admin);
    s.client.migrate(&s.admin);
    assert_eq!(s.client.get_state().schema_version, CURRENT_SCHEMA_VERSION);
    assert!(!s.client.get_state().whitelist_enabled);
}
