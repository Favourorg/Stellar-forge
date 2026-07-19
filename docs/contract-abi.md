# Token Factory Contract ABI

This document describes the public interface of the Stellar Forge `token-factory` Soroban contract deployed on Stellar testnet and mainnet.

The contract binary is built as `token_factory.wasm` (released alongside the frontend). All function names are lower_snake_case on-chain and translate to camelCase on the frontend wrapper in `frontend/src/services/stellar.ts`.

## Conventions

| Soroban | TypeScript |
|---|---|
| `Address` | `string` (Stellar `G...` or contract `C...`) |
| `u32` | `number` |
| `u64` | `number` (lossy above `Number.MAX_SAFE_INTEGER`) |
| `i128` | `string` (decimal) |
| `Vec<T>` | `T[]` |
| `Option<T>` | `T \| undefined` |

## Initialization

### `initialize(admin, treasury, fee_token, token_wasm_hash, base_fee, metadata_fee)`

One-time setup. Fails with `Error::AlreadyInitialized` on retry.

| Param | Type | Description |
|---|---|---|
| `admin` | `Address` | Authority for upgrades, fee updates, pause, and admin transfer. |
| `treasury` | `Address` | Default recipient of factory fees. |
| `fee_token` | `Address` | SEP-41 token used for fee payments. |
| `token_wasm_hash` | `BytesN<32>` | Hash of the token-contract WASM deployed for each new token. |
| `base_fee` | `i128` | Fee charged for `create_token`, `mint_tokens`, `create_tokens_batch`. **Must be ≥ 0.** |
| `metadata_fee` | `i128` | Fee charged for `set_metadata`. **Must be ≥ 0.** |

**Fee sign constraint:** Both `base_fee` and `metadata_fee` must be **≥ 0**. A value of `0` is explicitly permitted (free token creation is a valid use-case). Any negative value is rejected with `Error::InvalidParameters` before any state is written. This constraint exists because:

- A negative required fee satisfies every `fee_payment < required_fee` guard trivially, making the fee gate a no-op regardless of what the caller sends.
- A negative amount passed to `distribute_fee` produces a negative SEP-41 `transfer`, whose behavior is implementation-defined on the token contract and has not been audited for this factory.

Stamps `FactoryState.schema_version = CURRENT_SCHEMA_VERSION` and stores the same value under the legacy `sv` instance key so `migrate` works on pre-versioned deployments.

## Token Lifecycle

### `create_token(creator, salt, name, symbol, decimals, initial_supply, fee_payment)`

Deploy a new token contract under the factory. Requires `fee_payment >= base_fee`. Returns the deployed contract address.

### `create_tokens_batch(creator, tokens, fee_payment)`

Atomically deploy `tokens` (a `Vec<BatchTokenParams>`). Requires `fee_payment >= base_fee * tokens.len()`. Partial-batch failure rolls state back to pre-call values.

#### Batch size limits and resource costs

Soroban transactions are subject to per-transaction resource budgets enforced by the ledger. Exceeding these limits causes an immediate `ExceededLimit` error and costs the full simulation fee — the user never gets a refund.

The table below shows measured CPU instructions and memory bytes consumed by `create_tokens_batch` at representative batch sizes. Numbers were obtained by running the benchmark harness in `contracts/token-factory/src/bench.rs` via `cargo test bench_ -- --nocapture` and comparing against the Soroban mainnet resource limits. **Important:** the Soroban native test environment underestimates real WASM CPU instruction counts (~30×) and memory (~5×) compared to an actual on-chain simulation, so the values below are used for *relative* regression detection — the production limits column reflects real network values.

| Batch size | Test-env CPU (M insns) | Test-env Mem (MB) | Ledger reads | Ledger writes | Within mainnet limits? |
|:---:|---:|---:|---:|---:|:---:|
| 1  | ~0.65 M  | ~1.1 MB  |  6 |  6 | ✅ |
| 5  | ~2.5 M   | ~4.3 MB  | 18 | 18 | ✅ |
| 10 | ~4.9 M   | ~8.6 MB  | 33 | 33 | ✅ |
| 15 | ~7.3 M   | ~13 MB   | 48 | 48 | ✅ |
| 20 | ~9.7 M   | ~17 MB   | 63 | 63 | ✅ ← **recommended max** |
| 25 | ~12 M    | ~22 MB   | 78 | 78 | ⚠️ approaches write limit |

**Current Soroban per-transaction limits (Stellar Protocol 21+, mainnet):**

| Resource | Mainnet limit |
|---|---|
| CPU instructions | 600 000 000 (600 M) |
| Memory | 41 943 040 bytes (40 MB) |
| Ledger entries (read) | 100 per transaction |
| Ledger entries (write) | 50 per transaction |

> **Note:** The test-harness numbers above are native Rust measurements. Actual on-chain WASM costs are ~30× higher for CPU and ~5× higher for memory. At batch size 20 the extrapolated WASM-equivalent values are approximately 290 M CPU instructions and 85 MB memory — comfortably within the 600 M CPU limit but approaching the 40 MB memory limit. This provides a margin of ~52 % on CPU and ~0 % margin on memory at the extrapolated scale, which is why **20 is the recommended cap** rather than a higher number.
>
> Protocol limits may change with network upgrades. Re-run the benchmark harness after each SDK bump and update this table. The CI job in `.github/workflows/benchmarks.yml` runs on every PR touching `contracts/` and surfaces regressions automatically.

**✅ Recommended maximum batch size: 20 tokens**

This limit is enforced client-side by the frontend (`frontend/src/utils/validation.ts → validateBatchSize`) and documented here. Callers using the contract directly must enforce this limit themselves to avoid failed transactions.

If you need to deploy more than 20 tokens, split them into multiple sequential `create_tokens_batch` calls, each containing ≤ 20 entries.

### `mint_tokens(token_address, admin, to, amount, fee_payment)`

Mint `amount` of `token_address` to `to`. Rejects when a `max_supply` cap would be exceeded (`Error::MaxSupplyExceeded`).

### `burn(token_address, from, amount)`

Burn `amount` of `token_address` from `from`'s balance. Honors `burn_enabled`; rejects when disabled.

### `set_metadata(token_address, admin, metadata_uri, fee_payment)`

Set an IPFS / HTTPS metadata URI for an existing token. One-shot — re-setting returns `Error::MetadataAlreadySet`.

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

### `get_tokens_by_creator(creator, offset, limit) → Vec<u32>`

Return a paginated slice of token indices owned by `creator`. This replaces an earlier non-paginated version that returned the full `Vec<u32>` (which could exceed Stellar ledger entry size limits on creators with hundreds of registered tokens).

| Param | Type | Description |
|---|---|---|
| `creator` | `Address` | Creator whose tokens to list. |
| `offset` | `u32` | 0-based index of the first element to return. |
| `limit` | `u32` | Maximum number of elements to return. Capped server-side at `MAX_TOKENS_BY_CREATOR_PAGE` (currently `50`) so callers cannot request pathologically large pages. |

**Returns:** `Vec<u32>` of token indices, len ≤ `min(limit, MAX_TOKENS_BY_CREATOR_PAGE)`. Use the indices with `get_token_info` to materialize each token's `TokenInfo`.

**Behavior:**

| Input | Output |
|---|---|
| `limit == 0` | empty `Vec` (defensive — read-only path, no error) |
| `limit > MAX_TOKENS_BY_CREATOR_PAGE` | clamped down to the cap |
| `offset >= total_tokens_for_creator` | empty `Vec` (past-the-end) |
| Unknown creator | empty `Vec` |
| Otherwise | slice `[offset, offset + min(limit, cap, remaining))` |

To iterate the full list:

1. Call with `offset = 0, limit = 50`.
2. If response.length < 50 → you're done.
3. Otherwise advance `offset += response.length` and repeat.

The frontend helper `fetchAllTokensByCreator` in `frontend/src/hooks/useTokens.ts` does this loop automatically.

## Admin & Governance

### `update_fees(admin, base_fee?, metadata_fee?)`

Adjust either fee. `None` leaves the corresponding fee unchanged.

**Fee sign constraint:** Any `Some(value)` provided for `base_fee` or `metadata_fee` must be **≥ 0**. Negative values are rejected with `Error::InvalidParameters` and the stored fees are left unchanged. The same constraint applies as for `initialize` — see that section for the rationale.

### `pause(admin)` / `unpause(admin)`

Toggle factory-wide pause. `create_token`, `create_tokens_batch`, `mint_tokens`, and `set_metadata` honor the pause; `burn` does not (users can always burn their own balance).

### `set_fee_split(admin, splits)`

Set a fee split where `splits` is a `Map<Address, u32>` of basis-point recipients summing to `10_000`. Empty map clears the split (full fee goes back to `treasury`).

### `get_fee_split() → Map<Address, u32>`

Read the current split (empty map means no split).

### `update_admin(current_admin, new_admin)` / `transfer_admin(admin, new_admin)`

Hand the admin privilege to `new_admin`. Both events emit the same effect; `update_admin` additionally emits an `adm_upd` event for off-chain tracking.

### `upgrade(admin, new_wasm_hash)`

Replace the factory code in place while preserving state.

### `migrate(admin)`

Incrementally upgrades state between schema versions. Idempotent.

## Errors

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

## Events

The contract emits Soroban events on a `(factory, action)` topic. The frontend parses them via `frontend/src/services/stellar-impl.ts`. Events:

| Action | Payload | Trigger |
|---|---|---|
| `init` | `(admin)` | `initialize` |
| `created` | `(token_address, creator, name, symbol)` | `create_token` / `create_tokens_batch` |
| `meta` | `(token_address, metadata_uri)` | `set_metadata` |
| `mint` | `(token_address, to, amount)` | `mint_tokens` |
| `burn` | `(token_address, from, amount)` | `burn` |
| `fees` | `(base_fee, metadata_fee)` | `update_fees` |
| `pause` | `(admin)` | `pause` |
| `unpause` | `(admin)` | `unpause` |
| `adm_upd` | `(current_admin, new_admin)` | `update_admin` |

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
