import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { TokenDetail } from '../components/TokenDetail'
import { StellarContext } from '../context/StellarContext'
import { IPFSService, MAX_METADATA_DESCRIPTION_LENGTH } from '../services/ipfs'
import type { StellarService } from '../services/stellar'

// Legacy test CID that appears in image URIs; it is only used as a placeholder
// inside metadata documents (and as fallback — the actual bytes served by the
// gateway are what getMetadata validates, and the tests below compute a real
// CID from the served content so verification passes).
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

const resolveTokenInfoByAddress = vi.fn()

// Must be a real, checksum-valid contract address — TokenDetail short-circuits
// to NotFound before fetching anything if isValidContractAddress fails.
const TOKEN_ADDRESS = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'

// TokenDetail resolves its services from StellarContext, not from a module
// import — mocking '../services/stellar' would never bind. Supply the context
// directly with a stub service plus a real IPFSService, whose gateway fetch is
// stubbed through global fetch below.
function renderTokenDetail(address = TOKEN_ADDRESS, metadataCid = VALID_CID) {
  const value = {
    stellarService: { resolveTokenInfoByAddress } as unknown as StellarService,
    ipfsService: new IPFSService(),
  }

  resolveTokenInfoByAddress.mockResolvedValue({
    status: 'resolved',
    name: 'TestToken',
    symbol: 'TST',
    decimals: 7,
    creator: 'GCREATOR000000000000000000000000000000000000000000000',
    createdAt: 1_700_000_000,
    metadataUri: `ipfs://${metadataCid}`,
  })

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

/**
 * Stub the IPFS gateway response that TokenDetail fetches metadata from, and
 * return the CID that actually addresses those bytes. TokenDetail's
 * getMetadata now verifies the served content matches the requested CID, so
 * the URI in the token info must be the CID of the served content for
 * happy-path tests to resolve, while mismatch tests use a different CID.
 */
const mockPinnedMetadata = async (metadata: Record<string, unknown>): Promise<string> => {
  const content = JSON.stringify(metadata)
  const utf8 = new Uint8Array(new TextEncoder().encode(content))
  const digest = await sha256.digest(utf8)
  const cid = CID.createV1(0x70, digest).toString()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        utf8.buffer.slice(utf8.byteOffset, utf8.byteOffset + utf8.byteLength),
    } as unknown as Response),
  )
  return cid
}

describe('TokenDetail — untrusted metadata rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('discards pinned metadata with a non-IPFS image entirely, never rendering the attacker URL', async () => {
    await mockPinnedMetadata({
      name: 'EvilToken',
      description: 'desc',
      image: ATTACKER_URL,
    })

    renderTokenDetail()

    // The document is rejected at parse time (getMetadata), so no metadata
    // card — and therefore no <img> — renders at all.
    await screen.findByText('TestToken')
    await waitFor(() => {
      expect(screen.queryByRole('img')).toBeNull()
    })
    expect(screen.queryByText('EvilToken')).toBeNull()
    expect(document.querySelector(`img[src="${ATTACKER_URL}"]`)).toBeNull()
  })

  it('renders the real image when metadata has a well-formed ipfs:// image', async () => {
    const cid = await mockPinnedMetadata({
      name: 'GoodToken',
      description: 'desc',
      image: `ipfs://${VALID_CID}`,
    })

    renderTokenDetail(TOKEN_ADDRESS, cid)

    const img = await screen.findByRole('img', { name: 'GoodToken' })
    await waitFor(() => {
      expect(img.getAttribute('src')).toBe(`https://gateway.pinata.cloud/ipfs/${VALID_CID}`)
    })
  })

  it('bounds a huge description instead of rendering it in full', async () => {
    // Layout-DoS shape from #926: a wall of text engineered to freeze the tab
    // or push content below the fold. Two independent bounds should apply —
    // the data-layer clamp in getMetadata, and the CSS line-clamp on render.
    // Sized under the 100KB whole-document cap so this exercises the
    // truncation path, not the outright-rejection path.
    const pinnedLength = 40_000
    const cid = await mockPinnedMetadata({
      name: 'SpamToken',
      description: 'A'.repeat(pinnedLength),
      image: `ipfs://${VALID_CID}`,
    })

    renderTokenDetail(TOKEN_ADDRESS, cid)

    const para = await screen.findByText(/^A+…$/)

    // Data layer: clamped well below what was pinned.
    expect(para.textContent!.length).toBeLessThanOrEqual(MAX_METADATA_DESCRIPTION_LENGTH + 1)
    expect(para.textContent!.length).toBeLessThan(pinnedLength)

    // Render layer: bounded box regardless of character count.
    expect(para.className).toMatch(/line-clamp-\d/)
  })

  it('renders a <script>-containing description as inert text, not executed markup', async () => {
    const cid = await mockPinnedMetadata({
      name: 'Token',
      description: '<script>window.__pwned = true</script>',
      image: `ipfs://${VALID_CID}`,
    })

    renderTokenDetail(TOKEN_ADDRESS, cid)

    await waitFor(() => {
      expect(screen.getByText('<script>window.__pwned = true</script>')).toBeInTheDocument()
    })
    expect(document.body.querySelectorAll('script').length).toBe(0)
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })
})