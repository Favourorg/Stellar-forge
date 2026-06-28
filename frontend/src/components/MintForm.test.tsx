import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { MintForm } from './MintForm'
import { TosProvider } from '../context/TosContext'
import { NetworkProvider } from '../context/NetworkContext'

const mockStellarService = {
  getTokenInfo: vi.fn().mockRejectedValue(new Error('not found')),
  accountExists: vi.fn(),
  mintTokens: vi.fn(),
}
const VALID_RECIPIENT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

vi.mock('../context/StellarContext', () => ({
  useStellarContext: () => ({ stellarService: mockStellarService }),
}))

vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}))

vi.mock('../context/WalletContext', () => ({
  useWalletContext: () => ({ wallet: { isConnected: true, address: 'GABC123' } }),
}))

vi.mock('../hooks/useFactoryState', () => ({
  useFactoryState: () => ({ state: { baseFee: '100000' } }),
}))

vi.mock('../hooks/useBalanceCheck', () => ({
  useBalanceCheck: () => ({ hasSufficientBalance: true, shortfall: 0, isTestnet: true }),
}))

const renderMintForm = () =>
  render(
    <NetworkProvider>
      <TosProvider>
        <MintForm />
      </TosProvider>
    </NetworkProvider>,
  )

describe('MintForm', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.clearAllMocks()
    ;(mockStellarService.accountExists as Mock).mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces recipient account validation by 500ms', async () => {
    renderMintForm()

    const recipientInput = screen.getByLabelText('Recipient Address', { exact: false })
    fireEvent.change(recipientInput, {
      target: { value: VALID_RECIPIENT },
    })

    expect(mockStellarService.accountExists).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(499)
    })

    expect(mockStellarService.accountExists).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })

    await waitFor(() => {
      expect(mockStellarService.accountExists).toHaveBeenCalledTimes(1)
    })
  })

  it('shows a warning when the recipient account is not funded', async () => {
    ;(mockStellarService.accountExists as Mock).mockResolvedValue(false)

    renderMintForm()

    fireEvent.change(screen.getByLabelText('Recipient Address', { exact: false }), {
      target: { value: VALID_RECIPIENT },
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(
      await screen.findByText(
        'This address does not have a Stellar account yet. It may need to be funded first.',
      ),
    ).toBeInTheDocument()
  })

  it('shows an inline error and disables minting for an invalid recipient address', () => {
    renderMintForm()

    fireEvent.change(screen.getByLabelText('Recipient Address', { exact: false }), {
      target: { value: 'not-a-stellar-address' },
    })

    expect(screen.getByText('Enter a valid Stellar account address')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mint Tokens' })).toBeDisabled()
    expect(mockStellarService.accountExists).not.toHaveBeenCalled()
  })

  it('enables minting after the recipient address becomes valid', () => {
    renderMintForm()

    const recipientInput = screen.getByLabelText('Recipient Address', { exact: false })
    fireEvent.change(recipientInput, {
      target: { value: 'not-a-stellar-address' },
    })
    fireEvent.change(recipientInput, {
      target: { value: VALID_RECIPIENT },
    })

    expect(screen.queryByText('Enter a valid Stellar account address')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mint Tokens' })).toBeEnabled()
  })
})
