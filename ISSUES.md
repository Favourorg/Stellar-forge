# StellarForge — Tracked Issues

This document catalogs 30 non-trivial open issues identified in a full-codebase audit of StellarForge (smart contract, frontend, serverless API, and CI/infrastructure) conducted on 2026-08-18, with every claim re-verified against the source tree on 2026-08-19. It intentionally excludes issues that are already fixed and tracked elsewhere in the codebase (e.g. #5, #9, #913, #921, #943, #1005, #1006, #1007, #1022 — see `docs/CODEBASE_AUDIT_CHECKLIST.md`, `docs/STELLAR_IMPL_ABI_AUDIT.md`, and inline comments in `contracts/token-factory/src/lib.rs` for those).

Every issue below cites concrete file/line evidence in the current tree. Severities follow `SECURITY.md`'s definitions (Critical / High / Medium / Low) extended with **Medium-Low** and **Process** for hygiene/documentation items with no direct security or correctness impact.

**On the verification pass.** The re-verification was adversarial: each issue's central claim was checked against the code with the goal of disproving it. That pass rejected one issue outright (the original #11 asserted there was no centralized frontend validation module; `frontend/src/utils/validation.ts:78` is exactly that, and the entry has been replaced with the sharper defect found underneath it) and narrowed seven others whose descriptions over-claimed — most consequentially #23, whose remediation as originally written was not implementable, because the indexer it proposed falling back to stores no events at all. Issues are only useful if they survive someone trying to knock them down; these did, in their current form.

## Index

| #                                                                                             | Severity    | Area     | Title                                                                                |
| --------------------------------------------------------------------------------------------- | ----------- | -------- | ------------------------------------------------------------------------------------ |
| [1](#1-fee-split-distribution-is-not-fault-isolated-despite-documented-guarantee)             | Critical    | Contract | Fee-split distribution is not fault-isolated despite documented guarantee            |
| [2](#2-the-event-indexer-cron-job-is-never-actually-scheduled)                                | Critical    | Infra    | The event indexer cron job is never actually scheduled                               |
| [3](#3-wallet-auth-challenge-store-is-per-instance-in-memory)                                 | Critical    | API      | Wallet-auth challenge store is per-instance in-memory                                |
| [4](#4-jwt-signature-comparison-is-not-constant-time)                                         | High        | API      | JWT signature comparison is not constant-time                                        |
| [5](#5-stellar-signature-verification-rests-on-an-unverified-format-assumption)               | High        | API      | Stellar signature verification rests on an unverified format assumption              |
| [6](#6-contract-upgrade-has-no-on-chain-event-and-no-timelock)                                | High        | Contract | Contract `upgrade` has no on-chain event and no timelock                             |
| [7](#7-reentrancy-guard-is-never-tested-against-a-real-reentrant-call)                        | High        | Contract | Reentrancy guard is never tested against a real reentrant call                       |
| [8](#8-orphaned-ipfs-pins-accumulate-with-no-reconciliation)                                  | High        | Frontend | Orphaned IPFS pins accumulate with no reconciliation                                 |
| [9](#9-hand-built-contract-call-argument-lists-have-no-structural-safety-net)                 | High        | Frontend | Hand-built contract-call argument lists have no structural safety net                |
| [10](#10-fuzz-harnesses-fuzz-a-reimplementation-not-the-real-contract)                        | Medium-High | Contract | Fuzz harnesses fuzz a reimplementation, not the real contract                        |
| [11](#11-frontend-validation-silently-diverges-from-the-contract-in-both-directions)          | High        | Frontend | Frontend validation silently diverges from the contract in both directions           |
| [12](#12-no-explicit-batch-size-cap-on-create_tokens_batch)                                   | Medium      | Contract | No explicit batch-size cap on `create_tokens_batch`                                  |
| [13](#13-apiauthchallenge-has-no-rate-limiting)                                               | Medium      | API      | `/api/auth/challenge` has no rate limiting                                           |
| [14](#14-rate-limiter-silently-degrades-to-a-non-durable-no-op)                               | Medium      | API      | Rate limiter silently degrades to a non-durable no-op                                |
| [15](#15-apihealthindexer-leaks-raw-internal-error-strings)                                   | Medium      | API      | `/api/health/indexer` leaks raw internal error strings                               |
| [16](#16-two-divergent-verceljson-files-with-inconsistent-security-headers)                   | Medium      | Infra    | Two divergent `vercel.json` files with inconsistent security headers                 |
| [17](#17-csp-allows-unsafe-inline-for-style-src)                                              | Medium      | Infra    | CSP allows `'unsafe-inline'` for `style-src`                                         |
| [18](#18-dependabot-auto-merge-has-no-package-age-or-provenance-gate)                         | Medium      | Infra    | Dependabot auto-merge has no package-age or provenance gate                          |
| [19](#19-token-explorer-has-no-namesymbol-search)                                             | Medium      | Frontend | Token Explorer has no name/symbol search                                             |
| [20](#20-no-pre-signature-fee-breakdown-shown-to-users)                                       | Medium      | Frontend | No pre-signature fee breakdown shown to users                                        |
| [21](#21-tokendetail-admin-field-displays-the-creator-not-the-live-token-admin)               | Medium      | Frontend | `TokenDetail` "Admin" field displays the creator, not the live token admin           |
| [22](#22-token-listing-pagination-is-not-snapshot-consistent)                                 | Medium      | Frontend | Token listing pagination is not snapshot-consistent                                  |
| [23](#23-the-indexer-stores-no-events-so-token-history-is-permanently-retention-limited)      | Medium      | Frontend | The indexer stores no events, so token history is permanently retention-limited      |
| [24](#24-no-automated-detection-for-access-control-documentation-drift)                       | Medium      | Process  | No automated detection for access-control documentation drift                        |
| [25](#25-the-token-wasm-security-audit-spec-was-scoped-and-never-executed-or-closed)          | Medium      | Process  | The token-WASM security-audit spec was scoped and never executed or closed           |
| [26](#26-clientip-has-unverified-possibly-inverted-x-forwarded-for-parsing)                   | Medium-Low  | API      | `clientIp()` has unverified, possibly-inverted X-Forwarded-For parsing               |
| [27](#27-ipfs-metadata-is-trusted-with-no-content-hash-verification-against-the-cid)          | Medium-Low  | Frontend | IPFS metadata is trusted with no content-hash verification against the CID           |
| [28](#28-dev-dockerfiles-run-as-root-with-an-unpinned-base-image)                             | Low         | Infra    | Dev Dockerfiles run as root with an unpinned base image                              |
| [29](#29-multiple-kirospecs-directories-are-abandoned-stubs)                                  | Low         | Process  | Multiple `.kiro/specs` directories are abandoned stubs                               |
| [30](#30-adr-005s-privacy-guarantees-have-no-traceable-link-to-the-code-that-implements-them) | Low         | Process  | ADR-005's privacy guarantees have no traceable link to the code that implements them |

---

## 1. Fee-split distribution is not fault-isolated despite documented guarantee

**Severity:** Critical · **Area:** Contract (`contracts/token-factory/src/lib.rs`)

### Description

`distribute_fee`'s doc comment (`lib.rs:326-328`) states:

> "Per-recipient transfer failures are isolated: a recipient whose address cannot accept the fee token does NOT abort the whole call — their share is redirected to treasury so user transactions always succeed."

The implementation does not do this. The per-recipient payout loop (`lib.rs:403-409`) and the non-split path (`lib.rs:415`) both call `fee_client.transfer(payer, &addr, &share)` — the **panicking** SEP-41 client method, never `try_transfer`. Soroban aborts the entire host transaction on any panic/trap raised by a cross-contract call. If a single configured fee-split recipient cannot accept the fee token (frozen account, revoked trustline, clawback-locked balance, or a misbehaving contract address), **every** `create_token`, `create_tokens_batch`, `mint_tokens`, and `set_metadata` call reverts for **every user**, factory-wide, until an admin calls `set_fee_split` again to remove the bad recipient. This is a single-admin-error (or targeted griefing, if a split recipient is ever attacker-influenced) denial-of-service on the entire product, directly contradicting the safety guarantee the code claims to provide.

### Tasks

- [ ] Replace `fee_client.transfer(...)` with `fee_client.try_transfer(...)` in both the split-payout loop (`lib.rs:403-409`) and the non-split path (`lib.rs:415`).
- [ ] On a failed per-recipient transfer, redirect that recipient's share to `treasury` instead of aborting, exactly as the doc comment already promises.
- [ ] Ensure the _transfer to treasury itself_ failing is still a hard error (there's no further fallback recipient) — decide and document this terminal case.
- [ ] Emit a distinguishable event (or extend the existing `fees` event) when a redirect occurs, so admins can detect a broken split recipient without reading contract logs manually.
- [ ] Update `docs/contract-abi.md` fee-split section to reflect the corrected, now-true behavior.

### Acceptance Criteria

- [ ] A new contract test configures a fee split containing one address guaranteed to reject the fee-token transfer (e.g. an un-trusted/frozen asset holder) and asserts `create_token` **still succeeds**, with that recipient's share landing in `treasury`.
- [ ] A regression test asserts the existing happy-path fee-split accounting (sum of transfers == `amount`, largest-remainder assignment) is unchanged for all-good recipients.
- [ ] `cargo test` and the existing fuzz targets pass with no change to the largest-remainder rounding logic.
- [ ] The doc comment on `distribute_fee` and `docs/contract-abi.md` accurately describe the (now real) isolation guarantee.

---

## 2. The event indexer cron job is never actually scheduled

**Severity:** Critical · **Area:** Infra (`vercel.json`, `frontend/vercel.json`, `api/cron/index-tokens.ts`)

### Description

`api/cron/index-tokens.ts`'s header comment says it is "Invoked by the Vercel cron entry in `vercel.json`," and `.kiro/specs/contract-event-indexing/tasks.md` states "`vercel.json` schedules every 5 minutes." **Neither `vercel.json` (repo root) nor `frontend/vercel.json` contains a `crons` array** — both files define only a `headers` block (confirmed by direct inspection; `grep -rn "crons" **/*.json` returns nothing in the repo). Vercel Cron Jobs are configured exclusively via a `crons` entry in the deployed project's `vercel.json`; without one, `/api/cron/index-tokens` is simply never invoked automatically.

The practical effect: the indexer never backfills or ingests events, `POSTGRES_URL`-backed storage sits empty forever, `/api/health/indexer` reports `healthy: false` in perpetuity (`state.lastRunAt` never advances past `null`), and the entire indexer subsystem — `api/_lib/indexer/*`, the Postgres migration, the read API in `api/tokens/*` — is dead code in every real deployment. Since the frontend was specifically built to fall back gracefully to direct RPC when the indexer is unhealthy, this fails "safe" in the sense that the app still works — but it silently defeats the entire point of building the indexer (unbounded token-history retrieval past the RPC's 100-event/retention-window caps, per `docs/indexer.md`), and nobody would know unless they went looking at `/api/health/indexer` specifically.

### Tasks

- [ ] Determine the actual deployed Vercel project root (the README's one-click deploy button sets `root=frontend` — confirm whether `vercel.json` or `frontend/vercel.json` is authoritative, or whether both need one).
- [ ] Add a `crons` entry invoking `/api/cron/index-tokens` at the frequency described in the indexer design doc, gated by the two currently-unresolved "Needs a human" items in `.kiro/specs/contract-event-indexing/tasks.md`: (a) confirm the Vercel plan's minimum cron interval (Hobby is daily-only; a paid plan is required for the assumed 5-minute cadence), and (b) confirm the RPC provider's event-retention window, which bounds how stale a cold-started Phase B ingest can be.
- [ ] If the deployment is on a plan that cannot support 5-minute cadence, either upgrade the plan or update the lag thresholds (`LAG_WARNING_SECONDS` / `LAG_CRITICAL_SECONDS` in `api/_lib/indexer/ingest.ts`) and documentation to match the achievable cadence.
- [ ] Add a deploy-time or CI smoke check that fails the build if `vercel.json`'s `crons` array is missing or does not include the indexer path, so this cannot silently regress again.

### Acceptance Criteria

- [ ] `vercel.json` (the one governing the real deployment) contains a `crons` entry targeting `/api/cron/index-tokens` at a plan-supported interval.
- [ ] After deployment, `/api/health/indexer` transitions to `healthy: true` with `lastRunAt` advancing on schedule and `backfillComplete` eventually reaching `true`.
- [ ] A CI check (or documented manual verification step in the deployment checklist) asserts the cron configuration is present before every production deploy.
- [ ] `docs/indexer.md` and `.kiro/specs/contract-event-indexing/tasks.md` M1 items are marked resolved with the plan/interval actually chosen.

---

## 3. Wallet-auth challenge store is per-instance in-memory

**Severity:** Critical · **Area:** API (`api/auth/challenge.ts`)

### Description

`api/auth/challenge.ts:13-16` stores issued challenges in a bare in-process `Map`, with the comment: _"In production, swap for Vercel KV. For now, per-instance memory... acceptable for challenges since they're short-lived."_ That reasoning addresses TTL staleness, not the actual failure mode: on Vercel's serverless model, the `GET` request that issues a challenge and the subsequent `POST` that verifies it are independent invocations with **no guaranteed routing affinity** to the same process. A `GET` handled by instance A writes to instance A's `Map`; the paired `POST` can land on instance B, which has never seen that challenge, and legitimately-correct clients receive `"Challenge not found or expired. Request a new challenge."` (`challenge.ts:83`) at a rate governed by Vercel's instance scaling — not by anything the client did wrong.

This is the exact class of bug `api/_lib/rateLimit.ts` was already fixed for: it supports a durable Vercel KV backend with in-memory explicitly marked dev-only (`rateLimit.ts:9-19`, `"not production-safe"` comment). `challenge.ts` never received the same treatment, leaving the entire wallet-signature login flow — which every authenticated IPFS upload depends on — unreliable in exactly the environment it's deployed to.

### Tasks

- [ ] Extract the KV-backed key/value helpers already written in `api/_lib/rateLimit.ts` (`kvGet`/`kvSet`) into a shared module.
- [ ] Rewrite `challenges` storage in `challenge.ts` to use the same Vercel KV path, with in-memory as an explicit, clearly-labeled local-dev-only fallback (mirroring `rateLimit.ts`'s pattern exactly).
- [ ] Preserve the existing TTL/cleanup semantics (5-minute expiry, one-time use — delete on successful or failed verification).
- [ ] Add an integration test that simulates two independent invocations (no shared module state) to prove the challenge round-trips correctly through the KV path.

### Acceptance Criteria

- [ ] A challenge issued in one process/request context can be verified successfully from a separate process/request context that shares only the KV store.
- [ ] Existing single-instance tests continue to pass unmodified against the fallback path.
- [ ] `/api/health/*` (or a new dedicated check) surfaces whether the challenge store is durable, analogous to `isDurableStoreConfigured()` for the indexer.
- [ ] No behavioral change to challenge TTL, one-time-use, or the 400/401/500 response contract already documented in the handler.

---

## 4. JWT signature comparison is not constant-time

**Severity:** High · **Area:** API (`api/_lib/jwt.ts`)

### Description

`verifyToken` (`jwt.ts:56`) compares the provided and expected HMAC signatures with `signatureProvided !== expectedSignature` — a plain JavaScript string inequality check, which short-circuits at the first mismatched character. This leaks, via response timing, how many correct leading bytes of the signature an attacker has already guessed. Repeated requests against a timing oracle can, in principle, let an attacker incrementally forge a valid signature for an arbitrary `{address, iat, exp}` payload without ever learning `JWT_SECRET`, fully bypassing wallet-signature authentication on the IPFS upload endpoints this token gates. This is a textbook, well-documented vulnerability class (CWE-208) with a standard fix already available in Node's `crypto` module.

### Tasks

- [ ] Replace the `!==` comparison with `crypto.timingSafeEqual` on two fixed-length `Buffer`s.
- [ ] Guard the length check _before_ calling `timingSafeEqual` (it throws, rather than returning false, on mismatched-length buffers) without introducing a new length-based timing signal of its own — compare against a fixed-length HMAC digest buffer, not the raw base64url string length.
- [ ] Audit `api/auth/challenge.ts` and any other equality checks on secrets/signatures in the codebase for the same anti-pattern.

### Acceptance Criteria

- [ ] `verifyToken` uses `crypto.timingSafeEqual` for signature comparison.
- [ ] Existing JWT tests (valid token, tampered payload, tampered signature, expired token) all still pass.
- [ ] A new test asserts a signature comparison of mismatched-length input does not throw and is rejected.
- [ ] A short code comment documents _why_ constant-time comparison is required here, so it isn't "simplified" back to `!==` in a future refactor.

---

## 5. Stellar signature verification rests on an unverified format assumption

**Severity:** High · **Area:** API (`api/auth/challenge.ts`)

### Description

`verifyStellarSignature` (`challenge.ts:118-140`) contains this comment directly above the code that decodes the client-supplied signature:

> "For simplicity, we assume the signature is base64-encoded directly (Freighter returns the signature directly, not wrapped in XDR)"

This contradicts the parameter's own name (`signatureXdr`) and the handler's top-of-file comment describing it as "the XDR-encoded signed message from Freighter's `signMessage`." A `Keypair` is constructed via `Keypair.fromPublicKey(address)` (`challenge.ts:129`) and then never used — the verification actually runs against raw bytes from `StrKey.decodeEd25519PublicKey(address)`, suggesting an incomplete or abandoned implementation attempt. There is no test file for this module (`api/auth/challenge.ts` has no corresponding `*.test.ts`). If the real format Freighter returns differs from what's assumed here — which is plausible given the encoding conflict already present in the comments — every login attempt could be silently rejected, or worse, could be silently accepted incorrectly, depending on how `Buffer.from(signatureXdr, 'base64')` degrades on malformed input.

### Tasks

- [ ] Determine the actual wire format Freighter's `signMessage` API returns (check the installed `@stellar/freighter-api` version's types/docs, or capture a real signed response in a manual test against testnet).
- [ ] Fix the decoding in `verifyStellarSignature` to match reality — including correcting or removing the dead `Keypair.fromPublicKey` call.
- [ ] Add `api/auth/challenge.test.ts` with fixtures covering: a valid signature (accept), a tampered signature (reject), a signature for the wrong challenge value (reject), and malformed base64 input (reject without throwing an unhandled exception).
- [ ] Cross-check the frontend caller (wherever `signMessage` is invoked before POSTing to `/api/auth/challenge`) to confirm both sides agree on the exact encoding.

### Acceptance Criteria

- [ ] A documented, tested round trip: frontend signs a real challenge with Freighter, backend verifies it successfully, end-to-end (manual or e2e test).
- [ ] Unit tests cover accept and all reject paths listed above.
- [ ] No dead code (unused `Keypair` construction) remains in the verification path.
- [ ] The comment claiming "we assume" is replaced with a comment stating the actual, verified format.

---

## 6. Contract `upgrade` has no on-chain event and no timelock

**Severity:** High · **Area:** Contract (`contracts/token-factory/src/lib.rs`)

### Description

`upgrade()` swaps the factory's executable WASM immediately, on a single admin signature, with no on-chain event emitted (already tracked as "issue #9" in `SECURITY.md` and `docs/incident-response.md`, which document that detection currently requires active polling of the on-chain WASM hash). Beyond the missing event, there is no grace period between an `upgrade` call being submitted and taking effect: a compromised admin key can redeploy the factory to attacker-controlled code atomically, with zero warning window for monitoring, a multisig quorum, or the community to react before it's live. Given `SECURITY.md` itself classifies "contract upgrade to attacker WASM" as the single Critical-severity scenario in its own severity table, the current design offers no defense-in-depth against the exact failure mode it considers worst-case.

### Tasks

- [ ] Add a Soroban event emission to `upgrade()` (and `migrate()`) carrying the old and new WASM hash, closing the originally-tracked gap.
- [ ] Design and implement a two-step upgrade: `propose_upgrade(admin, new_wasm_hash)` records the pending hash and a ready-at ledger timestamp/sequence; `upgrade()` (or a renamed `execute_upgrade`) only succeeds once that delay has elapsed and only for the previously-proposed hash.
- [ ] Add a `cancel_upgrade(admin)` escape hatch so a proposed-but-not-yet-executed upgrade can be aborted if the proposal itself was made in error or under duress.
- [ ] Update `docs/incident-response.md` to describe the new timelock window as an active defense, not just a polling-detection gap.
- [ ] Update `docs/contract-abi.md` and the README's "Contract Upgrade Process" section with the new two-step flow, including the new error variants and events.

### Acceptance Criteria

- [ ] A test asserts `execute_upgrade` fails with a new `Error` variant (e.g. `UpgradeNotReady`) before the timelock delay has elapsed.
- [ ] A test asserts `execute_upgrade` succeeds once the delay has elapsed, and that it upgrades to exactly the previously-proposed hash (calling it with a different hash than proposed fails).
- [ ] A test asserts `cancel_upgrade` clears the pending proposal and a subsequent `execute_upgrade` call fails with `NoueUpgradePending` (or equivalent).
- [ ] An event is emitted on `propose_upgrade`, `cancel_upgrade`, and successful execution, each carrying the relevant WASM hash(es).
- [ ] `docs/mainnet-deployment-checklist.md` is updated to reflect the new operational upgrade procedure.

---

## 7. Reentrancy guard is never tested against a real reentrant call

**Severity:** High · **Area:** Contract (`contracts/token-factory/src/lib.rs`, `test.rs`)

### Description

`test.rs:2704-2711` states outright that the Soroban test environment "does not support running a malicious re-entrant WASM in-process," so every existing reentrancy test (e.g. `test_mint_tokens_reentrancy_guard`, `test.rs:2717+`) simulates the _mid-execution_ state by directly writing `locked = true` into storage before calling the guarded function, then asserting it's rejected. This only proves the guard **rejects when already locked** — it proves nothing about whether the lock is actually acquired _before_ the vulnerable external call in the real, unmodified control flow, and nothing prevents a future refactor from reordering `state.locked = true; save_state()` to _after_ a cross-contract call while every existing test continues to pass unchanged. This is precisely the kind of invariant a test suite exists to protect, and currently doesn't.

### Tasks

- [ ] Build (or vendor) a minimal malicious Soroban WASM contract, deployable in the test harness, whose `initialize` (or another lifecycle hook invoked during token deployment) calls back into the factory's `create_token`/`mint_tokens` before returning.
- [ ] Deploy the factory with this malicious WASM registered as `token_wasm_hash` in a dedicated test, and assert the reentrant inner call is rejected by the guard — proving the lock is acquired before the external call actually happens, not just that a pre-set lock is honored.
- [ ] Document in `test.rs` why this test exists and what gap it closes relative to the existing state-injection tests, so it isn't mistaken for a duplicate and removed.
- [ ] If a genuinely in-process malicious WASM is infeasible with the current `soroban-sdk` test harness version, document that limitation explicitly and add the strongest available substitute (e.g. an integration test against a local Soroban RPC/sandbox with a real deployed malicious contract).

### Acceptance Criteria

- [ ] A new test exercises the real `create_token`/`mint_tokens` code path end-to-end with an actual attempted reentrant call, not a pre-injected lock state.
- [ ] The test fails (i.e. would catch the bug) if the lock-acquisition line is manually moved after the external call, verified by a temporary local repro before the fix is finalized.
- [ ] `contracts/token-factory/fuzz/README.md` and `test.rs` document the limitation of the existing state-injection tests relative to this new coverage.

---

## 8. Orphaned IPFS pins accumulate with no reconciliation

**Severity:** High · **Area:** Frontend / API (`frontend/src/services/ipfs.ts`, `api/ipfs/*`)

### Description

`uploadMetadata()` in `frontend/src/services/ipfs.ts` (lines ~99-135) uploads the token image and then the metadata JSON to Pinata — both are pinned (permanently billed) storage — **before** the caller ever submits the on-chain `set_metadata` transaction. If the user rejects the Freighter signature prompt, the transaction fails simulation, the network request times out, or the contract returns `MetadataAlreadySet` (a second attempt on an already-configured token), the just-created pins are never cleaned up. There is no `unpin` call anywhere in `frontend/src` or `api/`, and no scheduled reconciliation job comparing Pinata's pin list against on-chain `meta` events. Every abandoned or failed metadata-set attempt leaves permanent, unbounded storage cost on the project's Pinata account with no way to identify or reclaim it short of manual dashboard auditing.

### Tasks

- [ ] Add an `unpin(cid)` helper to the IPFS service layer (backed by a new authenticated `api/ipfs/unpin.ts` proxy, consistent with the existing upload-proxy pattern that keeps Pinata credentials server-side).
- [ ] On a failed or user-rejected `set_metadata` call, unpin both the image and JSON CIDs that were just uploaded for that attempt.
- [ ] For failures that happen _after_ the pins might already be considered valid (e.g. network timeout with unknown transaction outcome), do not unpin blindly — instead:
- [ ] Build a reconciliation job (can reuse the indexer's cron infrastructure once issue #2 is resolved) that periodically lists an account's pins, cross-references them against `meta` events / `get_token_info` for confirmed on-chain usage, and unpins anything orphaned past a grace window (e.g. 24 hours).
- [ ] Log/metric the number of pins cleaned up per run for cost visibility.

### Acceptance Criteria

- [ ] A test simulates an upload followed by a rejected/failed `set_metadata` call and asserts an unpin request is issued for both CIDs.
- [ ] A test for the reconciliation job asserts pins referenced by a confirmed `meta` event are preserved, and pins with no matching on-chain reference older than the grace window are removed.
- [ ] The Pinata credentials remain server-side only (no regression on the existing `PINATA_API_KEY`/`PINATA_API_SECRET` server-only boundary documented in the README).
- [ ] `docs/metadata-format.md` documents the pin lifecycle, including the grace window and reconciliation cadence.

---

## 9. Hand-built contract-call argument lists have no structural safety net

**Severity:** High · **Area:** Frontend (`frontend/src/services/stellar-impl.ts`)

### Description

Every write path — `deployToken`, `mintTokens`, `burnTokens`, `setMetadata`, `updateFees`, `setWhitelistEnabled`, and others in `stellar-impl.ts` — hand-builds its `contract.call(...)` argument list inline, independently, with no shared, typed builder derived from the contract's actual ABI. This exact pattern — an extra or misordered argument silently accepted by TypeScript because `contract.call` takes a loose `...args: ScVal[]` — is precisely what caused the previously-fixed CRITICAL issue #5 (`docs/CODEBASE_AUDIT_CHECKLIST.md`: every token-deployment transaction failing at RPC simulation because of an inserted `tokenWasmHash` argument). The existing mitigation, `scripts/check-abi-doc-drift.sh`, goes a step further than name-presence in docs — it extracts `contract.call('name')` sites from the frontend and fails if a called name has no matching `pub fn` in `lib.rs` (`check-abi-doc-drift.sh:62-72`). But it validates only the _name_: argument _count_, _order_, and _type_ are never checked against the Rust signature, which is exactly the axis issue #5 broke on. The recommendation to close that gap was written down after issue #5 was fixed — `docs/CODEBASE_AUDIT_CHECKLIST.md:102-104` still lists "Add AST-based parameter validation…" unchecked — and never implemented, leaving every one of these six-plus call sites one careless edit away from silently reintroducing the same class of bug.

### Tasks

- [ ] Choose an approach: (a) generate a typed argument builder per entrypoint from `contracts/token-factory/src/lib.rs`'s signatures at build time, or (b) write an AST-based CI check comparing each `contract.call('fn_name', ...)` site's argument count/order against the corresponding `#[contractimpl]` function signature.
- [ ] Implement the chosen check as a CI job (or extend `scripts/check-abi-doc-drift.sh`) that fails on any drift between `lib.rs` signatures and `stellar-impl.ts` call sites.
- [ ] Backfill the check against all current call sites to confirm zero existing drift (regression baseline).
- [ ] Document the mechanism in `docs/STELLAR_IMPL_ABI_AUDIT.md` as the permanent structural fix superseding the manual-audit approach used to resolve issue #5.

### Acceptance Criteria

- [ ] A deliberately-introduced extra/misordered argument in a call site fails CI locally when the new check is run.
- [ ] All existing call sites pass the new check with zero modifications required (proving no current drift).
- [ ] The check runs in the same CI workflow(s) that already run `check-abi-doc-drift.sh`.
- [ ] The unchecked "Add AST-based parameter validation" item at `docs/CODEBASE_AUDIT_CHECKLIST.md:102-104` is marked done, with a link to the implementation.

---

## 10. Fuzz harnesses fuzz a reimplementation, not the real contract

**Severity:** Medium-High · **Area:** Contract (`contracts/token-factory/fuzz/`)

### Description

`fuzz_burn.rs` and `fuzz_fee_arithmetic.rs` (and largely `fuzz_mint_tokens.rs`, `fuzz_set_metadata.rs`) reimplement the validation/arithmetic logic inline inside the fuzz target itself — e.g. `fuzz_burn.rs:20` computes `initial_balance.saturating_sub(burn_amount)` directly rather than invoking the real `TokenFactory::burn` entrypoint through a `soroban_sdk::testutils::Env`. No target imports `soroban_sdk` or `TokenFactory` — `fuzz/Cargo.toml` lists only `libfuzzer-sys` and `arbitrary`, so the contract crate is not even a dependency and calling the real entrypoint is currently impossible without a build-graph change. `fuzz_create_token.rs:21-24` describes itself, accurately, as a "Pure re-implementation." This means a genuine bug introduced in `lib.rs` — a wrong operator, a missing `checked_` call, an off-by-one in a bounds check — can silently diverge from the fuzz author's mental model of the logic while every fuzz target stays green indefinitely, producing false confidence in exactly the area (arithmetic/fee/burn correctness) fuzzing is meant to protect. Additionally, no fuzz target exists at all for `create_tokens_batch`, `set_fee_split`/`distribute_fee` end-to-end, `migrate`, or the whitelist gate — some of the highest-complexity, highest-stakes entrypoints in the contract.

### Tasks

- [ ] Rewrite `fuzz_burn.rs` and `fuzz_fee_arithmetic.rs` to invoke the actual `TokenFactory` contract functions via a `soroban_sdk::testutils::Env`-backed harness, asserting against an independently-computed oracle rather than re-deriving the contract's own logic inline.
- [ ] Audit `fuzz_mint_tokens.rs` and `fuzz_set_metadata.rs` for the same pattern and fix similarly.
- [ ] Add a new fuzz target for `create_tokens_batch` covering batch size, mixed valid/invalid entries, and cumulative fee accounting.
- [ ] Add a new fuzz target for `distribute_fee`/`set_fee_split`, covering basis-point edge cases (0, 10_000 exactly, duplicate addresses, empty splits) — this target should also exercise the fix from issue #1 once implemented.
- [ ] Add a new fuzz target for `migrate`, covering out-of-order/repeated calls and multi-version catch-up.

### Acceptance Criteria

- [ ] Each rewritten/new fuzz target calls the real contract entrypoint (not a reimplementation) and only uses an independently-derived oracle for the pass/fail assertion.
- [ ] A deliberately-introduced regression in `lib.rs` (e.g. flipping a comparison operator in a bounds check) is caught by the corresponding fuzz target within a bounded run (documented in `contracts/token-factory/fuzz/README.md`).
- [ ] New targets are wired into the same fuzz CI job (`.github/workflows/fuzz-testing.yml`) as existing ones.
- [ ] `contracts/token-factory/fuzz/README.md` documents each target's real-vs-oracle coverage explicitly, so this gap doesn't silently reopen.

---

## 11. Frontend validation silently diverges from the contract in both directions

**Severity:** High · **Area:** Frontend (`frontend/src/utils/validation.ts`)

### Description

`frontend/src/utils/validation.ts:78` does have a block headed _"Single source of truth for token field rules"_, exported as `validateTokenParams` (`:111`) and consumed by the shared `TokenForm`, with boundary tests in `frontend/src/test/validateTokenParams.test.ts`. So centralization is not the problem. The problem is that this single source of truth is **not the same source of truth the contract uses**, and nothing detects the gap.

`validate_token_params` (`lib.rs:749-773`) enforces exactly three things on names and symbols: non-empty, `name.len() <= 32`, `symbol.len() <= 12`. On a Soroban `String`, `len()` counts **bytes**. It places no restriction whatsoever on which characters a name may contain.

The frontend enforces something materially different:

1. **An undocumented ASCII-only allow-list.** `TOKEN_NAME_PATTERN = /^[A-Za-z0-9 _-]+$/` (`validation.ts:81`) and `TOKEN_SYMBOL_PATTERN = /^[A-Za-z0-9-]+$/` (`:85`) reject every non-Latin script. A user cannot create a token named `Café`, `Наира`, `日本コイン`, or `نايرا` through the UI — even though the contract accepts all of them, any other Stellar client can create them, and such tokens render fine everywhere in the app. This restriction appears in no spec, no ADR, and no user-facing documentation; the README tells users only that names are "≤ 32 chars". For a project whose stated purpose is serving "creators, entrepreneurs, and businesses in **emerging markets**," a silent Latin-alphabet-only gate on the primary product action is a significant functional and inclusivity defect, not a cosmetic one.

2. **A latent unit mismatch, currently masked.** `isTokenNameLengthValid` (`:91`) measures with `trimmedName.length`, which counts UTF-16 code units, while the contract counts UTF-8 bytes. These agree only for ASCII — so the ASCII pattern in (1) is the sole reason this has not already produced wrong behavior. The moment anyone relaxes the pattern to fix (1) without also fixing the counting, the bug goes live in the worst way: a 32-character name in a non-Latin script is up to 96 bytes, passes the client, and is rejected on-chain with `InvalidTokenParams` **after** the user has signed and paid. Fixing the visible problem therefore activates the hidden one, which is why they must be treated as one issue.

3. **No drift detection.** Nothing ties `TOKEN_NAME_MAX_LENGTH` / `TOKEN_SYMBOL_MAX_LENGTH` / `TOKEN_DECIMALS_MAX` to `lib.rs`. `scripts/check-abi-doc-drift.sh` checks that called function _names_ exist; no equivalent guards parameter bounds. If a contract upgrade changes a limit, the frontend keeps enforcing the old one until a user hits it in production.

Compounding this, `.kiro/specs/invalid-parameters-validation/` is an empty stub (only `.config.kiro`), so the intended validation contract was never written down anywhere to check the implementation against (see issue #29).

### Tasks

- [ ] Decide and **document** the intended character policy. If the ASCII restriction is deliberate (e.g. anti-homograph/spoofing defense), state that rationale in an ADR and surface it in the form's help text and the README; if it is not, remove it.
- [ ] If the restriction is kept as a safety measure, replace the blanket ASCII allow-list with a targeted one that blocks the actual threat (mixed-script confusables, zero-width and bidirectional control characters, leading/trailing marks) while permitting ordinary non-Latin text.
- [ ] Fix the length unit **before or together with** any pattern change: measure with `new TextEncoder().encode(trimmed).length` so the client counts UTF-8 bytes exactly as `String::len()` does on-chain.
- [ ] Add a drift check, in the spirit of `scripts/check-abi-doc-drift.sh`, that parses the numeric bounds out of `validate_token_params` in `lib.rs` and fails CI if `validation.ts`'s constants disagree.
- [ ] Backfill or delete the `.kiro/specs/invalid-parameters-validation/` stub.

### Acceptance Criteria

- [ ] The character policy is documented, and the UI's behavior matches the documented policy exactly.
- [ ] A test asserts that a name of exactly 32 **bytes** in a multi-byte script is accepted, and one of 33 bytes is rejected — matching the contract byte-for-byte rather than by code-unit count.
- [ ] A test asserts the client and `validate_token_params` agree on the accept/reject verdict for a shared table of edge-case inputs (empty, whitespace-only, exactly-at-boundary, multi-byte, combining marks, emoji).
- [ ] CI fails if a bound in `validation.ts` diverges from the corresponding literal in `lib.rs`.
- [ ] No input that the UI accepts is ever rejected on-chain by `validate_token_params` — verified by the shared-table test, so users never pay for a transaction the client could have refused.

---

## 12. No explicit batch-size cap on `create_tokens_batch`

**Severity:** Medium · **Area:** Contract (`contracts/token-factory/src/lib.rs`)

### Description

`create_tokens_batch(creator, tokens: Vec<BatchTokenParams>, fee_payment)` (`lib.rs:859-938`) validates only that the batch is non-empty (`lib.rs:879`) and imposes **no upper bound** on `tokens.len()` before iterating and deploying each entry — unlike other unbounded-input surfaces in the same file that were deliberately capped for exactly this reason: `MAX_FEE_SPLIT_RECIPIENTS` (`lib.rs:236`) and `MAX_TOKENS_BY_CREATOR_PAGE` (`lib.rs:201`).

The limit is not unknown — it is known and simply **not enforced where it matters**. `docs/contract-abi.md:140-172` carries a "Batch size limits and resource costs" section with a measured CPU/memory table from `contracts/token-factory/src/bench.rs`, records observed resource exhaustion at batch size 30, and states a **recommended maximum batch size of 20**. That recommendation is enforced only client-side, by `MAX_BATCH_SIZE` in `frontend/src/utils/validation.ts:269` via `validateBatchSize` (`:277`).

Client-side enforcement of a contract-level resource limit is enforcement in name only: the factory is a public on-chain interface, and anyone calling `create_tokens_batch` directly — via the Stellar CLI, another dApp, or a modified frontend — bypasses `validateBatchSize` entirely. Such a caller gets an opaque host-level resource-exhaustion failure instead of the contract's own clean, typed rejection that the rest of the codebase consistently favors, after paying for the work performed up to the point of exhaustion. The contract already knows its own safe bound; it just doesn't assert it.

### Tasks

- [ ] Add a `MAX_BATCH_SIZE` constant to `lib.rs`, seeded from the value already derived in `docs/contract-abi.md:140-172` (20, against observed exhaustion at 30) rather than re-derived from scratch.
- [ ] Reject `create_tokens_batch` calls exceeding `MAX_BATCH_SIZE` with a clear, existing or new `Error` variant, before any per-item work begins.
- [ ] Update `docs/contract-abi.md:140-172` to present the cap as contract-enforced rather than a recommendation, and reconcile the frontend's `MAX_BATCH_SIZE` (`validation.ts:269`) so the two constants cannot drift — ideally with the client deferring to the contract's documented value rather than holding an independent copy.
- [ ] Add a benchmark/test confirming a batch at exactly `MAX_BATCH_SIZE` completes within resource limits with margin.

### Acceptance Criteria

- [ ] A test asserts a batch of `MAX_BATCH_SIZE + 1` tokens is rejected by the **contract** with the new typed error, not a host-level resource-limit failure — proving the limit holds against callers that never touch the frontend.
- [ ] A test asserts a batch of exactly `MAX_BATCH_SIZE` tokens succeeds.
- [ ] The contract's cap and the frontend's `MAX_BATCH_SIZE` are the same number, with a check that fails if they diverge.
- [ ] `docs/contract-abi.md` describes the cap as enforced on-chain, with its measured rationale retained.

---

## 13. `/api/auth/challenge` has no rate limiting

**Severity:** Medium · **Area:** API (`api/auth/challenge.ts`)

### Description

Unlike the downstream upload endpoints, which call `isRateLimited` (`api/_lib/rateLimit.ts`), neither `handleGetChallenge` nor `handleVerifyChallenge` in `challenge.ts` apply any rate limiting. An attacker can flood challenge creation for arbitrary well-formed addresses (each just a cheap `randomBytes(32)` call plus a `Map.set`, per-address so there's no natural cap on distinct keys) and flood verification attempts against issued challenges. This both worsens the unbounded-memory-growth risk noted in issue #3 (once fixed to use KV, this becomes unbounded KV usage/cost instead) and removes any friction against brute-forcing or probing the signature-verification path from issue #5.

### Tasks

- [ ] Apply the same `isRateLimited` gate used in `api/ipfs/upload-file.ts`/`upload-json.ts` to both challenge endpoints, keyed by the requested `address`.
- [ ] Consider a separate, tighter limit for `GET` (challenge issuance) than `POST` (verification), since issuance has no proof-of-possession requirement at all.
- [ ] Add tests asserting repeated requests beyond the limit are rejected with a clear error/status code.

### Acceptance Criteria

- [ ] Both challenge endpoints reject requests once the configured rate limit is exceeded, mirroring the existing upload-endpoint behavior and error contract.
- [ ] Legitimate single-attempt login flows are unaffected by the new limit under normal test conditions.
- [ ] The rate-limit keys used here don't collide with unrelated upload-endpoint rate-limit keys for the same address (namespaced appropriately).

---

## 14. Rate limiter silently degrades to a non-durable no-op

**Severity:** Medium · **Area:** API (`api/_lib/rateLimit.ts`)

### Description

`isRateLimited` falls back to `isRateLimitedInMemory` whenever `VERCEL_KV_REST_API_URL`/`VERCEL_KV_REST_API_TOKEN` are unset (`rateLimit.ts:12-19`) — by the code's own comment, "not production-safe," for the same cross-instance reason described in issue #3. Unlike the indexer, which exposes `isDurableStoreConfigured()` through `/api/health/indexer`, or IPFS configuration, which is exposed through `/api/health/ipfs`, there is no equivalent visibility into whether rate limiting is actually durable in a given deployment. A production deployment that simply forgot to provision Vercel KV ships with effectively no working abuse protection on the upload endpoints, and nothing surfaces that fact anywhere an operator would look.

### Tasks

- [ ] Add an `isRateLimitDurable()` export (mirroring the indexer's pattern) reporting whether KV env vars are configured.
- [ ] Surface it through a health endpoint (either a new `/api/health/rate-limit` or folded into an existing general health check).
- [ ] Consider failing closed in production specifically (deny requests, or at minimum log loudly) when KV is unconfigured and `VERCEL_ENV === 'production'`, consistent with the fail-closed pattern already used for the cron endpoint's `CRON_SECRET` check in `api/cron/index-tokens.ts`.

### Acceptance Criteria

- [ ] A health/status endpoint reports rate-limiter durability, analogous to the existing indexer and IPFS health checks.
- [ ] A test confirms the durability flag correctly reflects presence/absence of the KV env vars.
- [ ] Production behavior when KV is unconfigured is deliberate (documented) rather than silent, matching the existing fail-closed precedent elsewhere in `api/`.

---

## 15. `/api/health/indexer` leaks raw internal error strings

**Severity:** Medium · **Area:** API (`api/health/indexer.ts`)

### Description

`GET /api/health/indexer` has no authentication beyond checking the HTTP method, and returns `lastError: state.lastError` verbatim to any caller. Depending on the underlying failure, this can include raw database driver or connection error text — potentially internal hostnames, port numbers, or other infrastructure details. This is inconsistent with the deliberate design of the neighboring `/api/health/ipfs` endpoint, whose comment at `api/health/ipfs.ts:10-11` explains that it deliberately reports "no key material, no lengths, no prefixes" — the same caution was not applied here.

### Tasks

- [ ] Sanitize `lastError` before returning it in the public response — map internal error messages to a small, stable set of generic categories (e.g. `"connection_failed"`, `"query_timeout"`, `"unknown"`).
- [ ] Keep full, unsanitized error detail in server-side logs only.
- [ ] Alternatively (or additionally), gate the raw-detail field behind an internal-only auth header/secret for operator tooling, while the public response stays sanitized.

### Acceptance Criteria

- [ ] The public response never contains raw driver/connection error strings, verified by a test that injects a realistic internal error and asserts the response body only contains an allow-listed category.
- [ ] Full error detail remains available in logs for debugging.
- [ ] Existing consumers of the `healthy`/`severity`/`lagSeconds` fields are unaffected.

---

## 16. Two divergent `vercel.json` files with inconsistent security headers

**Severity:** Medium · **Area:** Infra (`vercel.json`, `frontend/vercel.json`)

### Description

The repo root `vercel.json` sets only a Content-Security-Policy header. `frontend/vercel.json` sets the same CSP **plus** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy: camera=(), microphone=(), geolocation=()` — all entirely absent from the root file. The README's one-click Vercel deploy button sets `root=frontend`, suggesting `frontend/vercel.json` is the one that matters for that path, but it is not documented anywhere which file is authoritative for which deployment configuration, and nothing prevents a deployment path that picks up the weaker root file and ships without clickjacking (`X-Frame-Options`) or MIME-sniffing (`X-Content-Type-Options`) protection.

### Tasks

- [ ] Determine definitively which `vercel.json` governs the actual production deployment(s). Note there is no `docs/deployment-vercel.md` — the README linked to one that was never written, and that link now points at the README's own Deployment section instead, so this is the place to record the answer.
- [ ] Consolidate to a single source of truth (delete the redundant/superseded file), or, if both are genuinely needed for different deployment topologies, make the root file's header set a strict superset/match of the frontend one.
- [ ] Add a CI check that fails if the two files' `headers` arrays diverge, until/unless they're consolidated to one file.
- [ ] Document the chosen setup in the README's Deployment section (or a new `docs/deployment-vercel.md`, if one is written to back the link that previously assumed it).

### Acceptance Criteria

- [ ] Exactly one `vercel.json` is authoritative for the documented deployment path, or both are provably identical in their security-relevant headers with a CI check enforcing that.
- [ ] The deployment documentation explicitly states which `vercel.json` governs which deployment root.
- [ ] A manual header check (`curl -I` against a real deployment) confirms all five security headers are present on the live site.

---

## 17. CSP allows `'unsafe-inline'` for `style-src`

**Severity:** Medium · **Area:** Infra/Frontend (`frontend/src/csp/policy.ts`, generated into `vercel.json` / `index.html` / `public/_headers`)

### Description

The CSP generated from `frontend/src/csp/policy.ts` (the single source of truth, per its own header comment, propagated by `scripts/generateCSP.ts` into `index.html`, `vercel.json`, and `public/_headers`) includes `style-src 'self' 'unsafe-inline'`. This permits CSS-injection-based attacks (data exfiltration via CSS selectors, UI redress/clickjacking-adjacent techniques) to function even though `script-src 'self'` is otherwise strictly locked down — `'unsafe-inline'` on styles is a well-known, meaningful weakening of an otherwise strict policy, and undercuts the "strict CSP" framing used in the README's Security section.

### Tasks

- [ ] Identify what currently requires inline styles (likely a CSS-in-JS pattern, a UI library, or Tailwind's arbitrary-value/`style=` usage somewhere in `frontend/src/components`).
- [ ] Migrate inline styles to either static stylesheet classes, or a nonce-based/hash-based CSP exception scoped as tightly as possible (avoiding a blanket `'unsafe-inline'`).
- [ ] Update `frontend/src/csp/policy.ts` and regenerate via `npx tsx scripts/generateCSP.ts` once the underlying inline-style usage is eliminated or properly scoped.
- [ ] Run `npx tsx scripts/generateCSP.ts --check` in CI (if not already) to prevent the generated files from drifting from `policy.ts` again.

### Acceptance Criteria

- [ ] `style-src` no longer includes `'unsafe-inline'` (either removed entirely or replaced with a scoped nonce/hash mechanism).
- [ ] The app renders and functions identically in a manual smoke test with the tightened policy.
- [ ] `frontend/src/csp/cspReporter.ts`'s violation reporting (already wired to Sentry in production) shows zero new violations after the change ships.
- [ ] README's CSP documentation is updated to match the tightened policy.

---

## 18. Dependabot auto-merge has no package-age or provenance gate

**Severity:** Medium · **Area:** Infra (`.github/workflows/dependabot-auto-merge.yml`)

### Description

The workflow auto-merges any `patch` or `minor` Dependabot PR, across all ecosystems (npm, cargo, github-actions), once required CI checks pass, using a token with `contents: write` and `pull-requests: write`. Semver "minor" is not a security or non-breaking guarantee — for pre-1.0 (`0.x`) packages, a minor bump is conventionally allowed to include breaking changes, and more importantly, neither patch nor minor bumps are protected against a compromised upstream package publishing a malicious release: if a maintainer account or CI pipeline upstream is compromised and a malicious version is published as a "minor" bump, and if the project's existing test suite happens not to exercise the newly-malicious code path, the workflow merges it into `main` fully automatically with no human in the loop.

### Tasks

- [ ] Exclude `0.x` (pre-1.0) package updates from unconditional auto-merge, routing them to the existing "manual review" comment path used for major bumps.
- [ ] Evaluate adding a package-age gate (e.g. via `dependabot/fetch-metadata` outputs or a separate registry-age check) requiring a minimum time-since-publish before auto-merge, to allow a window for the ecosystem to catch obviously-malicious releases.
- [ ] Evaluate integrating a provenance/Scorecard signal (e.g. OpenSSF Scorecard or npm provenance attestations where available) as an additional gate for auto-merge eligibility.
- [ ] Document the final policy clearly in `CONTRIBUTING.md`'s existing "Dependabot auto-merge policy" section.

### Acceptance Criteria

- [ ] A `0.x` package minor/patch bump does not auto-merge and instead receives the manual-review comment.
- [ ] `CONTRIBUTING.md` accurately documents the final, implemented policy (including any age/provenance gates added).
- [ ] Existing legitimate 1.0+ patch/minor auto-merges continue to work without added friction.

---

## 19. Token Explorer has no name/symbol search

**Severity:** Medium · **Area:** Frontend (`frontend/src/components/TokenExplorer.tsx`)

### Description

`TokenExplorer.tsx` supports only a creator-address substring filter (`getFilteredTokens`) and an exact index/address lookup (`handleSearch`) — there is no way to search by token name or symbol. This is the real, concrete gap behind the empty `.kiro/specs/token-search-filter/` stub (directory exists with only a `.config.kiro` file; the spec was never scoped or built). Because `getAllTokens` pages tokens by index client-side, a naive name/symbol search implemented today would need to fetch every page to search across all tokens, which doesn't scale well as the deployed-token count grows — this is a real design decision to make, not just a UI addition, and connects directly to whether the frontend leans on the off-chain indexer (see issue #23) for this kind of query.

### Tasks

- [ ] Decide the search architecture: client-side full-fetch-then-filter (simple, doesn't scale), or indexer-backed search once the indexer is actually running in production (see issue #2) via a new `/api/tokens?search=` query parameter.
- [ ] Implement name/symbol search UI in `TokenExplorer.tsx`, composable with the existing creator-address filter rather than replacing it.
- [ ] Add a loading/empty state for search-in-progress and no-results, consistent with the rest of the explorer's UX.
- [ ] Add tests covering: exact match, partial/substring match, case-insensitivity, and combined creator + name/symbol filtering.

### Acceptance Criteria

- [ ] Users can search the Token Explorer by token name or symbol and see matching results.
- [ ] The chosen architecture (client-side vs indexer-backed) is documented, along with its scaling tradeoff, in a short design note or code comment.
- [ ] Search composes correctly with the existing creator-address filter (both applied simultaneously narrow results, not override each other).
- [ ] The `.kiro/specs/token-search-filter/` stub is backfilled with the actual requirements/design once built, or removed (see issue #29).

---

## 20. No pre-signature fee breakdown shown to users

**Severity:** Medium · **Area:** Frontend

### Description

The fee **amount** is shown pre-signature: `frontend/src/components/FeeDisplay.tsx` renders the live fee in XLM plus a USD estimate, sourced from `useFactoryState`, and is mounted in `MintForm.tsx:266` and `TokenForm.tsx:218`. What is missing is everything else about the payment, and the gaps are systematic rather than cosmetic:

1. **No recipient breakdown.** `FeeDisplay` never calls `get_fee_split()`, so when the admin has configured a split (up to 10 recipients by basis points — `lib.rs:1316`), the user sees a single number with no indication that their payment is being divided, or among whom. The contract exposes `get_fee_split()` as a free view function specifically so clients can show this; nothing reads it.
2. **Incomplete coverage.** Only `base`/`metadata` fee types are handled, and the component is absent from `SetMetadataForm.tsx` and from the batch-creation flow — precisely the path where the cost is least obvious, since a batch charges `base_fee × tokens.len()` rather than a flat fee. A user batching 20 tokens gets no pre-signature indication that they are paying twenty times the fee shown elsewhere in the app.

For a dApp whose core interaction is "pay a fee to perform an action," a fee whose destination is invisible and whose multiplier is unshown on the highest-cost path is a real trust gap. `.kiro/specs/fee-display/` is an empty stub, so no intended behavior was ever written down to check the shipped component against.

### Tasks

- [ ] Extend the existing `FeeDisplay.tsx` (do not build a parallel component) to read `get_fee_split()` and render each recipient with their percentage share, falling back to a single `treasury` row when no split is configured.
- [ ] Mount it in `SetMetadataForm.tsx` and the batch-creation flow, which currently have no fee display at all.
- [ ] Make the batch path show the computed total (`base_fee × tokens.len()`), not the per-token `base_fee`, so the multiplier is visible before signing.
- [ ] Add a test asserting the displayed total matches the actual `fee_payment` argument that will be submitted in the transaction, so the UI can never show a different number than what's actually charged.

### Acceptance Criteria

- [ ] Every fee-charging form — including `SetMetadataForm` and the batch flow — shows a pre-signature breakdown of the fee amount and its recipient(s).
- [ ] The displayed fee split, when configured, sums to the same total charged on-chain (verified by test, not just visual inspection).
- [ ] `.kiro/specs/fee-display/` is backfilled with the shipped requirements or removed.

---

## 21. `TokenDetail` "Admin" field displays the creator, not the live token admin

**Severity:** Medium · **Area:** Frontend (`frontend/src/components/TokenDetail.tsx`)

### Description

`TokenDetail.tsx:247` carries an explicit `TODO`: the field currently labeled "Admin" in the UI is populated from `token.creator` — the factory's bookkeeping of who originally deployed the token — not a live read of the deployed SEP-41 token contract's actual current admin. SEP-41 token contracts can have their admin rotated independently of the factory (the factory only ever records the creator at deploy time; it has no visibility into or control over subsequent admin changes on the token contract itself). If a token's real on-chain admin is ever rotated via a direct call to the token contract, this page continues to show the original, now-stale creator address as "Admin" — a correctness issue for the one page in the app someone would actually check to verify who currently controls mint/burn-adjacent privileges on a given token.

### Tasks

- [ ] Add a direct view-call to the deployed token contract's admin-reading entrypoint (per the SEP-41 interface) and wire it into `TokenDetail`'s data-fetching.
- [ ] Replace the `creator`-sourced "Admin" field with the live value, falling back gracefully (with a clear "unavailable" state, not a wrong value) if the read fails.
- [ ] If a live read is deemed infeasible or too costly for this release, relabel the existing field (e.g. "Deployed by" instead of "Admin") so it stops implying something it doesn't reflect, and file the live-read work as explicit follow-up.

### Acceptance Criteria

- [ ] The field either reflects the token's actual current on-chain admin, or is relabeled to accurately describe what it shows (`creator`/`deployed by`), with no field implying live-admin status without being one.
- [ ] A test covers the case where a token's admin has been rotated away from its creator (mocked contract read) and asserts the UI reflects the live value, not the stale creator.
- [ ] The `TODO` comment at `TokenDetail.tsx:247` is removed once resolved.

---

## 22. Token listing pagination is not snapshot-consistent

**Severity:** Medium · **Area:** Frontend (`frontend/src/services/stellar-impl.ts`)

### Description

`getAllTokens`'s index-window pagination computes its newest-first slice from `tokenCount`, read fresh via `getFactoryState()` at the start of each page fetch. If new tokens are created between a user fetching page 1 and page 2 of the Token Explorer (a realistic scenario on an active factory), `tokenCount` shifts, and the index arithmetic for the next page can skip a token or return a duplicate — there is no session-scoped snapshot of `total` pinning the pagination to a consistent view across a single browsing session, and no test exercises this interleaving.

### Tasks

- [ ] Snapshot `tokenCount` once when a browsing/pagination session begins (e.g. on Explorer mount or on an explicit "refresh" action), and compute all subsequent page index windows against that snapshot rather than re-reading `get_state()` per page.
- [ ] Provide an explicit, visible "refresh" action that re-snapshots and resets pagination, rather than having the count silently drift mid-session.
- [ ] Add a test simulating token creation between two page fetches and asserting no token is skipped or duplicated across the two pages under the snapshot approach.

### Acceptance Criteria

- [ ] Pagination within a single browsing session returns a consistent, non-overlapping, non-skipping view even if new tokens are created concurrently.
- [ ] A visible refresh mechanism lets users deliberately pick up newly created tokens without an implicit, silent mid-session shift.
- [ ] The interleaving test passes.

---

## 23. The indexer stores no events, so token history is permanently retention-limited

**Severity:** Medium · **Area:** Frontend / API (`frontend/src/services/stellar-impl.ts`, `api/_lib/indexer/`)

### Description

`getTokenEvents` in `stellar-impl.ts` reads directly from Soroban RPC's `getEvents` and hardcodes `retentionLimited: true` on every result (`stellar-impl.ts:1328` and `:1341`) — not conditionally, but as a literal. `TokenDetail.tsx:367` renders that through `TokenHistory.tsx:33`, which therefore shows an unconditional "history may be incomplete" banner. That banner is honest: RPC event queries are bounded by the provider's retention window, so a token's early history genuinely becomes unreachable over time.

The obvious fix — "serve old events from the indexer instead" — **is not implementable today**, and that is the actual issue. The indexer stores only token rows: `api/_lib/indexer/types.ts:10-23` defines a token record, and `api/tokens/index.ts` serves token listings. There is no event table, no event ingest beyond what is needed to derive token rows from `created`/`meta`, and no endpoint that returns an event stream. So there is nothing for the history views to fall back to, and the retention limit is permanent rather than merely un-wired.

Two related sub-claims are worth stating precisely, because they are easy to get wrong:

- The **token-listing** path is already wired to the indexer — `frontend/src/services/stellar.ts:118-119` composes `createFallbackTokenSource(createIndexerTokenSource(...))`. Token listings degrade gracefully; only event history does not.
- `TransactionHistory` is a **different feature on a different data source**: `useTransactionHistory.ts:84-87` fetches Horizon's `/accounts/{pk}/operations`, an account-scoped operation feed, not contract events. It is unaffected by this issue and should not be changed as part of it.

So the work is: give the indexer an event store, expose it, and only then make the banner conditional.

### Tasks

- [ ] Add an event table to the indexer schema (`api/_lib/indexer/types.ts`, plus a migration in `api/_lib/indexer/migrations/`) keyed by token address and ledger sequence, with the topic and payload of each factory event.
- [ ] Extend `api/_lib/indexer/ingest.ts` to persist all 15 event topics, not only the `created`/`meta` subset it currently derives token rows from.
- [ ] Add a paginated read endpoint (e.g. `api/tokens/[address]/events.ts`) serving that table.
- [ ] Only then: make `getTokenEvents` prefer the indexer-backed path when `/api/health/indexer` reports healthy, falling back to direct RPC for the live tail or when the indexer is unavailable.
- [ ] Replace the hardcoded `retentionLimited: true` at `stellar-impl.ts:1328,1341` with a value reflecting which source actually served the request.
- [ ] Sequence this after issue #2 — an indexer whose cron never runs has no history to serve regardless of schema.

### Acceptance Criteria

- [ ] The indexer persists every factory event topic, and a read endpoint returns them paginated by token.
- [ ] With the indexer healthy and backfilled, Token Detail displays events older than the RPC retention window, and the retention banner does **not** appear.
- [ ] With the indexer unhealthy or unavailable, behavior degrades to today's RPC-only path with the banner shown.
- [ ] A test covers both paths, asserting `retentionLimited` reflects the source that actually served the request rather than a constant.
- [ ] `useTransactionHistory`'s Horizon-backed account feed is left unchanged, and the distinction is noted in `docs/indexer.md` so the two histories are not conflated again.

---

## 24. No automated detection for access-control documentation drift

**Severity:** Medium · **Area:** Process/Docs (`scripts/check-abi-doc-drift.sh`, `README.md`, `SECURITY.md`)

### Description

`README.md` claimed the whitelist primitives (`add_to_whitelist` / `remove_from_whitelist` / `is_whitelisted`) were "standalone storage primitives; no factory entrypoint gates on them yet," pointing readers at a follow-up to "wire enforcement into `create_token`." That work had in fact already shipped: `whitelist_enabled` is a real `FactoryState` field, `set_whitelist_enabled` toggles it, and both `create_token` (`lib.rs:681`) and `create_tokens_batch` (`lib.rs:906`) call `require_whitelisted` (`lib.rs:580-587`) before proceeding, returning `Error::NotWhitelisted = 20`.

What makes this a process issue rather than a typo is how long it survived and how visible it was. The **same README** documented the enforcement correctly in its Contract Functions section, and `docs/contract-abi.md:375` documented it correctly too — so the file contradicted itself and its own companion doc, and nothing flagged it. The stale sentence has now been corrected, but only because a human read the whole file against the contract; no check would have caught it, and nothing prevents the next one.

`scripts/check-abi-doc-drift.sh` checks that function and error _names_ referenced in docs exist in `lib.rs` (`:62-72`). Nothing checks that _behavioral claims_ about access control — "not enforced," "admin-only," "requires whitelist," "off by default" — stay true as the contract evolves. In a project whose README explicitly presents itself to auditors and integrators as an authoritative access-control description, a stale "this is not enforced" claim is the most dangerous possible direction for documentation to be wrong in: an integrator reading it would conclude a security control is absent and build compensating logic, or conclude the opposite for a control that has since been removed.

### Tasks

- [ ] Extend `scripts/check-abi-doc-drift.sh` (or add a new lightweight check) that flags README/`docs/contract-abi.md` sentences referencing specific entrypoints alongside enforcement-status language ("not enforced," "requires," "admin-only") for manual re-review whenever the referenced function's body changes in a diff.
- [ ] At minimum, add this class of check as a documented item in the PR review checklist for any change touching `lib.rs`'s authorization logic.
- [ ] Extend the sweep to `SECURITY.md` and `docs/contract-abi.md`. The `README.md` pass has been done: alongside the whitelist claim, it also wrongly described `set_metadata` as one-shot returning `MetadataAlreadySet` (it permits 5 updates, then returns `MetadataFrozen`), claimed `update_admin` "additionally" emits `adm_upd` when both rotation entrypoints emit it, and undercounted both the `Error` enum (17 vs. 23) and the event-topic set (9 vs. 15) — all now corrected, and all of the same class this check would need to catch.

### Acceptance Criteria

- [ ] A CI check or documented review step exists specifically for access-control documentation claims, distinct from the existing name-presence drift check.
- [ ] The current README/SECURITY.md/contract-abi.md access-control descriptions are verified accurate as of this pass.
- [ ] The new check (or process step) is referenced in `CONTRIBUTING.md`'s contract-change guidance.

---

## 25. The token-WASM security-audit spec was scoped and never executed or closed

**Severity:** Medium · **Area:** Process/Security

### Description

`.kiro/specs/soroban-token-sdk-audit/` exists as an empty stub — a security-sounding task name with no `requirements.md`, `design.md`, or `tasks.md` ever written. The entire security model of the factory depends on the SEP-41 token WASM referenced by `token_wasm_hash` being trustworthy, since the factory deploys every user token as an instance of that exact code.

Provenance itself is documented: `README.md` §1 describes the WASM as a separately-deployed SEP-41 contract, and the testnet deployment guide gives the concrete source — `stellar/soroban-examples`' `soroban_token_contract.wasm`. The precise gap is narrower and, arguably, worse than "undocumented": README §1 calls that WASM **"audited"**, and there is no audit reference anywhere in the repository to support the word. No document names an auditor, a date, a scope, or a report; `grep` for audit references across `docs/` turns up nothing covering the token contract.

An unsourced "audited" claim in a security context is a liability rather than a gap in coverage — an integrator who reads it has been given a specific assurance the project cannot currently substantiate. Either the claim is true and the evidence needs to be cited, or it needs to be removed. `docs/mainnet-deployment-checklist.md` has WASM-hash verification steps but no audit-status line item, so nothing forces the question to be answered before a production deploy.

### Tasks

- [ ] Determine what `token_wasm_hash` currently points to in each deployed environment (testnet/mainnet) — a vendored copy of `soroban-examples`' token contract, a custom implementation, or something else.
- [ ] If it's an upstream, already-audited contract, document that fact explicitly (source, version, auditor, date, report link) in `docs/` and close the stub with that rationale.
- [ ] Until such a reference exists, remove or qualify the word "audited" in `README.md` §1 — an unsourced audit claim should not stand in the project's primary description of its own security model.
- [ ] If it's custom or modified code, commission or perform an actual audit and publish the findings/remediation under `docs/`.
- [ ] Add the audit status/reference as an explicit line item in `docs/mainnet-deployment-checklist.md`, so it can never again silently disappear as an abandoned spec stub.

### Acceptance Criteria

- [ ] `docs/` contains a definitive statement of the deployed token WASM's provenance and audit status, and every use of "audited" in project documentation either cites that statement or is removed.
- [ ] `docs/mainnet-deployment-checklist.md` requires confirming this before any (re-)deployment.
- [ ] The `.kiro/specs/soroban-token-sdk-audit/` stub is closed with a link to the resulting documentation, or fully backfilled if the audit work itself is done under that spec.

---

## 26. `clientIp()` has unverified, possibly-inverted X-Forwarded-For parsing

**Severity:** Medium-Low · **Area:** API (`api/_lib/rateLimit.ts`)

### Description

`clientIp()` (`rateLimit.ts:93-105`) takes the **rightmost** entry of a comma-separated `X-Forwarded-For` header as the trusted client IP, with an inline example comment reading `"203.0.113.1, 10.0.0.1" -> use "10.0.0.1" (Vercel's edge)` — treating what looks like a private/internal address as the "trusted client IP," which is backwards from the conventional `X-Forwarded-For` semantics (client IP first/leftmost, proxies appended after) and from how Vercel's own edge network is generally documented to populate this header. The function is currently unused anywhere in `api/` (rate limiting is keyed by authenticated wallet address, not IP), so there's no active bug today — but it's a latent one: if this helper is ever wired into an unauthenticated endpoint (for instance, as part of fixing issue #13's rate limiting on `/api/auth/challenge`) without first correcting and testing this logic, it would either fail to rate-limit distinct clients correctly or be trivially spoofable, depending on which direction is actually wrong.

### Tasks

- [ ] Confirm the actual `X-Forwarded-For` format Vercel's edge network produces for this project (check Vercel's current documentation and/or capture a real header value from a live request).
- [ ] Fix `clientIp()`'s parsing direction to match reality, or remove the function entirely if it remains genuinely unused.
- [ ] If kept, correct the **existing** test at `api/_lib/rateLimit.test.ts:45` (`'reads the rightmost (most trusted) address from x-forwarded-for'`), which currently pins the unverified direction in place — so the suite would stay green even if the parsing is backwards. A test that asserts the current behavior is not evidence the behavior is right.
- [ ] If removed, note in a commit/PR description that it should be re-added correctly if IP-based limiting is needed later (e.g. for issue #13).

### Acceptance Criteria

- [ ] Either `clientIp()` is removed as dead code, or it is corrected, tested against a documented-accurate example, and left ready for future use.
- [ ] No unauthenticated endpoint uses IP-based limiting derived from this function until it's verified correct.

---

## 27. IPFS metadata is trusted with no content-hash verification against the CID

**Severity:** Medium-Low · **Area:** Frontend (`frontend/src/services/ipfs.ts`)

### Description

`getMetadata` fetches from `${IPFS_CONFIG.pinataGateway}/${cid}` and, once the response is under the documented size cap, trusts the returned bytes as the content for that CID. IPFS's content-addressing model guarantees a CID corresponds to specific content only if something actually verifies the hash — the client here does not. Against Pinata specifically this is a low-likelihood risk (it's the project's own trusted gateway), but `docs/metadata-format.md` already explicitly documents that "anyone can pin metadata directly to IPFS and point a token at it" as untrusted input, and any future support for alternate/user-selectable gateways would make this a real integrity gap rather than a theoretical one.

### Tasks

- [ ] Add client-side CID verification: hash the fetched bytes with the appropriate multihash algorithm and compare against the CID before treating the content as valid, rejecting (rather than rendering) on mismatch.
- [ ] Document the decision either way in `docs/metadata-format.md` — if verification is added, document it as a real guarantee; if deliberately skipped (e.g. due to performance cost or algorithm-support gaps), document it as an accepted, scoped risk tied specifically to trusting the configured gateway.

### Acceptance Criteria

- [ ] Either CID verification is implemented and covered by a test asserting mismatched content is rejected, or `docs/metadata-format.md` is updated with an explicit, reasoned statement of the accepted risk.
- [ ] No behavior change to the existing truncation/placeholder rules documented in `docs/metadata-format.md` for otherwise-valid metadata.

---

## 28. Dev Dockerfiles run as root with an unpinned base image

**Severity:** Low · **Area:** Infra (`frontend/Dockerfile.dev`, `contracts/Dockerfile.dev`, `docker-compose.yml`)

### Description

Neither `frontend/Dockerfile.dev` nor `contracts/Dockerfile.dev` declares a non-root `USER`, so both containers run their build/dev tooling as root by default. `docker-compose.yml` bind-mounts live source into the frontend container (`./frontend:/app`), and `contracts/Dockerfile.dev` pins its base image to a mutable, dated tag (`rust:1.75-slim`) with no digest pin. This is development-only blast radius (these are not the images used for any production deployment, per the README's Vercel/Netlify/static-hosting deployment guidance), but a compromised transitive build dependency (`npm ci`, `cargo build`) would still run as root with write access to the bind-mounted host source tree.

### Tasks

- [ ] Add a non-root `USER` directive to both `Dockerfile.dev` files, with appropriate ownership of working directories.
- [ ] Pin `contracts/Dockerfile.dev`'s base image by digest (`rust:1.75-slim@sha256:...`) rather than a mutable tag.
- [ ] Confirm hot-reload/volume-mount workflows (`CHOKIDAR_USEPOLLING`, etc.) still function correctly for a non-root user, adjusting file permissions/ownership in the Dockerfile as needed.

### Acceptance Criteria

- [ ] `docker compose up -d` still functions identically for local development (hot reload, contract building) after the change.
- [ ] Neither container runs its main process as root, verified via `docker compose exec <service> whoami`.
- [ ] The Rust base image is pinned by digest.

---

## 29. Multiple `.kiro/specs` directories are abandoned stubs

**Severity:** Low · **Area:** Process

### Description

`.kiro/specs/` holds 12 directories. **Nine of them contain only a `.config.kiro` file** — no `requirements.md`, `design.md`, or `tasks.md` was ever written:

| Stub spec                       | Apparent status                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `cargo-lock-version-control`    | Already satisfied — `contracts/Cargo.lock` is git-tracked and Dependabot-bumped |
| `analytics-integration`         | Shipped and tested (see issue #30)                                              |
| `fee-display`                   | Partially shipped — `FeeDisplay.tsx` exists but is incomplete (see issue #20)   |
| `invalid-parameters-validation` | Shipped with divergences from the contract (see issue #11)                      |
| `token-search-filter`           | Not shipped — the gap is real (see issue #19)                                   |
| `soroban-token-sdk-audit`       | Not executed; security-relevant (see issue #25)                                 |
| `token-metadata-display`        | Status unverified                                                               |
| `skeleton-loaders`              | Status unverified                                                               |
| `eslint-import-order`           | Status unverified                                                               |
| `changelog`                     | Status unverified                                                               |

Only `contract-event-indexing` is fully specified, with all three documents and linked implementation. The others are indistinguishable, from the repository structure alone, between "still planned," "abandoned," "shipped and never closed," and "shipped incorrectly" — and as the table shows, real instances of each of those four states are present. That is what makes this more than tidiness: four separate issues in this document (#11, #19, #20, #25) each had to independently re-derive the status of a spec stub, because the directory itself carries no signal. The spec system is currently generating uncertainty rather than resolving it.

### Tasks

- [ ] For each of the nine stubs, determine current status: already done elsewhere (close with a pointer to where), still wanted (backfill a real spec and schedule it), or no longer relevant (delete the stub with a one-line rationale in the removal commit).
- [ ] Close `cargo-lock-version-control` — `contracts/Cargo.lock` is tracked in git with Dependabot updates, so it is already satisfied.
- [ ] Resolve the four unverified stubs (`token-metadata-display`, `skeleton-loaders`, `eslint-import-order`, `changelog`) against the shipped code before deciding their fate; do not assume they are abandoned.
- [ ] Cross-link the five stubs that already have a corresponding entry in this document (#11, #19, #20, #25, #30) so their status is discoverable from the spec directory rather than only from here.
- [ ] Establish a lightweight convention (e.g. a lint or periodic manual check) preventing `.kiro/specs/*` directories from sitting indefinitely with only a `.config.kiro` file and nothing else.

### Acceptance Criteria

- [ ] Each of the nine listed stubs is either backfilled with a real spec, closed with a documented rationale, or removed.
- [ ] No `.kiro/specs/*` directory remains with only a `.config.kiro` file and no linked resolution after this issue is closed.

---

## 30. ADR-005's privacy guarantees have no traceable link to the code that implements them

**Severity:** Low · **Area:** Process/Docs

### Description

The analytics feature is, unusually, **well tested**. `frontend/src/services/analytics.test.ts` asserts opt-out behavior directly — including a case at `:209` titled _"zero analytics events dispatched after opt-out across every call site"_ — and `frontend/src/components/AnalyticsOptOut.test.tsx:74` covers the UI path. So the substantive privacy question ("does opting out genuinely prevent collection, or merely hide a toggle?") is answered, and answered in code.

What is missing is the **link** between that verification and the document it satisfies. `docs/adr/ADR-005-analytics-privacy-consent.md` states the decision and its legal rationale; `frontend/scripts/check-analytics-bypass.mjs` enforces some subset of it in CI. Nothing connects the three. Specifically:

- No test or comment cites ADR-005, so a reader of the ADR cannot tell which of its requirements are enforced and which rest on good intentions, and a reader of the tests cannot tell which obligation each one discharges.
- `check-analytics-bypass.mjs`'s checks have never been diffed against ADR-005's stated requirements, so its coverage is unknown — it may enforce a subset, a superset, or a drifted variant.
- `.kiro/specs/analytics-integration/` is an empty stub (see issue #29), so the usual place to record that mapping was never filled in.

The risk is not that privacy is currently broken — the evidence says it isn't. It is that a legally-motivated commitment is upheld by tests nobody can prove are complete against it, so the next refactor can quietly drop a requirement while the suite stays green. For a consent mechanism with a regulatory rationale, "we believe this is covered" is a materially weaker position than "each clause maps to a named test."

### Tasks

- [ ] Enumerate ADR-005's requirements as a checklist, and map each to the specific test or CI check that enforces it — citing ADR-005 by name in those tests so the mapping survives in the code.
- [ ] Diff `check-analytics-bypass.mjs`'s actual checks against that checklist and close any requirement with no enforcement.
- [ ] Record the resulting mapping in `.kiro/specs/analytics-integration/`, backfilled from the as-built implementation, or delete the stub and put the mapping in ADR-005 itself.
- [ ] Add a note to ADR-005 stating where its enforcement lives, so the next person changing analytics knows what they must not break.

### Acceptance Criteria

- [ ] Every requirement in ADR-005 maps to a named, existing test or CI check, and every such test cites the requirement it discharges.
- [ ] Any ADR-005 requirement found unenforced is either implemented and tested, or explicitly and visibly waived in the ADR with a rationale.
- [ ] `.kiro/specs/analytics-integration/` is backfilled or removed, consistent with the resolution of issue #29.

---

## Methodology

This list was produced by directly reading `contracts/token-factory/src/lib.rs` and `test.rs`, the `frontend/src/services/*`, `frontend/src/components/*`, and `frontend/src/hooks/*` write/read paths, every file under `api/`, all `.github/workflows/*.yml`, both `vercel.json` files, `docker-compose.yml`, and the project's own documentation (`README.md`, `SECURITY.md`, `docs/*`, `.kiro/specs/*`) — cross-referencing claims in comments and docs against the actual code behavior in each case. Every issue above cites the specific file(s) and, where practical, line numbers backing its claim. Issues already fixed and tracked elsewhere in the codebase (referenced throughout as e.g. #5, #9, #913, #921, #943, #1005, #1006, #1007, #1022) were deliberately excluded to keep this list focused on what remains open.
