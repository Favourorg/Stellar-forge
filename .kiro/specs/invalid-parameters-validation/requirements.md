# Invalid Parameters Validation Spec

## Status
**Shipped with Contract Divergences (Active Issue #1099)**

## Summary
Ensure rigorous parameter validation across Frontend, API, and Soroban Smart Contracts to prevent invalid token creation or parameter rejection.

## Current State & Shipped Code
- Frontend parameter validation implemented in `frontend/src/utils/validation.ts` and `frontend/src/components/CreateToken.tsx`.
- API payload schema validation implemented in `api/_lib/schemaValidation.ts`.
- Contract validation implemented in `contracts/token-factory/src/lib.rs`.

## Identified Divergences & Gaps
- Issue #1099 identifies divergence where frontend validation limits, regex patterns, or string length rules differ from the Soroban smart contract invariants.
- Frontend and backend validation bounds must strictly match contract bounds.

## Requirements
1. **Contract Parity**: Input validation rules in frontend/API must strictly mirror smart contract constraints.
2. **Immediate Feedback**: Display clear field-level error messages before submitting transactions.

## Related Issues
- Issue #1099: Frontend validation silently diverges from the contract in both directions
- Issue #1117: Multiple `.kiro/specs` directories are abandoned stubs
