# StellarForge - Stellar Token Deployer

StellarForge is a user-friendly decentralized application (dApp) that enables creators, entrepreneurs, and businesses in emerging markets to deploy custom tokens on the Stellar blockchain without writing a single line of code.

## Features

- **Token Factory Contract**: Deploy custom tokens on Stellar using Soroban smart contracts
- **Fee-Based System**: Configurable fees for token creation, metadata setting, and minting
- **IPFS Integration**: Store token metadata (images, descriptions) on IPFS via Pinata
- **Wallet Integration**: Connect with Freighter wallet for seamless transactions
- **Burn Functionality**: Burn tokens to reduce supply
- **Admin Controls**: Update fees and manage the factory
- **Network Switcher**: Toggle between testnet and mainnet from the UI
- **Transaction History**: View on-chain contract events with pagination
- **Testnet & Mainnet Support**: Deploy on both testnet and mainnet

## Tech Stack

### Backend (Smart Contracts)
- **Rust**: Programming language for Soroban contracts
- **Soroban SDK**: Stellar's smart contract development framework
- **Soroban Token SDK**: For token operations

### Frontend
- **React 19**: UI framework
- **TypeScript**: Type-safe JavaScript
- **Vite**: Build tool and dev server
- **Tailwind CSS**: Utility-first CSS framework
- **Vitest**: Testing framework

### Integrations
- **Freighter Wallet**: Stellar wallet browser extension
- **IPFS/Pinata**: Decentralized file storage for metadata
- **Stellar Horizon**: Blockchain data API
- **Soroban RPC**: Smart contract interaction

## Prerequisites

- **Rust**: For building Soroban contracts
- **Node.js** (v18+): For frontend development
- **Stellar CLI**: For contract deployment and testing (see setup below)
- **Freighter Wallet**: Browser extension for Stellar transactions

## Installation & Setup

### 1. Clone the Repository
```bash
git clone <repository-url>
cd stellar-forge
```

### 2. Setup Stellar CLI Environment
Run the setup script to install Rust, Stellar CLI, and configure testnet:
```bash
./scripts/setup-soroban.sh
```

> **Note:** The Soroban CLI was renamed to `stellar` in recent versions. All commands below use `stellar`. If you have the old `soroban` binary installed, uninstall it and run the setup script again:
> ```bash
> cargo uninstall soroban-cli
> cargo install stellar-cli --features opt
> ```

### 3. Install Frontend Dependencies
```bash
cd frontend
npm install
```

### 4. Environment Variables
Create a `.env` file in the `frontend` directory:
```env
VITE_NETWORK=testnet
VITE_FACTORY_CONTRACT_ID=<deployed-contract-id>
```

Metadata uploads go through a serverless proxy (`api/ipfs/*`) so Pinata
credentials never reach the browser. Set these as **server-side** environment
variables in your Vercel project settings (or a local `.env` at the repo
root when running `vercel dev`) - never prefix them with `VITE_`, or they'll
be inlined into the client bundle and shipped to every visitor:
```env
PINATA_API_KEY=<pinata-api-key>
PINATA_API_SECRET=<pinata-api-secret>
```

## Building & Testing

### Smart Contracts
```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

### Run Contract Tests
```bash
cd contracts/token-factory
cargo test
```

### Frontend
```bash
cd frontend
npm run dev          # Start dev server
npm run build        # Build for production
npm run test         # Run tests
npm run lint         # Lint code
```

## Contract Functions

### Initialization
- `initialize(admin, treasury, base_fee, metadata_fee)`: Set up the factory with admin controls and fees

### Token Operations
- `create_token(creator, name, symbol, decimals, initial_supply, fee_payment)`: Deploy a new token
- `mint_tokens(token_address, admin, to, amount, fee_payment)`: Mint additional tokens
- `burn(token_address, from, amount)`: Burn tokens from supply

### Metadata
- `set_metadata(token_address, admin, metadata_uri, fee_payment)`: Set token metadata URI

### Admin Functions
- `update_fees(admin, base_fee?, metadata_fee?)`: Update factory fees
- `pause(admin)` / `unpause(admin)`: Pause or resume the factory

### View Functions
- `get_state()`: Get factory state
- `get_base_fee()`: Get token creation fee
- `get_metadata_fee()`: Get metadata setting fee
- `get_token_info(index)`: Get token information by index
- `get_tokens_by_creator(creator)`: Get all token indices created by a given address

## Usage

1. **Connect Wallet**: Use Freighter wallet to connect to the dApp
2. **Create Token**: Fill in token details (name, symbol, decimals, supply) and pay the creation fee
3. **Set Metadata**: Upload token image and description to IPFS
4. **Mint Tokens**: Mint additional tokens as needed
5. **Manage Supply**: Burn tokens to reduce circulating supply

## Deployment

### Contract Deployment
```bash
# Build the contract
cd contracts/token-factory
cargo build --target wasm32-unknown-unknown --release

# Deploy to testnet
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/token_factory.wasm \
  --source <your-secret-key> \
  --network testnet

# Initialize the contract
stellar contract invoke \
  --id <contract-id> \
  --source <your-secret-key> \
  --network testnet \
  -- \
  initialize \
  --admin <admin-address> \
  --treasury <treasury-address> \
  --base_fee 70000000 \
  --metadata_fee 30000000
```

### Frontend Deployment
The frontend depends on the serverless IPFS proxy under `api/` for metadata
uploads, so the repo root (not just `frontend/`) is the deploy unit.

```bash
# Deploy the whole repo to Vercel - vercel.json builds frontend/ to
# frontend/dist and deploys api/ as serverless functions alongside it.
vercel deploy
```

Set `PINATA_API_KEY` and `PINATA_API_SECRET` as server-side environment
variables in the Vercel project settings before deploying (see
[Environment Variables](#4-environment-variables) above).

If you deploy `frontend/dist` to a static host that doesn't run the `api/`
functions (e.g. plain Netlify static hosting), metadata uploads won't work
until you stand up the proxy endpoints (`POST /api/ipfs/upload-file` and
`POST /api/ipfs/upload-json`) on that platform yourself.

## Project Structure

```
stellar-forge/
├── contracts/                 # Soroban smart contracts
│   ├── Cargo.toml            # Workspace configuration
│   └── token-factory/        # Token factory contract
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs        # Contract implementation
│           └── test.rs       # Contract tests
├── frontend/                  # React application
│   ├── src/
│   │   ├── components/       # UI components (NetworkSwitcher, TransactionHistory, ...)
│   │   ├── context/          # React contexts (Wallet, Toast, Network)
│   │   ├── services/         # API integrations (stellar, wallet, ipfs)
│   │   ├── hooks/            # React hooks
│   │   ├── config/           # Configuration files
│   │   ├── types/            # TypeScript type definitions
│   │   └── utils/            # Utility functions
│   ├── package.json
│   └── vite.config.ts
├── scripts/                   # Setup scripts
│   └── setup-soroban.sh      # Installs Rust + Stellar CLI + configures testnet
└── README.md
```

## Security

We take security seriously. If you discover a security vulnerability, please review our [Security Policy](SECURITY.md) for responsible disclosure guidelines.

For users deploying tokens, we strongly recommend:
- Always test on testnet first before mainnet deployment
- Review all parameters carefully using the mainnet deployment checklist
- Verify contract addresses and transaction details before signing

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local development setup and contribution guidelines.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Disclaimer

This software is for educational and development purposes. Always test thoroughly on testnet before mainnet deployment. The authors are not responsible for any financial losses incurred through the use of this software.
