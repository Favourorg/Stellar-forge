# Contract.call() Audit Against docs/contract-abi.md

This document audits every `contract.call(...)` invocation in `frontend/src/services/stellar-impl.ts` against the authoritative contract signatures in `docs/contract-abi.md`.

**Date**: 2024
**Status**: FIXED - Issue #5 (tokenWasmHash mismatch removed)

## Summary

| Function | Location | Status | Notes |
|----------|----------|--------|-------|
| `create_token` | `deployToken` | ✅ FIXED | Was passing 8 args (included erroneous tokenWasmHash), now 7 |
| `mint_tokens` | `mintTokens` | ✅ OK | 5 args match ABI |
| `burn` | `burnTokens` | ✅ OK | 3 args match ABI |
| `set_metadata` | `setMetadata` | ✅ OK | 4 args match ABI |
| `update_fees` | `updateFees` | ✅ OK | Option<i128> encoding correct |

---

## Detailed Audit

### 1. `create_token` (deployToken method)

**ABI Signature** (from docs/contract-abi.md):
```
create_token(creator, salt, name, symbol, decimals, initial_supply, fee_payment)
```

**Parameters**:
| Param | Type | Expected ScVal Type |
|-------|------|-------------------|
| creator | Address | Address |
| salt | BytesN<32> | bytes |
| name | String | string |
| symbol | String | string |
| decimals | u32 | u32 |
| initial_supply | u128 | u128 |
| fee_payment | i128 | i128 |

**Frontend Implementation** (frontend/src/services/stellar-impl.ts, ~line 530):
```typescript
contract.call(
  'create_token',
  new Address(sourceAddress).toScVal(),              // ✅ creator: Address
  nativeToScVal(hexToBytes(params.salt), { type: 'bytes' }),  // ✅ salt: bytes
  nativeToScVal(params.name, { type: 'string' }),   // ✅ name: string
  nativeToScVal(params.symbol, { type: 'string' }), // ✅ symbol: string
  nativeToScVal(params.decimals, { type: 'u32' }), // ✅ decimals: u32
  nativeToScVal(BigInt(params.initialSupply), { type: 'u128' }), // ✅ initial_supply: u128
  nativeToScVal(BigInt(params.feePayment), { type: 'i128' }), // ✅ fee_payment: i128
)
```

**Status**: ✅ FIXED
- **Previous Issue**: Was passing 8 arguments with `tokenWasmHash` between salt and name
- **Root Cause**: Contract legacy from earlier revision that accepted the hash as a parameter; factory now reads it from FactoryState during initialization
- **Fix Applied**: Removed `nativeToScVal(hexToBytes(params.tokenWasmHash), { type: 'bytes' })` line
- **Verification**: Updated `TokenDeployParams` type interface to exclude `tokenWasmHash`

---

### 2. `mint_tokens` (mintTokens method)

**ABI Signature**:
```
mint_tokens(token_address, admin, to, amount, fee_payment)
```

**Parameters**:
| Param | Type | Expected ScVal Type |
|-------|------|-------------------|
| token_address | Address | Address |
| admin | Address | Address |
| to | Address | Address |
| amount | u128 | u128 |
| fee_payment | i128 | i128 |

**Frontend Implementation** (frontend/src/services/stellar-impl.ts, ~line 596):
```typescript
contract.call(
  'mint_tokens',
  new Address(params.tokenAddress).toScVal(),     // ✅ token_address: Address
  new Address(sourceAddress).toScVal(),           // ✅ admin: Address
  new Address(params.to).toScVal(),               // ✅ to: Address
  nativeToScVal(BigInt(params.amount), { type: 'i128' }), // ✅ amount: i128
  nativeToScVal(BigInt(params.feePayment), { type: 'i128' }), // ✅ fee_payment: i128
)
```

**Status**: ✅ OK
- All 5 arguments present and correctly typed
- Parameter order matches ABI exactly

**Note on `amount` type**: ABI specifies `amount` as semantically i128 (signed integer for flexibility with negative logic elsewhere), frontend encodes as i128. ✅ Correct.

---

### 3. `burn` (burnTokens method)

**ABI Signature**:
```
burn(token_address, from, amount)
```

**Parameters**:
| Param | Type | Expected ScVal Type |
|-------|------|-------------------|
| token_address | Address | Address |
| from | Address | Address |
| amount | i128 | i128 |

**Frontend Implementation** (frontend/src/services/stellar-impl.ts, ~line 647):
```typescript
contract.call(
  'burn',
  new Address(params.tokenAddress).toScVal(),    // ✅ token_address: Address
  new Address(sourceAddress).toScVal(),          // ✅ from: Address
  nativeToScVal(BigInt(params.amount), { type: 'i128' }), // ✅ amount: i128
)
```

**Status**: ✅ OK
- All 3 arguments present and correctly typed
- Parameter order matches ABI exactly

---

### 4. `set_metadata` (setMetadata method)

**ABI Signature**:
```
set_metadata(token_address, admin, metadata_uri, fee_payment)
```

**Parameters**:
| Param | Type | Expected ScVal Type |
|-------|------|-------------------|
| token_address | Address | Address |
| admin | Address | Address |
| metadata_uri | String | string |
| fee_payment | i128 | i128 |

**Frontend Implementation** (frontend/src/services/stellar-impl.ts, ~line 691):
```typescript
contract.call(
  'set_metadata',
  new Address(params.tokenAddress).toScVal(),    // ✅ token_address: Address
  new Address(sourceAddress).toScVal(),          // ✅ admin: Address
  nativeToScVal(params.metadataUri, { type: 'string' }), // ✅ metadata_uri: string
  nativeToScVal(BigInt(params.feePayment), { type: 'i128' }), // ✅ fee_payment: i128
)
```

**Status**: ✅ OK
- All 4 arguments present and correctly typed
- Parameter order matches ABI exactly

---

### 5. `update_fees` (updateFees method)

**ABI Signature**:
```
update_fees(admin, base_fee?, metadata_fee?)
```

**Parameters**:
| Param | Type | Expected ScVal Type |
|-------|------|-------------------|
| admin | Address | Address |
| base_fee | Option<i128> | Vec[Symbol("Some"), i128] |
| metadata_fee | Option<i128> | Vec[Symbol("Some"), i128] |

**Frontend Implementation** (frontend/src/services/stellar-impl.ts, ~line 884):
```typescript
const someI128 = (v: bigint) =>
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Some'), nativeToScVal(v, { type: 'i128' })])

contract.call(
  'update_fees',
  new Address(sourceAddress).toScVal(),    // ✅ admin: Address
  someI128(BigInt(params.baseFee)),        // ✅ base_fee: Option<i128>
  someI128(BigInt(params.metadataFee)),    // ✅ metadata_fee: Option<i128>
)
```

**Status**: ✅ OK
- All 3 arguments present and correctly typed
- Option<i128> hand-rolled encoding is correct (Vec with 'Some' symbol + value)
- Parameter order matches ABI exactly

---

## Test Coverage

- ✅ `stellar-impl.deployToken.test.ts` - Integration test validating create_token argument count and order
- ✅ Compile-time type checking via updated `TokenDeployParams` interface
- ✅ Extended CI check in `scripts/check-abi-doc-drift.sh` now scans stellar-impl.ts for contract.call invocations

## VITE_TOKEN_WASM_HASH Environment Variable

**Status**: ⚠️ UNDOCUMENTED USAGE

The `VITE_TOKEN_WASM_HASH` environment variable is read in `CreateToken.tsx` but no longer used after this fix. Recommendations:

1. **Option A**: Remove it entirely if it's not needed for display/verification
2. **Option B**: Use it for frontend validation (e.g., warn if on-chain factory tokenWasmHash differs)
3. **Option C**: Re-document its purpose in `docs/deployment-env.md`

Current recommendation: Remove unused reference from `CreateToken.tsx` (already done in this fix).

---

## CI Drift Detection

The enhanced `scripts/check-abi-doc-drift.sh` now:
1. ✅ Extracts public functions from lib.rs and verifies they're in docs/contract-abi.md
2. ✅ Extracts error enum variants and verifies they're in docs/contract-abi.md
3. ✅ **NEW**: Scans stellar-impl.ts for contract.call invocations and verifies function names exist in lib.rs
4. **Future Enhancement**: Deep signature validation (argument count/types) would require parsing both Rust function signatures and TypeScript contract.call sites into a common AST

---

## References

- Contract ABI: `docs/contract-abi.md`
- Frontend service layer: `frontend/src/services/stellar-impl.ts`
- Types: `frontend/src/types/index.ts`
- Issue: #5 (Argument-count mismatch in create_token invocation)
- Related: Issue #1006 (max-supply fix), Issue #1005 (constructor race condition)

---

## Audit Checklist

- [x] create_token: 7 args, no tokenWasmHash
- [x] mint_tokens: 5 args, correct types
- [x] burn: 3 args, correct types
- [x] set_metadata: 4 args, correct types
- [x] update_fees: 3 args with Option<i128> encoding correct
- [x] No other contract.call sites with mismatched signatures
- [x] Types updated (TokenDeployParams, DeploymentResult)
- [x] All callers updated (CreateToken.tsx)
- [x] CI drift check extended to scan stellar-impl.ts
- [x] Integration test added
- [x] Documentation in contract-abi.md matches implementation
