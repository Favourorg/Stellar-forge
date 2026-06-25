import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ErrorBoundary } from '../../lib/monitoring/errorBoundary'

const { mockCaptureException } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
}))
vi.mock('../../lib/monitoring/sentry', () => ({
  captureException: mockCaptureException,
}))

function Bomb(): never {
  throw new Error('boom')
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Suppress jsdom console.error for expected throws
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('calls captureException with error and componentStack', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(mockCaptureException).toHaveBeenCalledOnce()
    const [err, ctx] = mockCaptureException.mock.calls[0] as [Error, Record<string, unknown>]
    expect(err.message).toBe('boom')
    expect(ctx).toHaveProperty('componentStack')
  })

  it('renders fallback UI without exposing raw error', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/something went wrong/i)).toBeTruthy()
    expect(screen.getByText(/reload page/i)).toBeTruthy()
    expect(screen.queryByText('boom')).toBeNull()
  })

  it('renders custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div>custom fallback</div>}>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText('custom fallback')).toBeTruthy()
  })

  it('allows a route fallback to reset the boundary and display recovered content', async () => {
    // A ref (not a render-time mutation) so React's concurrent-render retry
    // can't silently "absorb" the throw by re-invoking with different state.
    const shouldThrow = { current: true }

    function FlakyRoute(): JSX.Element {
      if (shouldThrow.current) {
        throw new Error('boom-once')
      }
      return <div>route restored</div>
    }

    const RouteFallback = ({ resetErrorBoundary }: { resetErrorBoundary?: () => void }) => (
      <div>
        <div>route error</div>
        <button
          onClick={() => {
            shouldThrow.current = false
            resetErrorBoundary?.()
          }}
        >
          Try again
        </button>
      </div>
    )

    render(
      <ErrorBoundary fallback={<RouteFallback />}>
        <FlakyRoute />
      </ErrorBoundary>,
    )

    expect(screen.getByText('route error')).toBeTruthy()
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(await screen.findByText('route restored')).toBeTruthy()
  })
})
