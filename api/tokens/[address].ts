/**
 * `GET /api/tokens/:address` — single-token lookup served by the indexer
 * (issue #943, spec milestone M3).
 *
 * Returns 404 when the address is genuinely absent from the index. **A 404 is
 * not authoritative**: a token created since the last ingest run is
 * legitimately missing, so clients must fall through to direct RPC rather than
 * treating this as "does not exist". Turning "too new" into "does not exist"
 * is exactly the class of silent-wrong-answer bug the indexer exists to
 * remove, so the response says so explicitly via `authoritative: false`.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getStore } from '../_lib/indexer/store'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const raw = req.query['address']
  const address = Array.isArray(raw) ? raw[0] : raw

  if (!address) {
    res.status(400).json({ error: 'Missing token address' })
    return
  }

  try {
    const store = await getStore()
    const token = await store.getToken(address)

    if (!token) {
      res.status(404).json({
        error: 'Token not indexed',
        // Tells the client this is a cache miss, not proof of non-existence.
        authoritative: false,
      })
      return
    }

    const state = await store.getState()

    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120')
    res.status(200).json({
      ...token,
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
