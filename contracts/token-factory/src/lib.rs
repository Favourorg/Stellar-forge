#![no_std]
#![cfg_attr(not(test), deny(clippy::unwrap_used))]
#![cfg_attr(not(test), deny(clippy::expect_used))]
#![cfg_attr(not(test), deny(clippy::panic))]
#![cfg_attr(not(test), deny(clippy::arithmetic_side_effects))]
// `Events::publish` and `DeployerWithAddress::deploy` are deprecated in favor of newer
// soroban-sdk APIs (`#[contractevent]`, `deploy_v2`). Migrating changes the contract's
// emitted-event wire format and deployment call shape, so it's deferred; suppress for now.
#![allow(deprecated)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token, vec,
    Address, BytesN, Env, Map, String, Vec,
};

/// Minimal interface for initializing a deployed SEP-41 token contract.
#[contractclient(name = "TokenInitClient")]
pub trait TokenInit {
    fn initialize(env: Env, admin: Address, decimal: u32, name: String, symbol: String);
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    State,
    TokenInfo(u32),
    CreatorTokens(Address),
    TokenIndex(Address),
    Metadata(Address),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BatchTokenParams {
    pub salt: BytesN<32>,
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    pub initial_supply: i128,
    pub max_supply: Option<i128>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenInfo {
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    pub creator: Address,
    pub created_at: u64,
    pub burn_enabled: bool,
    pub max_supply: Option<i128>,
}

/// Current schema version written by `initialize` and bumped by `migrate`.
/// Increment this constant whenever `FactoryState` gains new fields.
pub const CURRENT_SCHEMA_VERSION: u32 = 3;

#[contracttype]
#[derive(Clone)]
pub struct FactoryState {
    pub admin: Address,
    pub paused: bool,
    /// # Reentrancy guard — threat model
    ///
    /// ## What it guards against
    /// Soroban's cross-contract call model differs from EVM: each top-level
    /// transaction runs in a single host invocation, and the storage layer
    /// does **not** automatically roll back mid-function on re-entry. A
    /// malicious contract called during an in-progress factory operation
    /// (e.g. a crafted token-init WASM, a fee-split recipient that is itself
    /// a contract, or a future cross-contract callback) could re-enter the
    /// factory and observe or mutate partially-committed state — for example:
    ///
    /// - `token_count` incremented but `TokenInfo` not yet written
    /// - Fee transferred out but `creator_tokens` list not yet updated
    /// - Multiple tokens deployed with the same `salt`/`token_count` index
    ///
    /// ## Concrete sequence that `locked` prevents
    /// 1. Alice calls `create_token`.
    /// 2. Factory sets `locked = true` and starts executing.
    /// 3. During `TokenInitClient::initialize` (external call), a malicious
    ///    WASM calls back into `create_token` or `create_tokens_batch`.
    /// 4. The guard detects `locked == true` and returns `Error::Reentrancy`,
    ///    rejecting the re-entrant call before any state mutation can occur.
    ///
    /// ## Scope — all state-mutating, cross-contract-calling entrypoints
    /// The guard applies to every entrypoint that both (a) calls out to an
    /// external contract and (b) writes factory state. This currently covers:
    /// `create_token`, `create_tokens_batch`, `mint_tokens`, `burn`,
    /// `set_metadata`, and `set_burn_enabled`.
    ///
    /// ## Lock release on panic / host trap
    /// Soroban executes each top-level transaction atomically: if the host
    /// traps or the contract panics, the **entire transaction is rolled back**,
    /// including the `locked = true` write. The lock is therefore guaranteed
    /// to be released on every exit path:
    ///
    /// - **Normal return (Ok or Err)**: the outer function always writes
    ///   `locked = false` via `save_state` before returning.
    /// - **Panic / host trap**: Soroban rolls back all storage mutations for
    ///   the transaction, so `locked = true` is never persisted.
    ///
    /// This means there is no "stuck lock" risk even if an inner function
    /// panics rather than returning an `Err`.
    pub locked: bool,
    pub treasury: Address,
    pub fee_token: Address,
    pub base_fee: i128,

    pub metadata_fee: i128,
    pub token_wasm_hash: BytesN<32>,
    pub token_count: u32,
    /// Schema version of this state struct. Used by `migrate` to apply
    /// incremental upgrades without data loss.
    pub schema_version: u32,
    /// When true, only addresses on the whitelist may call `create_token` or
    /// `create_tokens_batch`.
    pub whitelist_enabled: bool,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InsufficientFee = 1,
    Unauthorized = 2,
    InvalidParameters = 3,
    TokenNotFound = 4,
    MetadataAlreadySet = 5,
    AlreadyInitialized = 6,
    BurnAmountExceedsBalance = 7,
    BurnNotEnabled = 8,
    InvalidBurnAmount = 9,
    ContractPaused = 10,
    Reentrancy = 11,
    ArithmeticOverflow = 12,
    StateNotFound = 13,
    InvalidTokenParams = 14,
    InvalidDecimals = 15,
    /// Mint would exceed the token's max supply cap
    MaxSupplyExceeded = 16,
    /// Fee split basis points do not sum to 10_000
    InvalidFeeSplit = 17,
    /// Fee split recipient count exceeds `MAX_FEE_SPLIT_RECIPIENTS`
    TooManyFeeSplitRecipients = 18,
    /// `backfill_capped_supply` already applied for this token
    AlreadyBackfilled = 19,
    /// Caller is not on the whitelist when whitelist enforcement is enabled
    NotWhitelisted = 20,
}

#[contract]
pub struct TokenFactory;

const MIN_TTL: u32 = 100_000;
const MAX_TTL: u32 = 535_000;
/// Maximum number of token indices returned in a single
/// `get_tokens_by_creator` call. Capping this keeps the resulting Vec well
/// below Stellar ledger entry size limits (~64KB) even if a prolific creator
/// has registered many tokens, which is the problem this cap was added to
/// address.
const MAX_TOKENS_BY_CREATOR_PAGE: u32 = 50;
/// Maximum number of recipients allowed in a `set_fee_split` map.
///
/// `distribute_fee` transfers a share to every configured recipient on each
/// `create_token` / `create_tokens_batch` / `mint_tokens` / `set_metadata`
/// call, so an unbounded recipient count makes every fee-paying call
/// arbitrarily expensive for the caller and risks exceeding Soroban's
/// per-transaction resource limits.
///
/// Empirically measured (`bench_fee_split_mint_*` in `bench.rs`): ledger
/// *writes* — not CPU or memory — is the binding resource, since each
/// non-zero-share recipient writes a new SEP-41 balance entry. Cost grows at
/// ~1.03 writes per recipient; at 20 recipients that's 24 of the mainnet
/// per-transaction write-entry limit of 50 (48%), leaving a 52% margin.
/// CPU/memory stay under 1.5% of their respective mainnet limits at this
/// size, even before accounting for the native-test-host underestimate
/// (~30x CPU, ~5x memory) documented in `docs/contract-abi.md`. See
/// `bench_fee_split_mint_20_within_limits` for the assertion that enforces
/// this margin going forward.
const MAX_FEE_SPLIT_RECIPIENTS: u32 = 20;

#[contractimpl]
impl TokenFactory {
    /// Constructor — runs atomically as part of contract deployment (Soroban
    /// SDK ≥ 22 `deploy_v2` constructor support), so there is no window
    /// between deployment and initialization for an attacker to front-run
    /// with their own admin/treasury. `fee_token` is the SEP-41 token used
    /// for all fee payments; fees are transferred from the caller to
    /// `treasury`.
    ///
    /// `admin.require_auth()` additionally ensures the designated admin
    /// address itself has authorized taking on that role, not just the
    /// deploying account.
    ///
    /// `base_fee` and `metadata_fee` must be **≥ 0**. A value of `0` is
    /// explicitly allowed (free token creation / free metadata). Negative
    /// values are rejected with `Error::InvalidParameters` because a negative
    /// fee satisfies every `fee_payment < required_fee` guard (making the
    /// gate trivially by-passable) and would flow a negative amount into
    /// `distribute_fee`, whose behavior with a negative SEP-41 transfer is
    /// implementation-defined on the token contract side.
    pub fn __constructor(
        env: Env,
        admin: Address,
        treasury: Address,
        fee_token: Address,
        token_wasm_hash: BytesN<32>,
        base_fee: i128,
        metadata_fee: i128,
    ) -> Result<(), Error> {
        admin.require_auth();

        if env.storage().instance().has(&DataKey::State) {
            return Err(Error::AlreadyInitialized);
        }

        // Fee sign constraint: fees must be non-negative.
        // 0 is allowed (free token creation is a legitimate use-case).
        // Negative fees corrupt the fee-gate logic and produce undefined
        // behaviour in distribute_fee — reject them unconditionally.
        if base_fee < 0 || metadata_fee < 0 {
            return Err(Error::InvalidParameters);
        }

        let state = FactoryState {
            admin: admin.clone(),
            paused: false,
            locked: false,
            treasury,
            fee_token,
            token_wasm_hash: token_wasm_hash.clone(),
            base_fee,
            metadata_fee,
            token_count: 0,
            whitelist_enabled: false,
            schema_version: CURRENT_SCHEMA_VERSION,
        };

        env.storage().instance().set(&DataKey::State, &state);
        env.storage()
            .instance()
            .set(&symbol_short!("sv"), &CURRENT_SCHEMA_VERSION);
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.events()
            .publish((symbol_short!("factory"), symbol_short!("init")), (admin,));
        Ok(())
    }

    fn load_state(env: &Env) -> Result<FactoryState, Error> {
        env.storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::StateNotFound)
    }

    fn save_state(env: &Env, state: &FactoryState) {
        env.storage().instance().set(&DataKey::State, state);
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
    }

    /// Transfer `amount` of `fee_token` from `payer` to `treasury` (or split
    /// recipients if a fee split is configured).
    fn distribute_fee(
        env: &Env,
        state: &FactoryState,
        payer: &Address,
        amount: i128,
    ) -> Result<(), Error> {
        let fee_client = token::TokenClient::new(env, &state.fee_token);
        let split_key = symbol_short!("split");

        if let Some(splits) = env
            .storage()
            .instance()
            .get::<_, Map<Address, u32>>(&split_key)
        {
            let mut distributed: i128 = 0;
            for (recipient, bps) in splits.iter() {
                // Safe: `bps` is a fee basis-points value validated by
                // `set_fee_split` to sum to exactly 10_000 (≤ i16::MAX),
                // so the cast to i128 is always lossless.
                let share = amount
                    .checked_mul(bps as i128)
                    .ok_or(Error::ArithmeticOverflow)?
                    / 10_000;
                if share > 0 {
                    fee_client.transfer(payer, &recipient, &share);
                }
                distributed = distributed
                    .checked_add(share)
                    .ok_or(Error::ArithmeticOverflow)?;
            }
            let remainder = amount
                .checked_sub(distributed)
                .ok_or(Error::ArithmeticOverflow)?;
            if remainder > 0 {
                fee_client.transfer(payer, &state.treasury, &remainder);
            }
        } else {
            fee_client.transfer(payer, &state.treasury, &amount);
        }
        Ok(())
    }

    fn extend_token_ttl(env: &Env, _token_address: &Address, _index: u32) {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
    }

    fn whitelist_key(address: &Address) -> (soroban_sdk::Symbol, Address) {
        (symbol_short!("wl"), address.clone())
    }

    pub fn add_to_whitelist(env: Env, admin: Address, address: Address) -> Result<(), Error> {
        admin.require_auth();
        let state = Self::load_state(&env)?;
        if state.admin != admin {
            return Err(Error::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&Self::whitelist_key(&address), &true);
        env.events().publish(
            (symbol_short!("factory"), symbol_short!("wl_add")),
            (address,),
        );
        Ok(())
    }

    pub fn remove_from_whitelist(env: Env, admin: Address, address: Address) -> Result<(), Error> {
        admin.require_auth();
        let state = Self::load_state(&env)?;
        if state.admin != admin {
            return Err(Error::Unauthorized);
        }
        env.storage()
            .instance()
            .remove(&Self::whitelist_key(&address));
        env.events().publish(
            (symbol_short!("factory"), symbol_short!("wl_rm")),
            (address,),
        );
        Ok(())
    }

    pub fn is_whitelisted(env: Env, address: Address) -> bool {
        env.storage()
            .instance()
            .get(&Self::whitelist_key(&address))
            .unwrap_or(false)
    }

    pub fn set_whitelist_enabled(env: Env, admin: Address, enabled: bool) -> Result<(), Error> {
        admin.require_auth();
        let mut state = Self::load_state(&env)?;
        if state.admin != admin {
            return Err(Error::Unauthorized);
        }
        state.whitelist_enabled = enabled;
        Self::save_state(&env, &state);
        env.events().publish(
            (symbol_short!("factory"), symbol_short!("wl_tog")),
            (enabled,),
        );
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), Error> {
        if Self::load_state(env)?.paused {
            return Err(Error::ContractPaused);
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_token(
        env: Env,
        creator: Address,
        salt: BytesN<32>,
        name: String,
        symbol: String,
        decimals: u32,
        initial_supply: u128,
        fee_payment: i128,
    ) -> Result<Address, Error> {
        Self::require_not_paused(&env)?;
        creator.require_auth();

        let mut state = Self::load_state(&env)?;

        if state.locked {
            return Err(Error::Reentrancy);
        }
        state.locked = true;
        Self::save_state(&env, &state);

        let result = Self::create_token_inner(
            &env,
            creator,
            salt,
            name,
            symbol,
            decimals,
            initial_supply,
            fee_payment,
            &mut state,
        );

        state.locked = false;
        Self::save_state(&env, &state);

        result
    }

    #[allow(clippy::too_many_arguments)]
    fn create_token_inner(
        env: &Env,
        creator: Address,
        salt: BytesN<32>,
        name: String,
        symbol: String,
        decimals: u32,
        initial_supply: u128,
        fee_payment: i128,
        state: &mut FactoryState,
    ) -> Result<Address, Error> {
        if name.is_empty() || name.len() > 32 {
            state.locked = false;
            return Err(Error::InvalidTokenParams);
        }
        if symbol.is_empty() || symbol.len() > 12 {
            state.locked = false;
            return Err(Error::InvalidTokenParams);
        }
        if decimals > 18 {
            state.locked = false;
            return Err(Error::InvalidParameters);
        }
        if fee_payment < state.base_fee {
            state.locked = false;
            return Err(Error::InsufficientFee);
        }
        // Whitelist gate: when enabled, only whitelisted addresses may create tokens.
        if state.whitelist_enabled {
            let wl_key = Self::whitelist_key(&creator);
            let is_wl: bool = env.storage().instance().get(&wl_key).unwrap_or(false);
            if !is_wl {
                state.locked = false;
                return Err(Error::NotWhitelisted);
            }
        }
        // initial_supply is u128 but token::mint accepts i128.
        // Values > i128::MAX silently wrap via `as i128`; reject them early.
        if initial_supply > i128::MAX as u128 {
            state.locked = false;
            return Err(Error::InvalidParameters);
        }
        // Fail fast if token count would overflow
        if state.token_count.checked_add(1).is_none() {
            state.locked = false;
            return Err(Error::ArithmeticOverflow);
        }
        // Guard: u128 values above i128::MAX would wrap silently to a negative
        // number when cast to i128, allowing a negative mint.  Reject them
        // with InvalidParameters before the cast so the invariant
        // "minted supply ≥ 0" is always upheld.
        if initial_supply > i128::MAX as u128 {
            state.locked = false;
            return Err(Error::InvalidParameters);
        }

        // Transfer fee from creator to treasury using the dedicated fee_token
        Self::distribute_fee(env, state, &creator, fee_payment)?;

        let token_address = env
            .deployer()
            .with_address(creator.clone(), salt)
            .deploy(state.token_wasm_hash.clone());

        TokenInitClient::new(env, &token_address).initialize(&creator, &decimals, &name, &symbol);

        if initial_supply > 0 {
            // Safe: value is guaranteed ≤ i128::MAX by the guard above.
            token::StellarAssetClient::new(env, &token_address)
                .mint(&creator, &(initial_supply as i128));
        }

        state.token_count = state
            .token_count
            .checked_add(1)
            .ok_or(Error::ArithmeticOverflow)?;
        let index = state.token_count;

        let token_name = name.clone();
        let token_symbol = symbol.clone();
        env.storage().instance().set(
            &DataKey::TokenInfo(index),
            &TokenInfo {
                name,
                symbol,
                decimals,
                creator: creator.clone(),
                created_at: env.ledger().timestamp(),
                burn_enabled: true,
                max_supply: None,
            },
        );

        let creator_key = DataKey::CreatorTokens(creator.clone());
        let mut list: Vec<u32> = env
            .storage()
            .instance()
            .get(&creator_key)
            .unwrap_or_else(|| vec![env]);
        list.push_back(index);
        env.storage().instance().set(&creator_key, &list);

        env.storage()
            .instance()
            .set(&DataKey::TokenIndex(token_address.clone()), &index);
        env.storage()
            .instance()
            .set(&(&token_address, symbol_short!("owner")), &creator);

        Self::extend_token_ttl(env, &token_address, index);

        env.events().publish(
            (symbol_short!("factory"), symbol_short!("created")),
            (token_address.clone(), creator, token_name, token_symbol),
        );
        Ok(token_address)
    }

    fn validate_batch_params(p: &BatchTokenParams) -> Result<(), Error> {
        if p.name.is_empty() || p.name.len() > 32 {
            return Err(Error::InvalidParameters);
        }
        if p.symbol.is_empty() || p.symbol.len() > 12 {
            return Err(Error::InvalidParameters);
        }
        if p.decimals > 18 {
            return Err(Error::InvalidParameters);
        }
        if p.initial_supply < 0 {
            return Err(Error::InvalidParameters);
        }
        if let Some(cap) = p.max_supply {
            if cap <= 0 || p.initial_supply > cap {
                return Err(Error::InvalidParameters);
            }
        }
        Ok(())
    }

    fn deploy_one(
        env: &Env,
        creator: &Address,
        p: BatchTokenParams,
        state: &mut FactoryState,
    ) -> Result<Address, Error> {
        let token_address = env
            .deployer()
            .with_address(creator.clone(), p.salt)
            .deploy(state.token_wasm_hash.clone());

        TokenInitClient::new(env, &token_address).initialize(
            creator,
            &p.decimals,
            &p.name,
            &p.symbol,
        );

        if p.initial_supply > 0 {
            token::StellarAssetClient::new(env, &token_address).mint(creator, &p.initial_supply);
        }

        // Seed the tracked-supply counter with `initial_supply` so `mint_tokens`'s
        // cap check accounts for tokens already minted at creation time.
        // Without this, a capped token created with `initial_supply == max_supply`
        // could still be minted for another full `max_supply`, since the counter
        // (which `mint_tokens` reads via `.unwrap_or(0)`) would otherwise start
        // at zero regardless of how much was minted here (issue #1006).
        if p.max_supply.is_some() {
            let supply_key = (&token_address, symbol_short!("supply"));
            env.storage().instance().set(&supply_key, &p.initial_supply);
        }

        state.token_count = state
            .token_count
            .checked_add(1)
            .ok_or(Error::ArithmeticOverflow)?;
        let index = state.token_count;

        let token_name = p.name.clone();
        let token_symbol = p.symbol.clone();
        env.storage().instance().set(
            &DataKey::TokenInfo(index),
            &TokenInfo {
                name: p.name,
                symbol: p.symbol,
                decimals: p.decimals,
                creator: creator.clone(),
                created_at: env.ledger().timestamp(),
                burn_enabled: true,
                max_supply: p.max_supply,
            },
        );

        let creator_key = DataKey::CreatorTokens(creator.clone());
        let mut list: Vec<u32> = env
            .storage()
            .instance()
            .get(&creator_key)
            .unwrap_or_else(|| vec![env]);
        list.push_back(index);
        env.storage().instance().set(&creator_key, &list);

        env.storage()
            .instance()
            .set(&DataKey::TokenIndex(token_address.clone()), &index);
        env.storage()
            .instance()
            .set(&(&token_address, symbol_short!("owner")), creator);
        Self::extend_token_ttl(env, &token_address, index);

        env.events().publish(
            (symbol_short!("factory"), symbol_short!("created")),
            (
                token_address.clone(),
                creator.clone(),
                token_name,
                token_symbol,
            ),
        );
        Ok(token_address)
    }

    pub fn create_tokens_batch(
        env: Env,
        creator: Address,
        tokens: Vec<BatchTokenParams>,
        fee_payment: i128,
    ) -> Result<Vec<Address>, Error> {
        Self::require_not_paused(&env)?;
        creator.require_auth();

        let mut state = Self::load_state(&env)?;

        if state.locked {
            return Err(Error::Reentrancy);
        }

        // Safe: Soroban `Vec::len()` returns a `u32` (at most u32::MAX ≈ 4 × 10⁹),
        // which is well within i128's positive range.  The empty-batch check
        // below immediately rejects the count == 0 case.
        let count = tokens.len() as i128;
        if count == 0 {
            return Err(Error::InvalidParameters);
        }

        for p in tokens.iter() {
            Self::validate_batch_params(&p)?;
        }

        // Front-load token count overflow check for the entire batch before any deployment happens.
        state
            .token_count
            .checked_add(tokens.len())
            .ok_or(Error::ArithmeticOverflow)?;

        let total_fee = state
            .base_fee
            .checked_mul(count)
            .ok_or(Error::ArithmeticOverflow)?;
        if fee_payment < total_fee {
            return Err(Error::InsufficientFee);
        }
        // Whitelist gate: when enabled, only whitelisted addresses may create tokens.
        if state.whitelist_enabled {
            let wl_key = Self::whitelist_key(&creator);
            let is_wl: bool = env.storage().instance().get(&wl_key).unwrap_or(false);
            if !is_wl {
                return Err(Error::NotWhitelisted);
            }
        }

        state.locked = true;
        Self::save_state(&env, &state);

        let mut addresses: Vec<Address> = vec![&env];

        // Soroban enforces per-invocation ledger atomicity: if any host error, panic,
        // or Err occurs during deployment or fee transfer, the entire invocation transaction
        // (including all deployed sub-tokens, storage updates, and mints) is automatically reverted.
        for p in tokens.into_iter() {
            let addr = Self::deploy_one(&env, &creator, p, &mut state)?;
            addresses.push_back(addr);
        }

        // Transfer fee from creator to treasury using the dedicated fee_token
        Self::distribute_fee(&env, &state, &creator, fee_payment)?;
        state.locked = false;
        Self::save_state(&env, &state);
        Ok(addresses)
    }

    pub fn set_metadata(
        env: Env,
        token_address: Address,
        admin: Address,
        metadata_uri: String,
        fee_payment: i128,
    ) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        admin.require_auth();

        let mut state = Self::load_state(&env)?;

        if state.locked {
            return Err(Error::Reentrancy);
        }

        if fee_payment < state.metadata_fee {
            return Err(Error::InsufficientFee);
        }

        let creator: Address = env
            .storage()
            .instance()
            .get(&(&token_address, symbol_short!("owner")))
            .ok_or(Error::TokenNotFound)?;

        if creator != admin {
            return Err(Error::Unauthorized);
        }

        if env
            .storage()
            .instance()
            .has(&DataKey::Metadata(token_address.clone()))
        {
            return Err(Error::MetadataAlreadySet);
        }

        state.locked = true;
        Self::save_state(&env, &state);

        // Transfer fee from admin to treasury using the dedicated fee_token
        Self::distribute_fee(&env, &state, &admin, fee_payment)?;

        env.storage()
            .instance()
            .set(&DataKey::Metadata(token_address.clone()), &metadata_uri);
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        state.locked = false;
        Self::save_state(&env, &state);

        env.events().publish(
            (symbol_short!("factory"), symbol_short!("meta")),
            (token_address, metadata_uri),
        );
        Ok(())
    }

    pub fn mint_tokens(
        env: Env,
        token_address: Address,
        admin: Address,
        to: Address,
        amount: i128,
        fee_payment: i128,
    ) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        admin.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidParameters);
        }

        let mut state = Self::load_state(&env)?;

        if state.locked {
            return Err(Error::Reentrancy);
        }

        if fee_payment < state.base_fee {
            return Err(Error::InsufficientFee);
        }

        // Fetch token index and verify creator authorization
        let index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TokenIndex(token_address.clone()))
            .ok_or(Error::TokenNotFound)?;

        let token_info: TokenInfo = env
            .storage()
            .instance()
            .get(&DataKey::TokenInfo(index))
            .ok_or(Error::TokenNotFound)?;

        // Verify admin is the token creator using direct mapping
        let creator: Address = env
            .storage()
            .instance()
            .get(&(&token_address, symbol_short!("owner")))
            .ok_or(Error::TokenNotFound)?;

        if creator != admin {
            return Err(Error::Unauthorized);
        }

        if let Some(cap) = token_info.max_supply {
            let supply_key = (&token_address, symbol_short!("supply"));
            let current: i128 = env.storage().instance().get(&supply_key).unwrap_or(0i128);
            let new_total = current
                .checked_add(amount)
                .ok_or(Error::ArithmeticOverflow)?;
            if new_total > cap {
                return Err(Error::MaxSupplyExceeded);
            }
            env.storage().instance().set(&supply_key, &new_total);
        }

        state.locked = true;
        Self::save_state(&env, &state);

        // Transfer fee from admin to treasury using the dedicated fee_token
        Self::distribute_fee(&env, &state, &admin, fee_payment)?;

        token::StellarAssetClient::new(&env, &token_address).mint(&to, &amount);

        state.locked = false;
        Self::save_state(&env, &state);

        env.events().publish(
            (symbol_short!("factory"), symbol_short!("mint")),
            (token_address, to, amount),
        );
        Ok(())
    }

    pub fn burn(
        env: Env,
        token_address: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), Error> {
        from.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidBurnAmount);
        }

        let token = token::TokenClient::new(&env, &token_address);
        let balance = token.balance(&from);
        if amount > balance {
            return Err(Error::BurnAmountExceedsBalance);
        }

        if let Some(index) = env
            .storage()
            .instance()
            .get::<_, u32>(&DataKey::TokenIndex(token_address.clone()))
        {
            let info: TokenInfo = env
                .storage()
                .instance()
                .get(&DataKey::TokenInfo(index))
                .ok_or(Error::TokenNotFound)?;
            if !info.burn_enabled {
                return Err(Error::Unauthorized);
            }
        }

        // Acquire the reentrancy lock before the external burn call.
        // `burn` calls into an externally-deployed token contract, which
        // could theoretically call back into the factory. The lock prevents
        // any re-entrant factory call from seeing or mutating partially-
        // committed state.
        //
        // Note: `burn` does not load a full FactoryState (it is intentionally
        // lightweight and works even when the factory is paused), so we guard
        // via a direct storage read/write rather than through `load_state`.
        let state_key = DataKey::State;
        if let Some(mut state) = env.storage().instance().get::<_, FactoryState>(&state_key) {
            if state.locked {
                return Err(Error::Reentrancy);
            }
            state.locked = true;
            env.storage().instance().set(&state_key, &state);
            env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

            token.burn(&from, &amount);

            state.locked = false;
            env.storage().instance().set(&state_key, &state);
            env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        } else {
            // Factory not initialized — proceed without the lock (no state to protect).
            token.burn(&from, &amount);
        }

        env.events().publish(
            (symbol_short!("factory"), symbol_short!("burn")),
            (token_address, from, amount),
        );
        Ok(())
    }

    pub fn set_burn_enabled(
        env: Env,
        token_address: Address,
        admin: Address,
        enabled: bool,
    ) -> Result<(), Error> {
        admin.require_auth();

        let mut state = Self::load_state(&env)?;

        if state.locked {
            return Err(Error::Reentrancy);
        }

        let creator: Address = env
            .storage()
            .instance()
            .get(&(&token_address, symbol_short!("owner")))
            .ok_or(Error::TokenNotFound)?;

        if creator != admin {
            return Err(Error::Unauthorized);
        }

        let index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TokenIndex(token_address.clone()))
            .ok_or(Error::TokenNotFound)?;

        let mut info: TokenInfo = env
            .storage()
            .instance()
            .get(&DataKey::TokenInfo(index))
            .ok_or(Error::TokenNotFound)?;

        // set_burn_enabled does not make any external cross-contract calls, so
        // the lock is acquired and immediately released in the same call frame.
        // It is guarded anyway for consistency: all state-mutating entrypoints
        // share the same invariant so future additions cannot accidentally
        // introduce cross-contract calls without being noticed as "already
        // guarded" or "newly needs the guard".
        state.locked = true;
        Self::save_state(&env, &state);

        info.burn_enabled = enabled;
        env.storage()
            .instance()
            .set(&DataKey::TokenInfo(index), &info);
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        state.locked = false;
        Self::save_state(&env, &state);

        Ok(())
    }

    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let mut state = Self::load_state(&env)?;
        if state.admin != admin {
            return Err(Error::Unauthorized);
        }
        state.paused = true;
        Self::save_state(&env, &state);
        env.events()
            .publish((symbol_short!("factory"), symbol_short!("pause")), (admin,));
        Ok(())
    }

    pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let mut state = Self::load_state(&env)?;
        if state.admin != admin {
            return Err(Error::Unauthorized);
        }
        state.paused = false;
        Self::save_state(&env, &state);
        env.events().publish(
            (symbol_short!("factory"), symbol_short!("unpause")),
            (admin,),
        );
        Ok(())
    }

    pub fn set_fee_split(env: Env, admin: Address, splits: Map<Address, u32>) -> Result<(), Error> {
        admin.require_auth();
        let state = Self::load_state(&env)?;
        if state.admin != admin {
            return Err(Error::Unauthorized);
        }

        let split_key = symbol_short!("split");

        if splits.is_empty() {
            env.storage().instance().remove(&split_key);
            return Ok(());
        }

        // Fail fast on an oversized map before paying for the summation loop
        // below — see `MAX_FEE_SPLIT_RECIPIENTS` for why this bound exists.
        // Guard: cap the number of recipients to prevent transaction-budget
        // exhaustion and ledger-entry size overflow in `distribute_fee`.
        // Exceeding the cap is rejected with `TooManyFeeSplitRecipients` so
        // callers get a meaningful error rather than a silent host-level failure.
        if splits.len() > MAX_FEE_SPLIT_RECIPIENTS {
            return Err(Error::TooManyFeeSplitRecipients);
        }

        let mut total: u32 = 0;
        for (_, bps) in splits.iter() {
            total = total.checked_add(bps).ok_or(Error::ArithmeticOverflow)?;
        }
        if total != 10_000 {
            return Err(Error::InvalidFeeSplit);
        }

        env.storage().instance().set(&split_key, &splits);
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        Ok(())
    }

    pub fn get_fee_split(env: Env) -> Map<Address, u32> {
        env.storage()
            .instance()
            .get(&symbol_short!("split"))
            .unwrap_or_else(|| Map::new(&env))
    }

    pub fn update_fees(
        env: Env,
        admin: Address,
        base_fee: Option<i128>,
        metadata_fee: Option<i128>,
    ) -> Result<(), Error> {
        admin.require_auth();
        let mut state = Self::load_state(&env)?;
        if admin != state.admin {
            return Err(Error::Unauthorized);
        }
        // Fee sign constraint — same policy as initialize: 0 is allowed,
        // negative values are rejected.  A negative fee would silently bypass
        // every fee-gate check (`fee_payment < required_fee` is always false
        // when required_fee < 0) and pass a negative amount to distribute_fee.
        if let Some(fee) = base_fee {
            if fee < 0 {
                return Err(Error::InvalidParameters);
            }
            state.base_fee = fee;
        }
        if let Some(fee) = metadata_fee {
            if fee < 0 {
                return Err(Error::InvalidParameters);
            }
            state.metadata_fee = fee;
        }
        Self::save_state(&env, &state);
        env.events().publish(
            (symbol_short!("factory"), symbol_short!("fees")),
            (base_fee, metadata_fee),
        );
        Ok(())
    }

    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        admin.require_auth();
        let state = Self::load_state(&env)?;
        if state.admin != admin {
            return Err(Error::Unauthorized);
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn migrate(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let state = Self::load_state(&env)?;
        if state.admin != admin {
            return Err(Error::Unauthorized);
        }
        let sv_key = symbol_short!("sv");

        // `on_chain_version` is declared `mut` so that each migration step can
        // bump it immediately after it runs.  This is the critical detail that
        // makes multi-step migrations compose correctly: the *next* `if` block
        // compares against the value that was just written, not the value that
        // was read before any step ran.  Without the `mut` + in-place bump the
        // second block would still see the original version and would either
        // run unconditionally (wrong) or not run at all (also wrong).
        let mut on_chain_version: u32 = env.storage().instance().get(&sv_key).unwrap_or(0);

        if on_chain_version < 1 {
            // Version 1: stamp schema_version onto pre-versioned state.
            let mut s = Self::load_state(&env)?;
            s.schema_version = 1;
            Self::save_state(&env, &s);
            on_chain_version = 1;
            env.storage().instance().set(&sv_key, &on_chain_version);
        }

        if on_chain_version < 2 {
            // Version 2: fixes the max-supply accounting bug (issue #1006) where
            // `deploy_one` never seeded the tracked-supply counter with
            // `initial_supply`, letting a capped token be minted past its
            // advertised cap. This step only bumps the version marker — it does
            // NOT loop over every stored `TokenInfo`, because `token_count` is
            // unbounded and rewriting every entry inside a single `migrate` call
            // could exceed the transaction's instruction budget.
            //
            // Tokens created before this fix that have `max_supply` configured
            // still have an under-seeded (or absent) supply counter. There is no
            // on-chain record of their true `initial_supply` to recover it
            // automatically. Operators must back-fill each affected token
            // individually via `backfill_capped_supply`, supplying a
            // `verified_supply` reconstructed off-chain (e.g. by summing every
            // `mint` event the token contract itself has emitted since
            // deployment). See docs/contract-abi.md ("Supply cap accounting")
            // for the full back-fill procedure and its limitations.
            let mut s = Self::load_state(&env)?;
            s.schema_version = 2;
            Self::save_state(&env, &s);
            on_chain_version = 2;
            env.storage().instance().set(&sv_key, &on_chain_version);
        }

        if on_chain_version < 3 {
            // Version 3: add the `whitelist_enabled` field, defaulting to
            // `false` so existing deployments keep their open behaviour until an
            // admin explicitly enables enforcement via `set_whitelist_enabled`.
            let mut s = Self::load_state(&env)?;
            s.whitelist_enabled = false;
            s.schema_version = 3;
            Self::save_state(&env, &s);
            on_chain_version = 3;
            env.storage().instance().set(&sv_key, &on_chain_version);
        }

        // Each future migration step follows the same pattern:
        //
        //   if on_chain_version < N {
        //       // … apply N-specific changes …
        //       on_chain_version = N;
        //       env.storage().instance().set(&sv_key, &on_chain_version);
        //   }
        //
        // Because `on_chain_version` is updated in-place between blocks,
        // a contract that is K versions behind will walk through every pending
        // step in a single `migrate` call, arriving at CURRENT_SCHEMA_VERSION.

        let _ = on_chain_version; // suppress unused-variable warning when no further steps exist
        Ok(())
    }

    /// One-time back-fill of the tracked-supply counter for a capped token
    /// created before `deploy_one` began seeding it with `initial_supply`
    /// (issue #1006). See docs/contract-abi.md for the full procedure.
    ///
    /// `verified_supply` must be independently reconstructed off-chain — the
    /// factory has no on-chain record of a pre-fix token's true initial
    /// supply. A reliable source is the sum of every `mint` event the token
    /// contract itself has emitted since deployment (queryable via RPC /
    /// Horizon even though the factory never stored it).
    ///
    /// Guards: admin-only; the token must exist and have `max_supply`
    /// configured; `verified_supply` must fit within the cap; and this may
    /// only be applied once per token, so it cannot be used as a repeated
    /// backdoor to rewrite tracked supply after the fact.
    pub fn backfill_capped_supply(
        env: Env,
        admin: Address,
        token_address: Address,
        verified_supply: i128,
    ) -> Result<(), Error> {
        admin.require_auth();
        let state = Self::load_state(&env)?;
        if state.admin != admin {
            return Err(Error::Unauthorized);
        }

        let index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TokenIndex(token_address.clone()))
            .ok_or(Error::TokenNotFound)?;
        let token_info: TokenInfo = env
            .storage()
            .instance()
            .get(&DataKey::TokenInfo(index))
            .ok_or(Error::TokenNotFound)?;
        let cap = token_info.max_supply.ok_or(Error::InvalidParameters)?;

        if verified_supply < 0 || verified_supply > cap {
            return Err(Error::InvalidParameters);
        }

        let backfill_marker = (&token_address, symbol_short!("bkfld"));
        if env.storage().instance().has(&backfill_marker) {
            return Err(Error::AlreadyBackfilled);
        }

        let supply_key = (&token_address, symbol_short!("supply"));
        let current: i128 = env.storage().instance().get(&supply_key).unwrap_or(0i128);
        if verified_supply > current {
            env.storage().instance().set(&supply_key, &verified_supply);
        }
        env.storage().instance().set(&backfill_marker, &true);
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        Ok(())
    }

    pub fn transfer_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let mut state = Self::load_state(&env)?;
        if state.admin != admin {
            return Err(Error::Unauthorized);
        }
        if admin == new_admin {
            return Err(Error::InvalidParameters);
        }
        state.admin = new_admin;
        Self::save_state(&env, &state);
        Ok(())
    }

    pub fn update_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), Error> {
        current_admin.require_auth();
        let mut state = Self::load_state(&env)?;
        if state.admin != current_admin {
            return Err(Error::Unauthorized);
        }
        if current_admin == new_admin {
            return Err(Error::InvalidParameters);
        }
        state.admin = new_admin.clone();
        Self::save_state(&env, &state);
        env.events().publish(
            (symbol_short!("factory"), symbol_short!("adm_upd")),
            (current_admin, new_admin),
        );
        Ok(())
    }

    pub fn get_state(env: Env) -> Result<FactoryState, Error> {
        Self::load_state(&env)
    }

    pub fn get_base_fee(env: Env) -> Result<i128, Error> {
        Ok(Self::load_state(&env)?.base_fee)
    }

    pub fn get_metadata_fee(env: Env) -> Result<i128, Error> {
        Ok(Self::load_state(&env)?.metadata_fee)
    }

    pub fn get_token_info(env: Env, index: u32) -> Result<TokenInfo, Error> {
        env.storage()
            .instance()
            .get(&DataKey::TokenInfo(index))
            .ok_or(Error::TokenNotFound)
    }

    /// Resolve a token's storage index from its contract address.
    ///
    /// The `TokenIndex(address)` mapping is written by `create_token` /
    /// `create_tokens_batch` when a token is registered, so this is the
    /// authoritative address → index lookup. Returns `TokenNotFound` when the
    /// address was never registered with this factory.
    ///
    /// This exists so off-chain clients can resolve a token's identity in O(1)
    /// from its address alone, rather than re-deriving it from the factory's
    /// event stream — which only reflects a bounded RPC retention window and
    /// silently truncates once history exceeds one page.
    pub fn get_token_index(env: Env, token_address: Address) -> Result<u32, Error> {
        env.storage()
            .instance()
            .get(&DataKey::TokenIndex(token_address))
            .ok_or(Error::TokenNotFound)
    }

    /// Return a token's full `TokenInfo` addressed by its contract address.
    ///
    /// Equivalent to `get_token_info(get_token_index(address))` but in a single
    /// call. This is the source of truth for a token's name, symbol, decimals,
    /// creator and creation time — clients must prefer it over event-derived
    /// data, which cannot be trusted for tokens created outside the RPC's
    /// event-retention window. Returns `TokenNotFound` for unregistered
    /// addresses.
    pub fn get_token_info_by_address(
        env: Env,
        token_address: Address,
    ) -> Result<TokenInfo, Error> {
        let index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TokenIndex(token_address))
            .ok_or(Error::TokenNotFound)?;
        env.storage()
            .instance()
            .get(&DataKey::TokenInfo(index))
            .ok_or(Error::TokenNotFound)
    }

    /// Return the metadata URI set for a token, or `None` if none was set.
    ///
    /// Metadata is written by `set_metadata` and stored under
    /// `DataKey::Metadata(address)`. Exposing it as a view lets clients read
    /// the current URI directly from contract state instead of scanning `meta`
    /// events, which are subject to the same retention truncation as every
    /// other event.
    pub fn get_metadata(env: Env, token_address: Address) -> Option<String> {
        env.storage()
            .instance()
            .get(&DataKey::Metadata(token_address))
    }

    /// Return a paginated slice of token indices for `creator`.
    ///
    /// `offset` is the 0-based index of the first element to return, and
    /// `limit` is the maximum number of elements to return. Both must be `u32`.
    ///
    /// The returned `Vec` size is bounded by `MAX_TOKENS_BY_CREATOR_PAGE` so
    /// the function never produces a value large enough to exceed Stellar
    /// ledger entry size limits, even on mainnet where prolific creators can
    /// have hundreds of registered tokens. Callers that need to iterate
    /// through more than one page should advance `offset` by the previous
    /// page's length until the returned Vec is shorter than `limit`.
    ///
    /// Edge cases:
    /// - `limit == 0` → empty `Vec` (requesting zero items is invalid but
    ///   handled defensively rather than erroring, since this is a read-only
    ///   view function).
    /// - `limit > MAX_TOKENS_BY_CREATOR_PAGE` → `limit` is clamped down to
    ///   the cap, defending the contract against callers requesting
    ///   arbitrarily large pages.
    /// - `offset >= total` → empty `Vec` (past-the-end iteration).
    /// - `creator` has no stored entries → empty `Vec`.
    pub fn get_tokens_by_creator(env: Env, creator: Address, offset: u32, limit: u32) -> Vec<u32> {
        let key = DataKey::CreatorTokens(creator);
        let list: Vec<u32> = env
            .storage()
            .instance()
            .get(&key)
            .unwrap_or_else(|| vec![&env]);

        if limit == 0 {
            return vec![&env];
        }

        // Clamp the requested page size to prevent pathologically large
        // responses from causing ledger entry size errors.
        let effective_limit = if limit > MAX_TOKENS_BY_CREATOR_PAGE {
            MAX_TOKENS_BY_CREATOR_PAGE
        } else {
            limit
        };

        let total = list.len();
        if offset >= total {
            return vec![&env];
        }

        // Saturating arithmetic: `offset + effective_limit` could overflow
        // when callers pass `offset = u32::MAX - small`; cap at `total`.
        let end = core::cmp::min(offset.saturating_add(effective_limit), total);

        let mut page: Vec<u32> = vec![&env];
        let mut i: u32 = offset;
        // `Vec::try_get` returns `Result<Option<u32>, ConversionError>`.
        // Using `Vec::get` instead would panic on bounds and (via its
        // internal unwrap) trigger the workspace's denied
        // `clippy::expect_used` / `clippy::panic` lints. Treating any
        // conversion error or missing entry as end-of-iteration matches the
        // storage invariant: a creator's `Vec<u32>` has no holes.
        while i < end {
            if let Ok(Some(val)) = list.try_get(i) {
                page.push_back(val);
                i = i.saturating_add(1);
            } else {
                break;
            }
        }
        page
    }
}

#[cfg(test)]
mod test;

// Benchmarks need a real token WASM installed in the env, which plain unit
// tests can't provide; opt in via `cargo test --features bench bench_`.
#[cfg(all(test, feature = "bench"))]
mod bench;
