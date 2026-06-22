# Mainnet Deployment Checklist

Use this checklist before promoting Stellar Forge from testnet to mainnet. Mainnet actions use real assets, so every item should be reviewed by at least one operator who did not prepare the deployment.

## Readiness

- [ ] Freeze the release branch and tag the exact commit that will be deployed.
- [ ] Confirm all contract audit findings are closed, accepted, or tracked with an explicit launch decision.
- [ ] Rebuild contracts from a clean checkout and record the resulting WASM hashes.
- [ ] Run WASM optimization and confirm optimized artifacts match the hashes shared with reviewers.
- [ ] Verify fee settings, network passphrase, RPC URL, and Horizon endpoint all target mainnet.
- [ ] Store the admin key in a hardware wallet, multisig account, or other approved custody process.
- [ ] Confirm treasury, fee collector, and emergency admin addresses are correct and funded.
- [ ] Review frontend environment variables, CSP headers, and allowed wallet connection origins.
- [ ] Pin or publish the final frontend build artifacts before switching traffic.
- [ ] Run the full deployment once on testnet with the same scripts and configuration shape.
- [ ] Complete a testnet smoke test for wallet connect, contract calls, error handling, and explorer links.
- [ ] Prepare the mainnet transaction envelope review log before signing.

## Mainnet Smoke Test

- [ ] Open the deployed frontend with `VITE_NETWORK=mainnet` and verify the displayed network.
- [ ] Connect a funded wallet and confirm the account address is shown correctly.
- [ ] Submit a low-value contract interaction and verify it succeeds on-chain.
- [ ] Confirm generated explorer links point to Stellar mainnet, not testnet.
- [ ] Check browser console and API logs for CSP, RPC, or wallet adapter errors.

## Rollback Plan

- [ ] Keep the previous frontend build available for immediate redeploy.
- [ ] Document the DNS, hosting, or feature-flag steps needed to restore the previous build.
- [ ] Record the operator who can pause or disable affected contract actions.
- [ ] Prepare a public incident note template with contact and status page links.
- [ ] Define the decision point for rollback, including failed smoke-test criteria.

## Sign-off

- [ ] Deployment owner confirms all required checklist items are complete.
- [ ] Security reviewer signs off on admin key handling and audit status.
- [ ] Product or operations reviewer signs off on the launch window and rollback plan.
