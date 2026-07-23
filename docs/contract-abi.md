# Token Factory Contract ABI

This document describes the public interface of the Stellar Forge `token-factory` Soroban contract deployed on Stellar testnet and mainnet.

The contract binary is built as `token_factory.wasm` (released alongside the frontend). All function names are lower_snake_case on-chain and translate to camelCase on the frontend wrapper in `frontend/src/services/stellar.ts`.

## Conventions

| Soroban     | TypeScript                                       |
| ----------- | ------------------------------------------------ |
| `Address`   | `string` (Stellar `G...` or contract `C...`)     |
| `u32`       | `number`                                         |
| `u64`       | `number` (lossy above `Number.MAX_SAFE_INTEGER`) |
| `i128`      | `string` (decimal)                               |
| `Vec<T>`    | `T[]`                                            |
| `Option<T>` | `T \| undefined`                                 |

## Initialization

### `initialize(admin, treasury, fee_token, token_wasm_hash, base_fee, metadata_fee)`

One-time setup. Fails with `Error::AlreadyInitialized` on retry.

| Param             | Type         | Description                                                                            |
| ----------------- | ------------ | -------------------------------------------------------------------------------------- |
| `admin`           | `Address`    | Authority for upgrades, fee updates, pause, and admin transfer.                        |
| `treasury`        | `Address`    | Default recipient of factory fees.                                                     |
| `fee_token`       | `Address`    | SEP-41 token used for fee payments.                                                    |
| `token_wasm_hash` | `BytesN<32>` | Hash of the token-contract WASM deployed for each new token.                           |
| `base_fee`        | `i128`       | Fee charged for `create_token`, `mint_tokens`, `create_tokens_batch`. **Must be ≥ 0.** |
| `metadata_fee`    | `i128`       | Fee charged for `set_metadata`. **Must be ≥ 0.**                                       |
### `__constructor(admin, treasury, fee_token, token_wasm_hash, base_fee, metadata_fee)`

> Formerly a plain `initialize(...)` entrypoint invoked _after_ deployment in a
> separate transaction. That left a window between deployment and
> initialization where an attacker could race the deployer's own
> `initialize` call with their own, passing themselves as `admin`/`treasury`
> and permanently seizing the factory (see
> [issue #1005](https://github.com/Favourorg/Stellar-forge/issues/1005)).
> It is now the contract's `__constructor` (Soroban SDK ≥ 22), which the host
> runs atomically as part of the deployment transaction itself (`deploy_v2`),
> so there is no separate transaction to race. `admin.require_auth()` is also
> now required, so the named `admin` address must itself authorize the
> deployment, not just the deploying account. Deploy tooling calls this via
> `stellar contract deploy ... -- --admin ... --treasury ...` (constructor
> args after `--`) rather than a follow-up `contract invoke`; see
> `scripts/deploy-contract.sh` and
> [`docs/mainnet-deployment-checklist.md`](./mainnet-deployment-checklist.md).
> This is a naming/entrypoint and auth change only — `FactoryState`'s field
> layout is unchanged, so `CURRENT_SCHEMA_VERSION` was not bumped.

One-time setup, atomic with deployment. Fails with `Error::AlreadyInitialized` if the factory's state already exists.

| Param             | Type         | Description                                                                                                |
| ----------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `admin`           | `Address`    | Authority for upgrades, fee updates, pause, and admin transfer. Must authorize this call (`require_auth`). |
| `treasury`        | `Address`    | Default recipient of factory fees.                                                                         |
| `fee_token`       | `Address`    | SEP-41 token used for fee payments.                                                                        |
| `token_wasm_hash` | `BytesN<32>` | Hash of the token-contract WASM deployed for each new token.                                               |
| `base_fee`        | `i128`       | Fee charged for `create_token`, `mint_tokens`, `create_tokens_batch`. **Must be ≥ 0.**                     |
| `metadata_fee`    | `i128`       | Fee charged for `set_metadata`. **Must be ≥ 0.**                                                           |

**Fee sign constraint:** Both `base_fee` and `metadata_fee` must be **≥ 0**. A value of `0` is explicitly permitted (free token creation is a valid use-case). Any negative value is rejected with `Error::InvalidParameters` before any state is written. This constraint exists because:

- A negative required fee satisfies every `fee_payment < required_fee` guard trivially, making the fee gate a no-op regardless of what the caller sends.
- A negative amount passed to `distribute_fee` produces a negative SEP-41 `transfer`, whose behavior is implementation-defined on the token contract and has not been audited for this factory.

Stamps `FactoryState.schema_version = CURRENT_SCHEMA_VERSION` and stores the same value under the legacy `sv` instance key so `migrate` works on pre-versioned deployments.

## Token Lifecycle

### `create_token(creator, salt, name, symbol, decimals, initial_supply, fee_payment)`

Deploy a new token contract under the factory. Requires `fee_payment >= base_fee`. Returns the deployed contract address.

### `create_tokens_batch(creator, tokens, fee_payment)`

Atomically deploy `tokens` (a `Vec<BatchTokenParams>`). Requires `fee_payment >= base_fee * tokens.len()`. All parameter validation (name, symbol, decimals, initial supply, and total `token_count` arithmetic overflow checks) is front-loaded before any contract deployment or state locking begins. Furthermore, Soroban's per-invocation transaction atomicity guarantees that if any failure or host error occurs during execution, all state changes, sub-token deployments, and supply mints within the transaction are completely reverted at the ledger level.

#### Batch size limits and resource costs

Soroban transactions are subject to per-transaction resource budgets enforced by the ledger. Exceeding these limits causes an immediate `ExceededLimit` error and costs the full simulation fee — the user never gets a refund.

The table below shows measured CPU instructions and memory bytes consumed by `create_tokens_batch` at representative batch sizes. Numbers were obtained by running the benchmark harness in `contracts/token-factory/src/bench.rs` via `cargo test bench_ -- --nocapture` and comparing against the Soroban mainnet resource limits. **Important:** the Soroban native test environment underestimates real WASM CPU instruction counts (~30×) and memory (~5×) compared to an actual on-chain simulation, so the values below are used for _relative_ regression detection — the production limits column reflects real network values.

| Batch size | Test-env CPU (M insns) | Test-env Mem (MB) | Ledger reads | Ledger writes |  Within mainnet limits?   |
| :--------: | ---------------------: | ----------------: | -----------: | ------------: | :-----------------------: |
|     1      |                ~0.65 M |           ~1.1 MB |            6 |             6 |            ✅             |
|     5      |                 ~2.5 M |           ~4.3 MB |           18 |            18 |            ✅             |
|     10     |                 ~4.9 M |           ~8.6 MB |           33 |            33 |            ✅             |
|     15     |                 ~7.3 M |            ~13 MB |           48 |            48 |            ✅             |
|     20     |                 ~9.7 M |            ~17 MB |           63 |            63 | ✅ ← **recommended max**  |
|     25     |                  ~12 M |            ~22 MB |           78 |            78 | ⚠️ approaches write limit |

**Current Soroban per-transaction limits (Stellar Protocol 21+, mainnet):**

| Resource               | Mainnet limit            |
| ---------------------- | ------------------------ |
| CPU instructions       | 600 000 000 (600 M)      |
| Memory                 | 41 943 040 bytes (40 MB) |
| Ledger entries (read)  | 100 per transaction      |
| Ledger entries (write) | 50 per transaction       |

> **Note:** The test-harness numbers above are native Rust measurements. Actual on-chain WASM costs are ~30× higher for CPU and ~5× higher for memory. At batch size 20 the extrapolated WASM-equivalent values are approximately 290 M CPU instructions and 85 MB memory — comfortably within the 600 M CPU limit but approaching the 40 MB memory limit. This provides a margin of ~52 % on CPU and ~0 % margin on memory at the extrapolated scale, which is why **20 is the recommended cap** rather than a higher number.
>
> Protocol limits may change with network upgrades. Re-run the benchmark harness after each SDK bump and update this table. The CI job in `.github/workflows/benchmarks.yml` runs on every PR touching `contracts/` and surfaces regressions automatically.

**✅ Recommended maximum batch size: 20 tokens**

This limit is enforced client-side by the frontend (`frontend/src/utils/validation.ts → validateBatchSize`) and documented here. Callers using the contract directly must enforce this limit themselves to avoid failed transactions.

If you need to deploy more than 20 tokens, split them into multiple sequential `create_tokens_batch` calls, each containing ≤ 20 entries.

### `mint_tokens(token_address, admin, to, amount, fee_payment)`

Mint `amount` of `token_address` to `to`. Rejects when a `max_supply` cap would be exceeded (`Error::MaxSupplyExceeded`).

#### Supply cap accounting

`max_supply` (set per-token via `create_tokens_batch`'s `BatchTokenParams.max_supply`) is enforced against a running counter stored under the instance key `(token_address, "supply")`, not against the token's live balance. Every successful `mint_tokens` call adds `amount` to this counter and rejects the call if the result would exceed the cap.

**What counts toward the cap:** the token's `initial_supply` (minted at creation, before the token even has a `TokenInfo` entry to check against) **plus** every amount minted afterward via `mint_tokens`. As of the fix for issue #1006, `deploy_one` seeds the counter with `initial_supply` at creation time whenever `max_supply` is set, so a token created with `initial_supply == max_supply` can never be minted again — any `mint_tokens` call on it fails with `MaxSupplyExceeded`.

`burn` does **not** decrement this counter — burning tokens frees up balance for the holder but does not restore headroom under the cap. The cap therefore bounds _cumulative_ mints (initial + all `mint_tokens` calls), not net circulating supply.

**Back-fill for tokens created before this fix:** capped tokens deployed by a factory binary older than this fix have an under-seeded (or entirely absent) supply counter — `mint_tokens` would have read it as `0` regardless of `initial_supply`, letting the cap be bypassed. The factory has no on-chain record of a pre-fix token's true `initial_supply` to recover it automatically (`TokenInfo` never stored it, and standard SEP-41 tokens don't expose a `total_supply` query), so this cannot be fixed by `migrate()` alone. Operators must:

1. Reconstruct the token's true cumulative minted amount off-chain — the most reliable source is summing every `mint` event the token contract itself has emitted since deployment (queryable via RPC/Horizon `get_events`, independent of what the factory stored).
2. Call `backfill_capped_supply(admin, token_address, verified_supply)` once per affected token with that reconstructed value.

`backfill_capped_supply` is admin-only, requires the token to have `max_supply` configured, rejects a `verified_supply` outside `[0, max_supply]`, and can only be applied once per token (subsequent calls fail with `Error::AlreadyBackfilled`) — it cannot be used as a repeated backdoor to rewrite tracked supply.

### `burn(token_address, from, amount)`

Burn `amount` of `token_address` from `from`'s balance. Honors `burn_enabled`; rejects when disabled.

### `set_metadata(token_address, admin, metadata_uri, fee_payment)`

Set an IPFS / HTTPS metadata URI for an existing token. One-shot — re-setting returns `Error::MetadataAlreadySet`.

The contract stores the URI opaquely and does not validate the document it points at. The frontend does, and enforces length caps on `name` and `description` plus an `ipfs://`-only rule for `image` when rendering — see [Token Metadata Format](./metadata-format.md) before pinning your own metadata.

### `set_burn_enabled(token_address, admin, enabled)`

Toggle the burn flag for a token.

## View Functions

### `get_state() → FactoryState`

Inspect factory configuration and aggregate counts.

### `get_base_fee() → i128`

Current base fee.

### `get_metadata_fee() → i128`

Current set-metadata fee.

### `get_token_info(index) → TokenInfo`

Look up a single token by 1-based index. Returns `Error::TokenNotFound` for unknown indices.

### `get_token_index(token_address) → u32`

Resolve a token's 1-based storage index from its contract address, via the `TokenIndex(address)` mapping written at creation. Returns `Error::TokenNotFound` for addresses not registered with this factory. This is the authoritative address → index lookup — clients must not re-derive identity from the factory event stream, which only reflects a bounded RPC retention window.

### `get_token_info_by_address(token_address) → TokenInfo`

Return a token's full `TokenInfo` addressed by its contract address — equivalent to `get_token_info(get_token_index(address))` in a single call. This is the **source of truth** for a token's name, symbol, decimals, creator and creation time; unlike event-derived data it is unaffected by RPC event retention, so a token created arbitrarily long ago still resolves correctly. Returns `Error::TokenNotFound` for unregistered addresses (including the case where the index mapping exists but the `TokenInfo` entry is missing).

### `get_metadata(token_address) → Option<String>`

Return the metadata URI set for a token via `set_metadata`, or `None` if none was set. Reads directly from `Metadata(address)` state instead of scanning `meta` events (which are subject to the same retention truncation).

### `get_tokens_by_creator(creator, offset, limit) → Vec<u32>`

Return a paginated slice of token indices owned by `creator`. This replaces an earlier non-paginated version that returned the full `Vec<u32>` (which could exceed Stellar ledger entry size limits on creators with hundreds of registered tokens).

| Param     | Type      | Description                                                                                                                                                     |
| --------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `creator` | `Address` | Creator whose tokens to list.                                                                                                                                   |
| `offset`  | `u32`     | 0-based index of the first element to return.                                                                                                                   |
| `limit`   | `u32`     | Maximum number of elements to return. Capped server-side at `MAX_TOKENS_BY_CREATOR_PAGE` (currently `50`) so callers cannot request pathologically large pages. |

**Returns:** `Vec<u32>` of token indices, len ≤ `min(limit, MAX_TOKENS_BY_CREATOR_PAGE)`. Use the indices with `get_token_info` to materialize each token's `TokenInfo`.

**Behavior:**

| Input                                | Output                                                |
| ------------------------------------ | ----------------------------------------------------- |
| `limit == 0`                         | empty `Vec` (defensive — read-only path, no error)    |
| `limit > MAX_TOKENS_BY_CREATOR_PAGE` | clamped down to the cap                               |
| `offset >= total_tokens_for_creator` | empty `Vec` (past-the-end)                            |
| Unknown creator                      | empty `Vec`                                           |
| Otherwise                            | slice `[offset, offset + min(limit, cap, remaining))` |

To iterate the full list:

1. Call with `offset = 0, limit = 50`.
2. If response.length < 50 → you're done.
3. Otherwise advance `offset += response.length` and repeat.

The frontend helper `fetchAllTokensByCreator` in `frontend/src/hooks/useTokens.ts` does this loop automatically.

## Admin & Governance

### `update_fees(admin, base_fee?, metadata_fee?)`

Adjust either fee. `None` leaves the corresponding fee unchanged.

**Fee sign constraint:** Any `Some(value)` provided for `base_fee` or `metadata_fee` must be **≥ 0**. Negative values are rejected with `Error::InvalidParameters` and the stored fees are left unchanged. The same constraint applies as for `__constructor` — see that section for the rationale.

### `pause(admin)` / `unpause(admin)`

Toggle factory-wide pause. `create_token`, `create_tokens_batch`, `mint_tokens`, and `set_metadata` honor the pause; `burn` does not (users can always burn their own balance).

### `set_fee_split(admin, splits)`

Set a fee split where `splits` is a `Map<Address, u32>` of basis-point recipients summing to `10_000`. Empty map clears the split (full fee goes back to `treasury`).

**Recipient cap:** `splits` may contain at most **20 recipients** (`MAX_FEE_SPLIT_RECIPIENTS`). Exceeding it is rejected with `Error::TooManyFeeSplitRecipients` before the basis-point sum is even checked. This exists because `distribute_fee` transfers a share to every configured recipient on **every** `create_token`, `create_tokens_batch`, `mint_tokens`, and `set_metadata` call — an unbounded admin-configured split would make every fee-paying call on the contract arbitrarily expensive for the caller, and risk exceeding Soroban's per-transaction resource limits outright.

The cap was derived by measuring `distribute_fee`'s resource cost via the benchmark harness (`contracts/token-factory/src/bench.rs`, `bench_fee_split_mint_*`) across a range of split sizes. Ledger *writes* — not CPU or memory — turned out to be the binding resource: each non-zero-share recipient writes a new SEP-41 balance entry, at a measured rate of ~1.03 writes per recipient. At 20 recipients that's 24 of the mainnet per-transaction write-entry limit of 50 (48%), leaving a 52% margin; CPU and memory stay under 1.5% of their respective limits at this size. See `bench_fee_split_at_max_within_limits` for the test that keeps this margin enforced going forward.

### `get_fee_split() → Map<Address, u32>`

Read the current split (empty map means no split).

### `update_admin(current_admin, new_admin)` / `transfer_admin(admin, new_admin)`

Hand the admin privilege to `new_admin`. Both events emit the same effect; `update_admin` additionally emits an `adm_upd` event for off-chain tracking.

### `upgrade(admin, new_wasm_hash)`

Replace the factory code in place while preserving state.

### `migrate(admin)`

Incrementally upgrades state between schema versions. Idempotent. As of schema version 2, this only bumps the version marker for the issue #1006 max-supply fix — it does not automatically back-fill any capped token's supply counter (see `backfill_capped_supply` below and "Supply cap accounting" above).

### `backfill_capped_supply(admin, token_address, verified_supply)`

One-time back-fill of the tracked-supply counter for a capped token created before the issue #1006 fix. See "Supply cap accounting" above for the full procedure. Admin-only; fails with `Error::TokenNotFound` if the token doesn't exist, `Error::InvalidParameters` if the token has no `max_supply` or `verified_supply` is outside `[0, max_supply]`, and `Error::AlreadyBackfilled` if already applied to this token.

### `add_to_whitelist(admin, address)` / `remove_from_whitelist(admin, address)`

Add or remove an address from the factory whitelist. Emits `wl_add` / `wl_rm` events. Only the factory admin may call these.

### `set_whitelist_enabled(admin, enabled)`

Toggle whitelist enforcement on or off. When `enabled = true`, only addresses that have been added to the whitelist via `add_to_whitelist` may call `create_token` or `create_tokens_batch` — attempts from non-whitelisted addresses return `Error::NotWhitelisted` (code 18). Emits a `wl_tog` event.

When `enabled = false` (the default after `initialize` and after `migrate`), the factory is open to all creators and the whitelist contents are ignored.

**Decision: mint_tokens and set_metadata are not gated.**  
These operations are only available to existing token creators (the `owner` of a deployed token contract), so they already passed the whitelist gate at creation time. Gating them again would lock out operators who created tokens before whitelisting was enabled.

### `is_whitelisted(address) → bool`

Read-only: returns `true` if `address` is on the whitelist.

| Param | Type | Description |
|---|---|---|
| `address` | `Address` | Address to query. |

## Errors

| Code | Symbol                     | When                                                    |
| ---- | -------------------------- | ------------------------------------------------------- |
| 1    | `InsufficientFee`          | `fee_payment < required_fee`                            |
| 2    | `Unauthorized`             | caller is not allowed for this operation                |
| 3    | `InvalidParameters`        | argument out of range or malformed                      |
| 4    | `TokenNotFound`            | unknown token index or address                          |
| 5    | `MetadataAlreadySet`       | `set_metadata` called twice                             |
| 6    | `AlreadyInitialized`       | double-initialize attempt                               |
| 7    | `BurnAmountExceedsBalance` | `burn` > balance                                        |
| 8    | `BurnNotEnabled`           | burning on a token that has been disabled               |
| 9    | `InvalidBurnAmount`        | zero or negative burn                                   |
| 10   | `ContractPaused`           | operation blocked because factory is paused             |
| 11   | `Reentrancy`               | concurrent reentrant call detected                      |
| 12   | `ArithmeticOverflow`       | checked-op failed                                       |
| 13   | `StateNotFound`            | factory not yet initialized                             |
| 14   | `InvalidTokenParams`       | name/symbol validation failed during token creation     |
| 15   | `InvalidDecimals`          | decimals outside `[0, 18]`                              |
| 16   | `MaxSupplyExceeded`        | mint would exceed cap                                   |
| 17   | `InvalidFeeSplit`          | `set_fee_split` map bps do not sum to 10_000            |
| 18   | `AlreadyBackfilled`        | `backfill_capped_supply` already applied for this token |
| Code | Symbol | When |
|---|---|---|
| 1 | `InsufficientFee` | `fee_payment < required_fee` |
| 2 | `Unauthorized` | caller is not allowed for this operation |
| 3 | `InvalidParameters` | argument out of range or malformed |
| 4 | `TokenNotFound` | unknown token index or address |
| 5 | `MetadataAlreadySet` | `set_metadata` called twice |
| 6 | `AlreadyInitialized` | double-initialize attempt |
| 7 | `BurnAmountExceedsBalance` | `burn` > balance |
| 8 | `BurnNotEnabled` | burning on a token that has been disabled |
| 9 | `InvalidBurnAmount` | zero or negative burn |
| 10 | `ContractPaused` | operation blocked because factory is paused |
| 11 | `Reentrancy` | concurrent reentrant call detected |
| 12 | `ArithmeticOverflow` | checked-op failed |
| 13 | `StateNotFound` | factory not yet initialized |
| 14 | `InvalidTokenParams` | name/symbol validation failed during token creation |
| 15 | `InvalidDecimals` | decimals outside `[0, 18]` |
| 16 | `MaxSupplyExceeded` | mint would exceed cap |
| 17 | `InvalidFeeSplit` | `set_fee_split` map bps do not sum to 10_000 |
| 18 | `TooManyFeeSplitRecipients` | `set_fee_split` map has more than `MAX_FEE_SPLIT_RECIPIENTS` (20) recipients |
| 19 | `AlreadyBackfilled` | `backfill_capped_supply` already applied for this token |
| 20 | `NotWhitelisted` | creator is not on the whitelist when enforcement is enabled |

## Events

The contract emits Soroban events on a `(factory, action)` topic. The frontend parses them via `frontend/src/services/stellar-impl.ts`. Events:

| Action    | Payload                                  | Trigger                                |
| --------- | ---------------------------------------- | -------------------------------------- |
| `init`    | `(admin)`                                | `initialize`                           |
| `init`    | `(admin)`                                | `__constructor`                        |
| `created` | `(token_address, creator, name, symbol)` | `create_token` / `create_tokens_batch` |
| `meta`    | `(token_address, metadata_uri)`          | `set_metadata`                         |
| `mint`    | `(token_address, to, amount)`            | `mint_tokens`                          |
| `burn`    | `(token_address, from, amount)`          | `burn`                                 |
| `fees`    | `(base_fee, metadata_fee)`               | `update_fees`                          |
| `pause`   | `(admin)`                                | `pause`                                |
| `unpause` | `(admin)`                                | `unpause`                              |
| `adm_upd` | `(current_admin, new_admin)`             | `update_admin`                         |
| `wl_add`  | `(address)`                              | `add_to_whitelist`                     |
| `wl_rm`   | `(address)`                              | `remove_from_whitelist`                |
| `wl_tog`  | `(enabled)`                              | `set_whitelist_enabled`                |

## Batch creation UI

The `create_tokens_batch` function is exposed in the frontend when a user chooses to deploy multiple tokens in one transaction.

### Client-side soft cap

The frontend enforces a hard cap of **20 tokens per batch** before the transaction is submitted. Attempting to submit more than 20 entries triggers a validation error:

```
Batch size of N exceeds the maximum recommended batch size of 20.
Please split your tokens into multiple batches of ≤ 20 to avoid
a failed on-chain transaction. Each failed submission still costs
the simulation fee.
```

This validation is implemented in `frontend/src/utils/validation.ts` (`validateBatchSize`) and is checked in the batch creation form before the user is allowed to sign with Freighter.

### Keeping resource cost documentation current

Resource numbers in the table above are generated by the benchmark harness in `contracts/token-factory/src/bench.rs`. The CI job in `.github/workflows/benchmarks.yml` runs automatically on every PR that touches `contracts/` and posts a comparison report to the job summary.

To regenerate the numbers locally and compare against the baseline:

```bash
cd contracts/token-factory
cargo test bench_ -- --nocapture 2>/dev/null | python3 ../../scripts/check_benchmarks.py
```

To update the baseline after an intentional resource change (e.g., a new SDK bump or refactor):

```bash
cd contracts/token-factory
cargo test bench_ -- --nocapture 2>/dev/null | \
  python3 ../../scripts/check_benchmarks.py --update-baseline
```

Or trigger it from GitHub Actions: go to **Actions → Contract Benchmarks → Run workflow** and set **Update baseline** to `true`.

The benchmark harness (`.../src/bench.rs`) also includes a sanity-check test (`bench_create_token_within_limits`) that asserts `create_token` stays below 50 % of the mainnet CPU and memory limits in the native test environment, providing an early warning for accidental bloat.
