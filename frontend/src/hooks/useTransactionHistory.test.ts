import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useTransactionHistory } from './useTransactionHistory'

// vi.mock is hoisted, so mockConfig must use vi.hoisted() to be available inside the factory
const mockConfig = vi.hoisted(() => ({
  network: 'testnet' as 'testnet' | 'mainnet',
  testnet: { horizonUrl: 'https://horizon-testnet.stellar.org' },
  mainnet: { horizonUrl: 'https://horizon.stellar.org' },
}))

vi.mock('../config/stellar', () => ({ STELLAR_CONFIG: mockConfig }))

// ─── fixtures ────────────────────────────────────────────────────────────────

const PUB = 'GABC1234567890'
const TESTNET = 'https://horizon-testnet.stellar.org'
const MAINNET = 'https://horizon.stellar.org'

function paymentOp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op1',
    type: 'payment',
    asset_code: 'TKA',
    asset_issuer: 'GISSUER',
    amount: '100',
    created_at: '2024-01-01T00:00:00Z',
    transaction_successful: true,
    transaction_hash: 'txhash1',
    paging_token: 'cursor1',
    ...overrides,
  }
}

function manageDataOp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op2',
    type: 'manage_data',
    name: 'token_TKA',
    created_at: '2024-01-01T00:00:00Z',
    transaction_successful: true,
    transaction_hash: 'txhash2',
    paging_token: 'cursor2',
    ...overrides,
  }
}

function changeTrustOp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op3',
    type: 'change_trust',
    asset_code: 'TKA',
    asset_issuer: 'GISSUER',
    created_at: '2024-01-01T00:00:00Z',
    transaction_successful: true,
    transaction_hash: 'txhash3',
    paging_token: 'cursor3',
    ...overrides,
  }
}

function page(records: unknown[]) {
  return { _embedded: { records } }
}

function mockOk(body: unknown) {
  vi.mocked(global.fetch).mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(body),
  } as Response)
}

function mockErr(status = 500) {
  vi.mocked(global.fetch).mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.resolve({}),
  } as Response)
}

/** Fire the 400 ms debounce and await the resulting fetch chain. */
async function fireDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(400)
    await Promise.resolve()
    await Promise.resolve()
  })
}

// ─── setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn())
  mockConfig.network = 'testnet'
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// ─── tests ───────────────────────────────────────────────────────────────────

describe('useTransactionHistory', () => {
  // ── no publicKey ────────────────────────────────────────────────────────────

  describe('when publicKey is undefined', () => {
    it('returns empty state without fetching', () => {
      const { result } = renderHook(() => useTransactionHistory(undefined))
      expect(result.current.transactions).toEqual([])
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBeNull()
      expect(result.current.hasMore).toBe(true)
      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  // ── network selection ───────────────────────────────────────────────────────

  describe('network selection', () => {
    it('uses the testnet Horizon URL when network is testnet', async () => {
      mockOk(page([paymentOp()]))
      renderHook(() => useTransactionHistory(PUB))
      await fireDebounce()
      expect(vi.mocked(global.fetch).mock.calls[0]![0]).toContain(TESTNET)
    })

    it('uses the mainnet Horizon URL when network is mainnet', async () => {
      mockConfig.network = 'mainnet'
      mockOk(page([paymentOp()]))
      renderHook(() => useTransactionHistory(PUB))
      await fireDebounce()
      expect(vi.mocked(global.fetch).mock.calls[0]![0]).toContain(MAINNET)
    })
  })

  // ── debounce ────────────────────────────────────────────────────────────────

  describe('debounce on publicKey change', () => {
    it('does not fetch before 400 ms have elapsed', () => {
      mockOk(page([]))
      renderHook(() => useTransactionHistory(PUB))
      act(() => {
        vi.advanceTimersByTime(399)
      })
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('cancels an in-flight debounce when publicKey changes rapidly', async () => {
      mockOk(page([]))
      const { rerender } = renderHook(({ k }: { k: string }) => useTransactionHistory(k), {
        initialProps: { k: 'GKEY1' },
      })
      act(() => {
        vi.advanceTimersByTime(200)
      })
      rerender({ k: 'GKEY2' })
      act(() => {
        vi.advanceTimersByTime(200)
      })
      // 200 ms since last key — debounce not yet fired
      expect(global.fetch).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(200)
        await Promise.resolve()
        await Promise.resolve()
      })
      // Exactly one fetch for GKEY2, none for GKEY1
      expect(global.fetch).toHaveBeenCalledTimes(1)
      expect(vi.mocked(global.fetch).mock.calls[0]![0]).toContain('GKEY2')
    })
  })

  // ── basic fetch behaviour ───────────────────────────────────────────────────

  describe('initial fetch', () => {
    it('reflects loading=true during the in-flight request', async () => {
      mockOk(page([paymentOp()]))

      const { result } = renderHook(() => useTransactionHistory(PUB))
      // Fire the debounce timer in a sync act — fetch starts (setLoading(true))
      // but microtasks are NOT flushed yet, so the fetch hasn't resolved
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(result.current.loading).toBe(true)

      // Now flush microtasks to resolve fetch + json, then React flushes
      // the setLoading(false) update
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current.loading).toBe(false)
    })

    it('populates transactions after a successful response', async () => {
      mockOk(page([paymentOp()]))
      const { result } = renderHook(() => useTransactionHistory(PUB))
      await fireDebounce()

      expect(result.current.transactions).toHaveLength(1)
      expect(result.current.transactions[0]).toMatchObject({
        type: 'mint',
        token: 'TKA',
        amount: '100',
        status: 'success',
        hash: 'txhash1',
      })
      expect(result.current.error).toBeNull()
    })

    it('sets hasMore=false when response has fewer records than pageSize', async () => {
      mockOk(page([paymentOp()])) // 1 record < default pageSize 10
      const { result } = renderHook(() => useTransactionHistory(PUB))
      await fireDebounce()
      expect(result.current.hasMore).toBe(false)
    })

    it('sets hasMore=true when response fills the full pageSize', async () => {
      const records = Array.from({ length: 3 }, (_, i) =>
        paymentOp({ id: `op${i}`, paging_token: `c${i}` }),
      )
      mockOk(page(records))
      const { result } = renderHook(() => useTransactionHistory(PUB, { pageSize: 3 }))
      await fireDebounce()
      expect(result.current.hasMore).toBe(true)
    })

    it('sets error on a non-ok HTTP response', async () => {
      mockErr(500)
      const { result } = renderHook(() => useTransactionHistory(PUB))
      await fireDebounce()
      expect(result.current.error).toBe('Failed to fetch transactions')
      expect(result.current.transactions).toHaveLength(0)
    })

    it('sets error on a network failure', async () => {
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error('Network error'))
      const { result } = renderHook(() => useTransactionHistory(PUB))
      await fireDebounce()
      expect(result.current.error).toBe('Network error')
    })
  })

  // ── loadMore / cursor pagination ────────────────────────────────────────────

  describe('loadMore and cursor pagination', () => {
    it('appends page-2 results to the existing list', async () => {
      const p1 = Array.from({ length: 2 }, (_, i) =>
        paymentOp({ id: `p1_${i}`, paging_token: `pt_p1_${i}` }),
      )
      const p2 = [paymentOp({ id: 'p2_0', paging_token: 'pt_p2_0' })]
      mockOk(page(p1))
      mockOk(page(p2))

      const { result } = renderHook(() => useTransactionHistory(PUB, { pageSize: 2 }))
      await fireDebounce()
      expect(result.current.transactions).toHaveLength(2)
      expect(result.current.hasMore).toBe(true)

      await act(async () => {
        result.current.loadMore()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current.transactions).toHaveLength(3)
    })

    it('passes paging_token of last page-1 record as cursor for page-2 request', async () => {
      const p1 = [
        paymentOp({ id: 'op1', paging_token: 'tok_first' }),
        paymentOp({ id: 'op2', paging_token: 'tok_last' }),
      ]
      mockOk(page(p1))
      mockOk(page([]))

      const { result } = renderHook(() => useTransactionHistory(PUB, { pageSize: 2 }))
      await fireDebounce()

      await act(async () => {
        result.current.loadMore()
        await Promise.resolve()
        await Promise.resolve()
      })

      const secondUrl = vi.mocked(global.fetch).mock.calls[1]![0] as string
      expect(secondUrl).toContain('cursor=tok_last')
    })

    it('first-page request always uses an empty cursor', async () => {
      mockOk(page([paymentOp()]))
      renderHook(() => useTransactionHistory(PUB))
      await fireDebounce()
      const firstUrl = vi.mocked(global.fetch).mock.calls[0]![0] as string
      expect(firstUrl).toContain('cursor=')
      // cursor param is present but empty (reset path)
      expect(firstUrl).toMatch(/cursor=$/)
    })

    it('ignores loadMore calls while a fetch is already loading', async () => {
      const p1 = Array.from({ length: 2 }, (_, i) =>
        paymentOp({ id: `op${i}`, paging_token: `c${i}` }),
      )
      mockOk(page(p1))
      const { result } = renderHook(() => useTransactionHistory(PUB, { pageSize: 2 }))
      // Advance timer to trigger fetch but don't await completion
      act(() => {
        vi.advanceTimersByTime(400)
      })
      // loading=true here — loadMore must be a no-op
      act(() => {
        result.current.loadMore()
      })
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })
  })

  // ── cache ───────────────────────────────────────────────────────────────────

  describe('in-memory cache', () => {
    it('serves a cache hit without a second network request', async () => {
      mockOk(page([paymentOp()]))
      mockOk(page([paymentOp({ id: 'op_b' })]))

      const { rerender } = renderHook(({ k }: { k: string }) => useTransactionHistory(k), {
        initialProps: { k: 'KEY_A' },
      })
      await fireDebounce() // fetches KEY_A — fetch count: 1

      rerender({ k: 'KEY_B' })
      await fireDebounce() // fetches KEY_B — fetch count: 2

      rerender({ k: 'KEY_A' })
      await fireDebounce() // KEY_A is cached — must NOT call fetch again
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('busts the cache when assetCodes filter changes for the same publicKey', async () => {
      mockOk(page([paymentOp()]))
      mockOk(page([paymentOp()]))

      const { rerender } = renderHook(
        ({ opts }: { opts: Parameters<typeof useTransactionHistory>[1] }) =>
          useTransactionHistory(PUB, opts),
        { initialProps: { opts: {} } },
      )
      await fireDebounce()
      expect(global.fetch).toHaveBeenCalledTimes(1)

      // Changing options triggers a re-fetch because the debounce effect
      // now depends on filterKey as well as publicKey
      rerender({ opts: { assetCodes: ['TKA'] } })
      await fireDebounce()
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })
  })

  // ── parseOperation ──────────────────────────────────────────────────────────

  describe('parseOperation type mapping', () => {
    async function fetchSingle(op: unknown) {
      mockOk(page([op]))
      const { result } = renderHook(() => useTransactionHistory(PUB))
      await fireDebounce()
      return result.current.transactions
    }

    it('manage_data with "token" in name → type=create', async () => {
      const txns = await fetchSingle(manageDataOp())
      expect(txns).toHaveLength(1)
      expect(txns[0]).toMatchObject({ type: 'create', token: 'token_TKA' })
    })

    it('payment with positive amount → type=mint', async () => {
      const txns = await fetchSingle(paymentOp({ amount: '50' }))
      expect(txns[0]).toMatchObject({ type: 'mint', token: 'TKA', amount: '50' })
    })

    it('payment with negative amount → type=burn', async () => {
      const txns = await fetchSingle(paymentOp({ amount: '-25' }))
      expect(txns[0]).toMatchObject({ type: 'burn', token: 'TKA', amount: '-25' })
    })

    it('change_trust → type=create', async () => {
      const txns = await fetchSingle(changeTrustOp())
      expect(txns[0]).toMatchObject({ type: 'create', token: 'TKA' })
    })

    it('unknown operation type is filtered out of results', async () => {
      const txns = await fetchSingle({
        id: 'op_x',
        type: 'set_options',
        created_at: '2024-01-01T00:00:00Z',
        transaction_successful: true,
        transaction_hash: 'txhash_x',
        paging_token: 'cursor_x',
      })
      expect(txns).toHaveLength(0)
    })

    it('transaction_successful=false maps to status=failed', async () => {
      const txns = await fetchSingle(paymentOp({ transaction_successful: false }))
      expect(txns[0]!.status).toBe('failed')
    })
  })

  // ── filter options ──────────────────────────────────────────────────────────

  describe('filter options applied to parsed operations', () => {
    it('excludes operations whose asset_code is not in assetCodes', async () => {
      mockOk(
        page([
          paymentOp({ asset_code: 'TKA', id: 'op1' }),
          paymentOp({ asset_code: 'TKB', id: 'op2', paging_token: 'c2' }),
        ]),
      )
      const { result } = renderHook(() => useTransactionHistory(PUB, { assetCodes: ['TKB'] }))
      await fireDebounce()
      expect(result.current.transactions).toHaveLength(1)
      expect(result.current.transactions[0]!.token).toBe('TKB')
    })

    it('excludes operations whose asset_issuer does not match issuer filter', async () => {
      mockOk(
        page([
          paymentOp({ asset_issuer: 'GISSUER_MATCH', id: 'op1' }),
          paymentOp({ asset_issuer: 'GISSUER_OTHER', id: 'op2', paging_token: 'c2' }),
        ]),
      )
      const { result } = renderHook(() => useTransactionHistory(PUB, { issuer: 'GISSUER_MATCH' }))
      await fireDebounce()
      expect(result.current.transactions).toHaveLength(1)
    })
  })
})
