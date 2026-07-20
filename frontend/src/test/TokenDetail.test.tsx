import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TokenDetail } from '../components/TokenDetail'
import { ipfsService } from '../services/ipfs'
import type { TokenInfo } from '../types'

const VALID_CID = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'
const TOKEN_ADDRESS = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

const BASE_TOKEN: TokenInfo = {
  name: 'EvilToken',
  symbol: 'EVIL',
  decimals: 7,
  creator: 'GABC123',
  createdAt: 1700000000,
  metadataUri: `ipfs://${VALID_CID}`,
}

const mockGetTokenInfoByAddress = vi.fn()

vi.mock('../services/ipfs', () => ({
  ipfsService: { getMetadata: vi.fn() },
}))

vi.mock('../context/StellarContext', () => ({
  useStellarContext: () => ({ stellarService: { getTokenInfoByAddress: mockGetTokenInfoByAddress } }),
}))

vi.mock('../context/NetworkContext', () => ({
  useNetwork: () => ({ network: 'testnet' }),
}))

vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}))

vi.mock('../hooks/useWallet', () => ({
  useWallet: () => ({ wallet: { address: null, isConnected: false } }),
}))

function renderTokenDetail() {
  return render(
    <MemoryRouter initialEntries={[`/tokens/${TOKEN_ADDRESS}`]}>
      <Routes>
        <Route path="/tokens/:address" element={<TokenDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('TokenDetail — untrusted metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetTokenInfoByAddress.mockResolvedValue(BASE_TOKEN)
  })

  it('never renders a non-ipfs:// metadata image, so an attacker URL cannot reach <img src>', async () => {
    vi.mocked(ipfsService.getMetadata).mockResolvedValue({
      name: 'EvilToken',
      description: 'desc',
      image: 'https://evil.example.com/pixel.png',
    })

    renderTokenDetail()

    await waitFor(() => expect(screen.getByText('desc')).toBeInTheDocument())

    // The image is dropped entirely rather than passed through to the DOM.
    expect(document.body.innerHTML).not.toContain('evil.example.com')
    expect(screen.queryByAltText(/token art/)).not.toBeInTheDocument()
  })

  it('renders the image through the gateway when metadata has a well-formed ipfs:// URI', async () => {
    vi.mocked(ipfsService.getMetadata).mockResolvedValue({
      name: 'GoodToken',
      description: 'desc',
      image: `ipfs://${VALID_CID}`,
    })

    renderTokenDetail()

    const img = await screen.findByAltText(/token art/)
    expect(img).toHaveAttribute('src', `https://gateway.pinata.cloud/ipfs/${VALID_CID}`)
  })

  it('renders a <script>-containing description as inert text, not executed markup', async () => {
    vi.mocked(ipfsService.getMetadata).mockResolvedValue({
      name: 'Token',
      description: '<script>window.__pwned = true</script>',
      image: `ipfs://${VALID_CID}`,
    })

    renderTokenDetail()

    await waitFor(() => {
      expect(screen.getByText('<script>window.__pwned = true</script>')).toBeInTheDocument()
    })
    expect(document.body.querySelectorAll('script').length).toBe(0)
  })
})
