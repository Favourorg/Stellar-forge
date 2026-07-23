# Contract Event Indexing — Tasks

Milestoned build plan for [design.md](./design.md). Tracking issue: #943.

Milestones are ordered so each one is independently shippable and reversible.

## M0 — Unblock (done in this change)

- [x] Fill in this spec (requirements, design, tasks).
- [x] Fix the surviving 100-event cap in `getTokenInfoByAddress`, which silently
      resolved tokens beyond the first event page to a placeholder record
      instead of their real metadata. Regression-tested in
      `services/stellar-impl.getTokenInfoByAddress.test.ts`.

No infrastructure yet — M0 is spec plus the correctness fix that does not need it.

## M1 — Resolve open questions

Blocks M2; each is cheap and each can invalidate part of the design.

- [ ] Confirm the RPC provider's event retention window.
- [ ] Confirm whether `simulateTransaction` accepts an unfunded source account
      for `get_token_info`; if not, provision a read-only account per network
      and document key handling.
- [ ] Confirm the Vercel plan's minimum cron interval (Hobby is daily-only,
      which does not meet R4).

## M2 — Ingest, no frontend changes

- [ ] Provision Postgres; apply the schema from design.md as a checked-in migration.
- [ ] Backfill job (Phase A): `get_state().token_count` → `get_token_info(i)`,
      batched, resumable, idempotent.
- [ ] Steady-state job (Phase B): cursor-paged `getEvents`, upsert, advance
      checkpoint only on success.
- [ ] Reconciliation: compare `COUNT(*)` to `token_count`, re-trigger backfill
      for missing indices.
- [ ] Tests: idempotent re-ingest, cursor-not-advanced-on-error, reconciliation
      detects a deliberately skipped index.

Exit: backfill completes on testnet and `COUNT(*) == token_count`.

## M3 — Read API

- [ ] `GET /api/tokens` with keyset pagination and clamped `limit`.
- [ ] `GET /api/tokens/:address` returning a true 404 when absent.
- [ ] `GET /api/health/indexer` exposing `lagSeconds`.
- [ ] Tests: pagination covers all rows with no duplicates or gaps across page
      boundaries; `limit` clamping; 404 shape.

Exit: API serves >100 tokens completely (R1) against testnet.

## M4 — Frontend integration behind fallback

- [ ] Extract the `TokenSource` interface; wrap the existing RPC path as
      `RpcTokenSource` with no behaviour change.
- [ ] Add `IndexerTokenSource` and the fallback composer (timeout, stale-lag,
      error, and 404-falls-through — all four branches from design.md).
- [ ] Feature flag, defaulting to RPC-only.
- [ ] Degraded-mode indicator in the UI.
- [ ] Tests for every fallback branch, asserting RPC is actually invoked (R3).

Exit: flag on, explorer served by the indexer, downgrade rate observable.

## M5 — Monitoring

- [ ] Alert thresholds from design.md wired to Sentry.
- [ ] Ingest failures reported with the failing cursor range.
- [ ] Runbook: what to do when lag alerts fire, including forced re-backfill.

Exit: a deliberately stalled indexer produces an alert within 15 minutes.

## M6 — Expansion

Only after M4 is proven in production.

- [ ] Per-creator queries served by the indexer (`useTokens`).
- [ ] Search and filter pushed server-side.
- [ ] Transaction history.

## Verification note

Acceptance criterion "verified against a testnet deployment with more than 100
tokens created" is satisfied at **M3**, not before. M0 deliberately does not
claim it: no indexer exists yet, and the fix it ships was verified by unit
tests against a stubbed event source, not against a live testnet deployment.
