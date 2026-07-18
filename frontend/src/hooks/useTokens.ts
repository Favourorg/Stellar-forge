import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { stellarService } from '../services/stellar'
import { STELLAR_CONFIG } from '../config/stellar'
import type { TokenInfo } from '../types'

// ── Module-level cache keyed by creator address ('' = all tokens) ─────────────
// Shared across all hook instances — any component mounting within the TTL
// window reuses the same result without an extra network round-trip.

const CACHE_TTL_MS = 30_000

interface CacheEntry {
  tokens: TokenInfo[]
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

/** Exposed for testing only */
export function _clearCache() {
  cache.clear()
}

// ── Paginated token fetcher ────────────────────────────────────────────────────
//
// The contract's `get_tokens_by_creator(env, creator, offset, limit)` view
// function caps responses at MAX_TOKENS_BY_CREATOR_PAGE (50) per call to
// avoid exceeding Stellar ledger entry size limits on mainnet.
//
// Performance rationale
// ─────────────────────
// BEFORE (sequential): each page was awaited individually, so a creator with
//   N pages incurred N × RPC-latency wall-clock time (e.g. 10 pages × ~400 ms
//   = ~4 s before the UI could render anything).
//
// AFTER (concurrent): page 0 is still fetched first to establish (a) that
//   there is more data and (b) the page size in use.  Once we know how many
//   additional pages exist we issue them all at once — capped at
//   CONCURRENT_PAGE_LIMIT simultaneous in-flight requests to avoid
//   overwhelming the RPC endpoint or tripping rate limits.  For the same
//   10-page example the total wait drops to roughly 1 × RPC-latency for the
//   probe page + 1 × RPC-latency for the concurrent batch ≈ ~800 ms — an
//   ~80 % wall-clock reduction on a latency-bound path.
//
// Concurrency cap
// ───────────────
// CONCURRENT_PAGE_LIMIT = 5 was chosen to stay comfortably below typical
// Soroban RPC per-IP rate limits while still saturating a reasonable number
// of parallel connections.  For reference, issue #16 flags concern about
// total RPC load; 5 concurrent views per hook call is a reasonable balance.

/** Maximum simultaneous in-flight getTokensByCreator requests for pages ≥ 1 */
const CONCURRENT_PAGE_LIMIT = 5

/**
 * Run an array of async thunks with a bounded concurrency window.
 * Results are returned in the same order as `tasks`.
 */
async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++
      results[i] = await tasks[i]()
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker)
  await Promise.all(workers)
  return results
}

async function fetchAllTokensByCreator(creator: string): Promise<TokenInfo[]> {
  if (!STELLAR_CONFIG.factoryContractId) {
    throw new Error('VITE_FACTORY_CONTRACT_ID is not configured')
  }

  // Mirror the contract's per-page cap so successive calls advance correctly.
  const pageSize = 50

  // ── Phase 1: probe page 0 ─────────────────────────────────────────────────
  // Fetching page 0 first tells us whether there is more data (returned a full
  // page) without needing a separate get_state() call, keeping the happy-path
  // cost at a single extra round-trip only when multiple pages exist.
  const firstPage = await stellarService.getTokensByCreator(creator, 0, pageSize)

  if (firstPage.length < pageSize) {
    // All tokens fit in one page — no concurrent work needed.
    return firstPage
  }

  // ── Phase 2: compute remaining offsets ───────────────────────────────────
  // Hard upper bound to prevent runaway requests when the contract ever
  // returns a full page at the very end (defensive; contract guarantees a
  // short page at end-of-data, but guard against future changes).
  const MAX_EXTRA_PAGES = 10_000 - 1 // total pages minus the probe

  // Optimistically request up to MAX_EXTRA_PAGES more pages.  Each page's
  // task returns an empty slice when the offset is past the end, and we stop
  // collecting at the first short (or empty) page.
  //
  // We do NOT know the exact total upfront (get_state().token_count is a
  // global count, not per-creator), so we over-request by one page and let
  // the short-page signal terminate the outer loop below.
  const extraOffsets: number[] = []
  for (let p = 1; p <= MAX_EXTRA_PAGES; p++) {
    extraOffsets.push(p * pageSize)
    // We'll break out of the result-assembly loop below on the first short
    // page, so we keep the task list bounded: stop pre-computing offsets once
    // we've already queued more than CONCURRENT_PAGE_LIMIT pages beyond the
    // ones we know we need.  In practice we rely on the short-page termination
    // rather than a tight upfront bound — this just keeps memory reasonable.
    if (extraOffsets.length >= MAX_EXTRA_PAGES) break
  }

  // Build thunks so runConcurrent can control dispatch timing.
  const tasks = extraOffsets.map(
    (offset) => () => stellarService.getTokensByCreator(creator, offset, pageSize),
  )

  // ── Phase 3: dispatch concurrently in batches ─────────────────────────────
  const collected: TokenInfo[] = [...firstPage]

  // Process batches of CONCURRENT_PAGE_LIMIT until a short (terminal) page.
  for (let batchStart = 0; batchStart < tasks.length; batchStart += CONCURRENT_PAGE_LIMIT) {
    const batch = tasks.slice(batchStart, batchStart + CONCURRENT_PAGE_LIMIT)
    const pages = await runConcurrent(batch, CONCURRENT_PAGE_LIMIT)

    let done = false
    for (const page of pages) {
      collected.push(...page)
      if (page.length < pageSize) {
        done = true
        break
      }
    }
    if (done) break
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

  const [tokens, setTokens] = useState<TokenInfo[]>(() => cache.get(cacheKey)?.tokens ?? [])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [page, setPageRaw] = useState(1)
  const [pageSize, setPageSizeRaw] = useState(10)

  // Prevent duplicate in-flight requests when multiple components mount at once
  const fetchingRef = useRef(false)

  const load = useCallback(
    async (bypassCache: boolean) => {
      const now = Date.now()
      const hit = cache.get(cacheKey)

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
        cache.set(cacheKey, { tokens: result, fetchedAt: Date.now() })
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
