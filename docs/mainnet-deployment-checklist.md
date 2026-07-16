# Mainnet Deployment Checklist

Use this checklist before promoting Stellar Forge from testnet to mainnet. Mainnet actions can move real funds, so keep a deployment owner, an approver, and a rollback owner available until smoke tests pass.

## Pre-Deployment

- [ ] Confirm the latest contract code has completed audit or peer security review, and document any accepted risks.
- [ ] Resolve or explicitly defer all high and medium audit findings before signing mainnet transactions.
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

## Incident Readiness

These items must be verified before the factory is accessible to end users on mainnet. A deployed contract is only as safe as the team's ability to respond when things go wrong.

- [ ] Read the [Incident Response Runbook](./incident-response.md) in full and confirm the team understands every section.
- [ ] Break-glass admin address is generated, funded with at least 5 XLM, and recorded in the deployment log (see [runbook section 7](./incident-response.md#7-break-glass-recovery-mechanism)).
- [ ] WASM hash monitoring script (`check-wasm-hash.sh`) is deployed on a cron schedule (≤ 5 minutes) and confirmed to send alerts.
- [ ] Sentry alert rules for mainnet anomalous-fee events and admin transfers are active (see [runbook section 2](./incident-response.md#2-how-compromise-would-be-detected)).
- [ ] Incident commander and break-glass custodian contact details are documented in the team's private channel, not in this file.
- [ ] Tabletop exercise (runbook section 10) has been completed and dated in the deployment log.

> See [SECURITY.md](../SECURITY.md) for the responsible disclosure policy and further security context.

