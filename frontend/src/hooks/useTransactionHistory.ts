import { useState, useEffect, useCallback, useRef } from 'react'
import { STELLAR_CONFIG } from '../config/stellar'

export type TransactionType = 'create' | 'mint' | 'burn' | 'other'

export interface TransactionHistoryItem {
  id: string
  type: TransactionType
  token: string
  amount: string
  date: string
  status: 'success' | 'failed'
  hash: string
}

interface UseTransactionHistoryOptions {
  assetCodes?: string[] | undefined
  issuer?: string | undefined
  contractIds?: string[] | undefined
  pageSize?: number | undefined
  pollIntervalMs?: number | undefined
}

/** The subset of Horizon's polymorphic operation record shape this hook reads. */
interface HorizonOperationRecord {
  id: string
  type: string
  name?: string
  asset_code?: string
  asset_issuer?: string
  amount?: string
  created_at: string
  transaction_successful: boolean
  transaction_hash: string
  paging_token?: string
}

export function useTransactionHistory(
  publicKey: string | undefined,
  options: UseTransactionHistoryOptions = {},
) {
  const [transactions, setTransactions] = useState<TransactionHistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [page, setPage] = useState(1)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const cacheRef = useRef<{ [key: string]: TransactionHistoryItem[] }>({})
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks the paging_token of the last fetched record for cursor-based pagination
  const cursorRef = useRef<string>('')
  const fetchRef = useRef<(reset?: boolean) => void>(() => {})
  const isMountedRef = useRef(true)
  const pageRef = useRef(page)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const pageSize = options.pageSize || 10
  const pollIntervalMs = options.pollIntervalMs ?? 30_000

  // Stable string key derived from filter values so the cache is filter-aware
  const filterKey = JSON.stringify({
    assetCodes: options.assetCodes ? [...options.assetCodes].sort() : null,
    issuer: options.issuer ?? null,
    contractIds: options.contractIds ? [...options.contractIds].sort() : null,
  })

  const fetchTransactions = useCallback(
    async (reset = false) => {
      if (!publicKey) return
      setLoading(true)
      setError(null)
      try {
        const cacheKey = `${publicKey}-${page}-${filterKey}`
        const cached = cacheRef.current[cacheKey]
        if (cached) {
          setTransactions((prev: TransactionHistoryItem[]) =>
            reset ? cached : [...prev, ...cached],
          )
          setHasMore(cached.length === pageSize)
          setLoading(false)
          return
        }
        const network = STELLAR_CONFIG.network as 'testnet' | 'mainnet'
        const { horizonUrl } = STELLAR_CONFIG[network]
        const cursor = reset ? '' : cursorRef.current
        const url = `${horizonUrl}/accounts/${publicKey}/operations?order=desc&limit=${pageSize}&cursor=${cursor}`
        const resp = await fetch(url)
        if (!resp.ok) throw new Error('Failed to fetch transactions')
        const data = await resp.json()
        const records: HorizonOperationRecord[] = data._embedded?.records ?? []
        const items: TransactionHistoryItem[] = records
          .map((op: HorizonOperationRecord) => parseOperation(op, options))
          .filter((item): item is TransactionHistoryItem => item !== null)
        if (records.length > 0) {
          cursorRef.current = records[records.length - 1]!.paging_token ?? ''
        }
        cacheRef.current[cacheKey] = items
        setTransactions((prev: TransactionHistoryItem[]) => (reset ? items : [...prev, ...items]))
        setHasMore(items.length === pageSize)
        setLastUpdated(new Date())
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicKey, page, pageSize, filterKey],
  )

  useEffect(() => {
    fetchRef.current = fetchTransactions
  }, [fetchTransactions])

  useEffect(() => {
    pageRef.current = page
  }, [page])

  // Debounce re-fetch when publicKey or filter options change
  useEffect(() => {
    if (!publicKey) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      cursorRef.current = ''
      setPage(1)
      setTransactions([])
      fetchRef.current(true)
    }, 400)
  }, [publicKey, filterKey])

  // Fetch on page change
  useEffect(() => {
    if (page === 1) return
    fetchRef.current()
  }, [page])

  // Polling: re-fetch the first page every pollIntervalMs
  useEffect(() => {
    isMountedRef.current = true
    const id = setInterval(() => {
      if (!publicKey || !isMountedRef.current) return
      if (pageRef.current === 1) {
        cacheRef.current = {}
        fetchRef.current(true)
      }
    }, pollIntervalMs)
    pollRef.current = id
    return () => {
      isMountedRef.current = false
      clearInterval(id)
    }
  }, [publicKey, pollIntervalMs])

  const loadMore = useCallback(() => {
    if (!loading && hasMore) setPage((p: number) => p + 1)
  }, [loading, hasMore])

  const refresh = useCallback(() => {
    cacheRef.current = {}
    setPage(1)
    setTransactions([])
    fetchRef.current(true)
  }, [])

  return { transactions, loading, error, hasMore, loadMore, lastUpdated, refresh }
}

function parseOperation(
  op: HorizonOperationRecord,
  options: UseTransactionHistoryOptions,
): TransactionHistoryItem | null {
  let type: TransactionType = 'other'
  let token = ''
  let amount = ''
  if (op.type === 'manage_data' && op.name && op.name.toLowerCase().includes('token')) {
    type = 'create'
    token = op.name
  } else if (op.type === 'payment' && op.asset_code && op.amount) {
    if (Number(op.amount) > 0) {
      type = 'mint'
      token = op.asset_code
      amount = op.amount
    } else if (Number(op.amount) < 0) {
      type = 'burn'
      token = op.asset_code
      amount = op.amount
    }
  } else if (op.type === 'change_trust' && op.asset_code) {
    type = 'create'
    token = op.asset_code
  }
  // Optionally filter by assetCodes, issuer, contractIds
  if (options.assetCodes && token && !options.assetCodes.includes(token)) return null
  if (options.issuer && op.asset_issuer && op.asset_issuer !== options.issuer) return null
  if (type === 'other') return null
  return {
    id: op.id,
    type,
    token,
    amount: amount || op.amount || '',
    date: op.created_at,
    status: op.transaction_successful ? 'success' : 'failed',
    hash: op.transaction_hash,
  }
}
