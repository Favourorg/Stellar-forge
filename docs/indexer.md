# Off-chain contract event indexer

Implementation of [`.kiro/specs/contract-event-indexing/`](../.kiro/specs/contract-event-indexing/), tracking issue #943.

The indexer ingests factory events and token records into Postgres and serves
fast, complete, paginated queries over them. It exists because the frontend's
data layer previously re-derived everything from live RPC calls on every page
load, which silently truncated the token list at the RPC's 100-event page cap
and could not see tokens older than the event-retention window at all.

> **The indexer is never a source of truth.** Every value it serves is
> re-derivable from the chain. A broken, slow, or stale indexer degrades to
> direct RPC — it can make reads faster, never change whether they succeed.
> Rollback is a feature flag, and because of that it loses speed, not data.

## Components

| Path                                   | Role                                                     |
| -------------------------------------- | -------------------------------------------------------- |
| `api/_lib/indexer/types.ts`            | `TokenStore` seam, row shapes, `limit`/`cursor` clamping |
| `api/_lib/indexer/ingest.ts`           | Backfill, steady-state paging, reconciliation            |
| `api/_lib/indexer/sorobanChain.ts`     | Soroban RPC reads (view calls + `getEvents`)             |
| `api/_lib/indexer/postgresStore.ts`    | Postgres implementation of `TokenStore`                  |
| `api/_lib/indexer/memoryStore.ts`      | In-memory store for tests and local dev                  |
| `api/cron/index-tokens.ts`             | Scheduled ingest entrypoint                              |
| `api/tokens/`, `api/health/`           | Read API                                                 |
| `frontend/src/services/tokenSource.ts` | `TokenSource` seam and the RPC fallback composer         |

## Ingest

Two phases, because the RPC only retains events for a bounded window.

**Phase A — backfill.** Walks `1..=get_state().token_count`, resolving each
index through `get_token_address(index)` and `get_token_info(index)`. This is
the only phase that can recover tokens older than the retention window.
Resumable across cron runs and idempotent.

**Phase B — steady state.** Pages `getEvents` from the stored cursor, upserting
`created` events and applying `meta` events.

Delivery is **at-least-once**: the cursor advances only after a page has been
written, so a crash mid-run replays that range rather than skipping it. Every
write is an idempotent upsert, which is what makes replay safe.

**Reconciliation** compares `COUNT(*)` against `token_count` on every run and
re-reads any missing indices. This is the backstop that keeps at-least-once
delivery honest when a cursor range is lost entirely.

### Contract support

Backfill depends on `get_token_address(index) → Address`, added to the factory
for this work. `get_token_info(index)` carries no address, so without the
reverse mapping the enumerable key space `1..=token_count` could not be
resolved to actual tokens and a cold backfill was impossible — addresses could
only be learned from `created` events, capping recovery at the retention
window.

Tokens created by a factory binary predating that mapping return
`TokenNotFound`. Repair them with `backfill_token_address(token_address)`,
which is permissionless but self-verifying: it reads the index back from the
token's own `TokenIndex(address)` entry rather than trusting the caller.

## Read API

```
GET /api/tokens?creator=<G…>&cursor=<token_index>&limit=<1..100>
  -> { tokens: [...], nextCursor: string | null, indexedAt: string | null }

GET /api/tokens/:address
  -> { ...token, indexedAt } | 404 { error, authoritative: false }

GET /api/health/indexer
  -> { healthy, severity, lagSeconds, lastLedger, lastRunAt, lastError,
       backfillComplete, indexedCount, durable }
```

Pagination is keyset (`token_index < cursor`), not `OFFSET`, so page cost does
not grow with depth. `limit` is clamped server-side to 100.

**A 404 is not authoritative.** A token created since the last ingest run is
legitimately absent, so clients must fall through to RPC. Treating a cache miss
as non-existence is exactly the silent-wrong-answer bug the indexer exists to
remove, which is why the payload says so explicitly.

## Frontend integration

Off by default. Set `VITE_INDEXER_ENABLED=true` to opt in. When enabled, reads
go through `createFallbackTokenSource`, which degrades to RPC on any of:

| Branch                | Behaviour                                                     |
| --------------------- | ------------------------------------------------------------- |
| indexer ok and fresh  | serve indexed data                                            |
| error                 | RPC, log downgrade                                            |
| timeout (2s default)  | RPC, log downgrade — a slow indexer must never stall the page |
| lag > 15 min          | RPC, log downgrade                                            |
| 404 on address lookup | RPC — the token may be newer than the last ingest             |

`StellarService.onIndexerDowngrade` fires on every downgrade so the degradation
rate stays observable and a permanently broken indexer cannot hide behind a
working app.

## Deployment

Everything below needs a human — the code is complete, the infrastructure is
not provisioned.

1. **Provision Postgres** (Vercel Postgres / Neon) and set `POSTGRES_URL`.
   Install the driver: `npm install @neondatabase/serverless` (override with
   `INDEXER_PG_DRIVER` if using a different one). Without `POSTGRES_URL` the
   API falls back to a per-process in-memory store, which `/api/health/indexer`
   reports as `durable: false` and never `healthy`.
2. **Apply the schema**: `api/_lib/indexer/migrations/001_init.sql`.
3. **Set the ingest environment**:

   | Variable                      | Purpose                                   |
   | ----------------------------- | ----------------------------------------- |
   | `INDEXER_FACTORY_CONTRACT_ID` | Factory contract to index                 |
   | `INDEXER_RPC_URL`             | Soroban RPC endpoint                      |
   | `INDEXER_NETWORK_PASSPHRASE`  | Must match the RPC's network              |
   | `INDEXER_START_LEDGER`        | Optional first ledger for the initial run |
   | `CRON_SECRET`                 | Set by Vercel; **required** in production |

   The cron endpoint refuses to run in production without `CRON_SECRET`, so a
   misconfigured deployment fails closed rather than leaving an unauthenticated
   endpoint that burns RPC quota.

4. **Confirm the cron cadence.** `vercel.json` schedules
   `/api/cron/index-tokens` every 5 minutes. **Vercel Hobby only supports daily
   crons** — the 5-minute cadence the lag thresholds assume requires a paid
   plan. On Hobby, either upgrade or relax the lag alerting to match.
5. **Let the backfill finish** before enabling the frontend flag. Poll
   `/api/health/indexer` until `backfillComplete` is true and `indexedCount`
   equals the factory's `token_count`.
6. **Enable the frontend** with `VITE_INDEXER_ENABLED=true` and watch the
   downgrade rate.

## Monitoring

`lagSeconds = now − last_ledger_close_time`, from `/api/health/indexer`.

| Condition                                     | Severity                        |
| --------------------------------------------- | ------------------------------- |
| `lagSeconds > 15m`                            | warning                         |
| `lagSeconds > 1h`, or `lastError` set         | page                            |
| `backfillComplete = false` for > 24h          | warning                         |
| `indexedCount != token_count` after reconcile | page — indicates real data loss |

## Local development

No database needed: without `POSTGRES_URL` the in-memory store is used, so the
API and cron endpoint run standalone. Tests use it directly (`npm test` at the
repo root).
