import { describe, it, expect, vi, afterEach } from 'vitest'
import { isRateLimited } from './rateLimit'

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

