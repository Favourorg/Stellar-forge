import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTokens, _clearCache, CACHE_MAX_SIZE } from './useTokens'
import { stellarService } from '../services/stellar'

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

const TOKEN_A = { name: 'TokenA', symbol: 'TKA', decimals: 7, creator: 'GABC', createdAt: 1000 }
const TOKEN_B = { name: 'TokenB', symbol: 'TKB', decimals: 7, creator: 'GABC', createdAt: 2000 }

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
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce(partialBatch)

    const { result } = renderHook(() => useTokens('GABC'))

    await waitFor(() => expect(result.current.totalCount).toBe(60))
    expect(stellarService.getTokensByCreator).toHaveBeenCalledTimes(2)
    expect(stellarService.getTokensByCreator).toHaveBeenNthCalledWith(1, 'GABC', 0, 50)
    expect(stellarService.getTokensByCreator).toHaveBeenNthCalledWith(2, 'GABC', 50, 50)
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
})

// ── LRU eviction tests ────────────────────────────────────────────────────────

describe('useTokens LRU cache eviction', () => {
  it('CACHE_MAX_SIZE is 50', () => {
    expect(CACHE_MAX_SIZE).toBe(50)
  })

  it('never stores more than CACHE_MAX_SIZE entries regardless of how many creators are queried', async () => {
    // Populate the cache with CACHE_MAX_SIZE + 10 distinct creator addresses
    // by rendering the hook once per creator and waiting for it to settle.
    const total = CACHE_MAX_SIZE + 10

    for (let i = 0; i < total; i++) {
      const creator = `GCREATOR${i.toString().padStart(4, '0')}`
      vi.mocked(stellarService.getTokensByCreator).mockResolvedValue([
        { name: `Token${i}`, symbol: `TK${i}`, decimals: 7, creator, createdAt: i },
      ])
      const { result, unmount } = renderHook(() => useTokens(creator))
      await waitFor(() => expect(result.current.isLoading).toBe(false))
      unmount()
    }

    // Import the internal cache size via a fresh render using a sentinel key
    // that is guaranteed to already be in the cache (the last written entry).
    // We verify the cap indirectly by checking that a cache hit still occurs
    // for the most-recently-used entry and that a cache miss occurs for the
    // oldest entry — which proves the LRU bound is enforced.

    // The last-written creator should be a cache hit (no extra RPC call).
    const lastCreator = `GCREATOR${(total - 1).toString().padStart(4, '0')}`
    vi.mocked(stellarService.getTokensByCreator).mockClear()
    const { result: lastResult, unmount: unmountLast } = renderHook(() => useTokens(lastCreator))
    await waitFor(() => expect(lastResult.current.isLoading).toBe(false))
    // No new RPC call — served from cache
    expect(stellarService.getTokensByCreator).not.toHaveBeenCalled()
    unmountLast()

    // The very first creator should have been evicted (LRU) — a new RPC call
    // is required to serve it.
    const firstCreator = 'GCREATOR0000'
    vi.mocked(stellarService.getTokensByCreator).mockResolvedValue([TOKEN_A])
    vi.mocked(stellarService.getTokensByCreator).mockClear()
    const { result: firstResult, unmount: unmountFirst } = renderHook(() =>
      useTokens(firstCreator),
    )
    await waitFor(() => expect(firstResult.current.isLoading).toBe(false))
    // Cache miss — RPC was called
    expect(stellarService.getTokensByCreator).toHaveBeenCalledWith(firstCreator, 0, expect.any(Number))
    unmountFirst()
  })

  it('promotes a re-read entry to MRU so it is not evicted before newer entries', async () => {
    // Fill the cache up to the cap with creators 0..CACHE_MAX_SIZE-1.
    for (let i = 0; i < CACHE_MAX_SIZE; i++) {
      const creator = `GREREAD${i.toString().padStart(4, '0')}`
      vi.mocked(stellarService.getTokensByCreator).mockResolvedValue([
        { name: `Token${i}`, symbol: `TK${i}`, decimals: 7, creator, createdAt: i },
      ])
      const { result, unmount } = renderHook(() => useTokens(creator))
      await waitFor(() => expect(result.current.isLoading).toBe(false))
      unmount()
    }

    // Re-read the very first entry (GREREAD0000) to promote it to MRU.
    const promotedCreator = 'GREREAD0000'
    vi.mocked(stellarService.getTokensByCreator).mockClear()
    const { result: promoResult, unmount: unmountPromo } = renderHook(() =>
      useTokens(promotedCreator),
    )
    await waitFor(() => expect(promoResult.current.isLoading).toBe(false))
    // Should be a cache hit since TTL has not elapsed.
    expect(stellarService.getTokensByCreator).not.toHaveBeenCalled()
    unmountPromo()

    // Now add one more creator to push the cap over by 1.
    const overflowCreator = `GREREAD${CACHE_MAX_SIZE.toString().padStart(4, '0')}`
    vi.mocked(stellarService.getTokensByCreator).mockResolvedValue([TOKEN_B])
    const { result: overResult, unmount: unmountOver } = renderHook(() =>
      useTokens(overflowCreator),
    )
    await waitFor(() => expect(overResult.current.isLoading).toBe(false))
    unmountOver()

    // The promoted entry should still be cached (it was MRU, not LRU).
    vi.mocked(stellarService.getTokensByCreator).mockClear()
    const { result: stillCached, unmount: unmountStill } = renderHook(() =>
      useTokens(promotedCreator),
    )
    await waitFor(() => expect(stillCached.current.isLoading).toBe(false))
    expect(stellarService.getTokensByCreator).not.toHaveBeenCalled()
    unmountStill()

    // GREREAD0001 (the LRU after promotion) should have been evicted.
    const evictedCreator = 'GREREAD0001'
    vi.mocked(stellarService.getTokensByCreator).mockResolvedValue([TOKEN_A])
    vi.mocked(stellarService.getTokensByCreator).mockClear()
    const { result: evictedResult, unmount: unmountEvicted } = renderHook(() =>
      useTokens(evictedCreator),
    )
    await waitFor(() => expect(evictedResult.current.isLoading).toBe(false))
    expect(stellarService.getTokensByCreator).toHaveBeenCalledWith(evictedCreator, 0, expect.any(Number))
    unmountEvicted()
  })
})
