/**
 * #944 — Sentry tag correlation during transaction poll errors
 *
 * Verifies that a client-side error occurring during an active transaction
 * poll carries the expected structured tags (txHash, network, contractId,
 * functionName) through to the Sentry-captured payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @sentry/react before any module under test is imported ───────────────
const mockScope = {
  setTag: vi.fn(),
  setExtras: vi.fn(),
}
const mockWithScope = vi.fn((cb: (scope: typeof mockScope) => void) => cb(mockScope))
const mockCaptureException = vi.fn()
const mockLastEventId = vi.fn(() => 'test-event-id-abcd1234')

vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  captureException: mockCaptureException,
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setTag: vi.fn(),
  withScope: mockWithScope,
  withProfiler: vi.fn((c) => c),
  browserTracingIntegration: vi.fn(),
  replayIntegration: vi.fn(),
  lastEventId: mockLastEventId,
  ErrorBoundary: ({ children }: { children: unknown }) => children,
}))

// Enable Sentry by simulating production environment before importing sentry.ts
vi.stubEnv('MODE', 'production')
vi.stubEnv('VITE_SENTRY_DSN', 'https://test@sentry.io/1')

describe('#944 captureTransactionError Sentry tag correlation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLastEventId.mockReturnValue('test-event-id-abcd1234')
  })

  it('tags txHash, network, contractId, and functionName on a poll failure', async () => {
    const { captureTransactionError } = await import('../../lib/monitoring/sentry')

    const testTxHash = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
    const error = new Error('Transaction failed: simulate poll error')

    captureTransactionError(error, {
      txHash: testTxHash,
      network: 'testnet',
      contractId: 'CABC1234TEST',
      functionName: 'pollTransaction',
    })

    // withScope must have been called
    expect(mockWithScope).toHaveBeenCalledOnce()

    // All four required tags must be present
    expect(mockScope.setTag).toHaveBeenCalledWith('txHash', testTxHash)
    expect(mockScope.setTag).toHaveBeenCalledWith('network', 'testnet')
    expect(mockScope.setTag).toHaveBeenCalledWith('contractId', 'CABC1234TEST')
    expect(mockScope.setTag).toHaveBeenCalledWith('functionName', 'pollTransaction')

    // The error itself must be captured
    expect(mockCaptureException).toHaveBeenCalledWith(error)

    // Extras must mirror the tags for rich event detail
    expect(mockScope.setExtras).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: testTxHash,
        network: 'testnet',
        contractId: 'CABC1234TEST',
        functionName: 'pollTransaction',
      }),
    )
  })

  it('returns the Sentry event ID so the UI can surface it to the user', async () => {
    const { captureTransactionError } = await import('../../lib/monitoring/sentry')

    const eventId = captureTransactionError(new Error('poll timeout'), {
      txHash: 'deadbeef'.repeat(8),
      network: 'mainnet',
      contractId: 'CMAINNET',
      functionName: 'pollTransaction',
    })

    expect(eventId).toBe('test-event-id-abcd1234')
  })

  it('returns undefined and is a no-op when Sentry is disabled (development)', async () => {
    vi.resetModules()
    vi.stubEnv('MODE', 'development')
    vi.unstubAllEnvs()
    vi.stubEnv('MODE', 'development')

    const { captureTransactionError: devCapture } = await import('../../lib/monitoring/sentry')
    const result = devCapture(new Error('noop'), { txHash: 'abc', network: 'testnet' })

    expect(result).toBeUndefined()
    expect(mockWithScope).not.toHaveBeenCalled()

    vi.unstubAllEnvs()
    vi.stubEnv('MODE', 'production')
    vi.stubEnv('VITE_SENTRY_DSN', 'https://test@sentry.io/1')
  })

  it('works without optional fields — only provided context is tagged', async () => {
    vi.resetModules()
    vi.stubEnv('MODE', 'production')
    vi.stubEnv('VITE_SENTRY_DSN', 'https://test@sentry.io/1')

    const { captureTransactionError } = await import('../../lib/monitoring/sentry')

    captureTransactionError(new Error('minimal context'), {
      txHash: 'cafebabe'.repeat(8),
    })

    // txHash must be tagged
    expect(mockScope.setTag).toHaveBeenCalledWith('txHash', 'cafebabe'.repeat(8))
    // Other optional tags should NOT be set when not provided
    const tagCalls = mockScope.setTag.mock.calls.map(([k]) => k)
    expect(tagCalls).not.toContain('network')
    expect(tagCalls).not.toContain('contractId')
    expect(tagCalls).not.toContain('functionName')
  })

  it('captureContractError also tags txHash when provided', async () => {
    vi.resetModules()
    vi.stubEnv('MODE', 'production')
    vi.stubEnv('VITE_SENTRY_DSN', 'https://test@sentry.io/1')

    const { captureContractError } = await import('../../lib/monitoring/sentry')

    const txHash = 'deadcafe'.repeat(8)
    captureContractError(new Error('contract revert'), {
      network: 'testnet',
      contractId: 'CTEST',
      functionName: 'deployToken',
      txHash,
    })

    expect(mockScope.setTag).toHaveBeenCalledWith('txHash', txHash)
    expect(mockScope.setTag).toHaveBeenCalledWith('network', 'testnet')
    expect(mockScope.setTag).toHaveBeenCalledWith('contractId', 'CTEST')
    expect(mockScope.setTag).toHaveBeenCalledWith('functionName', 'deployToken')
  })
})
