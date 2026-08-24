import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NetworkProvider } from '../context/NetworkContext'
import { useNetworkGuard } from './useNetworkGuard'

// Integration test with the REAL NetworkProvider + useLocalStorage so that the
// cross-tab `storage` event path is exercised end-to-end (issue #1163).

function GuardConsumer() {
  const { blocked, reason } = useNetworkGuard()
  return (
    <div>
      <button disabled={blocked} data-testid="submit-btn">
        Submit
      </button>
      {blocked && reason && (
        <p role="alert" data-testid="network-warning">
          {reason}
        </p>
      )}
      {!blocked && <p data-testid="safe-indicator">Form is safe</p>}
    </div>
  )
}

describe('useNetworkGuard (integration with real NetworkProvider)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('blocks when a cross-tab storage event changes the network mid-fill', () => {
    render(
      <NetworkProvider>
        <GuardConsumer />
      </NetworkProvider>,
    )

    // Initially on testnet — form should be safe
    expect(screen.getByTestId('safe-indicator')).toBeInTheDocument()
    expect(screen.getByTestId('submit-btn')).not.toBeDisabled()

    // Simulate a cross-tab storage event: another tab changed the network
    act(() => {
      window.localStorage.setItem('stellarforge_network', JSON.stringify('mainnet'))
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'stellarforge_network',
          newValue: JSON.stringify('mainnet'),
          oldValue: JSON.stringify('testnet'),
        }),
      )
    })

    // The form should now be blocked with a warning
    expect(screen.getByTestId('submit-btn')).toBeDisabled()
    expect(screen.getByTestId('network-warning')).toHaveTextContent(
      /Network changed to mainnet/i,
    )
    expect(screen.getByTestId('network-warning')).toHaveTextContent(/Review the token address/i)
  })
})