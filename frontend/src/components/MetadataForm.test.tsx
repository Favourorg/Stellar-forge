import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TosProvider } from '../context/TosContext'
import { MetadataForm } from './MetadataForm'

vi.mock('../context/StellarContext', () => ({
  useStellarContext: () => ({
    ipfsService: { uploadMetadata: vi.fn() },
    stellarService: { setMetadata: vi.fn() },
  }),
}))

vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}))

vi.mock('../context/NetworkContext', () => ({
  useNetwork: () => ({ network: 'testnet' }),
}))

vi.mock('../hooks/useFactoryState', () => ({
  useFactoryState: () => ({ state: { metadataFee: '100000' } }),
}))

vi.mock('../hooks/useBalanceCheck', () => ({
  useBalanceCheck: () => ({ hasSufficientBalance: true, shortfall: 0, isTestnet: true }),
}))

vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/env')>()),
  isIpfsConfigured: () => true,
}))

const renderMetadataForm = () =>
  render(
    <TosProvider>
      <MetadataForm />
    </TosProvider>,
  )

describe('MetadataForm ToS gate', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('requires accepting the terms before showing the on-chain metadata confirmation', () => {
    const { container } = renderMetadataForm()

    fireEvent.change(screen.getByLabelText(/token address/i), {
      target: { value: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    })

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(fileInput).not.toBeNull()
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(['token image'], 'token.png', { type: 'image/png' })],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /set metadata/i }))

    expect(screen.getByRole('dialog', { name: /terms of service/i })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /confirm set metadata/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText(/accept the terms/i))
    fireEvent.click(screen.getByRole('button', { name: /^accept$/i }))

    expect(screen.getByRole('dialog', { name: /confirm set metadata/i })).toBeInTheDocument()
  })
})
