/**
 * Scheduled IPFS pin reconciliation.
 *
 * Runs every 6 hours (configured in repo-root `vercel.json`). Lists all pins
 * from the Pinata account, cross-references them against on-chain `meta`
 * events stored by the indexer, and unpins anything orphaned past a 24-hour
 * grace window.
 *
 * Depends on the indexer store (Postgres or in-memory fallback) for the
 * on-chain reference set. When the store is not configured or empty, the job
 * is conservative and preserves all pins.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { runReconciliation, type ReconciliationResult } from '../_lib/pinReconciliation'
import { getStore } from '../_lib/indexer/store'

/**
 * Vercel signs cron invocations with `Authorization: Bearer <CRON_SECRET>`.
 * Reconciliation is read-heavy (Pinata pinList) and write-heavy for orphaned
 * pins, so it must be authenticated.
 */
function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env['CRON_SECRET']
  if (!secret) return process.env['VERCEL_ENV'] !== 'production'
  return req.headers.authorization === `Bearer ${secret}`
}

/**
 * Collect all on-chain metadata URIs from the indexer store.
 * Fails gracefully: returns an empty list when the store is unavailable,
 * causing the reconciliation to preserve all pins (conservative).
 */
async function getMetadataUrisFromIndexer(): Promise<string[]> {
  const store = await getStore()
  const uris: string[] = []
  let cursor: number | undefined = undefined

  for (;;) {
    const result = await store.listTokens({ limit: 100, cursor })
    for (const token of result.tokens) {
      if (token.metadataUri) {
        uris.push(token.metadataUri)
      }
    }
    if (!result.nextCursor) break
    cursor = Number(result.nextCursor)
  }

  return uris
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const result: ReconciliationResult = await runReconciliation(() => getMetadataUrisFromIndexer())

  // Always return 200 so the cron scheduler doesn't retry on expected
  // outcomes (e.g. empty store, no orphaned pins). The response body carries
  // the actual status.
  res.status(200).json(result)
}
