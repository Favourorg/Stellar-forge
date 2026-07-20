import type { VercelRequest } from '@vercel/node'

// Best-effort per-instance limiter: a warm Vercel function instance can serve
// many invocations and this map persists across them, but there's no
// guarantee of a single instance under load. For a durable, cross-instance
// limit, swap this for a shared store (Vercel KV / Upstash Redis).
const WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const MAX_REQUESTS_PER_WINDOW = 10

interface Bucket {
  count: number
  windowStart: number
}

const buckets = new Map<string, Bucket>()

export function isRateLimited(key: string): boolean {
  const now = Date.now()
  const bucket = buckets.get(key)

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now })
    return false
  }

  bucket.count += 1
  return bucket.count > MAX_REQUESTS_PER_WINDOW
}

export function clientIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
  if (Array.isArray(forwarded) && forwarded.length > 0) return forwarded[0]
  return req.socket?.remoteAddress ?? 'unknown'
}
