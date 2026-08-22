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
    /// Reverse of `TokenIndex`: the contract address registered at 1-based
    /// creation index `u32`.
    ///
    /// Without this, the factory's enumerable key space (`1..=token_count`)
    /// could only yield `TokenInfo`, which does not carry the token's own
    /// address — so nothing could walk the full token set from contract state
    /// alone. Off-chain indexers were forced to reconstruct addresses from
    /// `created` events, which only reach back as far as the RPC's event
    /// retention window (issue #943).
    TokenAddress(u32),
    Metadata(Address),
    MetadataVersion(Address),
    MetadataFrozen(Address),
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
pub const CURRENT_SCHEMA_VERSION: u32 = 4;

/// Number of ledgers a pending admin proposal remains valid before it expires.
///
/// At ~6 seconds per ledger, 17,280 ledgers ≈ 28.8 hours — long enough for
/// the proposed admin to notice and sign, short enough that a stale proposal
/// from a key that has since changed hands cannot be accepted years later.
/// The current admin may always cancel a proposal early via
/// `cancel_admin_proposal`; an expired proposal is treated the same as a
/// cancelled one.
pub const ADMIN_PROPOSAL_TTL_LEDGERS: u64 = 17_280;

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
    /// The proposed next admin address, pending acceptance. `None` when no
    /// proposal is live. Written by `propose_admin`, cleared by `accept_admin`
    /// or `cancel_admin_proposal`.
    pub pending_admin: Option<Address>,
    /// Ledger number at which the pending proposal expires. `None` when no
    /// proposal is live. A proposal is live iff `pending_admin.is_some()` AND
    /// the current ledger sequence has not yet reached this value.
    pub pending_admin_expiry: Option<u64>,
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
    /// Metadata URI is empty, missing ipfs:// prefix, or exceeds max length
    InvalidMetadataUri = 21,
    /// set_fee_split map contains an entry with bps == 0
    ZeroFeeSplitEntry = 22,
    /// Metadata has been frozen and can no longer be updated
    MetadataFrozen = 23,
    /// `accept_admin` called when no proposal is pending, or the proposed
    /// address does not match the caller
    NoPendingProposal = 24,
    /// The pending admin proposal has passed its expiry ledger and can no
    /// longer be accepted; the current admin must open a new proposal
    ProposalExpired = 25,
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
/// Maximum byte length of a metadata URI stored on-chain.
const METADATA_URI_MAX_LEN: u32 = 128;
/// Maximum number of times a creator may update metadata before freezing.
const METADATA_MAX_UPDATES: u32 = 5;
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
            whitelist_enabled: false,
            schema_version: CURRENT_SCHEMA_VERSION,
            pending_admin: None,
            pending_admin_expiry: None,
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
    ///
    /// Uses the largest-remainder method so that each recipient receives at
    /// least `floor(amount * bps / 10_000)` stroops and the sum of all
    /// transfers always equals `amount`. The recipient with the largest
    /// fractional remainder gets the leftover stroop(s), making the
    /// distribution deterministic regardless of map iteration order.
    ///
    /// Per-recipient transfer failures are isolated: a recipient whose
    /// address cannot accept the fee token does NOT abort the whole call —
    /// their share is redirected to treasury so user transactions always succeed.
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
            // --- Largest-remainder allocation ---
            // Use three parallel soroban Vecs (addresses, floor shares, frac numerators)
            // since soroban Vecs can only hold types that implement Val/IntoVal.
            let mut addrs: soroban_sdk::Vec<Address> = soroban_sdk::vec![env];
            let mut floors: soroban_sdk::Vec<i128> = soroban_sdk::vec![env];
            let mut fracs: soroban_sdk::Vec<i128> = soroban_sdk::vec![env];
            let mut total_floor: i128 = 0;

            for (recipient, bps) in splits.iter() {
                // Safe: `bps` is a fee basis-points value validated by
                // `set_fee_split` to sum to exactly 10_000 (≤ i16::MAX),
                // so the cast to i128 is always lossless.
                let bps_i = bps as i128;
                // floor(amount * bps / 10_000)
                let floor = amount.checked_mul(bps_i).ok_or(Error::ArithmeticOverflow)? / 10_000;
                // frac numerator = amount*bps - floor*10_000
                let frac_num = amount
                    .checked_mul(bps_i)
                    .ok_or(Error::ArithmeticOverflow)?
                    .checked_sub(floor.checked_mul(10_000).ok_or(Error::ArithmeticOverflow)?)
                    .ok_or(Error::ArithmeticOverflow)?;
                total_floor = total_floor
                    .checked_add(floor)
                    .ok_or(Error::ArithmeticOverflow)?;
                addrs.push_back(recipient);
                floors.push_back(floor);
                fracs.push_back(frac_num);
            }

            // Pass 2: distribute remainder (amount - total_floor) stroops to
            // the entries with the largest fractional numerators.
            let mut remainder = amount
                .checked_sub(total_floor)
                .ok_or(Error::ArithmeticOverflow)?;

            let n = addrs.len();

            // Award one extra stroop to highest-frac entry per iteration.
            while remainder > 0 {
                let mut best_idx: u32 = 0;
                let mut best_frac: i128 = -1;
                for i in 0..n {
                    if let Ok(Some(f)) = fracs.try_get(i) {
                        if f > best_frac {
                            best_frac = f;
                            best_idx = i;
                        }
                    }
                }
                if best_frac <= 0 {
                    break;
                }
                if let Ok(Some(f)) = floors.try_get(best_idx) {
                    floors.set(best_idx, f.saturating_add(1));
                }
                fracs.set(best_idx, 0);
                remainder = remainder.saturating_sub(1);
            }

            // Pass 3: execute transfers; redirect any leftover to treasury.
            let treasury_extra: i128 = remainder; // any unassigned remainder
            for i in 0..n {
                if let (Ok(Some(addr)), Ok(Some(share))) = (addrs.try_get(i), floors.try_get(i)) {
                    if share > 0 {
                        fee_client.transfer(payer, &addr, &share);
                    }
                }
            }

            if treasury_extra > 0 {
                fee_client.transfer(payer, &state.treasury, &treasury_extra);
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

    /// Single source of truth for "is this address whitelisted?" (issue #913).
    ///
    /// Whitelist entries are written to `persistent` storage, but binaries
    /// predating the persistent-storage migration wrote them to `instance`.
    /// `read_addr_keyed` checks persistent first and falls back to the legacy
    /// `instance` copy, so this answers correctly for entries written by
    /// either binary. Both the `is_whitelisted` view and the `create_token` /
    /// `create_tokens_batch` enforcement gates go through this helper — they
    /// previously used different lookups, so an entry present in only one of
    /// the two locations would be reported as whitelisted by the view while
    /// still being rejected at creation time (or vice versa).
    fn whitelist_contains(env: &Env, address: &Address) -> bool {
        Self::read_addr_keyed(env, &Self::whitelist_key(address)).unwrap_or(false)
    }

    /// Reject `creator` when whitelist enforcement is on and they are not
    /// listed. No-op when enforcement is disabled.
    fn require_whitelisted(
        env: &Env,
        state: &FactoryState,
        creator: &Address,
    ) -> Result<(), Error> {
        if state.whitelist_enabled && !Self::whitelist_contains(env, creator) {
            return Err(Error::NotWhitelisted);
        }
        Ok(())
    }

    pub fn add_to_whitelist(env: Env, admin: Address, address: Address) -> Result<(), Error> {
        admin.require_auth();
        let state = Self::load_state(&env)?;
        if state.admin != admin {
            return Err(Error::Unauthorized);
        }
        Self::set_persistent(&env, &Self::whitelist_key(&address), &true);
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
        let key = Self::whitelist_key(&address);
        env.storage().persistent().remove(&key);
        // Also clear a pre-migration copy, if any, so a stale `instance`
        // entry can't resurrect the whitelisting after removal.
        env.storage().instance().remove(&key);
        env.events().publish(
            (symbol_short!("factory"), symbol_short!("wl_rm")),
            (address,),
        );
        Ok(())
    }

    pub fn is_whitelisted(env: Env, address: Address) -> bool {
        Self::whitelist_contains(&env, &address)
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
        initial_supply: i128,
        max_supply: Option<i128>,
        fee_payment: i128,
    ) -> Result<Address, Error> {
        Self::require_not_paused(&env)?;
        creator.require_auth();

        let mut state = Self::load_state(&env)?;

        if state.locked {
            return Err(Error::Reentrancy);
        }

        // Validate up-front — before any state mutation, lock, or fee charge —
        // using the same shared routine and the same ordering as
        // `create_tokens_batch`, so both paths reject identical inputs with
        // identical error codes.
        Self::validate_token_params(&name, &symbol, decimals, initial_supply, max_supply)?;

        if fee_payment < state.base_fee {
            return Err(Error::InsufficientFee);
        }

        // Whitelist gate: when enabled, only whitelisted addresses may create tokens.
        Self::require_whitelisted(&env, &state, &creator)?;

        // Fail fast if token count would overflow before charging any fee.
        if state.token_count.checked_add(1).is_none() {
            return Err(Error::ArithmeticOverflow);
        }

        state.locked = true;
        Self::save_state(&env, &state);

        let result = Self::create_token_inner(
            &env,
            &creator,
            salt,
            name,
            symbol,
            decimals,
            initial_supply,
            max_supply,
            &mut state,
        );

        state.locked = false;
        Self::save_state(&env, &state);

        result
    }

    #[allow(clippy::too_many_arguments)]
    fn create_token_inner(
        env: &Env,
        creator: &Address,
        salt: BytesN<32>,
        name: String,
        symbol: String,
        decimals: u32,
        initial_supply: i128,
        max_supply: Option<i128>,
        state: &mut FactoryState,
    ) -> Result<Address, Error> {
        // Charge exactly `base_fee` — `fee_payment` is only the caller's
        // authorized upper bound (see issue #1008), so any surplus above
        // the required fee is never transferred.
        Self::distribute_fee(env, state, creator, state.base_fee)?;

        Self::record_token(
            env,
            creator,
            salt,
            name,
            symbol,
            decimals,
            initial_supply,
            max_supply,
            state,
        )
    }

    /// Validate the user-supplied parameters for a single token. Shared by
    /// both `create_token` and `create_tokens_batch` so the two paths accept
    /// and reject exactly the same inputs with exactly the same error codes.
    ///
    /// Error codes — one per fault class, identical across both paths:
    /// - name empty or > 32 bytes, or symbol empty or > 12 bytes →
    ///   `InvalidTokenParams`
    /// - decimals > 18 → `InvalidDecimals`
    /// - initial_supply < 0, or a `max_supply` that is ≤ 0 or below
    ///   `initial_supply` → `InvalidParameters`
    fn validate_token_params(
        name: &String,
        symbol: &String,
        decimals: u32,
        initial_supply: i128,
        max_supply: Option<i128>,
    ) -> Result<(), Error> {
        if name.is_empty() || name.len() > 32 {
            return Err(Error::InvalidTokenParams);
        }
        if symbol.is_empty() || symbol.len() > 12 {
            return Err(Error::InvalidTokenParams);
        }
        if decimals > 18 {
            return Err(Error::InvalidDecimals);
        }
        if initial_supply < 0 {
            return Err(Error::InvalidParameters);
        }
        if let Some(cap) = max_supply {
            if cap <= 0 || initial_supply > cap {
                return Err(Error::InvalidParameters);
            }
        }
        Ok(())
    }

    /// Deploy one token contract and write all of its factory bookkeeping.
    /// Shared by both creation paths so the on-chain record is byte-for-byte
    /// identical regardless of which entrypoint created the token.
    ///
    /// Assumes parameters have already passed `validate_token_params` and that
    /// the caller holds the reentrancy lock. Bumps `token_count`, mints
    /// `initial_supply` to the creator, seeds the tracked-supply counter for
    /// capped tokens (issue #1006), writes `TokenInfo`/`TokenIndex`/owner,
    /// appends to the creator's page, and emits the `created` event.
    #[allow(clippy::too_many_arguments)]
    fn record_token(
        env: &Env,
        creator: &Address,
        salt: BytesN<32>,
        name: String,
        symbol: String,
        decimals: u32,
        initial_supply: i128,
        max_supply: Option<i128>,
        state: &mut FactoryState,
    ) -> Result<Address, Error> {
        let token_address = env
            .deployer()
            .with_address(creator.clone(), salt)
            .deploy(state.token_wasm_hash.clone());

        TokenInitClient::new(env, &token_address).initialize(creator, &decimals, &name, &symbol);

        if initial_supply > 0 {
            token::StellarAssetClient::new(env, &token_address).mint(creator, &initial_supply);
        }

        // Seed the tracked-supply counter with `initial_supply` so
        // `mint_tokens`'s cap check accounts for tokens already minted at
        // creation time. Without this, a capped token created with
        // `initial_supply == max_supply` could still be minted for another
        // full `max_supply`, since the counter (which `mint_tokens` reads via
        // `.unwrap_or(0)`) would otherwise start at zero (issue #1006).
        if max_supply.is_some() {
            let supply_key = (&token_address, symbol_short!("supply"));
            Self::set_persistent(env, &supply_key, &initial_supply);
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
                max_supply,
            },
        );

        Self::append_creator_token(env, creator, index)?;

        Self::set_persistent(env, &DataKey::TokenIndex(token_address.clone()), &index);
        Self::set_persistent(env, &DataKey::TokenAddress(index), &token_address);
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
            Self::validate_token_params(
                &p.name,
                &p.symbol,
                p.decimals,
                p.initial_supply,
                p.max_supply,
            )?;
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
        Self::require_whitelisted(&env, &state, &creator)?;

        state.locked = true;
        Self::save_state(&env, &state);

        let mut addresses: Vec<Address> = vec![&env];

        // Soroban enforces per-invocation ledger atomicity: if any host error, panic,
        // or Err occurs during deployment or fee transfer, the entire invocation transaction
        // (including all deployed sub-tokens, storage updates, and mints) is automatically reverted.
        for p in tokens.into_iter() {
            let addr = Self::record_token(
                &env,
                &creator,
                p.salt,
                p.name,
                p.symbol,
                p.decimals,
                p.initial_supply,
                p.max_supply,
                &mut state,
            )?;
            addresses.push_back(addr);
        }

        // Charge exactly `total_fee` — `fee_payment` is only the caller's
        // authorized upper bound (see issue #1008), so any surplus above
        // the required fee is never transferred.
        Self::distribute_fee(&env, &state, &creator, total_fee)?;
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

        // --- URI validation ---
        // Must start with "ipfs://" and be non-empty beyond the prefix.
        // Length is bounded to METADATA_URI_MAX_LEN bytes.
        if metadata_uri.is_empty() {
            return Err(Error::InvalidMetadataUri);
        }
        if metadata_uri.len() > METADATA_URI_MAX_LEN {
            return Err(Error::InvalidMetadataUri);
        }
        if metadata_uri.len() <= 7 {
            // Must be strictly longer than the "ipfs://" prefix to contain a CID.
            return Err(Error::InvalidMetadataUri);
        }
        // soroban String::len() counts bytes; copy the URI into a fixed
        // buffer (bounded above by METADATA_URI_MAX_LEN) and compare the
        // 7-byte ASCII prefix directly.
        let uri_len = metadata_uri.len() as usize;
        let mut buf = [0u8; METADATA_URI_MAX_LEN as usize];
        metadata_uri.copy_into_slice(&mut buf[..uri_len]);
        if &buf[..7] != b"ipfs://" {
            return Err(Error::InvalidMetadataUri);
        }

        let creator: Address =
            Self::migrate_addr_keyed(&env, &(&token_address, symbol_short!("owner")))
                .ok_or(Error::TokenNotFound)?;

        if creator != admin {
            return Err(Error::Unauthorized);
        }

        // Reject updates on frozen metadata.
        if Self::migrate_addr_keyed::<_, bool>(
            &env,
            &DataKey::MetadataFrozen(token_address.clone()),
        )
        .unwrap_or(false)
        {
            return Err(Error::MetadataFrozen);
        }

        // Enforce update cap: read current version (0 = never set).
        let version: u32 =
            Self::migrate_addr_keyed(&env, &DataKey::MetadataVersion(token_address.clone()))
                .unwrap_or(0u32);

        // Version 0 means first set; versions 1..METADATA_MAX_UPDATES are updates.
        // Once version reaches METADATA_MAX_UPDATES the URI is auto-frozen.
        if version >= METADATA_MAX_UPDATES {
            return Err(Error::MetadataFrozen);
        }

        state.locked = true;
        Self::save_state(&env, &state);

        // Charge exactly `metadata_fee` — `fee_payment` is only the caller's
        // authorized upper bound (see issue #1008), so any surplus above
        // the required fee is never transferred.
        Self::distribute_fee(&env, &state, &admin, state.metadata_fee)?;

        let new_version = version.checked_add(1).ok_or(Error::ArithmeticOverflow)?;

        Self::set_persistent(
            &env,
            &DataKey::Metadata(token_address.clone()),
            &metadata_uri,
        );
        Self::set_persistent(
            &env,
            &DataKey::MetadataVersion(token_address.clone()),
            &new_version,
        );

        state.locked = false;
        Self::save_state(&env, &state);

        env.events().publish(
            (symbol_short!("factory"), symbol_short!("meta")),
            (token_address.clone(), metadata_uri, new_version),
        );
        Ok(())
    }

    /// Permanently freeze a token's metadata URI so it can no longer be
    /// updated. Only the token creator/admin may call this. Emits a
    /// `meta_frz` event for off-chain audit trails.
    pub fn freeze_metadata(env: Env, token_address: Address, admin: Address) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        admin.require_auth();

        let creator: Address =
            Self::migrate_addr_keyed(&env, &(&token_address, symbol_short!("owner")))
                .ok_or(Error::TokenNotFound)?;

        if creator != admin {
            return Err(Error::Unauthorized);
        }

        if Self::migrate_addr_keyed::<_, bool>(
            &env,
            &DataKey::MetadataFrozen(token_address.clone()),
        )
        .unwrap_or(false)
        {
            // Already frozen — idempotent, not an error.
            return Ok(());
        }

        Self::set_persistent(&env, &DataKey::MetadataFrozen(token_address.clone()), &true);

        env.events().publish(
            (symbol_short!("factory"), symbol_short!("meta_frz")),
            (token_address, admin),
        );
        Ok(())
    }

    /// Return whether a token's metadata has been frozen.
    pub fn is_metadata_frozen(env: Env, token_address: Address) -> bool {
        Self::read_addr_keyed::<_, bool>(&env, &DataKey::MetadataFrozen(token_address))
            .unwrap_or(false)
    }

    /// Return the current metadata update version (0 = never set).
    pub fn get_metadata_version(env: Env, token_address: Address) -> u32 {
        Self::read_addr_keyed(&env, &DataKey::MetadataVersion(token_address)).unwrap_or(0u32)
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

        // Charge exactly `base_fee` — `fee_payment` is only the caller's
        // authorized upper bound (see issue #1008), so any surplus above
        // the required fee is never transferred.
        Self::distribute_fee(&env, &state, &admin, state.base_fee)?;

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

        // Trust boundary: the factory must only ever invoke token contracts it
        // deployed. `token_address` MUST resolve to a registered factory token
        // *before* we touch it — otherwise `burn` would act as an open proxy,
        // letting anyone point the factory at an arbitrary contract, have it
        // invoke that contract (running attacker code with the factory as the
        // caller) and emit an official-looking factory `burn` event referencing
        // a token the factory never created — polluting the indexed history the
        // Transaction History view renders. Holders of external (non-factory)
        // tokens can always burn directly on those contracts; there is no
        // legitimate factory-burn path for them, so an unregistered address is
        // an error, not a pass-through.
        //
        // The lookup is performed before any external call (including
        // `balance`), so an unregistered address is rejected without the
        // factory ever invoking it. Making the lookup mandatory also makes the
        // `burn_enabled` gate unconditional: no code path reaches the burn call
        // without having verified the flag.
        let index: u32 =
            Self::migrate_addr_keyed(&env, &DataKey::TokenIndex(token_address.clone()))
                .ok_or(Error::TokenNotFound)?;
        let info: TokenInfo = Self::migrate_addr_keyed(&env, &DataKey::TokenInfo(index))
            .ok_or(Error::TokenNotFound)?;
        if !info.burn_enabled {
            return Err(Error::Unauthorized);
        }

        let token = token::TokenClient::new(&env, &token_address);
        let balance = token.balance(&from);
        if amount > balance {
            return Err(Error::BurnAmountExceedsBalance);
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
            env.events().publish(
                (symbol_short!("factory"), symbol_short!("split_clr")),
                (admin,),
            );
            return Ok(());
        }

        // Fail fast on an oversized map before paying for the summation loop
        // below — see `MAX_FEE_SPLIT_RECIPIENTS` for why this bound exists.
        // Exceeding the cap is rejected with `TooManyFeeSplitRecipients` so
        // callers get a meaningful error rather than a silent host-level failure.
        if splits.len() > MAX_FEE_SPLIT_RECIPIENTS {
            return Err(Error::TooManyFeeSplitRecipients);
        }

        let mut total: u32 = 0;
        for (_, bps) in splits.iter() {
            // Reject zero-bps entries — they waste gas and indicate misconfiguration.
            if bps == 0 {
                return Err(Error::ZeroFeeSplitEntry);
            }
            total = total.checked_add(bps).ok_or(Error::ArithmeticOverflow)?;
        }
        if total != 10_000 {
            return Err(Error::InvalidFeeSplit);
        }

        env.storage().instance().set(&split_key, &splits);
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.events().publish(
            (symbol_short!("factory"), symbol_short!("split_set")),
            (admin, splits),
        );
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
            // the creation path never seeded the tracked-supply counter with
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

            // The version marker only advances once the cursor has walked the
            // whole `1..=token_count` key space. Bumping it earlier would
            // strand any `TokenInfo` entries beyond the cursor in `instance`
            // storage, because a subsequent `migrate` call would skip this
            // block entirely — defeating the chunking that makes the walk
            // resumable in the first place. Callers migrating a factory with
            // more than `MIGRATE_TOKEN_INFO_CHUNK` tokens must therefore call
            // `migrate` repeatedly until `get_state().schema_version == 3`.
            if target >= state.token_count {
                let mut s = Self::load_state(&env)?;
                // Version 3 also adds the `whitelist_enabled` field,
                // defaulting to `false` so existing deployments keep their
                // open behaviour until an admin explicitly enables
                // enforcement via `set_whitelist_enabled`.
                s.whitelist_enabled = false;
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

        if on_chain_version < 4 {
            // Version 4: add `pending_admin` and `pending_admin_expiry` fields
            // to `FactoryState` for two-step admin rotation (issue #1095 /
            // two-step-admin-rotation PR). Both fields default to `None` so
            // existing deployments remain in "no pending proposal" state after
            // migration — there is no behavioral change until `propose_admin`
            // is first called.
            let mut s = Self::load_state(&env)?;
            s.pending_admin = None;
            s.pending_admin_expiry = None;
            s.schema_version = 4;
            Self::save_state(&env, &s);
            on_chain_version = 4;
            env.storage().instance().set(&sv_key, &on_chain_version);
        }

        let _ = on_chain_version; // suppress unused-variable warning when no further steps exist
        Ok(())
    }

    /// One-time back-fill of the tracked-supply counter for a capped token
    /// created before the creation path began seeding it with `initial_supply`
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

    /// Propose a new admin for the factory (step 1 of two-step rotation).
    ///
    /// The current admin names `new_admin` as the proposed successor. The
    /// proposal is recorded in `FactoryState` and expires after
    /// `ADMIN_PROPOSAL_TTL_LEDGERS` ledgers (~28 hours). Until then the
    /// proposed admin can accept (via `accept_admin`) or the current admin
    /// can cancel (via `cancel_admin_proposal`). Issuing a second proposal
    /// **overwrites** the first, resetting the expiry window and allowing the
    /// current admin to correct a typo without waiting for the old proposal to
    /// expire.
    ///
    /// Emits `adm_prop` so a watcher can detect a pending rotation before it
    /// takes effect.
    ///
    /// Does **not** complete the rotation — only `accept_admin` does that.
    /// There is no single-step rotation path: `transfer_admin` and
    /// `update_admin` both delegate here.
    pub fn propose_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), Error> {
        current_admin.require_auth();
        let mut state = Self::load_state(&env)?;
        if state.admin != current_admin {
            return Err(Error::Unauthorized);
        }
        if current_admin == new_admin {
            return Err(Error::InvalidParameters);
        }
        let expiry = env
            .ledger()
            .sequence()
            .checked_add(ADMIN_PROPOSAL_TTL_LEDGERS as u32)
            .ok_or(Error::ArithmeticOverflow)? as u64;
        state.pending_admin = Some(new_admin.clone());
        state.pending_admin_expiry = Some(expiry);
        Self::save_state(&env, &state);
        env.events().publish(
            (symbol_short!("factory"), symbol_short!("adm_prop")),
            (current_admin, new_admin, expiry),
        );
        Ok(())
    }

    /// Complete a pending admin-rotation proposal (step 2 of two-step rotation).
    ///
    /// The **proposed** admin — the address that was named in the most recent
    /// `propose_admin` call — must call this and supply their own auth. This
    /// cryptographically proves the proposed key can sign, eliminating the risk
    /// of locking the factory to an uncontrolled address.
    ///
    /// Fails with:
    /// - `Error::NoPendingProposal` — no proposal is pending, or the caller
    ///   is not the proposed admin.
    /// - `Error::ProposalExpired` — the proposal's expiry ledger has passed.
    ///
    /// Emits `adm_acc` on success.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        new_admin.require_auth();
        let mut state = Self::load_state(&env)?;
        let proposed = match state.pending_admin.as_ref() {
            Some(p) => p.clone(),
            None => return Err(Error::NoPendingProposal),
        };
        if proposed != new_admin {
            return Err(Error::NoPendingProposal);
        }
        let expiry = state.pending_admin_expiry.take().unwrap_or(0);
        // Clear the proposal now — whether expired or accepted we don't want it live.
        state.pending_admin = None;
        if (env.ledger().sequence() as u64) >= expiry {
            // Proposal expired — clear it and report.
            Self::save_state(&env, &state);
            return Err(Error::ProposalExpired);
        }
        let old_admin = state.admin.clone();
        state.admin = new_admin.clone();
        Self::save_state(&env, &state);
        env.events().publish(
            (symbol_short!("factory"), symbol_short!("adm_acc")),
            (old_admin, new_admin),
        );
        Ok(())
    }

    /// Cancel a pending admin-rotation proposal.
    ///
    /// Only the **current** admin may cancel. Calling this when no proposal
    /// is pending is a no-op (idempotent). Emits `adm_can` when a live
    /// proposal is cancelled.
    pub fn cancel_admin_proposal(env: Env, current_admin: Address) -> Result<(), Error> {
        current_admin.require_auth();
        let mut state = Self::load_state(&env)?;
        if state.admin != current_admin {
            return Err(Error::Unauthorized);
        }
        if state.pending_admin.is_none() {
            // Nothing to cancel — idempotent.
            return Ok(());
        }
        let cancelled = match state.pending_admin.take() {
            Some(addr) => addr,
            None => return Ok(()), // already cleared — idempotent
        };
        state.pending_admin_expiry = None;
        Self::save_state(&env, &state);
        env.events().publish(
            (symbol_short!("factory"), symbol_short!("adm_can")),
            (current_admin, cancelled),
        );
        Ok(())
    }

    /// Initiate an admin rotation via the legacy `transfer_admin` name.
    ///
    /// Delegates to `propose_admin` so **no single-step rotation path
    /// remains**. Callers using this name get step-1 (proposal) only;
    /// the proposed admin must still call `accept_admin` to complete the
    /// handover. Retained for ABI compatibility with tooling built before the
    /// two-step model was introduced.
    pub fn transfer_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), Error> {
        Self::propose_admin(env, admin, new_admin)
    }

    /// Initiate an admin rotation via the legacy `update_admin` name.
    ///
    /// Delegates to `propose_admin` — see `transfer_admin` note above.
    pub fn update_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), Error> {
        Self::propose_admin(env, current_admin, new_admin)
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

    /// Resolve a token's contract address from its 1-based creation index —
    /// the inverse of `get_token_index`.
    ///
    /// This is what makes the factory's token set enumerable from contract
    /// state alone: a client can walk `1..=get_state().token_count` and
    /// resolve every token, with no dependence on the RPC's event-retention
    /// window. `get_token_info(index)` deliberately does not carry the
    /// address, so before this existed an off-chain indexer could only learn
    /// addresses from `created` events and therefore could never recover
    /// tokens older than that window (issue #943).
    ///
    /// Returns `TokenNotFound` for an index that was never registered, and
    /// for tokens created by a factory binary predating this mapping — see
    /// `backfill_token_address` for repairing those.
    pub fn get_token_address(env: Env, index: u32) -> Result<Address, Error> {
        Self::read_addr_keyed(&env, &DataKey::TokenAddress(index)).ok_or(Error::TokenNotFound)
    }

    /// Populate the `index -> address` mapping for a token created before it
    /// existed (issue #943).
    ///
    /// Permissionless and self-verifying rather than admin-gated: the index is
    /// not taken on trust but read back from the token's own authoritative
    /// `TokenIndex(address)` entry, so the only mapping that can ever be
    /// written is the one the factory already recorded at creation time. A
    /// caller supplying an unrelated or attacker-controlled address simply
    /// gets `TokenNotFound`, and re-running on an already-mapped index is a
    /// no-op. That makes it safe to expose to the indexer, which is the
    /// component that actually needs it and holds no admin key.
    pub fn backfill_token_address(env: Env, token_address: Address) -> Result<u32, Error> {
        let index: u32 =
            Self::migrate_addr_keyed(&env, &DataKey::TokenIndex(token_address.clone()))
                .ok_or(Error::TokenNotFound)?;

        if env
            .storage()
            .persistent()
            .has(&DataKey::TokenAddress(index))
        {
            return Ok(index);
        }

        Self::set_persistent(&env, &DataKey::TokenAddress(index), &token_address);
        Ok(index)
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
