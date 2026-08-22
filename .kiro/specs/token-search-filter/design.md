# Design: Token Search & Filtering

## Architecture & Data Flow
- Update `TokenExplorer.tsx` to include search input and filter dropdown controls.
- Client-side filtering over fetched tokens in `useTokens()` hook state, with debounced input state using `useMemo` or custom hook.
- Search matches case-insensitively against `name`, `symbol`, and `address`.

## UI Components
- Search bar input with search icon and clear button (`x`).
- Filter pills / toggle switches for token status (e.g. Active / Paused).
- No results indicator with resetting option.
