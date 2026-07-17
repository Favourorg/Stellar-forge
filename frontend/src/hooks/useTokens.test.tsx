import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTokens, _clearCache } from './useTokens'
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

  // Regression test: a single fixed-size getContractEvents() call silently
  // drops any `created` events beyond the page limit. This asserts the "all
  // tokens" path pages through the full event history via the returned
  // cursor instead, so every token is still found once the factory has
  // emitted more than one page's worth of events.
  it('pages through the full event history when there are more than one page of created events', async () => {
    const makeEvent = (i: number) => ({
      id: String(i),
      type: 'created' as const,
      ledger: i,
      timestamp: i,
      txHash: `tx${i}`,
      data: { tokenAddress: `CADDR${i}` },
    })
    const page1 = Array.from({ length: 100 }, (_, i) => makeEvent(i))
    const page2 = Array.from({ length: 20 }, (_, i) => makeEvent(100 + i))

    vi.mocked(stellarService.getContractEvents)
      .mockResolvedValueOnce({ events: page1, cursor: 'cursor-1' })
      .mockResolvedValueOnce({ events: page2, cursor: 'cursor-2' })
    vi.mocked(stellarService.getTokenInfoByAddress).mockImplementation((addr: string) =>
      Promise.resolve({ ...TOKEN_A, name: addr }),
    )

    const { result } = renderHook(() => useTokens())

    await waitFor(() => expect(result.current.totalCount).toBe(120))
    expect(stellarService.getContractEvents).toHaveBeenCalledTimes(2)
    expect(stellarService.getContractEvents).toHaveBeenNthCalledWith(1, 'CFACTORY123', 100, undefined)
    expect(stellarService.getContractEvents).toHaveBeenNthCalledWith(
      2,
      'CFACTORY123',
      100,
      'cursor-1',
    )
    expect(stellarService.getTokenInfoByAddress).toHaveBeenCalledTimes(120)
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
