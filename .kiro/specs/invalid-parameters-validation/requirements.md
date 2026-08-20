# Invalid Parameters Validation

## Status

Implemented in `frontend/src/utils/validation.ts` (character policy block + exported constants).
Drift detection via `scripts/check-validation-drift.sh` (CI: `.github/workflows/ci.yml`).

## Character Policy

- **Names**: Block only dangerous/display-corrupting characters (control characters, zero-width, bidirectional overrides, BOM, unpaired surrogates). All other characters including non-Latin scripts are permitted, matching the contract's `validate_token_params` in `contracts/token-factory/src/lib.rs`.
- **Symbols**: ASCII alphanumeric + hyphens (ticker convention). This is a UI convention only; the contract accepts any symbol.

## Bounds (matching contract)

| Field    | Max   | Unit    |
|----------|-------|---------|
| name     | 32    | UTF-8 bytes |
| symbol   | 12    | UTF-8 bytes |
| decimals | 18    | integer |

## See Also

- `contracts/token-factory/src/lib.rs`:749 — `validate_token_params`
- `frontend/src/utils/validation.ts` — `validateTokenParams`, exported constants
- `scripts/check-validation-drift.sh` — CI drift detection