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

    // Unhealthy if it has never run, has fallen too far behind, or the last
    // run recorded an error. `durable === false` means results are per-process
    // and lost on restart, which is never production-healthy.
    const healthy =
      isDurableStoreConfigured() &&
      state.lastRunAt !== null &&
      state.lastError === null &&
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
      lastError: state.lastError,
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
