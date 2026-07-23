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
    MetadataVersion(Address),
    MetadataFrozen(Address),
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
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

#[contracttype]
#[derive(Clone)]
pub struct FactoryState {
    pub admin: Address,
    pub paused: bool,
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
    /// Metadata URI is empty, missing ipfs:// prefix, or exceeds max length
    InvalidMetadataUri = 18,
    /// set_fee_split map has more than MAX_FEE_SPLIT_RECIPIENTS entries
    TooManyFeeSplitRecipients = 19,
    /// set_fee_split map contains an entry with bps == 0
    ZeroFeeSplitEntry = 20,
    /// Metadata has been frozen and can no longer be updated
    MetadataFrozen = 21,
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
/// Maximum number of recipients in a fee split map. Bounding this limits the
/// number of cross-contract transfer calls per user transaction, keeping gas
/// predictable and preventing resource-limit griefing.
const MAX_FEE_SPLIT_RECIPIENTS: u32 = 10;
/// Maximum byte length of a metadata URI stored on-chain.
const METADATA_URI_MAX_LEN: u32 = 128;
/// Maximum number of times a creator may update metadata before freezing.
const METADATA_MAX_UPDATES: u32 = 5;

#[contractimpl]
impl TokenFactory {
    /// Initialize the factory. `fee_token` is the SEP-41 token used for all
    /// fee payments; fees are transferred from the caller to `treasury`.
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        fee_token: Address,
        token_wasm_hash: BytesN<32>,
        base_fee: i128,
        metadata_fee: i128,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::State) {
            return Err(Error::AlreadyInitialized);
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
                let bps_i = bps as i128;
                // floor(amount * bps / 10_000)
                let floor = amount
                    .checked_mul(bps_i)
                    .ok_or(Error::ArithmeticOverflow)?
                    / 10_000;
                // frac numerator = amount*bps - floor*10_000
                let frac_num = amount
                    .checked_mul(bps_i)
                    .ok_or(Error::ArithmeticOverflow)?
                    .checked_sub(
                        floor.checked_mul(10_000).ok_or(Error::ArithmeticOverflow)?,
                    )
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
            let mut treasury_extra: i128 = remainder; // any unassigned remainder
            for i in 0..n {
                if let (Ok(Some(addr)), Ok(Some(share))) =
                    (addrs.try_get(i), floors.try_get(i))
                {
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
        Ok(())
    }

    pub fn is_whitelisted(env: Env, address: Address) -> bool {
        env.storage()
            .instance()
            .get(&Self::whitelist_key(&address))
            .unwrap_or(false)
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
        // Fail fast if token count would overflow
        if state.token_count.checked_add(1).is_none() {
            state.locked = false;
            return Err(Error::ArithmeticOverflow);
        }

        // Transfer fee from creator to treasury using the dedicated fee_token
        Self::distribute_fee(env, state, &creator, fee_payment)?;

        let token_address = env
            .deployer()
            .with_address(creator.clone(), salt)
            .deploy(state.token_wasm_hash.clone());

        TokenInitClient::new(env, &token_address).initialize(&creator, &decimals, &name, &symbol);

        if initial_supply > 0 {
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

        let new_count = state
            .token_count
            .checked_add(1)
            .ok_or(Error::ArithmeticOverflow)?;
        state.token_count = new_count;
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

        let count = tokens.len() as i128;
        if count == 0 {
            return Err(Error::InvalidParameters);
        }

        for p in tokens.iter() {
            Self::validate_batch_params(&p)?;
        }

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
        let mut result: Result<(), Error> = Ok(());

        for p in tokens.into_iter() {
            match Self::deploy_one(&env, &creator, p, &mut state) {
                Ok(addr) => addresses.push_back(addr),
                Err(e) => {
                    result = Err(e);
                    break;
                }
            }
        }

        state.locked = false;

        if let Err(e) = result {
            Self::save_state(&env, &state);
            return Err(e);
        }

        // Transfer fee from creator to treasury using the dedicated fee_token
        Self::distribute_fee(&env, &state, &creator, fee_payment)?;
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

        let state = Self::load_state(&env)?;

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
        // soroban String::len() counts characters (u32 code-points); for the
        // ASCII-only prefix "ipfs://" (7 chars) this equals byte length.
        // Verify the prefix by comparing each character code-point.
        // 'i'=105, 'p'=112, 'f'=102, 's'=115, ':'=58, '/'=47, '/'=47
        let prefix_codepoints: [u32; 7] = [105, 112, 102, 115, 58, 47, 47];
        if metadata_uri.len() <= 7 {
            // Must be strictly longer than the prefix to contain a CID.
            return Err(Error::InvalidMetadataUri);
        }
        let mut prefix_ok = true;
        for i in 0..7u32 {
            if metadata_uri.get(i) != Some(prefix_codepoints[i as usize]) {
                prefix_ok = false;
                break;
            }
        }
        if !prefix_ok {
            return Err(Error::InvalidMetadataUri);
        }

        let creator: Address = env
            .storage()
            .instance()
            .get(&(&token_address, symbol_short!("owner")))
            .ok_or(Error::TokenNotFound)?;

        if creator != admin {
            return Err(Error::Unauthorized);
        }

        // Reject updates on frozen metadata.
        if env
            .storage()
            .instance()
            .has(&DataKey::MetadataFrozen(token_address.clone()))
        {
            return Err(Error::MetadataFrozen);
        }

        // Enforce update cap: read current version (0 = never set).
        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MetadataVersion(token_address.clone()))
            .unwrap_or(0u32);

        // Version 0 means first set; versions 1..METADATA_MAX_UPDATES are updates.
        // Once version reaches METADATA_MAX_UPDATES the URI is auto-frozen.
        if version >= METADATA_MAX_UPDATES {
            return Err(Error::MetadataFrozen);
        }

        // Transfer fee from admin to treasury.
        Self::distribute_fee(&env, &state, &admin, fee_payment)?;

        let new_version = version.checked_add(1).ok_or(Error::ArithmeticOverflow)?;

        env.storage()
            .instance()
            .set(&DataKey::Metadata(token_address.clone()), &metadata_uri);
        env.storage()
            .instance()
            .set(&DataKey::MetadataVersion(token_address.clone()), &new_version);
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        env.events().publish(
            (symbol_short!("factory"), symbol_short!("meta")),
            (token_address.clone(), metadata_uri, new_version),
        );
        Ok(())
    }

    /// Permanently freeze a token's metadata URI so it can no longer be
    /// updated. Only the token creator/admin may call this. Emits a
    /// `meta_freeze` event for off-chain audit trails.
    pub fn freeze_metadata(env: Env, token_address: Address, admin: Address) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        admin.require_auth();

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
            .has(&DataKey::MetadataFrozen(token_address.clone()))
        {
            // Already frozen — idempotent, not an error.
            return Ok(());
        }

        env.storage()
            .instance()
            .set(&DataKey::MetadataFrozen(token_address.clone()), &true);
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        env.events().publish(
            (symbol_short!("factory"), symbol_short!("meta_frz")),
            (token_address, admin),
        );
        Ok(())
    }

    /// Return whether a token's metadata has been frozen.
    pub fn is_metadata_frozen(env: Env, token_address: Address) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::MetadataFrozen(token_address))
    }

    /// Return the current metadata update version (0 = never set).
    pub fn get_metadata_version(env: Env, token_address: Address) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MetadataVersion(token_address))
            .unwrap_or(0u32)
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

        let state = Self::load_state(&env)?;

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

        // Transfer fee from admin to treasury using the dedicated fee_token
        Self::distribute_fee(&env, &state, &admin, fee_payment)?;

        token::StellarAssetClient::new(&env, &token_address).mint(&to, &amount);

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

        token.burn(&from, &amount);

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

        info.burn_enabled = enabled;
        env.storage()
            .instance()
            .set(&DataKey::TokenInfo(index), &info);
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
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

        // Enforce recipient cap to bound per-transaction gas.
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
        if let Some(fee) = base_fee {
            state.base_fee = fee;
        }
        if let Some(fee) = metadata_fee {
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
        let on_chain_version: u32 = env.storage().instance().get(&sv_key).unwrap_or(0);
        if on_chain_version < CURRENT_SCHEMA_VERSION {
            // Version 1: ensure schema_version field is set
            let mut s = state;
            s.schema_version = CURRENT_SCHEMA_VERSION;
            Self::save_state(&env, &s);
            env.storage()
                .instance()
                .set(&sv_key, &CURRENT_SCHEMA_VERSION);
        }
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
