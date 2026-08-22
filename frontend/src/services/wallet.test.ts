import { describe, test, expect, vi, beforeEach } from 'vitest'
import { WalletService } from './wallet'
import {
  isConnected,
  getAddress,
  getNetworkDetails,
  signTransaction as freighterSignTransaction,
} from '@stellar/freighter-api'

vi.mock('@stellar/freighter-api', () => ({
  isConnected: vi.fn(),
  getAddress: vi.fn(),
  getNetworkDetails: vi.fn(),
  signTransaction: vi.fn(),
}))

describe('WalletService.signTransaction', () => {
  let wallet: WalletService

  beforeEach(async () => {
    vi.clearAllMocks()
    wallet = new WalletService()
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true })
    vi.mocked(getAddress).mockResolvedValue({ address: 'GABC123' })
    await wallet.connect()
  })

  test('signs when Freighter is already on the expected network', async () => {
    vi.mocked(getNetworkDetails).mockResolvedValue({
      network: 'TESTNET',
      networkUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
    vi.mocked(freighterSignTransaction).mockResolvedValue({
      signedTxXdr: 'signed-xdr',
      signerAddress: 'GABC123',
    })

    const result = await wallet.signTransaction('unsigned-xdr', 'testnet')

    expect(result).toBe('signed-xdr')
    expect(freighterSignTransaction).toHaveBeenCalled()
  })

  // Regression test for #927: a network switch that happens *between* the
  // background poll ticks in useNetworkMismatch (every 5s) but *before* a
  // submit action must still block signing. This asserts the block comes
  // from a fresh getNetworkDetails() check at sign time, not from any
  // cached/stale mismatch state.
  test('blocks signing when Freighter switched networks since the last poll tick', async () => {
    vi.mocked(getNetworkDetails).mockResolvedValue({
      network: 'PUBLIC',
      networkUrl: 'https://horizon.stellar.org',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    })
    vi.mocked(freighterSignTransaction).mockResolvedValue({
      signedTxXdr: 'signed-xdr',
      signerAddress: 'GABC123',
    })

    await expect(wallet.signTransaction('unsigned-xdr', 'testnet')).rejects.toThrow(
      'Network mismatch: Please switch Freighter to testnet',
    )
    expect(freighterSignTransaction).not.toHaveBeenCalled()
  })

  test('does not block when getNetworkDetails errors (falls through to Freighter, which surfaces its own error)', async () => {
    vi.mocked(getNetworkDetails).mockResolvedValue({
      network: '',
      networkUrl: '',
      networkPassphrase: '',
      error: 'not available',
    })
    vi.mocked(freighterSignTransaction).mockResolvedValue({
      signedTxXdr: 'signed-xdr',
      signerAddress: 'GABC123',
    })

    const result = await wallet.signTransaction('unsigned-xdr', 'testnet')

    expect(result).toBe('signed-xdr')
  })
})
