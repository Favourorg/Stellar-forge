import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TokenDetail } from '../components/TokenDetail'
import { StellarContext } from '../context/StellarContext'
import { TOKEN_IMAGE_PLACEHOLDER } from '../utils/formatting'
import { IPFSService } from '../services/ipfs'
import type { StellarService } from '../services/stellar'
import type { TokenInfo } from '../types'

const VALID_CID = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'
const ATTACKER_URL = 'https://evil.example.com/pixel.png'

// Ambient context TokenDetail needs but which is irrelevant to what these
// tests assert; stubbed so the component can mount without a full app tree.
vi.mock('../context/ToastContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useToast: () => ({ addToast: vi.fn() }),
}))

vi.mock('../context/NetworkContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNetwork: () => ({ network: 'testnet', mismatch: { isMismatch: false } }),
}))

vi.mock('../hooks/useWallet', () => ({
  useWallet: () => ({ wallet: { isConnected: false, address: null } }),
}))

const getTokenInfoByAddress = vi.fn()

// TokenDetail resolves its services from StellarContext, not from a module
// import — mocking '../services/stellar' would never bind. Supply the context
// directly with a stub service plus a real IPFSService, whose gateway fetch is
// stubbed through global fetch below.
// Must be a real, checksum-valid contract address — TokenDetail short-circuits
// to NotFound before fetching anything if isValidContractAddress fails.
const TOKEN_ADDRESS = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'

function renderTokenDetail(address = TOKEN_ADDRESS) {
  const value = {
    stellarService: { getTokenInfoByAddress } as unknown as StellarService,
    ipfsService: new IPFSService(),
  }

  return render(
    <StellarContext.Provider value={value}>
      <MemoryRouter initialEntries={[`/tokens/${address}`]}>
        <Routes>
          <Route path="/tokens/:address" element={<TokenDetail />} />
        </Routes>
      </MemoryRouter>
    </StellarContext.Provider>,
  )
}

const tokenInfo = (overrides: Partial<TokenInfo> = {}): TokenInfo => ({
  name: 'TestToken',
  symbol: 'TST',
  decimals: 7,
  creator: 'GCREATOR000000000000000000000000000000000000000000000',
  createdAt: 1_700_000_000,
  metadataUri: `ipfs://${VALID_CID}`,
  ...overrides,
})

/** Stub the IPFS gateway response that TokenDetail fetches metadata from. */
const mockPinnedMetadata = (metadata: Record<string, unknown>) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => metadata,
    } as Response),
  )
}

describe('TokenDetail — untrusted metadata rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getTokenInfoByAddress.mockResolvedValue(tokenInfo())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a placeholder when pinned metadata has a non-IPFS image, never the attacker URL', async () => {
    mockPinnedMetadata({
      name: 'EvilToken',
      description: 'desc',
      image: ATTACKER_URL,
    })

    renderTokenDetail()

    const img = await screen.findByRole('img')
    await waitFor(() => {
      expect(img.getAttribute('src')).toBe(TOKEN_IMAGE_PLACEHOLDER)
    })
    expect(img.getAttribute('src')).not.toBe(ATTACKER_URL)
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
  })

  it('renders the real image when metadata has a well-formed ipfs:// image', async () => {
    mockPinnedMetadata({
      name: 'GoodToken',
      description: 'desc',
      image: `ipfs://${VALID_CID}`,
    })

    renderTokenDetail()

    const img = await screen.findByRole('img', { name: 'GoodToken' })
    await waitFor(() => {
      expect(img.getAttribute('src')).toBe(`https://gateway.pinata.cloud/ipfs/${VALID_CID}`)
    })
  })

  it('renders a <script>-containing description as inert text, not executed markup', async () => {
    mockPinnedMetadata({
      name: 'Token',
      description: '<script>window.__pwned = true</script>',
      image: `ipfs://${VALID_CID}`,
    })

    renderTokenDetail()

    await waitFor(() => {
      expect(screen.getByText('<script>window.__pwned = true</script>')).toBeInTheDocument()
    })
    expect(document.body.querySelectorAll('script').length).toBe(0)
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })
})
