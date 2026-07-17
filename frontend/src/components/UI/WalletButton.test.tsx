import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TosProvider } from '../../context/TosContext'
import { WalletButton } from './WalletButton'

const mockConnect = vi.fn()
const mockDisconnect = vi.fn()

vi.mock('../../hooks/useWallet', () => ({
  useWallet: () => ({
    wallet: { isConnected: false, address: null },
    isConnecting: false,
    isInstalled: true,
    error: null,
    connect: mockConnect,
    disconnect: mockDisconnect,
  }),
}))

const renderButton = () =>
  render(
    <TosProvider>
      <WalletButton />
    </TosProvider>,
  )

describe('WalletButton ToS gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('requires accepting the terms before connecting the wallet', () => {
    renderButton()

    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }))

    expect(mockConnect).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: /terms of service/i })).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText(/accept the terms/i))
    fireEvent.click(screen.getByRole('button', { name: /^accept$/i }))

    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('disconnects cleanly when the terms are declined during wallet connection', () => {
    renderButton()

    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }))
    fireEvent.click(screen.getByRole('button', { name: /decline/i }))

    expect(mockConnect).not.toHaveBeenCalled()
    expect(mockDisconnect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: /terms of service/i })).not.toBeInTheDocument()
  })
})
