/**
 * `GET /api/health/indexer` — indexer freshness, per the monitoring section of
 * `.kiro/specs/contract-event-indexing/design.md` (issue #943).
 *
 * `lagSeconds` is the gap between now and the newest ledger the indexer has
 * ingested. The frontend reads it to decide whether to trust indexed data or
 * degrade to direct RPC, and alerting reads it to page on a stalled indexer.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getStore, isDurableStoreConfigured } from '../_lib/indexer/store'
import { lagSeconds, LAG_CRITICAL_SECONDS, LAG_WARNING_SECONDS } from '../_lib/indexer/ingest'

/**
 * Classify a raw indexer error message into a stable, generic category
 * so that the public health endpoint never leaks internal infrastructure
 * details (connection strings, hostnames, port numbers, etc.).
 *
 * The full, unsanitized error is always written to the server-side log
 * so operators can debug without exposing internals to the network.
 *
 * Categories:
 * - `connection_failed` — database connection / network errors
 * - `query_timeout`    — query-level timeouts
 * - `unknown`          — everything else
 */
function sanitizeIndexerError(raw: string | null): string | null {
  if (raw === null) return null

  const lower = raw.toLowerCase()

  // Connection-level failures (ECONNREFUSED, connect ETIMEDOUT, DNS
  // resolution failures, driver-level handshake errors, etc.)
  if (
    /econnrefused|econnreset|enotfound|enetunreach|connect\s+(etimedout|failed)/i.test(lower) ||
    lower.includes('connection refused') ||
    lower.includes('connection failed') ||
    lower.includes('could not connect') ||
    lower.includes('no hosts available') ||
    lower.includes('getaddrinfo')
  ) {
    return 'connection_failed'
  }

  // Query-level timeouts
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('query timeout')
  ) {
    return 'query_timeout'
  }

  return 'unknown'
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const store = await getStore()
    const state = await store.getState()
    const lag = lagSeconds(state)
    const indexedCount = await store.countTokens()

    // Log the raw error server-side for operator debugging before
    // sanitizing it for the public response.
    if (state.lastError !== null) {
      console.error('[indexer-health] lastError:', state.lastError)
    }

    const sanitizedError = sanitizeIndexerError(state.lastError)

    // Unhealthy if it has never run, has fallen too far behind, or the last
    // run recorded an error. `durable === false` means results are per-process
    // and lost on restart, which is never production-healthy.
    const healthy =
      isDurableStoreConfigured() &&
      state.lastRunAt !== null &&
      sanitizedError === null &&
      lag !== null &&
      lag <= LAG_CRITICAL_SECONDS

    const severity =
      lag === null
        ? 'unknown'
        : lag > LAG_CRITICAL_SECONDS
          ? 'critical'
          : lag > LAG_WARNING_SECONDS
            ? 'warning'
            : 'ok'

    res.setHeader('Cache-Control', 'no-store')
    res.status(healthy ? 200 : 503).json({
      healthy,
      severity,
      lagSeconds: lag,
      lastLedger: state.lastLedger,
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
      lastError: sanitizedError,
      backfillComplete: state.backfillComplete,
      indexedCount,
      durable: isDurableStoreConfigured(),
    })
  } catch (err) {
    res.status(503).json({
      healthy: false,
      severity: 'critical',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
