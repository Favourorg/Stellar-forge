/**
 * `GET /api/health/rate-limit` — rate-limiter durability.
 *
 * Reports whether the rate limiter has a durable (KV-backed) store configured.
 * Without KV, the rate limiter falls back to in-memory tracking, which is
 * per-instance and reset on every cold start — effectively no abuse protection
 * for production deployments that omitted Vercel KV.
 *
 * Mirrors the pattern of `/api/health/indexer` (which exposes
 * `isDurableStoreConfigured`) and `/api/health/ipfs` (which exposes
 * `isPinataConfigured`): a single boolean, no key material, no internal
 * infrastructure details.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isRateLimitDurable } from '../_lib/rateLimit'

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  res.setHeader('Cache-Control', 'public, max-age=60')
  res.status(200).json({ durable: isRateLimitDurable() })
}