import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { stellarService } from '../services/stellar'
import { STELLAR_CONFIG } from '../config/stellar'
import type { TokenInfo } from '../types'

// ── Module-level cache keyed by creator address ('' = all tokens) ─────────────
// Shared across all hook instances — any component mounting within the TTL
// window reuses the same result without an extra network round-trip.
//
// LRU eviction: JavaScript's Map preserves insertion order, so we implement
// LRU by deleting and re-inserting a key on every read or write (moving it
// to the "most-recently-used" tail). When the map exceeds CACHE_MAX_SIZE the
// first (oldest / least-recently-used) entry is evicted. This caps memory
// use regardless of how many distinct creator addresses are queried in a
// long-lived session (e.g. the Token Explorer browsing hundreds of creators).

const CACHE_TTL_MS = 30_000
/** Maximum number of creator-keyed entries kept in memory at one time. */
export const CACHE_MAX_SIZE = 50

interface CacheEntry {
  tokens: TokenInfo[]
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Read an entry and promote it to most-recently-used.
 * Returns undefined on a cache miss.
 */
function cacheGet(key: string): CacheEntry | undefined {
  const entry = cache.get(key)
  if (entry === undefined) return undefined
  // Re-insert to move to tail (most-recently-used position).
  cache.delete(key)
  cache.set(key, entry)
  return entry
}

/**
 * Write an entry, promote it to MRU, and evict the LRU entry when the cap
 * is exceeded.
 */
function cacheSet(key: string, entry: CacheEntry): void {
  // Delete first so a re-write moves the key to the tail.
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size > CACHE_MAX_SIZE) {
    // The first key in iteration order is the least-recently-used one.
    const lruKey = cache.keys().next().value
    if (lruKey !== undefined) {
      cache.delete(lruKey)
    }
  }
}

/** Exposed for testing only */
export function _clearCache() {
  cache.clear()
}

// ── Paginated token fetcher ────────────────────────────────────────────────────
//
// The contract's `get_tokens_by_creator(env, creator, offset, limit)` view
// function caps responses at MAX_TOKENS_BY_CREATOR_PAGE per call to avoid
// exceeding Stellar ledger entry size limits on mainnet. This helper
// iterates the contract page-by-page until the returned slice is shorter
// than the requested page size (which signals end-of-data).

async function fetchAllTokensByCreator(creator: string): Promise<TokenInfo[]> {
  if (!STELLAR_CONFIG.factoryContractId) {
    throw new Error('VITE_FACTORY_CONTRACT_ID is not configured')
  }

  // Mirror the contract's per-page cap so successive calls advance correctly.
  const pageSize = 50
  const collected: TokenInfo[] = []
  let offset = 0
  // Hard upper bound to prevent infinite loops if the contract ever returns
  // a "full" page beyond the actual total (defensive only — contract
  // guarantees it returns < limit when the offset reaches the end).
  const maxPages = 10_000

  for (let page = 0; page < maxPages; page++) {
    const slice = await stellarService.getTokensByCreator(creator, offset, pageSize)
    collected.push(...slice)
    if (slice.length < pageSize) break
    offset += slice.length
  }

  return collected
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UseTokensResult {
  /** Tokens for the current page (1-based) */
  tokens: TokenInfo[]
  /**
   * Accumulated tokens across all fetched pages. Kept on the result shape
   * for backward-compatibility with code that consumed the previous client-
   * side pagination API; in the new server-paginated implementation this is
   * the same value backing `tokens`.
   */
  allTokens: TokenInfo[]
  isLoading: boolean
  error: Error | null
  /** Current 1-based page number */
  page: number
  pageSize: number
  totalCount: number
  totalPages: number
  setPage: (page: number) => void
  setPageSize: (size: number) => void
  /** Bypass cache and re-fetch from the contract */
  refresh: () => void
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useTokens(creator?: string): UseTokensResult {
  const cacheKey = creator ?? ''

  const [tokens, setTokens] = useState<TokenInfo[]>(() => cacheGet(cacheKey)?.tokens ?? [])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [page, setPageRaw] = useState(1)
  const [pageSize, setPageSizeRaw] = useState(10)

  // Prevent duplicate in-flight requests when multiple components mount at once
  const fetchingRef = useRef(false)

  const load = useCallback(
    async (bypassCache: boolean) => {
      const now = Date.now()
      const hit = cacheGet(cacheKey)

      if (!bypassCache && hit && now - hit.fetchedAt < CACHE_TTL_MS) {
        setTokens(hit.tokens)
        return
      }

      if (fetchingRef.current) return
      fetchingRef.current = true

      setIsLoading(true)
      setError(null)

      try {
        let result: TokenInfo[]
        if (creator) {
          result = await fetchAllTokensByCreator(creator)
        } else {
          result = await fetchAllTokens()
        }
        cacheSet(cacheKey, { tokens: result, fetchedAt: Date.now() })
        setTokens(result)
        // Reset to first page whenever data is refreshed
        setPageRaw(1)
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)))
      } finally {
        setIsLoading(false)
        fetchingRef.current = false
      }
    },
    [cacheKey, creator],
  )

  useEffect(() => {
    load(false)
  }, [load])

  const refresh = useCallback(() => load(true), [load])

  const totalCount = tokens.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const setPage = useCallback(
    (p: number) => setPageRaw(Math.min(Math.max(1, p), totalPages)),
    [totalPages],
  )

  const setPageSize = useCallback((size: number) => {
    setPageSizeRaw(Math.max(1, size))
    setPageRaw(1)
  }, [])

  // Slice the accumulated list to the current page. Because the contract call
  // is paginated server-side via offset/limit but the hook iterates fully to
  // populate this list, page navigation stays cheap and snappy.
  const visible = useMemo(() => {
    const start = (page - 1) * pageSize
    return tokens.slice(start, start + pageSize)
  }, [tokens, page, pageSize])

  return {
    tokens: visible,
    allTokens: tokens,
    isLoading,
    error,
    page,
    pageSize,
    totalCount,
    totalPages,
    setPage,
    setPageSize,
    refresh,
  }
}

// ── Fallback "all tokens" fetcher (kept from the original hook) ──────────────

async function fetchAllTokens(): Promise<TokenInfo[]> {
  const contractId = STELLAR_CONFIG.factoryContractId
  if (!contractId) throw new Error('VITE_FACTORY_CONTRACT_ID is not configured')

  const { events } = await stellarService.getContractEvents(contractId, 100)
  const addresses = [
    ...new Set(
      events
        .filter((e) => e.type === 'created')
        .map((e) => e.data.tokenAddress)
        .filter((addr): addr is string => !!addr),
    ),
  ]

  const results = await Promise.allSettled(
    addresses.map((addr) => stellarService.getTokenInfoByAddress(addr)),
  )

  return results
    .filter((r): r is PromiseFulfilledResult<TokenInfo> => r.status === 'fulfilled')
    .map((r) => r.value)
}
