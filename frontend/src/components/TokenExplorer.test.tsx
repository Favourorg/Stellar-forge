import { render, screen, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TokenExplorer } from './TokenExplorer'
import { StellarContext } from '../context/StellarContext'
import type { StellarService } from '../services/stellar'
import type { IPFSService } from '../services/ipfs'
import type { ContractEvent, TokenInfo } from '../types'

// ── Ambient context stubs (irrelevant to what these tests assert) ──────────────

vi.mock('../context/ToastContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useToast: () => ({ addToast: vi.fn() }),
}))

vi.mock('../context/NetworkContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNetwork: () => ({ network: 'testnet', mismatch: { isMismatch: false } }),
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

vi.mock('../config/stellar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/stellar')>()
  return {
    ...actual,
    STELLAR_CONFIG: { ...actual.STELLAR_CONFIG, factoryContractId: 'CFACTORY', network: 'testnet' },
  }
})

// Hoisted so the vi.mock factories (themselves hoisted) can reference them.
const { getMetadata, fetchAllContractEvents } = vi.hoisted(() => ({
  getMetadata: vi.fn(),
  fetchAllContractEvents: vi.fn(),
}))

vi.mock('../services/ipfs', () => ({ ipfsService: { getMetadata } }))

// The event-derived enrichment path (index → address) is mocked so we control
// exactly which addresses the index-range listing correlates to.
vi.mock('../utils/fetchAllContractEvents', () => ({ fetchAllContractEvents }))

// ── Fixtures ───────────────────────────────────────────────────────────────────

const getAllTokens = vi.fn()
const getTokenInfoByAddress = vi.fn()

const tokenAt = (index: number): TokenInfo => ({
  name: `Token ${index}`,
  symbol: `TK${index}`,
  decimals: 7,
  creator: `GCREATOR${index}`,
  createdAt: 1_700_000_000 + index,
  index,
})

const created = (ledger: number, address: string): ContractEvent => ({
  id: `created-${ledger}`,
  type: 'created',
  ledger,
  timestamp: 1_700_000_000 + ledger,
  txHash: `tx-${ledger}`,
  data: { tokenAddress: address, creator: `GCREATOR${ledger}` },
})

function renderExplorer() {
  const value = {
    stellarService: { getAllTokens, getTokenInfoByAddress } as unknown as StellarService,
    ipfsService: { getMetadata } as unknown as IPFSService,
  }
  return render(
    <StellarContext.Provider value={value}>
      <MemoryRouter>
        <TokenExplorer />
      </MemoryRouter>
    </StellarContext.Provider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getMetadata.mockResolvedValue(null)
  fetchAllContractEvents.mockResolvedValue([])
})

describe('TokenExplorer', () => {
  it('lists real tokens from a populated factory, newest-first, with resolved addresses', async () => {
    getAllTokens.mockResolvedValue({ tokens: [tokenAt(3), tokenAt(2), tokenAt(1)], total: 3 })
    // Creation order (ascending ledger) maps position k → 1-based index k+1.
    fetchAllContractEvents.mockResolvedValue([
      created(1, 'CADDR1'),
      created(2, 'CADDR2'),
      created(3, 'CADDR3'),
    ])

    renderExplorer()

    await waitFor(() => expect(screen.getByText('Token 3')).toBeInTheDocument())
    // First page requested from the authoritative index-range view.
    expect(getAllTokens).toHaveBeenCalledWith(0, 10)

    // Newest-first ordering and the true 1-based contract index label.
    const cards = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)
    expect(cards).toEqual(['Token 3', 'Token 2', 'Token 1'])
    expect(screen.getByText('#3')).toBeInTheDocument()

    // Address enrichment via events → working detail links, newest-first.
    const links = screen.getAllByRole('link', { name: /view full details/i })
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/tokens/CADDR3',
      '/tokens/CADDR2',
      '/tokens/CADDR1',
    ])
    expect(screen.getByText('All Tokens (3)')).toBeInTheDocument()
  })

  it('server-paginates: clicking Next fetches the next page by offset', async () => {
    getAllTokens.mockImplementation(async (offset = 0, limit = 10) => ({
      tokens: Array.from({ length: Math.min(limit, 25 - offset) }, (_, i) =>
        tokenAt(25 - offset - i),
      ),
      total: 25,
    }))

    renderExplorer()

    await waitFor(() => expect(screen.getByText('Token 25')).toBeInTheDocument())
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: /next page/i }))
    })

    await waitFor(() => expect(getAllTokens).toHaveBeenCalledWith(10, 10))
    await waitFor(() => expect(screen.getByText('Page 2 of 3')).toBeInTheDocument())
  })

  it('renders an error state — never a fake-empty list — when the page fetch fails', async () => {
    getAllTokens.mockRejectedValue(new Error('RPC unavailable'))

    renderExplorer()

    await waitFor(() => expect(screen.getByText('Could not load tokens')).toBeInTheDocument())
    expect(screen.getByText('RPC unavailable')).toBeInTheDocument()
    // Crucially, it must NOT claim the factory is empty.
    expect(screen.queryByText('No tokens have been deployed yet')).not.toBeInTheDocument()
  })

  it('retry re-fetches after a failure and can then succeed', async () => {
    getAllTokens
      .mockRejectedValueOnce(new Error('RPC unavailable'))
      .mockResolvedValue({ tokens: [tokenAt(1)], total: 1 })

    renderExplorer()

    await waitFor(() => expect(screen.getByText('Could not load tokens')).toBeInTheDocument())

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    })

    await waitFor(() => expect(screen.getByText('Token 1')).toBeInTheDocument())
    expect(screen.queryByText('Could not load tokens')).not.toBeInTheDocument()
  })

  it('distinguishes an empty factory from a failure', async () => {
    getAllTokens.mockResolvedValue({ tokens: [], total: 0 })

    renderExplorer()

    await waitFor(() =>
      expect(screen.getByText('No tokens have been deployed yet')).toBeInTheDocument(),
    )
    expect(screen.queryByText('Could not load tokens')).not.toBeInTheDocument()
    expect(screen.getByText('All Tokens (0)')).toBeInTheDocument()
  })

  it('still lists tokens when address enrichment is unavailable (no detail link)', async () => {
    getAllTokens.mockResolvedValue({ tokens: [tokenAt(1)], total: 1 })
    fetchAllContractEvents.mockRejectedValue(new Error('events down'))

    renderExplorer()

    await waitFor(() => expect(screen.getByText('Token 1')).toBeInTheDocument())
    // Graceful degradation: the row renders without a broken /tokens/ link.
    const cards = screen.getAllByRole('heading', { level: 4 })
    const card = cards[0]!.closest('div')!
    expect(within(card).queryByRole('link', { name: /view full details/i })).toBeNull()
  })
})
