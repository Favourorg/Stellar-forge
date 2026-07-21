# StellarForge — Critical Issue Backlog

This document tracks 20 high-difficulty, high-criticality issues identified through a full audit of the
contract (`contracts/token-factory/src/lib.rs`), the frontend (`frontend/src`), and the serverless IPFS
proxy (`api/`). Each issue includes a detailed description, a task breakdown, and acceptance criteria so
it can be copied directly into the GitHub issue tracker.

**Severity scale:** 🔴 Critical (funds/consensus/permanent-brick risk) · 🟠 High (broken core feature or
exploitable abuse vector) · 🟡 Elevated (correctness/robustness gap with user-visible impact)

---

## Issue 1 — 🔴 `initialize` can be front-run: attacker can seize admin of a freshly deployed factory

**Area:** Smart contract · `contracts/token-factory/src/lib.rs` (`initialize`)

### Description

`initialize(admin, treasury, fee_token, token_wasm_hash, base_fee, metadata_fee)` has **no caller
authentication** — it only checks that `DataKey::State` does not exist yet. Any observer watching the
network can see a `TokenFactory` WASM being deployed and race the deployer's own `initialize`
transaction with their own, passing **themselves** as `admin` and `treasury`. If the attacker's
transaction lands first, they permanently own the factory: they control fees, the fee split, pause,
whitelist, admin rotation, and — most dangerously — `upgrade`, which lets them replace the contract's
executable with arbitrary code. Because `initialize` fails with `AlreadyInitialized` on retry, the
legitimate deployer has no recovery path other than deploying a brand-new contract and re-publishing
its address everywhere (frontend env, docs, service-worker cache key).

This is a classic deployment race. Soroban supports atomic deploy-and-invoke (deploying and calling a
constructor/init in the same transaction), which eliminates the window entirely.

### Tasks

- [ ] Add a `__constructor` (Soroban SDK ≥ 22 constructor support) or migrate `initialize` to run
      atomically in the same transaction as deployment via `deploy_v2` with constructor args.
- [ ] Alternatively (if constructor migration is deferred): require `admin.require_auth()` inside
      `initialize` **and** update `scripts/deploy-contract.sh` to deploy + initialize in one
      `stellar contract deploy ... -- initialize ...` invocation so no unauthenticated window exists.
- [ ] Update `docs/mainnet-deployment-checklist.md` with an explicit "deploy and initialize atomically"
      step and a verification step (`get_state` must show the expected admin before the address is
      published anywhere).
- [ ] Add a test that simulates the race: deploy, then attempt `initialize` from a non-deployer address
      and assert the expected failure mode.
- [ ] Document the change in `docs/contract-abi.md` and bump `CURRENT_SCHEMA_VERSION` if state layout
      changes.

### Acceptance criteria

- It is impossible for any address other than the intended admin to become the factory admin between
  deployment and initialization — proven by a test.
- `scripts/deploy-contract.sh` performs deployment and initialization in a single atomic transaction.
- The mainnet checklist contains the verification step and CI runs the new race test.

---

## Issue 2 — 🔴 Max-supply cap accounting ignores `initial_supply` — capped tokens can be minted past their cap

**Area:** Smart contract · `lib.rs` (`deploy_one`, `mint_tokens`)

### Description

`create_tokens_batch` accepts a per-token `max_supply` cap and `validate_batch_params` correctly
requires `initial_supply <= cap` at creation time. However, the running-supply counter used to enforce
the cap in `mint_tokens` (`(&token_address, symbol_short!("supply"))`) is **never seeded with
`initial_supply`** — `deploy_one` mints `initial_supply` directly via `StellarAssetClient::mint`
without touching the supply key, and `mint_tokens` reads it with `.unwrap_or(0)`.

Concrete exploit: create a token with `initial_supply = 1_000_000` and `max_supply = 1_000_000`
(supposedly fully minted, fixed supply). The tracked supply starts at `0`, so the creator can then call
`mint_tokens` for another `1_000_000` — doubling the "hard-capped" supply. Anyone who bought the token
trusting the advertised fixed cap is diluted. For a token marketed on its supply cap, this is an
economic-integrity break equivalent to unlimited minting.

### Tasks

- [ ] In `deploy_one`, when `p.max_supply.is_some()`, write `p.initial_supply` to the token's supply
      key at creation time.
- [ ] Add a migration step (schema version bump + `migrate` block) that back-fills the supply key for
      existing capped tokens. Since historical `initial_supply` is not stored in `TokenInfo`, decide
      and document the back-fill strategy (e.g., read live `total_supply` from the token contract, or
      store `initial_supply` in `TokenInfo` going forward and document the limitation for pre-migration
      tokens).
- [ ] Add regression tests: `initial_supply == cap` ⇒ any `mint_tokens` call fails with
      `MaxSupplyExceeded`; `initial_supply = cap - 10` ⇒ minting 10 succeeds, minting 11 fails.
- [ ] Extend the `fuzz_mint_tokens` fuzz target so the corpus covers non-zero initial supplies with
      caps.
- [ ] Update `docs/contract-abi.md` to document exactly what the cap counts.

### Acceptance criteria

- A token created with `initial_supply == max_supply` can never be minted again — proven by tests.
- Fuzzing finds no input where cumulative minted supply (including initial supply) exceeds `max_supply`.
- The migration path for already-deployed capped tokens is implemented, tested, and documented.

---

## Issue 3 — 🔴 All factory bookkeeping lives in `instance` storage — the factory will eventually brick itself

**Area:** Smart contract · `lib.rs` (all storage access)

### Description

Every piece of per-token state — `TokenInfo(index)`, `CreatorTokens(Address)` (an append-only
`Vec<u32>`), `TokenIndex(Address)`, `Metadata(Address)`, the per-token `owner` and `supply` keys, and
the whitelist entries — is written to **`env.storage().instance()`**. Soroban instance storage is a
_single ledger entry_ shared with the contract instance itself, subject to the ledger-entry size limit
(~64 KiB) and loaded/serialized **in full on every invocation**.

Consequences as adoption grows:

1. **Hard brick:** once cumulative instance data approaches the entry-size limit, _every_ state-writing
   call (`create_token`, `set_metadata`, even `pause`) starts failing. There is no admin action that
   can fix it — the factory is permanently unusable and all token bookkeeping is trapped.
2. **Cost blow-up before the brick:** every invocation pays read/write fees proportional to the entire
   instance entry, so `create_token` becomes progressively more expensive for all users as unrelated
   tokens accumulate.
3. **Single TTL:** one archival event takes down all bookkeeping at once (see Issue 7).

The `MAX_TOKENS_BY_CREATOR_PAGE` cap addresses the _read_ path only; the underlying write-side growth
is unbounded. This is the single largest scalability defect in the contract and requires a storage
migration to `persistent` storage with per-key TTLs.

### Tasks

- [ ] Move `TokenInfo`, `TokenIndex`, `Metadata`, `owner`, `supply`, and whitelist keys to
      `env.storage().persistent()`; keep only `FactoryState` (and the fee split) in instance storage.
- [ ] Replace the monolithic `CreatorTokens` `Vec<u32>` with paginated persistent buckets (e.g.
      `CreatorTokens(Address, page: u32)` holding at most N indices each) so no single entry grows
      unboundedly.
- [ ] Implement `extend_ttl` correctly per persistent key on access (see Issue 7).
- [ ] Bump `CURRENT_SCHEMA_VERSION` and write a `migrate` step that moves existing instance entries to
      persistent storage; the migration must be idempotent and chunk-safe (callable repeatedly if it
      cannot complete in one invocation's resource budget).
- [ ] Add a stress test that creates several hundred tokens and asserts instance-entry size stays flat.
- [ ] Update the storage documentation in `docs/contract-abi.md` and the README architecture section.

### Acceptance criteria

- Instance storage size is O(1) with respect to token count, demonstrated by the stress test.
- All existing view/mutation entrypoints behave identically after migration (full test suite green).
- `migrate` converts a pre-migration state snapshot correctly and is proven idempotent by tests.

---

## Issue 4 — 🔴 Factory charges the full `fee_payment` instead of the required fee — silent overpayment kept by treasury

**Area:** Smart contract · `lib.rs` (`create_token_inner`, `create_tokens_batch`, `mint_tokens`, `set_metadata`)

### Description

Every fee-gated entrypoint validates `fee_payment >= required_fee` but then calls
`distribute_fee(..., fee_payment)` — transferring **whatever the caller passed**, not the fee actually
required. Two failure modes:

1. **Silent overpayment:** a UI bug, unit confusion (XLM vs stroops — a 10⁷ factor), or a stale cached
   fee causes the user to pass `fee_payment` far above `base_fee`. The contract keeps the entire
   amount with no refund and no warning. With real mainnet XLM this is direct loss of user funds.
2. **Admin fee front-running is aggravated:** users typically pass a `fee_payment` with headroom above
   the currently displayed fee so their transaction survives a fee update. The contract design
   _incentivizes_ overpaying, and then keeps the overpayment.

The contract should charge exactly `required_fee` (treating `fee_payment` as a maximum the user is
willing to pay — the same pattern as `amount`/`max_amount` in DEX contracts), or refund the surplus.

### Tasks

- [ ] Change `create_token`, `create_tokens_batch`, `mint_tokens`, and `set_metadata` to transfer
      exactly the required fee (`base_fee`, `base_fee * count`, `metadata_fee`), keeping `fee_payment`
      solely as the user's authorized upper bound.
- [ ] Add tests: passing `fee_payment = 2 × base_fee` results in exactly `base_fee` leaving the
      caller's balance; fee-split distribution still sums exactly to the charged amount.
- [ ] Add a test for the fee-update race: user submits with `fee_payment` above old fee but below the
      new fee ⇒ clean `InsufficientFee` failure with no partial transfer.
- [ ] Update `docs/contract-abi.md` fee semantics and the frontend `FeeDisplay`/forms so the UI stops
      padding `fee_payment` beyond a small explicit slippage allowance.
- [ ] Extend `fuzz_fee_arithmetic` to assert charged-amount == required-fee invariant.

### Acceptance criteria

- No entrypoint can ever transfer more than the currently configured required fee, proven by tests and
  fuzzing.
- Fee-split recipients receive shares of the charged fee (not the passed payment) and the sum of all
  transfers equals the charged fee exactly.
- Documentation and frontend fee construction are consistent with the new semantics.

---

## Issue 5 — 🔴 Frontend `deployToken` passes the wrong argument list to `create_token` — token creation is broken end-to-end

**Area:** Frontend · `frontend/src/services/stellar-impl.ts` (`deployToken`)

### Description

The contract signature is:

```rust
create_token(creator, salt, name, symbol, decimals, initial_supply, fee_payment) // 7 args
```

but `stellar-impl.ts` builds the invocation with **8 arguments**, inserting
`nativeToScVal(hexToBytes(params.tokenWasmHash), { type: 'bytes' })` between `salt` and `name`
(`stellar-impl.ts:424-432`). The factory reads the WASM hash from its own state and does not accept it
as a parameter. Every `create_token` submission therefore fails at simulation with an argument-count/
type mismatch — the app's core feature (deploying a token) cannot succeed against the current
contract. This appears to be drift left over from an earlier contract revision that took the hash as a
parameter, and it survived because the service-layer tests mock the contract instead of validating
against the real ABI.

### Tasks

- [ ] Remove the `tokenWasmHash` argument from the `contract.call('create_token', ...)` invocation and
      from `deployToken`'s params (and from every caller: `CreateToken.tsx`, `useTransaction`, types).
- [ ] Audit **every** `contract.call(...)` in `stellar-impl.ts` against `docs/contract-abi.md` for
      similar drift (`mint_tokens`, `burn`, `set_metadata`, `update_fees` — verify names, order, and
      ScVal types, including the hand-rolled `Option<i128>` encoding in `updateFees`).
- [ ] Add an integration test (vitest against a mocked RPC that validates the XDR-encoded arg vector,
      or a Playwright e2e against a localnet factory) that would have caught the mismatch.
- [ ] Add a CI check that flags when `docs/contract-abi.md` and the service layer drift (extend
      `scripts/check-abi-doc-drift.sh` to also scan `stellar-impl.ts` call sites).

### Acceptance criteria

- `create_token` succeeds end-to-end against a locally deployed factory (e2e or localnet test).
- All `contract.call` sites are verified against the ABI doc and covered by a drift check in CI.
- The `VITE_TOKEN_WASM_HASH` env var is either genuinely used (e.g. for display/verification) or its
  role is re-documented.

---

## Issue 6 — 🔴 IPFS proxy is an unauthenticated open pinning relay with spoofable rate limiting

**Area:** API · `api/ipfs/upload-file.ts`, `api/ipfs/upload-json.ts`, `api/_lib/rateLimit.ts`

### Description

The serverless proxy correctly hides the Pinata credentials, but the endpoints themselves are open to
the entire internet with three compounding weaknesses:

1. **No authentication or origin binding.** Any script anywhere can POST to
   `/api/ipfs/upload-file` and `/api/ipfs/upload-json` and pin content to the project's Pinata
   account. Attackers get a free, anonymous pinning service billed to the project (storage quota
   exhaustion, cost abuse, and reputational risk from pinning abusive content under the project's
   account).
2. **Rate limiting is trivially bypassed.** `clientIp` trusts the first entry of `x-forwarded-for`,
   which is client-controllable when the header is not normalized by the platform; and the bucket map
   is per-warm-instance memory, so cold starts and instance fan-out under load reset it — exactly when
   an attack is happening. The file itself documents this as best-effort.
3. **`upload-json` accepts arbitrary unvalidated JSON of any size** (up to the platform body cap) —
   there is no schema check that the payload is actually token metadata, and no size ceiling of its own.

### Tasks

- [ ] Bind uploads to real app usage: require a signed request from the connected Stellar wallet (e.g.
      the client signs a short-lived challenge with Freighter's `signMessage`; the proxy verifies the
      signature and enforces per-address quotas), or at minimum a same-origin check plus a
      server-issued short-TTL token.
- [ ] Replace the in-memory limiter with a durable shared store (Upstash Redis / Vercel KV) keyed by
      verified wallet address (fallback: platform-provided trusted IP), with per-window and per-day
      quotas.
- [ ] Derive the client IP only from the platform-trusted header position (rightmost untrusted-hop
      semantics on Vercel), never the raw first `x-forwarded-for` entry.
- [ ] Validate `upload-json` bodies against the `TokenMetadata` schema (`name`, `description`,
      `image: ipfs://CID`) with strict size limits (e.g. 8 KiB) and reject everything else.
- [ ] Add magic-byte (file signature) validation in `upload-file` instead of trusting the
      client-supplied `mimeType` (see Issue 15 for the content-validation half).
- [ ] Add tests for: unauthenticated request rejection, quota enforcement across simulated instances,
      spoofed `x-forwarded-for`, and oversized/malformed JSON.

### Acceptance criteria

- An unauthenticated third-party script cannot pin anything through the proxy (verified by test).
- Rate limits survive instance recycling and cannot be reset by header spoofing.
- Only schema-valid, size-bounded token metadata JSON and signature-verified image files are accepted.

---

## Issue 7 — 🔴 No TTL management for token bookkeeping — state can be archived and the factory has no rent strategy

**Area:** Smart contract · `lib.rs` (`extend_token_ttl`, all storage writes)

### Description

`extend_token_ttl(env, _token_address, _index)` **ignores both of its arguments** and merely extends
the instance TTL — a misleading no-op wrapper. The entire factory relies on a single instance-storage
TTL that is only extended when someone happens to call a state-writing function. If the factory sits
idle longer than the TTL window (`MAX_TTL = 535_000` ledgers ≈ 31 days), the instance entry —
containing _all_ token records, metadata pointers, creator lists, and the admin/fee configuration — is
archived. Reads start failing (`StateNotFound` / missing-entry traps) and every user's token becomes
invisible to the app until someone performs a state restoration, a flow neither the contract, the
scripts, nor the frontend implements or documents. On mainnet, "the app went dark because nobody made
a transaction for a month" is a critical operational failure. This issue is the TTL/archival half of
the storage redesign in Issue 3.

### Tasks

- [ ] After the persistent-storage migration (Issue 3), implement real per-key TTL extension: extend a
      token's `TokenInfo`/`TokenIndex`/`Metadata`/`owner`/`supply` keys whenever that token is touched.
- [ ] Delete or fix the argument-ignoring `extend_token_ttl` so its behavior matches its name.
- [ ] Add a public `extend_ttls(keys)`-style maintenance entrypoint (or document use of the ledger
      `RestoreFootprint`/`ExtendFootprintTTL` operations) so anyone can keep entries alive
      permissionlessly.
- [ ] Add an operational runbook (`docs/`): monitoring entry TTLs, restoring archived entries, and the
      expected rent budget; wire a scheduled CI job or cron doc for TTL keep-alive on mainnet.
- [ ] Add tests that advance the ledger past TTL boundaries and verify (a) touched entries survive,
      (b) restoration of archived entries works.

### Acceptance criteria

- Every persistent entry a user's token depends on gets its TTL extended on access, proven by
  ledger-advancing tests.
- An archived-entry recovery procedure exists, is documented, and is exercised by a test.
- No function signature advertises per-token TTL behavior it does not implement.

---

## Issue 8 — 🟠 Admin governance is single-step and unguarded: one typo permanently bricks the factory

**Area:** Smart contract · `lib.rs` (`transfer_admin`, `update_admin`, `upgrade`)

### Description

`transfer_admin`/`update_admin` immediately reassign `state.admin` to whatever address is passed. If
the admin fat-fingers an address (or transfers to a contract address that cannot sign), **all**
privileged operations — fee updates, pause/unpause, whitelist, `upgrade`, `migrate` — are lost
forever; there is no recovery. Two redundant functions performing the same mutation (one silent, one
with an event) doubles the attack/mistake surface and splits the audit trail. `upgrade` is similarly
instantaneous: a compromised or coerced admin key can atomically swap the executable for malicious
WASM with zero delay and zero on-chain warning, and nothing forces `migrate` to run afterwards, so an
upgrade requiring a schema change can leave state and code out of sync (Issue 2's migration depends on
this working).

### Tasks

- [ ] Implement two-step admin rotation: `propose_admin(new_admin)` stores a pending admin;
      `accept_admin()` requires `new_admin.require_auth()` to complete; `cancel_admin_proposal()` for
      the current admin. Remove the redundant duplicate function (keep one, emitting events for
      propose/accept/cancel).
- [ ] Add an optional upgrade timelock: `propose_upgrade(new_wasm_hash)` + `apply_upgrade()` callable
      only after N ledgers, with an event on propose so watchers can react; document the emergency
      trade-off chosen.
- [ ] Make `upgrade`/`apply_upgrade` automatically invoke the migration path (or hard-fail all
      entrypoints until `migrate` runs) so code/schema can never be observed out of sync.
- [ ] Emit events for every governance action, including `transfer_admin` (currently silent).
- [ ] Tests: pending-admin flow, cancel flow, auth failures, timelock boundaries, upgrade-then-migrate
      enforcement.
- [ ] Update `docs/contract-abi.md`, `docs/incident-response.md`, and the mainnet checklist.

### Acceptance criteria

- Admin can only move to an address that has proven it can sign (accept step), proven by tests.
- An upgrade cannot leave the contract serving new code against an old schema.
- Every governance mutation emits an auditable event.

---

## Issue 9 — 🟠 Whitelist is stored but never enforced — advertised access control is a no-op

**Area:** Smart contract · `lib.rs` (`add_to_whitelist`, `remove_from_whitelist`, `is_whitelisted`)

### Description

The factory exposes a full admin-managed whitelist API and the frontend Admin Panel surfaces it, but
**no entrypoint ever checks it** — `create_token`, `create_tokens_batch`, `mint_tokens`, and
`set_metadata` are open to every address regardless of list contents. An operator who populates the
whitelist believing they've restricted token creation (a compliance-relevant expectation for the
project's stated emerging-markets audience) is silently running a fully open factory. A feature that
looks like a security control but does nothing is worse than its absence. The README currently
carries a disclaimer; the gap itself remains.

### Tasks

- [ ] Add a `whitelist_enabled: bool` flag to `FactoryState` (schema bump + `migrate` step), toggled by
      a new admin entrypoint `set_whitelist_enabled`.
- [ ] When enabled, gate `create_token` and `create_tokens_batch` on `is_whitelisted(creator)`
      (decide and document whether `mint_tokens`/`set_metadata` are also gated — recommendation:
      creation only, since existing creators already passed the gate).
- [ ] Return a dedicated error (`NotWhitelisted`) rather than reusing `Unauthorized`.
- [ ] Move whitelist entries to persistent storage as part of Issue 3.
- [ ] Emit events on whitelist add/remove/toggle for auditability.
- [ ] Tests: gated vs. ungated mode, add→create→remove→create-fails sequence, batch path, event
      emission; frontend Admin Panel toggle wired to the new entrypoint with tests.
- [ ] Update `docs/contract-abi.md` and remove the README disclaimer.

### Acceptance criteria

- With whitelisting enabled, a non-whitelisted creator's `create_token`/`create_tokens_batch` fails
  with `NotWhitelisted`, proven by tests.
- With whitelisting disabled (default), behavior is unchanged for all existing tests.
- The Admin Panel can toggle enforcement and manage entries end-to-end.

---

## Issue 10 — 🟠 Contract event topic `adm_upd` vs frontend `admin_update` — admin-rotation events silently invisible

**Area:** Contract/frontend integration · `lib.rs` (`update_admin`), `frontend/src/services/stellar-impl.ts` (`EVENT_TOPICS`, `parseRpcEvent`)

### Description

The contract publishes admin rotations on topic `symbol_short!("adm_upd")` (`lib.rs:1033`), but the
frontend's `EVENT_TOPICS` allow-list contains the string `'admin_update'` and the parser's `switch`
has a `case 'admin_update'` (`stellar-impl.ts:288,335`). Since the decoded topic `adm_upd` is not in
the allow-list, `parseRpcEvent` returns `null` and **every admin-change event is dropped** from
Transaction History and CSV exports. For the single most security-sensitive state change the factory
makes — who controls it — the UI shows nothing. Users and auditors watching the history view would
never see a hostile or accidental admin rotation. This is exactly the class of silent drift that also
produced Issue 5.

### Tasks

- [ ] Align the identifiers: either rename the frontend constant/case to `adm_upd`, or (preferred for
      readability) map raw topic → display type in one explicit lookup table shared by allow-list and
      parser so they cannot diverge.
- [ ] Audit all nine topics (`init`, `created`, `meta`, `mint`, `burn`, `fees`, `pause`, `unpause`,
      `adm_upd`) against the contract source in one table, and add a unit test that decodes a real
      captured XDR fixture for each event type.
- [ ] Add the missing event type to `ContractEventType` in `frontend/src/types` if it differs.
- [ ] Extend `scripts/check-abi-doc-drift.sh` (or a new script) to grep contract `symbol_short!`
      topics and diff them against the frontend's list in CI.
- [ ] Verify Transaction History renders an admin-update row with both addresses, and CSV export
      includes it.

### Acceptance criteria

- An `update_admin` invocation on localnet/testnet produces a visible, correctly-labeled row in
  Transaction History and in the exported CSV, proven by test.
- CI fails if the contract's event topics and the frontend's parser list ever diverge again.

---

## Issue 11 — 🟠 `scValToString` renders contract addresses as raw hex, not StrKey — event filtering and history display are broken

**Area:** Frontend · `frontend/src/services/stellar-impl.ts` (`scValToString`, `getTokenInfoByAddress`, `getTokenEvents`)

### Description

For `scvAddress` values of contract type, `scValToString` returns the **raw 32-byte contract ID as a
hex string** instead of the canonical `C...` StrKey encoding (`stellar-impl.ts:254-256`,
`StrKey.encodeContract` is never used). Every event field that holds a token contract address
(`created.tokenAddress`, `mint.tokenAddress`, `burn.tokenAddress`, `meta.tokenAddress`) is therefore
stored in an encoding no other part of the system uses. Downstream:

- `getTokenInfoByAddress(tokenAddress)` compares `e.data.tokenAddress === tokenAddress` where the
  argument is a `C...` StrKey — the comparison **never matches**, so every token falls into the
  fallback branch (name = raw address, decimals = 7, no creator, no metadata).
- `getTokenEvents` filters the same way — the per-token history view is always empty.
- Transaction History and CSV export show meaningless hex blobs where addresses should be, and
  explorer links built from them are dead.

### Tasks

- [ ] Encode contract addresses with `StrKey.encodeContract(addr.contractId())` in `scValToString`
      (and audit the account branch for muxed-account handling while there).
- [ ] Prefer `scValToNative` + a thin formatting layer over the hand-rolled decoder where possible, to
      lean on the SDK's canonical conversions.
- [ ] Add unit tests with real XDR fixtures asserting `C...`/`G...` outputs for contract and account
      addresses respectively.
- [ ] Add regression tests for `getTokenInfoByAddress` and `getTokenEvents` proving a created token's
      events are found by its StrKey address.
- [ ] Verify explorer links, AddressDisplay truncation, and CSV output render the canonical encodings.

### Acceptance criteria

- All addresses surfaced in events, history, CSV, and explorer links are canonical StrKey strings.
- `getTokenInfoByAddress` returns real name/symbol/creator data for a token found in events, and the
  per-token history view is populated — both proven by tests.

---

## Issue 12 — 🟠 One `VITE_FACTORY_CONTRACT_ID` shared across the network switcher — mainnet/testnet toggle points both networks at the same contract

**Area:** Frontend · `frontend/src/config/env.ts`, `config/stellar.ts`, `context/NetworkContext.tsx`

### Description

The UI offers a runtime testnet/mainnet switcher (persisted in `localStorage`), but
`STELLAR_CONFIG.factoryContractId` is a **single value** from `VITE_FACTORY_CONTRACT_ID`, applied to
whichever network is selected. Switching a testnet-configured build to mainnet makes the app issue
mainnet transactions against a contract ID that either doesn't exist on mainnet (confusing "contract
not found" failures) or — the dangerous case — _does_ exist as an unrelated contract at the same ID,
against which users could be prompted to sign real-XLM transactions. The same applies to
`VITE_TOKEN_WASM_HASH`. Additionally, the hardcoded mainnet RPC endpoint
`https://soroban-mainnet.stellar.org` (`config/stellar.ts:21`) is not an SDF-operated public service
(SDF provides no public mainnet Soroban RPC), so mainnet mode is broken at the transport layer too.
The service-worker cache key derives from the single contract ID, compounding cross-network cache
confusion.

### Tasks

- [ ] Introduce per-network env vars (`VITE_FACTORY_CONTRACT_ID_TESTNET` / `_MAINNET`, same for the
      WASM hash) resolved through `NETWORK_CONFIGS`, with the misconfiguration screen listing exactly
      which network is missing configuration.
- [ ] Disable (with explanation) the network switcher for any network whose contract ID is not
      configured, instead of switching into a broken state.
- [ ] Make the mainnet RPC URL a required explicit env var (`VITE_SOROBAN_RPC_URL_MAINNET`) with
      documentation on choosing a provider, and validate reachability on startup (surfaced, not
      silent).
- [ ] Include the active network in the service-worker cache version key alongside its own contract ID.
- [ ] Update `.env.example`, `vercel.json` env docs, README, and the Vercel deploy button parameters.
- [ ] Tests: network switch resolves the correct contract ID; unconfigured network cannot be selected;
      misconfiguration screen names the missing variable.

### Acceptance criteria

- Each network resolves its own contract ID, WASM hash, and RPC endpoint, proven by tests.
- It is impossible to end up signing transactions on network A against network B's (or a missing)
  contract ID via the switcher.
- Mainnet mode has an explicitly configured, documented RPC endpoint.

---

## Issue 13 — 🟠 `getAllTokens()` is a stub returning `[]` — the Token Explorer's data source doesn't exist

**Area:** Frontend · `frontend/src/services/stellar-impl.ts` (`getAllTokens`), `hooks/useTokens.ts`, `components/TokenExplorer.tsx`

### Description

`StellarService.getAllTokens()` is implemented as `return []` (`stellar-impl.ts:813-815`). Any
consumer (Token Explorer's "all tokens" view, dashboard aggregates) silently renders an empty state
that is indistinguishable from "no tokens exist," with no error and no telemetry. The contract offers
no `get_all_tokens` view either, so this needs a real design: the factory _does_ have a global
`token_count` and 1-based `get_token_info(index)`, which supports index-range pagination; events
provide a complementary path. Shipping a permanently empty core screen misleads users into thinking
the factory is unused and hides every other creator's tokens.

### Tasks

- [ ] Implement paginated global listing: read `token_count` from `get_state`, then fetch
      `get_token_info(i)` for a bounded index window (newest-first), batched with `Promise.allSettled`
      and a concurrency cap to respect RPC rate limits (`docs/rpc-rate-limits.md`).
- [ ] Change the signature to `getAllTokens(offset, limit)` returning `{ tokens, total }`; wire
      `useTokens`/`TokenExplorer` to real pagination controls with loading/error states.
- [ ] Cache pages keyed by `(network, contractId, page)` with invalidation on `created` events.
- [ ] Distinguish "factory has zero tokens" from "fetch failed" in the UI.
- [ ] Remove the stub or make any intentionally unimplemented method throw `NotImplemented` loudly so
      future stubs cannot ship silently; add an ESLint guard or test for empty-return stubs.
- [ ] Unit tests for pagination math (first page, last partial page, out-of-range) and failure
      fallbacks.

### Acceptance criteria

- Token Explorer lists real tokens from a populated factory with working pagination, proven by tests
  against a mocked RPC and by an e2e run against localnet.
- Fetch failures render an error state, never a fake empty list.

---

## Issue 14 — 🟠 Event-derived token lookups scan only the last 100 events — older tokens get placeholder data

**Area:** Frontend · `stellar-impl.ts` (`getTokenInfoByAddress`, `getTokenEvents`), `utils/fetchAllContractEvents.ts`

### Description

`getTokenInfoByAddress` fetches a single page of 100 factory events and looks for the token's
`created` event inside it (`stellar-impl.ts:887`). On any active factory, a token created more than
100 events ago (creations, mints, burns, metadata, fee changes all share the stream) falls off the
window: the function then fabricates a `TokenInfo` whose `name` is the raw address, `decimals` is a
guessed `7`, and `creator`/`metadataUri` are empty. `getTokenEvents` has the same truncation — it
filters one page of factory events, so a token's history silently shows only whatever happened
recently, presented as if complete. Wrong `decimals` is particularly damaging: every balance and
amount rendered for that token is off by orders of magnitude. Soroban RPC also only retains events
for a bounded retention window (~7 days on public infrastructure), which this design ignores entirely.

### Tasks

- [ ] For token identity data, stop deriving from events: resolve address → index via the contract
      (`TokenIndex` is on-chain; expose a `get_token_index(address)` / `get_token_info_by_address`
      view in the contract) and use `get_token_info` as the source of truth.
- [ ] For history, paginate exhaustively with cursors (reuse `fetchAllContractEvents`) up to the RPC
      retention limit, and surface the retention boundary in the UI ("history older than N days is
      not available from this RPC") instead of implying completeness.
- [ ] Never fabricate placeholder `TokenInfo` silently — return a typed "unresolved" result the UI
      renders as such.
- [ ] Add contract view + tests; frontend tests covering a token whose creation is beyond the first
      event page.
- [ ] Document the RPC retention constraint in `docs/rpc-rate-limits.md`.

### Acceptance criteria

- A token created arbitrarily long ago resolves correct name/symbol/decimals/creator via the contract
  view, proven by tests.
- Per-token history is cursor-paginated to the retention limit and the UI discloses the limit.
- No code path renders guessed decimals or address-as-name without an explicit "unresolved" marker.

---

## Issue 15 — 🟠 Uploaded images are validated by client-declared MIME type only — no content verification before pinning

**Area:** API + frontend · `api/ipfs/upload-file.ts`, `frontend/src/utils/validation.ts`, `components/TokenMetadata.tsx`

### Description

`upload-file.ts` checks `ALLOWED_TYPES.has(file.mimeType)` — but `mimeType` is whatever the client
wrote in the multipart header. Any payload (HTML, SVG with scripts, polyglot files, malware) can be
pinned by declaring `image/png`. The resulting CID is then permanently distributed under the
project's Pinata account through public gateways, and the app itself later renders
`gateway.pinata.cloud/ipfs/<cid>` content in `<img>` tags based on unvalidated metadata JSON
(`TokenMetadata`). While `<img>` sinks constrain direct script execution and CSP helps inside the
app, the proxy still functions as an anonymous distribution channel for arbitrary content
masquerading as token images (see Issue 6 for the authentication half), and non-image payloads break
rendering for every consumer of the metadata.

### Tasks

- [ ] Validate magic bytes server-side (JPEG `FF D8 FF`, PNG signature, GIF87a/89a) against the
      declared type; reject mismatches. Explicitly keep SVG off the allow-list and document why.
- [ ] Enforce dimension/pixel-count sanity limits (decompression-bomb guard) using a
      metadata-only probe (e.g. `image-size`) — no full decode of untrusted input in the function.
- [ ] Re-encode or strip metadata (EXIF) if feasible within serverless limits; otherwise document.
- [ ] On the client, validate the file signature in `isValidImageFile` too (fast feedback), keeping
      the server as the enforcement point.
- [ ] When rendering metadata images, only accept `ipfs://CID` values (already resolvable through the
      configured gateway); reject `http(s)` and other schemes at parse time in `isTokenMetadata`.
- [ ] Tests: spoofed MIME type rejected; each allowed format accepted; polyglot fixtures rejected;
      metadata with non-ipfs image URI rejected.

### Acceptance criteria

- A file whose content is not a real JPEG/PNG/GIF cannot be pinned regardless of declared type,
  proven by tests with spoofed fixtures.
- Metadata JSON with a non-`ipfs://` image reference is rejected at upload and ignored at render.

---

## Issue 16 — 🟠 `sendTransaction` non-ERROR failure statuses treated as success — `TRY_AGAIN_LATER`/`DUPLICATE` lead to false "pending" states and hung polls

**Area:** Frontend · `stellar-impl.ts` (`simulateAndSubmit`, `submitFeeBumpTransaction`, `pollTransaction`)

### Description

`simulateAndSubmit` checks only `submitResult.status === 'ERROR'` and otherwise proceeds to poll the
returned hash. Soroban RPC's `sendTransaction` can also return `TRY_AGAIN_LATER` (mempool pressure —
the transaction was **not** accepted) and `DUPLICATE`. In the `TRY_AGAIN_LATER` case the app polls a
hash that will never appear, burning the full backoff schedule (20 attempts) before surfacing a
generic timeout, while the user's signed transaction was simply dropped — no retry, no accurate
message. Compounding issues in the same path: `pollTransaction` wraps each `getTransaction` in
`withRetry` (retry-inside-retry multiplies worst-case wait), treats `NOT_FOUND` and transport errors
identically, and on timeout the UI cannot distinguish "never submitted" from "submitted, still
unconfirmed" — the latter matters because re-signing and resubmitting a _possibly-landed_ transaction
risks double execution (a real-funds hazard for `create_token`/`mint_tokens`).

### Tasks

- [ ] Handle every `sendTransaction` status explicitly: `PENDING` → poll; `DUPLICATE` → poll existing
      hash; `TRY_AGAIN_LATER` → bounded resubmission with backoff of the _same signed envelope_ (no
      re-sign), then a precise error; `ERROR` → parse and surface.
- [ ] Restructure polling: single retry layer, distinct handling for `NOT_FOUND` (keep polling until
      the transaction's `ledgerBounds`/timeout ledger passes, then definitive "not included") vs
      transport errors.
- [ ] Use the transaction's known timebounds to give a definitive inclusion verdict instead of an
      attempt-count timeout, eliminating the ambiguous state that invites unsafe resubmission.
- [ ] Propagate a typed status (`submitted`, `retrying`, `dropped`, `confirmed`, `failed`,
      `expired`) through `useTransaction`/`TransactionStatus` so the UI says exactly what happened
      and only offers "try again" when re-signing is provably safe.
- [ ] Unit tests for each status path with mocked RPC responses, including `TRY_AGAIN_LATER` storms
      and late inclusion after `NOT_FOUND` streaks.

### Acceptance criteria

- Every documented `sendTransaction` status has an explicit, tested code path; none falls through to
  hash-polling incorrectly.
- A dropped transaction produces an accurate user-facing message within the resubmission budget, and
  an expired transaction yields a definitive "safe to retry" signal — both proven by tests.

---

## Issue 17 — 🟡 `burn` acts as an open proxy for arbitrary token contracts, and skips `burn_enabled` for unknown tokens

**Area:** Smart contract · `lib.rs` (`burn`)

### Description

`burn(token_address, from, amount)` never verifies that `token_address` was deployed by this factory.
For unknown addresses the `TokenIndex` lookup simply returns `None` and the function proceeds to call
`balance` and `burn` on the **arbitrary external contract** — meaning (a) the factory-wide invariant
"a token's `burn_enabled` flag gates burning" only applies to known tokens, and (b) the factory
happily forwards calls (and emits its own official-looking `burn` events, polluting the indexed
history that Transaction History renders) for any contract anyone points it at. A malicious contract
at `token_address` also gets to execute arbitrary code mid-call with the factory as caller — the
reentrancy lock protects factory state, but the factory still lends its event log and its transaction
context to whatever the callee does. There is no legitimate use of factory-`burn` for non-factory
tokens; holders of external tokens can burn directly on those contracts.

### Tasks

- [ ] Require `TokenIndex(token_address)` to exist in `burn`; return `TokenNotFound` otherwise
      (making the `burn_enabled` check unconditional as a side effect).
- [ ] Audit `mint_tokens`, `set_metadata`, and `set_burn_enabled` for the same trust boundary
      (they currently do check the `owner` key — add explicit tests locking that in).
- [ ] Add tests: burn on a never-registered address fails; burn events are only ever emitted for
      factory tokens; `burn_enabled=false` blocks burn for every factory token with no bypass.
- [ ] Update `docs/contract-abi.md` (`burn` errors gain `TokenNotFound`).

### Acceptance criteria

- The factory only ever invokes token contracts it deployed, proven by tests.
- No code path can burn a factory token whose `burn_enabled` is false, and no factory `burn` event
  can reference a non-factory token.

---

## Issue 18 — 🟡 Inconsistent validation and error codes between single and batch creation paths

**Area:** Smart contract · `lib.rs` (`create_token_inner`, `validate_batch_params`, `create_token`)

### Description

The two creation paths have drifted:

- **Error codes differ for identical faults:** single-path returns `InvalidTokenParams` for bad
  name/symbol but `InvalidParameters` for bad decimals; the batch path returns `InvalidParameters`
  for _all_ of them. Client error mapping (`utils/contractErrors.ts`) can't render consistent
  messages, and documented ABI behavior differs by entrypoint for the same user mistake.
- **Type asymmetry:** single-path `initial_supply` is `u128` (with two _duplicated_ `> i128::MAX`
  guards at `lib.rs:383` and `lib.rs:396` — dead code from a merge), batch `initial_supply` is
  `i128` (negative rejected at validation). Same concept, two types, two validation shapes.
- **Feature asymmetry:** only the batch path supports `max_supply`; a single-token creator cannot cap
  supply at all (the README documents this as a caveat rather than it being fixed), and the
  single-path always writes `max_supply: None`.
- **Fee-check ordering differs:** batch validates all params before charging; single-path interleaves.

These asymmetries are where bugs like Issue 2 breed — the paths must share one validation and one
bookkeeping routine.

### Tasks

- [ ] Extract a single shared `validate_token_params` + `record_token` used by both paths; delete the
      duplicated `i128::MAX` guard.
- [ ] Unify `initial_supply` typing (recommend `i128` with `>= 0` validation to match the batch path
      and the SDK's mint signature) — note this is an ABI change; coordinate with the frontend
      (Issue 5's audit) and bump documented ABI.
- [ ] Add `max_supply: Option<i128>` to single `create_token` for parity.
- [ ] Normalize error codes: one documented code per fault class across both paths; update
      `docs/contract-abi.md` and `frontend/src/utils/contractErrors.ts`.
- [ ] Property tests asserting single-path and batch-path accept/reject exactly the same parameter
      sets with the same error codes.

### Acceptance criteria

- For every invalid parameter set, both creation paths return the identical error code, proven by a
  shared property-based test matrix.
- Single-token creation supports `max_supply` with the Issue 2-corrected accounting.
- No duplicated validation logic remains (one shared routine, verified by review).

---

## Issue 19 — 🟡 On-chain metadata URI is write-once and completely unvalidated

**Area:** Smart contract · `lib.rs` (`set_metadata`) + frontend rendering

### Description

`set_metadata` accepts **any** `String` as `metadata_uri` — no scheme check, no length bound beyond
Soroban's value limits, no CID shape check — and then locks it forever (`MetadataAlreadySet`). Two
distinct problems compound:

1. **Garbage-in, locked forever:** a typo'd CID, an `https://` URL to a server that later dies, or an
   outright empty/junk string becomes the token's permanent metadata pointer. There is no
   correct-after-mistake path, not even for the token creator, and no admin override — a single
   mis-click permanently disfigures a token that may carry real economic value.
2. **Untrusted sink:** clients (this app, explorers, other dApps) resolve whatever the string says.
   The frontend guards `ipfs://` at fetch time, but the contract-level contract ("metadata_uri is an
   IPFS URI", as the docs claim) is unenforced, so every consumer must implement its own defenses
   against `javascript:`, `data:`, oversized, or malicious URIs.

### Tasks

- [ ] Validate the URI on-chain: require the `ipfs://` prefix (or the documented allow-list of
      schemes), enforce a sane maximum length (e.g. ≤ 128 bytes), and reject empty strings with a
      dedicated `InvalidMetadataUri` error.
- [ ] Replace hard write-once with a governed update path: allow the token creator to update the URI
      a bounded number of times or within a grace window, or add an explicit
      `freeze_metadata(token_address)` the creator calls to make it immutable intentionally. Emit
      `meta` events on every change so history stays auditable.
- [ ] Schema/ABI documentation updates + migration step if storage shape changes.
- [ ] Frontend: surface the mutability state ("metadata frozen" badge), validate the CID shape
      client-side before paying the metadata fee.
- [ ] Tests: scheme rejection, length bounds, update-then-freeze flow, unauthorized update attempts,
      event emission per change.

### Acceptance criteria

- The contract rejects any metadata URI that is not a bounded-length `ipfs://` (or explicitly
  allow-listed) string, proven by tests.
- A creator can recover from a wrong URI through the governed update path, and can deliberately
  freeze metadata; both states are visible in the UI.

---

## Issue 20 — 🟡 Fee-split distribution edge cases: zero-share recipients, self-payment, and dust griefing

**Area:** Smart contract · `lib.rs` (`distribute_fee`, `set_fee_split`)

### Description

`distribute_fee` iterates split recipients computing `amount * bps / 10_000` per recipient. Several
edge cases are unhandled:

1. **Small-fee starvation:** for small `amount` (e.g. a 100-stroop fee with a 50-recipient split),
   every share floors to 0 and the _entire_ fee lands in `treasury` as "remainder" — silently
   defeating the configured split. Recipients entitled to 99% of fees can receive exactly nothing
   forever if fees are set low.
2. **Recipient set is unbounded and unvalidated:** `set_fee_split` accepts any number of recipients
   (each adding a cross-contract `transfer` call to _every_ fee-charging user transaction, inflating
   every user's gas and pushing invocations toward resource limits) and does not reject `bps == 0`
   entries, the `treasury`/payer themselves, or duplicate-of-treasury entries.
3. **Recipient-induced failure:** the split executes inside user transactions; a recipient address
   that cannot receive the fee token (e.g. a contract that traps in `transfer`, or a frozen
   trustline-style condition) makes **every** `create_token`/`mint_tokens`/`set_metadata` in the
   factory fail until the admin notices and resets the split — a griefing lever handed to any split
   recipient. Iteration order over a Soroban `Map` also makes remainder attribution
   implementation-defined.

### Tasks

- [ ] Cap the number of split recipients (e.g. ≤ 10) and reject `bps == 0` entries in
      `set_fee_split`; document the cap in the ABI.
- [ ] Implement largest-remainder (or equivalent) share allocation so the configured proportions hold
      for small amounts, with deterministic remainder assignment; document rounding behavior.
- [ ] Evaluate pull-over-push: accrue shares in contract storage and let recipients `claim_fees()`,
      so a broken recipient can never block user transactions; if push is kept, isolate per-recipient
      transfer failure so one bad recipient doesn't fail the whole call (and document the trade-off).
- [ ] Add events for split configuration changes and (if pull model) claims.
- [ ] Tests: dust amounts across recipient counts (property test: sum of transfers == charged fee,
      each recipient's long-run share converges to its bps), recipient-cap enforcement, zero-bps
      rejection, and a trapping-recipient scenario proving user transactions still succeed.
- [ ] Extend `fuzz_fee_arithmetic` with multi-recipient split configurations.

### Acceptance criteria

- No configuration exists where a recipient with non-zero bps receives zero over repeated
  representative fee amounts, proven by property tests.
- A malfunctioning split recipient cannot cause unrelated user transactions to fail.
- Split size and entry validity are enforced at configuration time with documented limits.

---

## Suggested triage order

| Order | Issues                     | Rationale                                                                                    |
| ----- | -------------------------- | -------------------------------------------------------------------------------------------- |
| 1     | #5, #11, #10               | Frontend/contract drift — core flows broken today; small, high-certainty fixes               |
| 2     | #1, #2, #4                 | Contract exploits with direct fund/economic impact; must precede any mainnet deploy          |
| 3     | #3, #7                     | Storage/TTL redesign — largest change, blocks long-term viability; do as one program of work |
| 4     | #6, #15                    | Proxy abuse surface — externally reachable today                                             |
| 5     | #8, #9, #17, #18, #19, #20 | Contract hardening batch (ties into the schema bump from #3)                                 |
| 6     | #12, #13, #14, #16         | Frontend correctness/robustness batch                                                        |

> Contract-ABI-affecting issues (#1, #2, #4, #8, #9, #17, #18, #19, #20) should be coordinated into as
> few schema-version bumps as possible, with `migrate` steps and `docs/contract-abi.md` updated in the
> same PRs.
