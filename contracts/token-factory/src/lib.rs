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
    Address, BytesN, Env, IntoVal, Map, String, TryFromVal, Val, Vec,
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
    /// Per-token metadata record, keyed by 1-based creation index. Lives in
    /// `persistent` storage (see "Storage architecture" below).
    TokenInfo(u32),
    /// A page of up to `MAX_TOKENS_BY_CREATOR_PAGE` token indices belonging
    /// to `creator`. Pages are append-only and never rewritten once full, so
    /// no single persistent entry grows without bound as a creator
    /// registers more tokens.
    CreatorTokens(Address, u32),
    /// Total number of tokens registered to `creator`. Determines which
    /// page a new index is appended to and lets readers compute page
    /// boundaries without loading every page.
    CreatorTokenCount(Address),
    TokenIndex(Address),
    Metadata(Address),
}

/// Legacy (pre-schema-v3) `DataKey::CreatorTokens` shape: a single
/// unbounded `Vec<u32>` per creator stored in `instance` storage. Kept only
/// so `migrate`/lazy migration can still read data written before the
/// paginated-persistent-storage migration (issue #1007). Do not write new
/// data under this key — use `DataKey::CreatorTokens(Address, u32)`.
#[contracttype]
#[derive(Clone)]
enum LegacyDataKey {
    CreatorTokens(Address),
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
    /// `backfill_capped_supply` already applied for this token
    AlreadyBackfilled = 18,
    /// Fee split recipient count exceeds `MAX_FEE_SPLIT_RECIPIENTS`
    TooManyFeeSplitRecipients = 19,
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
/// Number of `TokenInfo` entries the schema-v3 `migrate` step moves from
/// `instance` to `persistent` storage per call. Bounded so a factory with a
/// large `token_count` can still complete its migration by calling
/// `migrate` repeatedly instead of exceeding a single invocation's resource
/// budget.
const MIGRATE_TOKEN_INFO_CHUNK: u32 = 20;

/// Maximum number of recipients allowed in a single fee split map.
///
/// ## Rationale
/// `distribute_fee` loops over every recipient in the split map and makes one
/// external `token::transfer` call per recipient.  Each cross-contract call
/// consumes ledger CPU and I/O budget, and the map itself is stored as a
/// Soroban `Map` entry whose encoded size grows with the number of keys.
/// Unbounded recipient counts therefore create two distinct DoS surfaces:
///
/// 1. **Transaction budget exhaustion** — enough recipients can push a single
///    `create_token` / `mint_tokens` / `set_metadata` call over Stellar's
///    per-transaction instruction limit, making the factory unusable.
/// 2. **Ledger entry size overflow** — a sufficiently large `Map` could
///    exceed the ~64 KB ledger entry size cap and cause the `set_fee_split`
///    call itself to fail at the host level rather than at the contract level.
///
/// The cap of 10 is conservative and gives the admin ample flexibility
/// (typical treasury + referral + protocol fund structures need ≤ 5) while
/// keeping `distribute_fee` well within budget on any supported network.
///
/// Enforcement is in `set_fee_split`: attempts to configure more than
/// `MAX_FEE_SPLIT_RECIPIENTS` recipients are rejected with
/// `Error::TooManyFeeSplitRecipients` before any storage write occurs.
pub const MAX_FEE_SPLIT_RECIPIENTS: u32 = 10;

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

    // ─── persistent-storage helpers (issue #1007) ──────────────────────────
    //
    // All per-token and per-creator bookkeeping lives in `persistent`
    // storage rather than `instance` storage, so its size and TTL are
    // tracked per-entry instead of as one ever-growing ledger entry shared
    // with the contract instance itself. Every read/write goes through the
    // helpers below so the TTL of the specific key touched is always
    // extended on access ("Implement extend_ttl correctly per persistent
    // key on access").
    //
    // Two lookup helpers exist because entries written by factory binaries
    // predating this migration still live in `instance` storage:
    //
    // - `read_addr_keyed` is for pure view entrypoints: persistent first,
    //   falling back to the legacy `instance` copy if present, but never
    //   writing storage. Keeps read-only calls free of a write footprint.
    // - `migrate_addr_keyed` is for mutating entrypoints, which already pay
    //   for a write: it performs the same fallback lookup, but if the value
    //   is only found in legacy `instance` storage it copies it into
    //   `persistent` storage (extending its TTL) and removes the `instance`
    //   copy, so the next access — from either helper — is O(1) against the
    //   persistent entry alone.
    //
    // `TokenInfo` is additionally migrated in bulk by `migrate`'s schema-v3
    // step (see below), since its key space (`1..=token_count`) is fully
    // enumerable; `migrate_addr_keyed` remains a safety net for any indices
    // that step hasn't reached yet.

    fn set_persistent<K, V>(env: &Env, key: &K, val: &V)
    where
        K: IntoVal<Env, Val>,
        V: IntoVal<Env, Val>,
    {
        env.storage().persistent().set(key, val);
        env.storage().persistent().extend_ttl(key, MIN_TTL, MAX_TTL);
    }

    fn read_addr_keyed<K, V>(env: &Env, key: &K) -> Option<V>
    where
        K: IntoVal<Env, Val>,
        V: TryFromVal<Env, Val>,
    {
        if let Some(v) = env.storage().persistent().get(key) {
            return Some(v);
        }
        env.storage().instance().get(key)
    }

    fn migrate_addr_keyed<K, V>(env: &Env, key: &K) -> Option<V>
    where
        K: IntoVal<Env, Val>,
        V: TryFromVal<Env, Val> + IntoVal<Env, Val>,
    {
        if let Some(v) = env.storage().persistent().get::<K, V>(key) {
            env.storage().persistent().extend_ttl(key, MIN_TTL, MAX_TTL);
            return Some(v);
        }
        let legacy: Option<V> = env.storage().instance().get(key);
        if let Some(v) = legacy {
            Self::set_persistent(env, key, &v);
            env.storage().instance().remove(key);
            return Some(v);
        }
        None
    }

    /// Append `index` to `creator`'s paginated token list, lazily migrating
    /// their legacy monolithic `instance` list (if any) into persistent
    /// pages first. Lazy per-creator migration here — rather than an
    /// explicit bulk step in `migrate` — is necessary because creator
    /// addresses aren't enumerable from factory state; the only points a
    /// given creator's data is ever touched are token-creation calls like
    /// this one.
    fn append_creator_token(env: &Env, creator: &Address, index: u32) -> Result<(), Error> {
        let count_key = DataKey::CreatorTokenCount(creator.clone());
        let mut count: u32 = match env.storage().persistent().get(&count_key) {
            Some(c) => {
                env.storage()
                    .persistent()
                    .extend_ttl(&count_key, MIN_TTL, MAX_TTL);
                c
            }
            None => {
                // Not migrated yet — pull the whole legacy list (if any) into
                // page 0..N up front so subsequent appends only ever touch
                // the current tail page.
                let legacy_key = LegacyDataKey::CreatorTokens(creator.clone());
                let legacy: Vec<u32> = env
                    .storage()
                    .instance()
                    .get(&legacy_key)
                    .unwrap_or_else(|| vec![env]);
                env.storage().instance().remove(&legacy_key);

                let mut migrated: u32 = 0;
                let mut bucket: Vec<u32> = vec![env];
                for tok_index in legacy.iter() {
                    bucket.push_back(tok_index);
                    migrated = migrated.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
                    if migrated % MAX_TOKENS_BY_CREATOR_PAGE == 0 {
                        let page = (migrated / MAX_TOKENS_BY_CREATOR_PAGE)
                            .checked_sub(1)
                            .ok_or(Error::ArithmeticOverflow)?;
                        Self::set_persistent(
                            env,
                            &DataKey::CreatorTokens(creator.clone(), page),
                            &bucket,
                        );
                        bucket = vec![env];
                    }
                }
                if !bucket.is_empty() {
                    let page = migrated / MAX_TOKENS_BY_CREATOR_PAGE;
                    Self::set_persistent(
                        env,
                        &DataKey::CreatorTokens(creator.clone(), page),
                        &bucket,
                    );
                }
                migrated
            }
        };

        let page = count / MAX_TOKENS_BY_CREATOR_PAGE;
        let page_key = DataKey::CreatorTokens(creator.clone(), page);
        let mut bucket: Vec<u32> = env
            .storage()
            .persistent()
            .get(&page_key)
            .unwrap_or_else(|| vec![env]);
        bucket.push_back(index);
        Self::set_persistent(env, &page_key, &bucket);

        count = count.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
        Self::set_persistent(env, &count_key, &count);
        Ok(())
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
        Self::set_persistent(&env, &Self::whitelist_key(&address), &true);
        Ok(())
    }

    pub fn remove_from_whitelist(env: Env, admin: Address, address: Address) -> Result<(), Error> {
        admin.require_auth();
        let state = Self::load_state(&env)?;
        if state.admin != admin {
            return Err(Error::Unauthorized);
        }
        let key = Self::whitelist_key(&address);
        env.storage().persistent().remove(&key);
        // Also clear a pre-migration copy, if any, so a stale `instance`
        // entry can't resurrect the whitelisting after removal.
        env.storage().instance().remove(&key);
        Ok(())
    }

    pub fn is_whitelisted(env: Env, address: Address) -> bool {
        Self::read_addr_keyed(&env, &Self::whitelist_key(&address)).unwrap_or(false)
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
        Self::set_persistent(
            env,
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

        Self::append_creator_token(env, &creator, index)?;

        Self::set_persistent(env, &DataKey::TokenIndex(token_address.clone()), &index);
        Self::set_persistent(env, &(&token_address, symbol_short!("owner")), &creator);

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
            Self::set_persistent(env, &supply_key, &p.initial_supply);
        }

        state.token_count = state
            .token_count
            .checked_add(1)
            .ok_or(Error::ArithmeticOverflow)?;
        let index = state.token_count;

        let token_name = p.name.clone();
        let token_symbol = p.symbol.clone();
        Self::set_persistent(
            env,
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

        Self::append_creator_token(env, creator, index)?;

        Self::set_persistent(env, &DataKey::TokenIndex(token_address.clone()), &index);
        Self::set_persistent(env, &(&token_address, symbol_short!("owner")), creator);

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

        let creator: Address =
            Self::migrate_addr_keyed(&env, &(&token_address, symbol_short!("owner")))
                .ok_or(Error::TokenNotFound)?;

        if creator != admin {
            return Err(Error::Unauthorized);
        }

        let existing: Option<String> =
            Self::migrate_addr_keyed(&env, &DataKey::Metadata(token_address.clone()));
        if existing.is_some() {
            return Err(Error::MetadataAlreadySet);
        }

        state.locked = true;
        Self::save_state(&env, &state);

        // Transfer fee from admin to treasury using the dedicated fee_token
        Self::distribute_fee(&env, &state, &admin, fee_payment)?;

        Self::set_persistent(
            &env,
            &DataKey::Metadata(token_address.clone()),
            &metadata_uri,
        );

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
        let index: u32 =
            Self::migrate_addr_keyed(&env, &DataKey::TokenIndex(token_address.clone()))
                .ok_or(Error::TokenNotFound)?;

        let token_info: TokenInfo = Self::migrate_addr_keyed(&env, &DataKey::TokenInfo(index))
            .ok_or(Error::TokenNotFound)?;

        // Verify admin is the token creator using direct mapping
        let creator: Address =
            Self::migrate_addr_keyed(&env, &(&token_address, symbol_short!("owner")))
                .ok_or(Error::TokenNotFound)?;

        if creator != admin {
            return Err(Error::Unauthorized);
        }

        if let Some(cap) = token_info.max_supply {
            let supply_key = (&token_address, symbol_short!("supply"));
            let current: i128 = Self::migrate_addr_keyed(&env, &supply_key).unwrap_or(0i128);
            let new_total = current
                .checked_add(amount)
                .ok_or(Error::ArithmeticOverflow)?;
            if new_total > cap {
                return Err(Error::MaxSupplyExceeded);
            }
            Self::set_persistent(&env, &supply_key, &new_total);
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

        if let Some(index) =
            Self::migrate_addr_keyed::<_, u32>(&env, &DataKey::TokenIndex(token_address.clone()))
        {
            let info: TokenInfo = Self::migrate_addr_keyed(&env, &DataKey::TokenInfo(index))
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

        let creator: Address =
            Self::migrate_addr_keyed(&env, &(&token_address, symbol_short!("owner")))
                .ok_or(Error::TokenNotFound)?;

        if creator != admin {
            return Err(Error::Unauthorized);
        }

        let index: u32 =
            Self::migrate_addr_keyed(&env, &DataKey::TokenIndex(token_address.clone()))
                .ok_or(Error::TokenNotFound)?;

        let mut info: TokenInfo = Self::migrate_addr_keyed(&env, &DataKey::TokenInfo(index))
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
        Self::set_persistent(&env, &DataKey::TokenInfo(index), &info);

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
        // Guards against transaction-budget exhaustion and ledger-entry size
        // overflow in `distribute_fee`.
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
            // Version 3 (issue #1007): move per-token bookkeeping —
            // `TokenInfo`, `TokenIndex`, `Metadata`, the per-token `owner`
            // and `supply` keys, and creator token lists — out of the
            // single `instance` ledger entry into `persistent` storage, so
            // the instance entry no longer grows without bound as tokens
            // accumulate.
            //
            // `TokenInfo`'s key space (`1..=token_count`) is the only part
            // that's cheaply enumerable, so this step walks it in
            // `MIGRATE_TOKEN_INFO_CHUNK`-sized slices per call via a cursor
            // stored under `"mig3cur"`, making the walk resumable if
            // `token_count` is too large to finish in one invocation's
            // resource budget. The on-chain schema version (and
            // `FactoryState.schema_version`) only advance to 3 once the
            // cursor has caught up to `token_count`.
            //
            // Every other migrated key (`TokenIndex`, `Metadata`, `owner`,
            // `supply`) is address-keyed rather than index-keyed, so it
            // can't be enumerated here; those are migrated lazily on first
            // access by `migrate_addr_keyed` (see its doc comment above),
            // and `CreatorTokens` lists are migrated lazily per-creator by
            // `append_creator_token`. Both are idempotent and safe to run
            // whether or not this step has completed.
            let cursor_key = symbol_short!("mig3cur");
            let cursor: u32 = env.storage().instance().get(&cursor_key).unwrap_or(0);
            let target = core::cmp::min(
                cursor.saturating_add(MIGRATE_TOKEN_INFO_CHUNK),
                state.token_count,
            );

            let mut idx = cursor.saturating_add(1);
            while idx <= target {
                let key = DataKey::TokenInfo(idx);
                if let Some(info) = env.storage().instance().get::<_, TokenInfo>(&key) {
                    Self::set_persistent(&env, &key, &info);
                    env.storage().instance().remove(&key);
                }
                idx = idx.saturating_add(1);
            }
            env.storage().instance().set(&cursor_key, &target);

            if target >= state.token_count {
                let mut s = Self::load_state(&env)?;
                s.schema_version = 3;
                Self::save_state(&env, &s);
                on_chain_version = 3;
                env.storage().instance().set(&sv_key, &on_chain_version);
            }
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

        let index: u32 =
            Self::migrate_addr_keyed(&env, &DataKey::TokenIndex(token_address.clone()))
                .ok_or(Error::TokenNotFound)?;
        let token_info: TokenInfo = Self::migrate_addr_keyed(&env, &DataKey::TokenInfo(index))
            .ok_or(Error::TokenNotFound)?;
        let cap = token_info.max_supply.ok_or(Error::InvalidParameters)?;

        if verified_supply < 0 || verified_supply > cap {
            return Err(Error::InvalidParameters);
        }

        let backfill_marker = (&token_address, symbol_short!("bkfld"));
        let already: Option<bool> = Self::migrate_addr_keyed(&env, &backfill_marker);
        if already.unwrap_or(false) {
            return Err(Error::AlreadyBackfilled);
        }

        let supply_key = (&token_address, symbol_short!("supply"));
        let current: i128 = Self::migrate_addr_keyed(&env, &supply_key).unwrap_or(0i128);
        if verified_supply > current {
            Self::set_persistent(&env, &supply_key, &verified_supply);
        }
        Self::set_persistent(&env, &backfill_marker, &true);

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
        Self::read_addr_keyed(&env, &DataKey::TokenInfo(index)).ok_or(Error::TokenNotFound)
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
        Self::read_addr_keyed(&env, &DataKey::TokenIndex(token_address)).ok_or(Error::TokenNotFound)
    }

    /// Return a token's full `TokenInfo` addressed by its contract address.
    ///
    /// Equivalent to `get_token_info(get_token_index(address))` but in a single
    /// call. This is the source of truth for a token's name, symbol, decimals,
    /// creator and creation time — clients must prefer it over event-derived
    /// data, which cannot be trusted for tokens created outside the RPC's
    /// event-retention window. Returns `TokenNotFound` for unregistered
    /// addresses.
    pub fn get_token_info_by_address(env: Env, token_address: Address) -> Result<TokenInfo, Error> {
        let index: u32 = Self::read_addr_keyed(&env, &DataKey::TokenIndex(token_address))
            .ok_or(Error::TokenNotFound)?;
        Self::read_addr_keyed(&env, &DataKey::TokenInfo(index)).ok_or(Error::TokenNotFound)
    }

    /// Return the metadata URI set for a token, or `None` if none was set.
    ///
    /// Metadata is written by `set_metadata` and stored under
    /// `DataKey::Metadata(address)`. Exposing it as a view lets clients read
    /// the current URI directly from contract state instead of scanning `meta`
    /// events, which are subject to the same retention truncation as every
    /// other event.
    pub fn get_metadata(env: Env, token_address: Address) -> Option<String> {
        Self::read_addr_keyed(&env, &DataKey::Metadata(token_address))
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

        let total: u32 =
            Self::read_addr_keyed(&env, &DataKey::CreatorTokenCount(creator.clone())).unwrap_or(0);
        if offset >= total {
            return vec![&env];
        }

        // Saturating arithmetic: `offset + effective_limit` could overflow
        // when callers pass `offset = u32::MAX - small`; cap at `total`.
        let end = core::cmp::min(offset.saturating_add(effective_limit), total);

        // Token indices are stored in fixed-size pages of
        // `MAX_TOKENS_BY_CREATOR_PAGE` entries (`DataKey::CreatorTokens(creator,
        // page)`), so a requested range can span at most two pages. Walk pages
        // in order, reading each one at most once.
        let mut page_out: Vec<u32> = vec![&env];
        let mut i: u32 = offset;
        while i < end {
            let page_no = i / MAX_TOKENS_BY_CREATOR_PAGE;
            let bucket: Vec<u32> =
                Self::read_addr_keyed(&env, &DataKey::CreatorTokens(creator.clone(), page_no))
                    .unwrap_or_else(|| vec![&env]);
            let local = i % MAX_TOKENS_BY_CREATOR_PAGE;
            // `Vec::try_get` returns `Result<Option<u32>, ConversionError>`.
            // Using `Vec::get` instead would panic on bounds and (via its
            // internal unwrap) trigger the workspace's denied
            // `clippy::expect_used` / `clippy::panic` lints. Treating any
            // conversion error or missing entry as end-of-iteration matches
            // the storage invariant: a page has no holes.
            match bucket.try_get(local) {
                Ok(Some(val)) => {
                    page_out.push_back(val);
                    i = i.saturating_add(1);
                }
                _ => break,
            }
        }
        page_out
    }
}

#[cfg(test)]
mod test;

// Benchmarks need a real token WASM installed in the env, which plain unit
// tests can't provide; opt in via `cargo test --features bench bench_`.
#[cfg(all(test, feature = "bench"))]
mod bench;
