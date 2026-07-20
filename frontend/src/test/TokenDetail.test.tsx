import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TokenDetail } from '../components/TokenDetail'
import { stellarService } from '../services/stellar'

const VALID_CID = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'

vi.mock('../services/stellar', () => ({
  stellarService: {
    getTokenInfo: vi.fn(),
  },
}))

function renderTokenDetail(address = 'CABC123') {
  return render(
    <MemoryRouter initialEntries={[`/tokens/${address}`]}>
      <Routes>
        <Route path="/tokens/:address" element={<TokenDetail />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('TokenDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a fallback placeholder image when pinned metadata has a non-IPFS image, not the attacker URL', async () => {
    vi.mocked(stellarService.getTokenInfo).mockResolvedValue({
      metadataUri: `ipfs://${VALID_CID}`,
    })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'EvilToken',
        description: 'desc',
        image: 'https://evil.example.com/pixel.png',
      }),
    } as Response)

    renderTokenDetail()

    const img = await screen.findByRole('img')
    await waitFor(() => {
      expect(img.getAttribute('src')).not.toBe('https://evil.example.com/pixel.png')
      expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    })
  })

  it('renders the real image when metadata has a well-formed ipfs:// image', async () => {
    vi.mocked(stellarService.getTokenInfo).mockResolvedValue({
      metadataUri: `ipfs://${VALID_CID}`,
    })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'GoodToken', description: 'desc', image: `ipfs://${VALID_CID}` }),
    } as Response)

    renderTokenDetail()

    const img = await screen.findByRole('img', { name: 'GoodToken' })
    await waitFor(() => {
      expect(img.getAttribute('src')).toBe(`https://gateway.pinata.cloud/ipfs/${VALID_CID}`)
    })
  })

  it('renders a <script>-containing description as inert text, not executed markup', async () => {
    vi.mocked(stellarService.getTokenInfo).mockResolvedValue({
      metadataUri: `ipfs://${VALID_CID}`,
    })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'Token',
        description: '<script>window.__pwned = true</script>',
        image: `ipfs://${VALID_CID}`,
      }),
    } as Response)

    renderTokenDetail()

    await waitFor(() => {
      expect(screen.getByText('<script>window.__pwned = true</script>')).toBeInTheDocument()
    })
    expect(document.body.querySelectorAll('script').length).toBe(0)
  })
})
