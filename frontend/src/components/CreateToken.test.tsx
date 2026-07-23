import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { CreateToken } from './CreateToken'

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockDeployToken = vi.fn()
const mockAddToast = vi.fn()
const mockRefreshBalance = vi.fn()
const mockOnSuccess = vi.fn()

vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ addToast: mockAddToast }),
}))

vi.mock('../context/StellarContext', () => ({
  useStellarContext: () => ({
    stellarService: { deployToken: mockDeployToken },
  }),
}))

vi.mock('../context/WalletContext', () => ({
  useWalletContext: () => ({
    refreshBalance: mockRefreshBalance,
    wallet: { isConnected: true, address: 'GABC' },
  }),
}))

vi.mock('../hooks/useFactoryState', () => ({
  useFactoryState: () => ({ state: { baseFee: '100000' } }),
}))

vi.mock('../config/stellar', () => ({
  STELLAR_CONFIG: { tokenWasmHash: 'abcdef' },
}))

vi.mock('../utils/logger', () => ({
  logger: { error: vi.fn() },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

// Minimal TokenForm that fires onSubmit immediately
vi.mock('./TokenForm', () => ({
  TokenForm: ({ onSubmit, isLoading }: { onSubmit: (p: unknown) => void; isLoading: boolean }) => (
    <form
      data-testid="token-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ name: 'Test', symbol: 'TST', decimals: 7, initialSupply: '100' })
      }}
    >
      <button type="submit" disabled={isLoading}>
        {isLoading ? 'Deploying...' : 'Create Token'}
      </button>
    </form>
  ),
}))

vi.mock('./ShareButton', () => ({ ShareButton: () => <div data-testid="share-button" /> }))
vi.mock('./CopyButton', () => ({ CopyButton: () => <button>Copy</button> }))
vi.mock('./ErrorBoundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}))

// ── Helpers ──────────────────────────────────────────────────────────────────

function submitForm() {
  const btn = screen.getByRole('button', { name: /create token/i })
  fireEvent.click(btn)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CreateToken (reconciliation policy)', () => {
  // ── Failure ────────────────────────────────────────────────────────────────

  it('does NOT show a phantom token when the transaction fails', async () => {
    mockDeployToken.mockRejectedValue(new Error('Simulated deploy failure'))

    render(<CreateToken />)
    submitForm()

    await waitFor(() => {
      // Success banner must not appear
      expect(screen.queryByText(/deployedSuccessfully/i)).toBeNull()
      expect(screen.queryByText(/copy token address/i)).toBeNull()
    })

    // Error toast shown
    expect(mockAddToast).toHaveBeenCalledWith('Simulated deploy failure', 'error')

    // Caches MUST NOT be refreshed — reconciliation policy step 3
    expect(mockRefreshBalance).not.toHaveBeenCalled()
    expect(mockOnSuccess).not.toHaveBeenCalled()
  })

  it('does NOT show a phantom token when deployToken returns success:false', async () => {
    mockDeployToken.mockResolvedValue({ success: false, tokenAddress: 'CTEST' })

    render(<CreateToken />)
    submitForm()

    await waitFor(() => {
      expect(screen.queryByText(/deployedSuccessfully/i)).toBeNull()
      expect(screen.queryByText(/CTEST/)).toBeNull()
    })

    expect(mockAddToast).toHaveBeenCalledWith('tokenForm.deployFailed', 'error')
    expect(mockRefreshBalance).not.toHaveBeenCalled()
    expect(mockOnSuccess).not.toHaveBeenCalled()
  })

  // ── Success ────────────────────────────────────────────────────────────────

  it('shows the deployed token and refreshes caches on success', async () => {
    mockDeployToken.mockResolvedValue({ success: true, tokenAddress: 'CNEWTOKEN' })

    render(<CreateToken onSuccess={mockOnSuccess} />)
    submitForm()

    await waitFor(() => {
      expect(screen.getByText(/deployedSuccessfully/i)).toBeInTheDocument()
      expect(screen.getByText(/CNEWTOKEN/)).toBeInTheDocument()
    })

    expect(mockAddToast).toHaveBeenCalledWith('tokenForm.deploySuccess', 'success')
    expect(mockRefreshBalance).toHaveBeenCalled()
    expect(mockOnSuccess).toHaveBeenCalled()
  })

  // ── Timeout (uncertainty) ──────────────────────────────────────────────────

  it('shows the uncertainty banner when the transaction times out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    // Simulate a never-resolving transaction — Promise.race will trigger the
    // timeout after DEPLOY_TIMEOUT_MS (90s).
    const neverSettle = new Promise<{ success: boolean; tokenAddress: string }>(() => {})
    mockDeployToken.mockReturnValue(neverSettle)

    render(<CreateToken />)
    act(() => {
      submitForm()
    })

    // Before the timeout fires, the form should be in loading state
    expect(screen.getByRole('button', { name: /deploying/i })).toBeDisabled()

    // No phantom success
    expect(screen.queryByText(/deployedSuccessfully/i)).toBeNull()
    expect(mockRefreshBalance).not.toHaveBeenCalled()
    expect(mockOnSuccess).not.toHaveBeenCalled()

    // Advance time past the timeout threshold
    vi.advanceTimersByTime(90_001)
    // Flush microtasks so the timeout rejection is processed
    await Promise.resolve()

    // Timeout banner must appear
    await waitFor(() => {
      expect(screen.getByTestId('timeout-banner')).toBeInTheDocument()
      expect(screen.getByText(/Transaction submitted but not yet confirmed/)).toBeInTheDocument()
    })

    // Still no phantom entry after timeout
    expect(screen.queryByText(/deployedSuccessfully/i)).toBeNull()
    expect(mockRefreshBalance).not.toHaveBeenCalled()
    expect(mockOnSuccess).not.toHaveBeenCalled()

    // Warning toast shown
    expect(mockAddToast).toHaveBeenCalledWith('tokenForm.deployTimeout', 'warning')

    vi.useRealTimers()
  }, 15000)

  it('does NOT show the timeout banner when the transaction succeeds quickly', async () => {
    mockDeployToken.mockResolvedValue({ success: true, tokenAddress: 'CFAST' })

    render(<CreateToken />)
    submitForm()

    await waitFor(() => {
      expect(screen.getByText(/deployedSuccessfully/i)).toBeInTheDocument()
    })

    // Timeout banner must not appear
    expect(screen.queryByTestId('timeout-banner')).toBeNull()
  })
})
