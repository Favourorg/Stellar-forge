# Fee Display Spec

## Status
**Partially Shipped (Active Issue #1108)**

## Summary
Provide transparent, real-time fee breakdown and simulation before the user signs Soroban smart contract transactions.

## Current State & Shipped Code
- `FeeDisplay.tsx` component is partially implemented (`frontend/src/components/FeeDisplay.tsx`).
- Basic fee estimation is displayed in certain UI components, but pre-signature fee breakdowns for complex Soroban invocation resource requirements (resource fee, network fee, inclusion fee) are missing.

## Requirements & Remaining Gaps
1. **Pre-Signature Breakdown**: Show explicit breakdown of base fee, resource fee, and maximum transaction fee prior to Freighter wallet signature prompt.
2. **Dynamic Estimation**: Re-estimate fees dynamically when transaction parameters change.
3. **Error Feedback**: Present clear user notification when estimated fee exceeds account balance.

## Implementation References
- Component: `frontend/src/components/FeeDisplay.tsx`

## Related Issues
- Issue #1108: No pre-signature fee breakdown shown to users
- Issue #1117: Multiple `.kiro/specs` directories are abandoned stubs
