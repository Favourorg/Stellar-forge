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
| `base_fee` | `i128` | Fee charged for `create_token`, `mint_tokens`, `create_tokens_batch`. |
| `metadata_fee` | `i128` | Fee charged for `set_metadata`. |

Stamps `FactoryState.schema_version = CURRENT_SCHEMA_VERSION` and stores the same value under the legacy `sv` instance key so `migrate` works on pre-versioned deployments.

## Token Lifecycle

### `create_token(creator, salt, name, symbol, decimals, initial_supply, fee_payment)`

Deploy a new token contract under the factory. Requires `fee_payment >= base_fee`. Returns the deployed contract address.

### `create_tokens_batch(creator, tokens, fee_payment)`

Atomically deploy `tokens` (a `Vec<BatchTokenParams>`). Requires `fee_payment >= base_fee * tokens.len()`. Partial-batch failure rolls state back to pre-call values.

### `mint_tokens(token_address, admin, to, amount, fee_payment)`

Mint `amount` of `token_address` to `to`. Rejects when a `max_supply` cap would be exceeded (`Error::MaxSupplyExceeded`).

### `burn(token_address, from, amount)`

Burn `amount` of `token_address` from `from`'s balance. Honors `burn_enabled`; rejects when disabled.

### `set_metadata(token_address, admin, metadata_uri, fee_payment)`

Set or update the metadata URI for an existing token. Requires `fee_payment >= metadata_fee`.

**URI validation (enforced on-chain):**

| Rule | Error |
|---|---|
| `metadata_uri` is empty | `InvalidMetadataUri` |
| Does not start with `ipfs://` | `InvalidMetadataUri` |
| No CID after the prefix | `InvalidMetadataUri` |
| `len > 128` bytes | `InvalidMetadataUri` |

**Mutability:** Metadata is no longer write-once. A creator may update the URI up to `METADATA_MAX_UPDATES` (currently **5**) times total. Once the update count is exhausted the URI is automatically frozen (`MetadataFrozen`). Creators may also explicitly freeze at any time via `freeze_metadata`.

Emits a `meta` event with `(token_address, metadata_uri, version)` on every successful update so the full history is auditable on-chain.

### `freeze_metadata(token_address, admin)`

Permanently freeze a token's metadata URI so it can no longer be updated. Only the token creator may call this. Idempotent — calling on an already-frozen token is a no-op. Emits a `meta_frz` event.

### `is_metadata_frozen(token_address) → bool`

Return `true` if the token's metadata has been frozen (either explicitly or by reaching the update cap).

### `get_metadata_version(token_address) → u32`

Return the current metadata update version (0 = never set, 1 = first set, …, up to `METADATA_MAX_UPDATES = 5`).

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

### `pause(admin)` / `unpause(admin)`

Toggle factory-wide pause. `create_token`, `create_tokens_batch`, `mint_tokens`, and `set_metadata` honor the pause; `burn` does not (users can always burn their own balance).

### `set_fee_split(admin, splits)`

Set a fee split where `splits` is a `Map<Address, u32>` of basis-point recipients summing to `10_000`. Empty map clears the split (full fee goes back to `treasury`).

**Constraints enforced at configuration time:**

| Rule | Error |
|---|---|
| `splits.len() > 10` | `TooManyFeeSplitRecipients` |
| Any entry has `bps == 0` | `ZeroFeeSplitEntry` |
| `sum(bps) != 10_000` | `InvalidFeeSplit` |

**Cap:** Maximum `10` recipients per split (`MAX_FEE_SPLIT_RECIPIENTS`). This bounds the number of cross-contract transfer calls per user transaction and keeps per-transaction gas predictable.

**Rounding:** `distribute_fee` uses the **largest-remainder method**. Each recipient's share is `floor(amount * bps / 10_000)`. Remainder stroops (at most `recipients - 1`) are awarded one-at-a-time to the entries with the largest fractional parts, so the sum of all transfers always equals the full fee amount. No recipient with non-zero `bps` receives zero forever as long as the fee amount is ≥ 1 stroop (the largest-remainder guarantee).

Emits a `split_set` event on successful configuration and a `split_clr` event when the split is cleared.

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
| 5 | `MetadataAlreadySet` | _(deprecated — retained for ABI compatibility; no longer returned by `set_metadata`)_ |
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
| 18 | `InvalidMetadataUri` | URI is empty, missing `ipfs://` prefix, exceeds 128 bytes, or has no CID |
| 19 | `TooManyFeeSplitRecipients` | `set_fee_split` map has more than 10 entries |
| 20 | `ZeroFeeSplitEntry` | `set_fee_split` map contains an entry with `bps == 0` |
| 21 | `MetadataFrozen` | metadata is frozen (via `freeze_metadata` or auto-freeze after max updates) |

## Events

The contract emits Soroban events on a `(factory, action)` topic. The frontend parses them via `frontend/src/services/stellar-impl.ts`. Events:

| Action | Payload | Trigger |
|---|---|---|
| `init` | `(admin)` | `initialize` |
| `created` | `(token_address, creator, name, symbol)` | `create_token` / `create_tokens_batch` |
| `meta` | `(token_address, metadata_uri, version)` | `set_metadata` (every update) |
| `meta_frz` | `(token_address, admin)` | `freeze_metadata` |
| `mint` | `(token_address, to, amount)` | `mint_tokens` |
| `burn` | `(token_address, from, amount)` | `burn` |
| `fees` | `(base_fee, metadata_fee)` | `update_fees` |
| `split_set` | `(admin, splits)` | `set_fee_split` (non-empty) |
| `split_clr` | `(admin)` | `set_fee_split` (empty — clears split) |
| `pause` | `(admin)` | `pause` |
| `unpause` | `(admin)` | `unpause` |
| `adm_upd` | `(current_admin, new_admin)` | `update_admin` |
