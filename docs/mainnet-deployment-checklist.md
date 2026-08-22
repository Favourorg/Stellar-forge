# Mainnet Deployment Checklist

Use this checklist before promoting Stellar Forge from testnet to mainnet. Mainnet actions can move real funds, so keep a deployment owner, an approver, and a rollback owner available until smoke tests pass.

## Pre-Deployment

- [ ] Confirm the latest contract code has completed audit or peer security review, and document any accepted risks.
- [ ] Resolve or explicitly defer all high and medium audit findings before signing mainnet transactions.
- [ ] **Token WASM provenance and audit status**: Confirm the WASM identified by `VITE_TOKEN_WASM_HASH` has a documented source (upstream tag/commit), a verified on-chain hash, and a recorded audit status or explicit risk-acceptance decision. See [`docs/token-wasm-provenance.md`](./token-wasm-provenance.md) and fill in the mainnet row of the deployment log before proceeding.
- [ ] Build the release WASM with production optimizations enabled and record the final artifact hash.
- [ ] Verify the optimized WASM hash matches the value configured for the frontend and deployment scripts.
- [ ] Review fee configuration, including base fees, token creation fees, treasury account, and expected transaction cost.
- [ ] Fund the deployer, treasury, and any operational accounts with the minimum mainnet XLM needed for deployment and reserves.
- [ ] Confirm admin keys are stored securely, preferably using a hardware wallet, multisig policy, or offline key custody process.
- [ ] Remove private keys, admin secrets, and mainnet credentials from local shell history, logs, screenshots, and committed files.

## Configuration

- [ ] Set `VITE_NETWORK=mainnet` and confirm no testnet network passphrase, RPC URL, or Friendbot reference remains.
- [ ] Verify `VITE_FACTORY_CONTRACT_ID`, `VITE_TOKEN_WASM_HASH`, and Pinata/IPFS configuration point to production values.
- [ ] Confirm Content Security Policy headers allow only the required Stellar, Pinata, and application origins.
- [ ] Review deployment hosting settings, environment variables, redirects, and security headers before publishing.

## Release Validation

- [ ] Run a complete smoke test on testnet using the same deployment steps planned for mainnet.
- [ ] Test token creation, metadata upload, minting, burning, transfer, and wallet connection flows on testnet.
- [ ] Prepare a rollback plan that names the last known-good frontend deployment, contract IDs, owner, and rollback command.
- [ ] Save deployment transaction hashes, contract IDs, WASM hashes, and release notes in the deployment log.
- [ ] After mainnet deployment, verify contract state, transaction history, and frontend reads against Stellar Explorer.
- [ ] Monitor application errors, failed transactions, fee spikes, and user-reported issues during the release window.

