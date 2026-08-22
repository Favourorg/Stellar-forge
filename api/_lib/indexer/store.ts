/**
 * Store selection for the contract-event indexer (issue #943).
 *
 * Mirrors the pattern already used by `api/_lib/rateLimit.ts`: use the durable
 * backend when it is configured, otherwise fall back to an in-memory one that
 * keeps local development working but is explicitly not production-safe.
 */

import { MemoryTokenStore } from './memoryStore'
import { createPostgresStore, type SqlExecutor } from './postgresStore'
import type { TokenStore } from './types'

let cached: TokenStore | null = null

/** True when a durable Postgres backend is configured for this deployment. */
export function isDurableStoreConfigured(): boolean {
  return Boolean(process.env['POSTGRES_URL'] ?? process.env['DATABASE_URL'])
}

/**
 * Resolve the process-wide `TokenStore`.
 *
 * The Postgres driver is imported dynamically so that deployments without a
 * database — and the unit tests — never need it installed. Any failure to load
 * or connect degrades to the in-memory store rather than taking the read API
 * down: the indexer is a cache, and the frontend falls back to direct RPC.
 */
export async function getStore(): Promise<TokenStore> {
  if (cached) return cached

  const connectionString = process.env['POSTGRES_URL'] ?? process.env['DATABASE_URL']
  if (!connectionString) {
    cached = new MemoryTokenStore()
    return cached
  }

  try {
    // Optional peer dependency: resolved through a variable specifier so the
    // driver only needs to be installed in deployments that actually configure
    // a database. Everything else runs on the in-memory store.
    const driver = process.env['INDEXER_PG_DRIVER'] ?? '@neondatabase/serverless'
    const { neon } = (await import(/* @vite-ignore */ driver)) as {
      neon: (
        url: string,
      ) => (strings: TemplateStringsArray | string, ...values: unknown[]) => Promise<unknown>
    }
    const client = neon(connectionString)

    // `neon()` supports both a tagged-template form and a
    // `(text, params)` form; the latter is what the store needs so that
    // parameters stay out-of-band and can never alter the statement.
    const sql: SqlExecutor = async <T>(text: string, params: unknown[]) =>
      (await (client as unknown as (t: string, p: unknown[]) => Promise<unknown>)(
        text,
        params,
      )) as T[]

    cached = createPostgresStore(sql)
  } catch {
    // Driver missing or unreachable — degrade rather than fail closed.
    cached = new MemoryTokenStore()
  }

  return cached
}

/** Test seam: replace the process-wide store. */
export function setStoreForTesting(store: TokenStore | null): void {
  cached = store
}
