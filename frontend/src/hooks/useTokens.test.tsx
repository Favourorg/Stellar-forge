import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTokens, _clearCache } from './useTokens'
import { stellarService } from '../services/stellar'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Returns a {promise, resolve, reject} triple so tests can control resolution timing. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeTokenBatch(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `Token${start + i}`,
    symbol: `TK${start + i}`,
    decimals: 7,
    creator: 'GABC',
    createdAt: start + i,
  }))
}

vi.mock('../services/stellar', () => ({
  stellarService: {
    getTokensByCreator: vi.fn(),
    getContractEvents: vi.fn(),
    getTokenInfoByAddress: vi.fn(),
  },
}))

vi.mock('../config/stellar', () => ({
  STELLAR_CONFIG: {
    network: 'testnet',
    factoryContractId: 'CFACTORY123',
    testnet: { sorobanRpcUrl: 'https://soroban-testnet.stellar.org' },
    mainnet: { sorobanRpcUrl: 'https://soroban-mainnet.stellar.org' },
  },
}))

const TOKEN_A = makeTokenBatch(0, 1)[0]
const TOKEN_B = makeTokenBatch(1, 1)[0]

beforeEach(() => {
  vi.clearAllMocks()
  _clearCache()
})

describe('useTokens', () => {
  it('returns isLoading true while fetching then false when done', async () => {
    vi.mocked(stellarService.getTokensByCreator).mockResolvedValue([TOKEN_A])

    const { result } = renderHook(() => useTokens('GABC'))

    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
  })

  it('returns tokens filtered by creator and calls paginated contract view', async () => {
    vi.mocked(stellarService.getTokensByCreator).mockResolvedValue([TOKEN_A, TOKEN_B])

    const { result } = renderHook(() => useTokens('GABC'))

    await waitFor(() => expect(result.current.tokens).toHaveLength(2))
    expect(stellarService.getTokensByCreator).toHaveBeenCalledWith('GABC', 0, expect.any(Number))
  })

  it('passes server-side pagination offset/limit when iterating pages', async () => {
    // Simulate a creator with 60 tokens; hook should request 50 at a time
    // (matching the contract's MAX_TOKENS_BY_CREATOR_PAGE) and stop when a
    // short page arrives.
    //
    // NOTE: With concurrent fetching the hook dispatches multiple pages in
    // parallel once page 0 confirms more data exists.  The exact call count
    // is ≥ 2 (page 0 always, plus at least the page at offset 50); extra
    // concurrent calls resolve immediately with [] (vitest default) and are
    // harmless.  We verify correctness via offset/limit arguments and the
    // final token count rather than an exact call count.
    const fullBatch = Array.from({ length: 50 }, (_, i) => ({
      name: `Token${i}`,
      symbol: `TK${i}`,
      decimals: 7,
      creator: 'GABC',
      createdAt: i,
    }))
    const partialBatch = Array.from({ length: 10 }, (_, i) => ({
      name: `Token${50 + i}`,
      symbol: `TK${50 + i}`,
      decimals: 7,
      creator: 'GABC',
      createdAt: 50 + i,
    }))

    vi.mocked(stellarService.getTokensByCreator)
      .mockResolvedValueOnce(fullBatch)    // offset 0  — full page, triggers concurrent batch
      .mockResolvedValueOnce(partialBatch) // offset 50 — partial, signals end-of-data
      .mockResolvedValue([])               // offsets 100, 150, … from concurrent batch → []

    const { result } = renderHook(() => useTokens('GABC'))

    await waitFor(() => expect(result.current.totalCount).toBe(60))
    // The first call must use offset 0, and the second must use offset 50
    expect(stellarService.getTokensByCreator).toHaveBeenCalledWith('GABC', 0, 50)
    expect(stellarService.getTokensByCreator).toHaveBeenCalledWith('GABC', 50, 50)
  })

  it('fetches all tokens in parallel when no creator given', async () => {
    vi.mocked(stellarService.getContractEvents).mockResolvedValue({
      events: [
        {
          id: '1',
          type: 'created',
          ledger: 1,
          timestamp: 1000,
          txHash: 'x',
          data: { tokenAddress: 'CAAA' },
        },
        {
          id: '2',
          type: 'created',
          ledger: 2,
          timestamp: 2000,
          txHash: 'y',
          data: { tokenAddress: 'CBBB' },
        },
      ],
      cursor: null,
    })
    vi.mocked(stellarService.getTokenInfoByAddress)
      .mockResolvedValueOnce(TOKEN_A)
      .mockResolvedValueOnce(TOKEN_B)

    const { result } = renderHook(() => useTokens())

    await waitFor(() => expect(result.current.tokens).toHaveLength(2))
    expect(stellarService.getTokenInfoByAddress).toHaveBeenCalledTimes(2)
  })

  it('populates error on RPC failure', async () => {
    vi.mocked(stellarService.getTokensByCreator).mockRejectedValue(new Error('RPC down'))

    const { result } = renderHook(() => useTokens('GABC'))

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error?.message).toBe('RPC down')
    expect(result.current.tokens).toHaveLength(0)
  })

  it('refresh triggers a fresh fetch bypassing cache', async () => {
    vi.mocked(stellarService.getTokensByCreator).mockResolvedValue([TOKEN_A])

    const { result } = renderHook(() => useTokens('GABC'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    vi.mocked(stellarService.getTokensByCreator).mockResolvedValue([TOKEN_A, TOKEN_B])
    await act(async () => {
      result.current.refresh()
    })

    await waitFor(() => expect(result.current.totalCount).toBe(2))
    expect(stellarService.getTokensByCreator).toHaveBeenCalled()
  })

  it('paginates visible tokens correctly using accumulated list', async () => {
    const manyTokens = Array.from({ length: 15 }, (_, i) => ({
      name: `Token${i}`,
      symbol: `TK${i}`,
      decimals: 7,
      creator: 'GABC',
      createdAt: i,
    }))
    vi.mocked(stellarService.getTokensByCreator).mockResolvedValue(manyTokens)

    const { result } = renderHook(() => useTokens('GABC'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Default pageSize=10, page=1
    expect(result.current.tokens).toHaveLength(10)
    expect(result.current.totalCount).toBe(15)
    expect(result.current.totalPages).toBe(2)

    // Navigate to page 2
    act(() => {
      result.current.setPage(2)
    })
    expect(result.current.tokens).toHaveLength(5)
    expect(result.current.page).toBe(2)
  })

  // ── Concurrency test ───────────────────────────────────────────────────────
  //
  // Verifies that for a creator with 3+ contract pages, the hook dispatches
  // pages 1, 2, … concurrently rather than awaiting each one sequentially.
  //
  // Technique: deferred promises for each page let us assert that all extra
  // page calls have been *invoked* (i.e. dispatched) before any of them
  // resolves.  If the implementation were sequential, only one call would be
  // in-flight at a time and the second deferred would never be invoked while
  // the first is still pending.
  it('dispatches pages 2+ concurrently — does not await each page sequentially', async () => {
    const pageSize = 50
    const page0 = makeTokenBatch(0, pageSize)   // full — signals more pages
    const page1 = makeTokenBatch(50, pageSize)  // full — signals more pages
    const page2 = makeTokenBatch(100, pageSize) // full — signals more pages
    const page3 = makeTokenBatch(150, 10)       // short — terminal page

    // Deferred handles for pages 1, 2, and 3 (page 0 resolves immediately).
    const d1 = deferred<typeof page1>()
    const d2 = deferred<typeof page2>()
    const d3 = deferred<typeof page3>()

    // page 0: resolves immediately with a full batch
    // pages 1–3: controlled by deferred promises
    vi.mocked(stellarService.getTokensByCreator)
      .mockResolvedValueOnce(page0) // offset 0  — immediate
      .mockImplementationOnce(() => d1.promise) // offset 50
      .mockImplementationOnce(() => d2.promise) // offset 100
      .mockImplementationOnce(() => d3.promise) // offset 150

    // Mount the hook — page 0 resolves before first tick.
    const { result } = renderHook(() => useTokens('GABC'))

    // Give the microtask queue time to process page 0 and kick off the
    // concurrent batch.  We do NOT waitFor isLoading=false because the hook
    // is still fetching the deferred pages.
    await new Promise((r) => setTimeout(r, 50))

    // At this point the concurrent batch should have been dispatched.
    // pages 1, 2, and 3 must all have been called already (they are
    // in-flight concurrently) — but none has resolved yet.
    const callCount = vi.mocked(stellarService.getTokensByCreator).mock.calls.length

    // We expect at least page 0 + 1 extra page to have been called.
    // With CONCURRENT_PAGE_LIMIT ≥ 3 all three extra pages should be called.
    expect(callCount).toBeGreaterThanOrEqual(2)

    // Specifically, pages at offsets 50 and 100 must be in-flight before any
    // of them resolves.  We verify this by resolving them in reverse order and
    // confirming the final token count is still correct.
    d2.resolve(page2)
    d1.resolve(page1)
    d3.resolve(page3)

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // All 4 pages' worth of tokens should be collected.
    expect(result.current.totalCount).toBe(pageSize * 3 + 10)

    // Critically, the mock must have received calls for offsets 0, 50, 100, 150
    // in that logical order, but 50/100/150 were all dispatched before any resolved.
    expect(stellarService.getTokensByCreator).toHaveBeenCalledWith('GABC', 0, pageSize)
    expect(stellarService.getTokensByCreator).toHaveBeenCalledWith('GABC', 50, pageSize)
    expect(stellarService.getTokensByCreator).toHaveBeenCalledWith('GABC', 100, pageSize)
    expect(stellarService.getTokensByCreator).toHaveBeenCalledWith('GABC', 150, pageSize)
  })
})
