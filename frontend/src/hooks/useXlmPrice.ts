import { useEffect, useState } from 'react'

/** CoinGecko price cache — shared across all hook instances */
let cachedPrice: number | null = null
let cachedAt = 0
const CACHE_TTL = 60_000 // 60 seconds
let pendingFetch: Promise<number> | null = null

async function fetchXlmUsdPrice(): Promise<number> {
  const now = Date.now()
  if (cachedPrice !== null && now - cachedAt < CACHE_TTL) {
    return cachedPrice
  }
  if (pendingFetch) return pendingFetch

  pendingFetch = fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd',
    { signal: AbortSignal.timeout(5000) },
  )
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    })
    .then((data) => {
      const price = data?.stellar?.usd ?? null
      if (price === null) throw new Error('No price in response')
      cachedPrice = price
      cachedAt = Date.now()
      pendingFetch = null
      return price
    })
    .catch((err) => {
      pendingFetch = null
      throw err
    })

  return pendingFetch
}

export interface XlmPriceResult {
  /** USD price per XLM, or null if loading / unavailable */
  price: number | null
  /** true when the price fetch is in flight */
  loading: boolean
  /** true when the price fetch failed and we fell back to hidden */
  unavailable: boolean
}

export function useXlmPrice(): XlmPriceResult {
  const [price, setPrice] = useState<number | null>(cachedPrice)
  const [loading, setLoading] = useState(!cachedPrice)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let cancelled = false

    if (cachedPrice !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing state from the module-level price cache
      setPrice(cachedPrice)
      setLoading(false)
      setUnavailable(false)
      return
    }

    setLoading(true)
    fetchXlmUsdPrice()
      .then((p) => {
        if (!cancelled) {
          setPrice(p)
          setLoading(false)
          setUnavailable(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUnavailable(true)
          setLoading(false)
        }
      })

    // Refresh every 60s while mounted
    const interval = setInterval(() => {
      cachedPrice = null // invalidate cache
      fetchXlmUsdPrice()
        .then((p) => {
          if (!cancelled) {
            setPrice(p)
            setUnavailable(false)
          }
        })
        .catch(() => {
          if (!cancelled) setUnavailable(true)
        })
    }, 60_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return { price, loading, unavailable }
}
