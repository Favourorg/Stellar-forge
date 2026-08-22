import type { VercelRequest } from '@vercel/node'
import { isKvConfigured, kvGet, kvSet } from './kv'

const WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const MAX_REQUESTS_PER_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW ?? '10', 10)
const MAX_REQUESTS_PER_DAY = parseInt(process.env.RATE_LIMIT_DAY ?? '100', 10)

/**
 * Check if a wallet address has exceeded rate limits (window or daily).
 * Uses Vercel KV for durable, cross-instance limits.
 * Falls back to in-memory tracking if KV is unavailable.
 *
 * The KV REST helpers moved to `./kv` when the challenge store (issue #1091)
 * needed the same durable path. Two behavioural notes from that move, both of
 * which make this function match the intent its own comment already stated
 * ("On error, deny the request (fail closed)"):
 *
 *   - A non-2xx read used to be indistinguishable from an empty bucket, so a
 *     KV outage silently reset every counter and let traffic through. It now
 *     throws and is caught below.
 *   - A failed write used to be ignored, leaving the limiter running against
 *     counters that were never incremented. It now throws too.
 */
export async function isRateLimited(address: string): Promise<boolean> {
  if (!isKvConfigured()) {
    // Fallback: use in-memory (not production-safe)
    return isRateLimitedInMemory(address)
  }

  try {
    const now = Date.now()
    const windowKey = `ratelimit:${address}:window`
    const dayKey = `ratelimit:${address}:day`

    // Window bucket (15 min rolling)
    const windowData = await kvGet(windowKey)
    if (windowData) {
      const { count, windowStart } = JSON.parse(windowData)
      if (now - windowStart > WINDOW_MS) {
        // Window expired, reset
        await kvSet(windowKey, JSON.stringify({ count: 1, windowStart: now }), 900)
      } else {
        // Window still active
        if (count >= MAX_REQUESTS_PER_WINDOW) return true
        await kvSet(windowKey, JSON.stringify({ count: count + 1, windowStart }), 900)
      }
    } else {
      // First request in this window
      await kvSet(windowKey, JSON.stringify({ count: 1, windowStart: now }), 900)
    }

    // Day bucket (24 hr)
    const dayData = await kvGet(dayKey)
    if (dayData) {
      const { count } = JSON.parse(dayData)
      if (count >= MAX_REQUESTS_PER_DAY) return true
      await kvSet(dayKey, JSON.stringify({ count: count + 1 }), 86400)
    } else {
      // First request in this day
      await kvSet(dayKey, JSON.stringify({ count: 1 }), 86400)
    }

    return false
  } catch (err) {
    console.error('Rate limit check failed:', err)
    // On error, deny the request (fail closed)
    return true
  }
}

// In-memory fallback (per-instance, not durable)
interface Bucket {
  count: number
  windowStart: number
}

const buckets = new Map<string, Bucket>()

function isRateLimitedInMemory(key: string): Promise<boolean> {
  const now = Date.now()
  const bucket = buckets.get(key)

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now })
    return Promise.resolve(false)
  }

  bucket.count += 1
  return Promise.resolve(bucket.count > MAX_REQUESTS_PER_WINDOW)
}

/**
 * Get trusted client IP from Vercel's rightmost x-forwarded-for position.
 * On Vercel, the rightmost untrusted hop is the user's real IP.
 */
export function clientIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') {
    // Take the rightmost IP (last entry) as the most-trusted one
    // e.g., "203.0.113.1, 10.0.0.1" -> use "10.0.0.1" (Vercel's edge)
    const ips = forwarded.split(',').map((ip) => ip.trim())
    return ips[ips.length - 1] ?? 'unknown'
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[forwarded.length - 1]
  }
  return req.socket?.remoteAddress ?? 'unknown'
}
