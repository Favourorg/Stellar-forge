/**
 * `GET /api/tokens` — keyset-paginated token listing served by the indexer
 * (issue #943, spec milestone M3).
 *
 * Read-only and public, mirroring but not replacing the on-chain view
 * functions: the indexer is a read-optimization layer, never a source of
 * truth, and the frontend must always be able to fall back to direct RPC.
 *
 * Pagination is keyset (`token_index < cursor`) rather than `OFFSET`, so page
 * cost does not grow with depth.
 *
 * Query parameters:
 *   creator  optional G… address filter
 *   cursor   optional keyset cursor from the previous page's `nextCursor`
 *   limit    optional 1..100, clamped server-side (default 20)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getStore } from '../_lib/indexer/store'
import { clampLimit, parseCursor } from '../_lib/indexer/types'

/** First query value only — Vercel surfaces repeated params as arrays. */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const store = await getStore()
    const state = await store.getState()

    const creator = single(req.query['creator'] as string | string[] | undefined)
    const result = await store.listTokens({
      creator,
      cursor: parseCursor(single(req.query['cursor'] as string | string[] | undefined)),
      limit: clampLimit(single(req.query['limit'] as string | string[] | undefined)),
    })

    // Short cache: the ingest cron runs every few minutes, so a stale response
    // is bounded and cheap, while `indexedAt` still lets the client judge
    // freshness for itself rather than being handed cached data as live.
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120')
    res.status(200).json({
      tokens: result.tokens,
      nextCursor: result.nextCursor,
      indexedAt: state.lastLedgerCloseTime
        ? new Date(state.lastLedgerCloseTime).toISOString()
        : null,
    })
  } catch (err) {
    res.status(503).json({
      error: 'Indexer unavailable',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}
