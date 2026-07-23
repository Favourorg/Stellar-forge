#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String, Vec, vec, symbol_short, token};
use soroban_token_sdk::TokenClient;

#[contracttype]
#[derive(Clone)]
pub struct TokenInfo {
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    pub creator: Address,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct FactoryState {
    pub admin: Address,
    pub paused: bool,
    pub treasury: Address,
    pub base_fee: i128,
    pub metadata_fee: i128,
    pub token_count: u32,
}

#[contract]
pub struct TokenFactory;

#[contractimpl]
impl TokenFactory {
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        base_fee: i128,
        metadata_fee: i128,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&symbol_short!("init")) {
            return Err(Error::AlreadyInitialized);
        }

        // FIX 1: Added `paused: false` to the FactoryState initializer
        let state = FactoryState {
            admin: admin.clone(),
            paused: false,
            treasury,
            base_fee,
            metadata_fee,
            token_count: 0,
        };

        env.storage().instance().set(&symbol_short!("state"), &state);
        env.storage().instance().set(&symbol_short!("init"), &true);

        env.events().publish((symbol_short!("init"),), (admin,));

        Ok(())
    }

    // FIX 2: Replaced DataKey::State with symbol_short!("state") to match the rest of the codebase
    fn require_not_paused(env: &Env) -> Result<(), Error> {
        let state: FactoryState = env.storage().instance().get(&symbol_short!("state")).unwrap();
        if state.paused {
            return Err(Error::ContractPaused);
        }
        Ok(())
    }

    pub fn create_token(
        env: Env,
        creator: Address,
        name: String,
        symbol: String,
        decimals: u32,
        initial_supply: i128,
        fee_payment: i128,
    ) -> Result<Address, Error> {
        // FIX 3: Changed require_not_paused(&env) to Self::require_not_paused(&env)
        Self::require_not_paused(&env)?;
        creator.require_auth();

        let state: FactoryState = env.storage().instance().get(&symbol_short!("state")).unwrap();
        
        if fee_payment < state.base_fee {
            return Err(Error::InsufficientFee);
        }

        // Transfer fee to treasury
        token::StellarAssetClient::new(&env, &env.current_contract_address()).transfer(
            &creator,
            &state.treasury,
            &fee_payment,
        );

        // Deploy token using soroban-token-sdk
        let token_address = env.deployer().deploy_token(
            &name,
            &symbol,
            &decimals,
            &creator,
            &initial_supply,
        );

        // Store token info
        let token_info = TokenInfo {
            name,
            symbol,
            decimals,
            creator: creator.clone(),
            created_at: env.ledger().timestamp(),
        };

        let mut token_count = state.token_count;
        token_count += 1;
        
        env.storage().instance().set(&token_count, &token_info);
        env.storage().instance().set(&symbol_short!("state"), &FactoryState {
            token_count,
            ..state
        });

        // Append token index to creator's list
        let creator_key = (symbol_short!("cr_tokens"), creator.clone());
        let mut creator_tokens: Vec<u32> = env
            .storage()
            .instance()
            .get(&creator_key)
            .unwrap_or_else(|| vec![&env]);
        creator_tokens.push_back(token_count);
        env.storage().instance().set(&creator_key, &creator_tokens);

        env.events().publish((symbol_short!("token_created"),), (token_address.clone(), creator));

        Ok(token_address)
    }

    pub fn set_metadata(
        env: Env,
        token_address: Address,
        admin: Address,
        metadata_uri: String,
        fee_payment: i128,
    ) -> Result<(), Error> {
        // FIX 3: Changed require_not_paused(&env) to Self::require_not_paused(&env)
        Self::require_not_paused(&env)?;
        admin.require_auth();

        let state: FactoryState = env.storage().instance().get(&symbol_short!("state")).unwrap();
        
        if fee_payment < state.metadata_fee {
            return Err(Error::InsufficientFee);
        }

        // Transfer fee
        token::StellarAssetClient::new(&env, &env.current_contract_address()).transfer(
            &admin,
            &state.treasury,
            &fee_payment,
        );

        env.storage().instance().set(&(&token_address, symbol_short!("metadata")), &metadata_uri);

        env.events().publish((symbol_short!("metadata_set"),), (token_address, metadata_uri));

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
        // FIX 3: Changed require_not_paused(&env) to Self::require_not_paused(&env)
        Self::require_not_paused(&env)?;
        admin.require_auth();

        let state: FactoryState = env.storage().instance().get(&symbol_short!("state")).unwrap();
        
        if fee_payment < state.base_fee {
            return Err(Error::InsufficientFee);
        }

        // Transfer fee
        token::StellarAssetClient::new(&env, &env.current_contract_address()).transfer(
            &admin,
            &state.treasury,
            &fee_payment,
        );

        // Mint tokens
        TokenClient::new(&env, &token_address).mint(&admin, &to, &amount);

        env.events().publish((symbol_short!("tokens_minted"),), (token_address, to, amount));

        Ok(())
    }

    pub fn burn(
        env: Env,
        token_address: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), Error> {
        // NOTE: burn intentionally has NO require_not_paused check
        from.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidBurnAmount);
        }

        TokenClient::new(&env, &token_address).burn(&from, &amount);

        env.events().publish((symbol_short!("tokens_burned"),), (token_address, from, amount));

        Ok(())
    }

    // FIX 2: Replaced DataKey::State with symbol_short!("state") throughout pause/unpause
    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let mut state: FactoryState = env.storage().instance().get(&symbol_short!("state")).unwrap();

        if state.admin != admin {
            return Err(Error::Unauthorized);
        }

        state.paused = true;
        env.storage().instance().set(&symbol_short!("state"), &state);

        env.events().publish((symbol_short!("paused"),), (admin,));

        Ok(())
    }

    pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let mut state: FactoryState = env.storage().instance().get(&symbol_short!("state")).unwrap();

        if state.admin != admin {
            return Err(Error::Unauthorized);
        }

        state.paused = false;
        env.storage().instance().set(&symbol_short!("state"), &state);

        env.events().publish((symbol_short!("unpaused"),), (admin,));

        Ok(())
    }

    pub fn update_fees(
        env: Env,
        admin: Address,
        base_fee: Option<i128>,
        metadata_fee: Option<i128>,
    ) -> Result<(), Error> {
        admin.require_auth();

        let mut state: FactoryState = env.storage().instance().get(&symbol_short!("state")).unwrap();
        
        if admin != state.admin {
            return Err(Error::Unauthorized);
        }

        if let Some(fee) = base_fee {
            state.base_fee = fee;
        }
        if let Some(fee) = metadata_fee {
            state.metadata_fee = fee;
        }

        env.storage().instance().set(&symbol_short!("state"), &state);

        env.events().publish((symbol_short!("fees_updated"),), (base_fee, metadata_fee));

        Ok(())
    }

    pub fn get_state(env: Env) -> FactoryState {
        env.storage().instance().get(&symbol_short!("state")).unwrap()
    }

    pub fn get_base_fee(env: Env) -> i128 {
        Self::get_state(env).base_fee
    }

    pub fn get_metadata_fee(env: Env) -> i128 {
        Self::get_state(env).metadata_fee
    }

    pub fn get_token_info(env: Env, index: u32) -> Result<TokenInfo, Error> {
        match env.storage().instance().get(&index) {
            Some(info) => Ok(info),
            None => Err(Error::TokenNotFound),
        }
    }

    pub fn get_tokens_by_creator(env: Env, creator: Address) -> Vec<u32> {
        let creator_key = (symbol_short!("cr_tokens"), creator);
        env.storage()
            .instance()
            .get(&creator_key)
            .unwrap_or_else(|| vec![&env])
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
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
    // FIX 4: Replaced X with 10
    ContractPaused = 10,
}

mod test;