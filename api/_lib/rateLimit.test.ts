import { describe, it, expect, vi, afterEach } from 'vitest'
import { isRateLimited, clientIp } from './rateLimit'

describe('isRateLimited', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows requests under the limit', () => {
    const key = `test-key-${Math.random()}`
    for (let i = 0; i < 10; i++) {
      expect(isRateLimited(key)).toBe(false)
    }
  })

  it('blocks requests once the per-window limit is exceeded', () => {
    const key = `test-key-${Math.random()}`
    for (let i = 0; i < 10; i++) {
      isRateLimited(key)
    }
    expect(isRateLimited(key)).toBe(true)
  })

  it('tracks separate keys independently', () => {
    const keyA = `key-a-${Math.random()}`
    const keyB = `key-b-${Math.random()}`
    for (let i = 0; i < 10; i++) isRateLimited(keyA)
    expect(isRateLimited(keyA)).toBe(true)
    expect(isRateLimited(keyB)).toBe(false)
  })

  it('resets the count after the window elapses', () => {
    vi.useFakeTimers()
    const key = `test-key-${Math.random()}`
    for (let i = 0; i < 11; i++) isRateLimited(key)
    expect(isRateLimited(key)).toBe(true)

    vi.advanceTimersByTime(15 * 60 * 1000 + 1)

    expect(isRateLimited(key)).toBe(false)
  })
})

describe('clientIp', () => {
  it('reads the first address from x-forwarded-for', () => {
    const req = { headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, socket: {} } as never
    expect(clientIp(req)).toBe('203.0.113.5')
  })

  it('falls back to the socket remote address', () => {
    const req = { headers: {}, socket: { remoteAddress: '198.51.100.7' } } as never
    expect(clientIp(req)).toBe('198.51.100.7')
  })

  it('falls back to "unknown" when nothing is available', () => {
    const req = { headers: {}, socket: {} } as never
    expect(clientIp(req)).toBe('unknown')
  })
})
