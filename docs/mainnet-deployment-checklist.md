# Mainnet Deployment Checklist

Use this checklist before promoting Stellar Forge from testnet to mainnet. Mainnet actions can move real funds, so keep a deployment owner, an approver, and a rollback owner available until smoke tests pass.

## Tagging Convention

Every mainnet deployment **must** be accompanied by a signed, annotated git tag so the WASM verification workflow can prove the on-chain bytecode matches the reviewed source.

- Tag format: `contract-v<MAJOR>.<MINOR>.<PATCH>` (e.g., `contract-v1.0.0`).
- The tag **must** point to the exact commit whose `contracts/token-factory/src/lib.rs` was reviewed and approved for deployment.
- Create the tag **before** deploying:
  ```bash
  # If you have a GPG key configured (recommended):
  git tag -s contract-v1.0.0 -m "Token Factory v1.0.0 — mainnet deployment"
  # Or, if GPG signing is not available:
  git tag -a contract-v1.0.0 -m "Token Factory v1.0.0 — mainnet deployment"
  git push origin contract-v1.0.0
  ```

## Pre-Deployment

- [ ] Confirm the latest contract code has completed audit or peer security review, and document any accepted risks.
- [ ] Resolve or explicitly defer all high and medium audit findings before signing mainnet transactions.
- [ ] Create the release git tag following the [Tagging Convention](#tagging-convention) above.
- [ ] Build the release WASM with production optimizations enabled and record the final artifact hash.
- [ ] Run the [WASM Hash Verification workflow](https://github.com/Favourorg/Stellar-forge/actions/workflows/wasm-verify.yml) against the deployment tag **after** the contract is deployed to confirm the on-chain bytecode matches the reviewed source commit. Do not rely solely on a manual hash comparison.
- [ ] Verify the optimized WASM hash matches the value configured for the frontend and deployment scripts.
- [ ] Review fee configuration, including base fees, token creation fees, treasury account, and expected transaction cost.
- [ ] Fund the deployer, treasury, and any operational accounts with the minimum mainnet XLM needed for deployment and reserves.
- [ ] Confirm admin keys are stored securely, preferably using a hardware wallet, multisig policy, or offline key custody process.
- [ ] Remove private keys, admin secrets, and mainnet credentials from local shell history, logs, screenshots, and committed files.

## Configuration

- [ ] Set `VITE_NETWORK=mainnet` and confirm no testnet network passphrase, RPC URL, or Friendbot reference remains.
- [ ] Verify `VITE_FACTORY_CONTRACT_ID`, `VITE_TOKEN_WASM_HASH`, and Pinata/IPFS configuration point to production values.
- [ ] Confirm `VITE_TOKEN_WASM_HASH` equals the factory's on-chain `token_wasm_hash` (`stellar contract invoke --id <factory> -- get_state`). If the factory is being upgraded in this release, the frontend must be redeployed with the new hash in the same release window.
- [ ] Confirm Content Security Policy headers allow only the required Stellar, Pinata, and application origins.
- [ ] Review deployment hosting settings, environment variables, redirects, and security headers before publishing.

## Deployment

- [ ] Deploy and initialize the factory **atomically** — `initialize` runs as the contract's `__constructor`, so `scripts/deploy-contract.sh` (or an equivalent `stellar contract deploy --wasm ... -- --admin ... --treasury ... --fee_token ... --token_wasm_hash ... --base_fee ... --metadata_fee ...` invocation) deploys and initializes in a single transaction. Never deploy the WASM and initialize it as two separate transactions — that reopens a front-running window where an attacker's `initialize` call could win the race and seize the admin role (see the [Token Factory front-running writeup](https://github.com/Favourorg/Stellar-forge/issues/1005)).
- [ ] Immediately after deployment, run `stellar contract invoke --id <contract-id> --network mainnet -- get_state` and confirm the returned `admin` field is **exactly** the intended admin address before publishing the contract ID anywhere (frontend `.env`, docs, service-worker cache key, announcements). `scripts/deploy-contract.sh` performs this check automatically and aborts if it fails.

## Release Validation

- [ ] Run a complete smoke test on testnet using the same deployment steps planned for mainnet.
- [ ] Test token creation, metadata upload, minting, burning, transfer, and wallet connection flows on testnet.
- [ ] Prepare a rollback plan that names the last known-good frontend deployment, contract IDs, owner, and rollback command.
- [ ] Save deployment transaction hashes, contract IDs, WASM hashes, and release notes in the deployment log.
- [ ] After mainnet deployment, verify contract state, transaction history, and frontend reads against Stellar Explorer.
- [ ] Load the deployed frontend against mainnet and confirm **no token-contract mismatch banner** appears. The app compares the factory's on-chain `token_wasm_hash` against `VITE_TOKEN_WASM_HASH` at startup; a red banner means the frontend build and the factory disagree about which token contract is being deployed. The check stays silent when it cannot complete (RPC read failure, or the variable unset), so pair this with the config verification above rather than relying on the absent banner alone.
- [ ] Run the [WASM Hash Verification workflow](https://github.com/Favourorg/Stellar-forge/actions/workflows/wasm-verify.yml) as the final post-deployment check, using the deployment tag as `git_ref` and the new factory contract ID. The job must pass before the deployment is considered complete.
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
