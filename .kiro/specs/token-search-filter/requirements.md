# Token Search & Filtering Spec

## Status
**Not Shipped (Active Feature Gap - Issue #1107)**

## Summary
Provide real-time name, symbol, and creator address search and filtering in the Token Explorer UI (`frontend/src/components/TokenExplorer.tsx`).

## User Stories & Requirements
1. **Name & Symbol Search**: As a user browsing tokens, I want to type keywords into a search bar to filter tokens by name or symbol.
2. **Creator Address Search**: Users can search by exact or partial Stellar G-address / contract C-address.
3. **Filter Controls**: Users can filter tokens by properties (e.g. paused state, mintable state, fee-enabled).
4. **Debounced Search**: Search input must debounce queries (e.g. 300ms) to avoid excessive re-renders or API calls.
5. **Empty State**: Show a clear empty state message when no tokens match the filter criteria.

## Implementation References
- Target Component: `frontend/src/components/TokenExplorer.tsx`
- Related Hook: `frontend/src/hooks/useTokens.ts`

## Related Issues
- Issue #1107: Token Explorer has no name/symbol search
- Issue #1117: Multiple `.kiro/specs` directories are abandoned stubs
