import { describe, test, expect, vi, afterEach } from 'vitest'
import { nextBackoffDelay } from './pollWithBackoff'

describe('nextBackoffDelay', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('grows with each attempt instead of using a fixed cadence', () => {
    // Pin jitter to 0 so the growth trend isn't masked by randomness.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const options = { initialDelayMs: 500, maxDelayMs: 4000 }
    const delays = [0, 1, 2, 3].map((attempt) => nextBackoffDelay(attempt, options))

    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]!)
    }
  })

  test('caps the delay at maxDelayMs once exponential growth exceeds it', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const options = { initialDelayMs: 500, maxDelayMs: 4000 }
    const delay = nextBackoffDelay(10, options)

    expect(delay).toBeLessThanOrEqual(4000)
  })

  test('applies jitter within +/-10% of the base delay by default', () => {
    const options = { initialDelayMs: 1000, maxDelayMs: 4000 }
    for (let i = 0; i < 50; i++) {
      const delay = nextBackoffDelay(0, options)
      expect(delay).toBeGreaterThanOrEqual(900)
      expect(delay).toBeLessThanOrEqual(1100)
    }
  })
})
