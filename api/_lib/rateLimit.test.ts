import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { isRateLimited, isRateLimitDurable, clientIp } from './rateLimit'

describe('isRateLimited', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows requests under the limit', async () => {
    const key = `test-key-${Math.random()}`
    for (let i = 0; i < 10; i++) {
      expect(await isRateLimited(key)).toBe(false)
    }
  })

  it('blocks requests once the per-window limit is exceeded', async () => {
    const key = `test-key-${Math.random()}`
    for (let i = 0; i < 10; i++) {
      await isRateLimited(key)
    }
    expect(await isRateLimited(key)).toBe(true)
  })

  it('tracks separate keys independently', async () => {
    const keyA = `key-a-${Math.random()}`
    const keyB = `key-b-${Math.random()}`
    for (let i = 0; i < 10; i++) await isRateLimited(keyA)
    expect(await isRateLimited(keyA)).toBe(true)
    expect(await isRateLimited(keyB)).toBe(false)
  })

  it('resets the count after the window elapses', async () => {
    vi.useFakeTimers()
    const key = `test-key-${Math.random()}`
    for (let i = 0; i < 11; i++) await isRateLimited(key)
    expect(await isRateLimited(key)).toBe(true)

    vi.advanceTimersByTime(15 * 60 * 1000 + 1)

    expect(await isRateLimited(key)).toBe(false)
  })
})

describe('clientIp', () => {
  it('reads the rightmost (most trusted) address from x-forwarded-for', () => {
    const req = {
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
      socket: {},
    } as never
    expect(clientIp(req)).toBe('10.0.0.1')
  })

  it('falls back to the socket remote address', () => {
    const req = {
      headers: {},
      socket: { remoteAddress: '198.51.100.7' },
    } as never
    expect(clientIp(req)).toBe('198.51.100.7')
  })

  it('falls back to "unknown" when nothing is available', () => {
    const req = { headers: {}, socket: {} } as never
    expect(clientIp(req)).toBe('unknown')
  })
})

describe('isRateLimitDurable', () => {
  const originalUrl = process.env.VERCEL_KV_REST_API_URL
  const originalToken = process.env.VERCEL_KV_REST_API_TOKEN

  beforeEach(() => {
    delete process.env.VERCEL_KV_REST_API_URL
    delete process.env.VERCEL_KV_REST_API_TOKEN
  })

  afterEach(() => {
    if (originalUrl !== undefined) process.env.VERCEL_KV_REST_API_URL = originalUrl
    else delete process.env.VERCEL_KV_REST_API_URL
    if (originalToken !== undefined) process.env.VERCEL_KV_REST_API_TOKEN = originalToken
    else delete process.env.VERCEL_KV_REST_API_TOKEN
  })

  it('returns true when both KV env vars are set', () => {
    process.env.VERCEL_KV_REST_API_URL = 'https://kv.example.com'
    process.env.VERCEL_KV_REST_API_TOKEN = 'token'
    expect(isRateLimitDurable()).toBe(true)
  })

  it('returns false when both KV env vars are absent', () => {
    expect(isRateLimitDurable()).toBe(false)
  })

  it('returns false when only VERCEL_KV_REST_API_URL is set', () => {
    process.env.VERCEL_KV_REST_API_URL = 'https://kv.example.com'
    expect(isRateLimitDurable()).toBe(false)
  })

  it('returns false when only VERCEL_KV_REST_API_TOKEN is set', () => {
    process.env.VERCEL_KV_REST_API_TOKEN = 'token'
    expect(isRateLimitDurable()).toBe(false)
  })
})
