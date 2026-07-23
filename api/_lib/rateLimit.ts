import type { VercelRequest } from '@vercel/node'

const WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const MAX_REQUESTS_PER_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW ?? '10', 10)
const MAX_REQUESTS_PER_DAY = parseInt(process.env.RATE_LIMIT_DAY ?? '100', 10)

/**
 * Check if a wallet address has exceeded rate limits (window or daily).
 * Uses Vercel KV for durable, cross-instance limits.
 * Falls back to in-memory tracking if KV is unavailable.
 */
export async function isRateLimited(address: string): Promise<boolean> {
  const kvUrl = process.env.VERCEL_KV_REST_API_URL
  const kvToken = process.env.VERCEL_KV_REST_API_TOKEN

  if (!kvUrl || !kvToken) {
    // Fallback: use in-memory (not production-safe)
    return isRateLimitedInMemory(address)
  }

  try {
    const now = Date.now()
    const windowKey = `ratelimit:${address}:window`
    const dayKey = `ratelimit:${address}:day`

    // Window bucket (15 min rolling)
    const windowData = await kvGet(kvUrl, kvToken, windowKey)
    if (windowData) {
      const { count, windowStart } = JSON.parse(windowData)
      if (now - windowStart > WINDOW_MS) {
        // Window expired, reset
        await kvSet(kvUrl, kvToken, windowKey, JSON.stringify({ count: 1, windowStart: now }), 900)
      } else {
        // Window still active
        if (count >= MAX_REQUESTS_PER_WINDOW) return true
        await kvSet(kvUrl, kvToken, windowKey, JSON.stringify({ count: count + 1, windowStart }), 900)
      }
    } else {
      // First request in this window
      await kvSet(kvUrl, kvToken, windowKey, JSON.stringify({ count: 1, windowStart: now }), 900)
    }

    // Day bucket (24 hr)
    const dayData = await kvGet(kvUrl, kvToken, dayKey)
    if (dayData) {
      const { count } = JSON.parse(dayData)
      if (count >= MAX_REQUESTS_PER_DAY) return true
      await kvSet(kvUrl, kvToken, dayKey, JSON.stringify({ count: count + 1 }), 86400)
    } else {
      // First request in this day
      await kvSet(kvUrl, kvToken, dayKey, JSON.stringify({ count: 1 }), 86400)
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

// Vercel KV REST API helpers
async function kvGet(url: string, token: string, key: string): Promise<string | null> {
  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) return null
  const data = (await response.json()) as { result: string | null }
  return data.result
}

async function kvSet(
  url: string,
  token: string,
  key: string,
  value: string,
  exSeconds: number,
): Promise<void> {
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ex: exSeconds, value }),
  })
}
