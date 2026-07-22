import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useStellarContext } from '../context/StellarContext'
import { useNetwork } from '../context/NetworkContext'
import { useToast } from '../context/ToastContext'
import { ipfsService } from '../services/ipfs'
import { STELLAR_CONFIG } from '../config/stellar'
import { isValidContractAddress } from '../utils/validation'
import { formatAddress, ipfsToGatewayUrl, formatTimestamp } from '../utils/formatting'
import type { TokenInfo, IPFSMetadata } from '../types'
import { Card, Button, Input, Spinner } from './UI'
import { CopyButton } from './CopyButton'
import { PaginationControls } from './UI/PaginationControls'
import { useDebounce } from '../hooks/useDebounce'
import { fetchAllContractEvents } from '../utils/fetchAllContractEvents'

interface TokenWithMetadata extends TokenInfo {
  address: string
  metadata?: IPFSMetadata | null
}

/**
 * Maps derived from factory events, correlating a token's on-chain 1-based
 * index to its contract address and latest metadata URI. `get_token_info`
 * (the authoritative index-range listing) carries neither, so events are the
 * complementary path used purely for enrichment — a token still renders from
 * its `get_token_info` data if this lookup is unavailable.
 */
interface EventMaps {
  key: string
  indexToAddress: Map<number, string>
  addressToMeta: Map<string, string>
}

export const TokenExplorer: React.FC = () => {
  const { t } = useTranslation()
  const { stellarService } = useStellarContext()
  const { network } = useNetwork()
  const { addToast } = useToast()

  const contractId = STELLAR_CONFIG.factoryContractId || ''

  const [searchInput, setSearchInput] = useState('')
  const [creatorFilter, setCreatorFilter] = useState('')
  const debouncedCreatorFilter = useDebounce(creatorFilter, 300)

  const [searchResult, setSearchResult] = useState<TokenWithMetadata | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const [currentPage, setCurrentPage] = useState(1)
  const [totalTokens, setTotalTokens] = useState(0)
  const [tokens, setTokens] = useState<TokenWithMetadata[]>([])
  const [loadingTokens, setLoadingTokens] = useState(false)
  // Distinct from an empty list: a non-null value means the page fetch failed,
  // so the UI must show an error state rather than "no tokens exist".
  const [listError, setListError] = useState<Error | null>(null)
  // Bumped to force a re-fetch (retry / after a mutation) without changing page.
  const [reloadNonce, setReloadNonce] = useState(0)

  const tokensPerPage = 10

  // Per-mount page cache keyed by (network, contractId, pageSize, page). The
  // key embeds network + contract so a page from another chain is never served
  // after a network switch. Created-event invalidation for shared app state
  // lives in the useTokens hook; here a stale cache is bypassed via
  // `reloadNonce`. Only ever read/written inside effects, never during render.
  const pageCacheRef = useRef<Map<string, { tokens: TokenInfo[]; total: number }>>(new Map())
  const eventMapsRef = useRef<EventMaps | null>(null)

  const pageCacheKey = useCallback(
    (page: number) => `${network}:${contractId}:${tokensPerPage}:${page}`,
    [network, contractId],
  )

  // Build (and memoise) the index→address / address→metadataUri correlation
  // from factory events. Paginated via fetchAllContractEvents — a single capped
  // getContractEvents() call would silently drop the newest tokens once history
  // exceeds one page.
  const getEventMaps = useCallback(async (): Promise<EventMaps> => {
    const key = `${network}:${contractId}`
    if (eventMapsRef.current?.key === key) return eventMapsRef.current

    const events = await fetchAllContractEvents(stellarService, contractId)
    // Creation order == 1-based index order: the k-th `created` event (oldest
    // first) is the token stored at index k+1.
    const created = events
      .filter((e) => e.type === 'created')
      .sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id))
    const indexToAddress = new Map<number, string>()
    created.forEach((e, k) => {
      if (e.data.tokenAddress) indexToAddress.set(k + 1, e.data.tokenAddress)
    })
    const addressToMeta = new Map<string, string>()
    for (const e of events.filter((e) => e.type === 'meta').sort((a, b) => a.ledger - b.ledger)) {
      if (e.data.tokenAddress && e.data.metadataUri) {
        addressToMeta.set(e.data.tokenAddress, e.data.metadataUri)
      }
    }

    const maps: EventMaps = { key, indexToAddress, addressToMeta }
    eventMapsRef.current = maps
    return maps
  }, [network, contractId, stellarService])

  // Enrich an authoritative index-range page with token address + metadata.
  // Best-effort: if events are unavailable the tokens still render (without a
  // detail link or image) rather than disappearing.
  const enrichPage = useCallback(
    async (infoPage: TokenInfo[]): Promise<TokenWithMetadata[]> => {
      let maps: EventMaps | null = null
      try {
        maps = await getEventMaps()
      } catch {
        maps = null
      }

      return Promise.all(
        infoPage.map(async (info) => {
          const address = info.index != null ? (maps?.indexToAddress.get(info.index) ?? '') : ''
          const metadataUri =
            info.metadataUri ?? (address ? maps?.addressToMeta.get(address) : undefined)

          let metadata: IPFSMetadata | null = null
          if (metadataUri) {
            try {
              metadata = (await ipfsService.getMetadata(metadataUri)) as IPFSMetadata
            } catch {
              // Metadata fetch failure is non-fatal
            }
          }

          const enriched: TokenWithMetadata = { ...info, address, metadata }
          if (metadataUri !== undefined) enriched.metadataUri = metadataUri
          return enriched
        }),
      )
    },
    [getEventMaps],
  )

  const loadTokenByAddress = useCallback(
    async (address: string): Promise<TokenWithMetadata | null> => {
      try {
        const info = await stellarService.getTokenInfoByAddress(address)

        let metadata: IPFSMetadata | null = null
        if (info.metadataUri) {
          try {
            metadata = (await ipfsService.getMetadata(info.metadataUri)) as IPFSMetadata
          } catch {
            // Metadata fetch failure is non-fatal
          }
        }

        return {
          ...info,
          address,
          metadata,
        }
      } catch {
        return null
      }
    },
    [stellarService],
  )

  // Load the current page from the authoritative index-range view
  // (getAllTokens → { tokens, total }), newest-first. "Latest request wins":
  // a superseded page fetch is discarded so rapid navigation cannot leave a
  // stale page rendered.
  useEffect(() => {
    let cancelled = false

    // eslint-disable-next-line react-hooks/set-state-in-effect -- entering the loading state is the first step of the page fetch this effect exists to run; see #1002 follow-up
    setLoadingTokens(true)
    setListError(null)

    async function run() {
      try {
        const key = pageCacheKey(currentPage)
        const cached = pageCacheRef.current.get(key)
        const page =
          cached ??
          (await stellarService.getAllTokens((currentPage - 1) * tokensPerPage, tokensPerPage))
        if (!cached) pageCacheRef.current.set(key, page)
        if (cancelled) return

        setTotalTokens(page.total)
        const enriched = await enrichPage(page.tokens)
        if (cancelled) return
        setTokens(enriched)
      } catch (err) {
        if (cancelled) return
        setTokens([])
        setListError(err instanceof Error ? err : new Error(String(err)))
      } finally {
        if (!cancelled) setLoadingTokens(false)
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [currentPage, stellarService, enrichPage, pageCacheKey, reloadNonce])

  const getFilteredTokens = (): TokenWithMetadata[] => {
    if (!debouncedCreatorFilter) return tokens

    const filterLower = debouncedCreatorFilter.toLowerCase()
    return tokens.filter((t) => t.creator && t.creator.toLowerCase().includes(filterLower))
  }

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    const query = searchInput.trim()

    if (!query) {
      setSearchError('Please enter a token address or index')
      return
    }

    setSearching(true)
    setSearchError(null)
    setSearchResult(null)

    try {
      // Check if input is a number (contract index, 1-based to match the
      // `#index` shown in the list below).
      const indexMatch = /^\d+$/.exec(query)
      if (indexMatch) {
        const index = parseInt(query, 10)
        if (index < 1 || index > totalTokens) {
          setSearchError(`Token index ${index} does not exist. Total tokens: ${totalTokens}`)
          return
        }

        // Get token address from events
        const events = await fetchAllContractEvents(
          stellarService,
          STELLAR_CONFIG.factoryContractId || '',
        )
        const tokenCreatedEvents = events
          .filter((e) => e.type === 'created')
          .sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id))

        const event = tokenCreatedEvents[index - 1]
        if (!event?.data.tokenAddress) {
          setSearchError('Token not found at this index')
          return
        }

        const result = await loadTokenByAddress(event.data.tokenAddress)
        if (result) {
          setSearchResult(result)
        } else {
          setSearchError('Token not found at this index')
        }
        return
      }

      // Otherwise treat as address
      if (!isValidContractAddress(query)) {
        setSearchError('Invalid token address format')
        return
      }

      const result = await loadTokenByAddress(query)
      if (result) {
        setSearchResult(result)
      } else {
        setSearchError('Token not found')
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Token not found')
      addToast('Token not found', 'error')
    } finally {
      setSearching(false)
    }
  }

  const totalPages = Math.ceil(totalTokens / tokensPerPage)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          {t('tokenExplorer.title', 'Token Explorer')}
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'tokenExplorer.description',
            'Search for any token by address or index, or browse all tokens',
          )}
        </p>
      </div>

      {/* Search Form */}
      <Card>
        <form onSubmit={handleSearch} className="space-y-4">
          <Input
            label={t('tokenExplorer.searchLabel', 'Token Address or Index')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t(
              'tokenExplorer.searchPlaceholder',
              'Enter token address (C...) or index (0, 1, 2...)',
            )}
            disabled={searching}
          />
          <Input
            label={t('tokenExplorer.filterByCreator', 'Filter by Creator Address')}
            value={creatorFilter}
            onChange={(e) => setCreatorFilter(e.target.value)}
            placeholder={t(
              'tokenExplorer.creatorPlaceholder',
              'Enter creator address to filter tokens (optional)',
            )}
            disabled={searching}
          />
          {searchError && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {searchError}
            </p>
          )}
          <Button type="submit" disabled={searching} loading={searching}>
            {searching
              ? t('tokenExplorer.searching', 'Searching...')
              : t('tokenExplorer.search', 'Search')}
          </Button>
        </form>
      </Card>

      {/* Search Result */}
      {searchResult && (
        <Card title={t('tokenExplorer.searchResult', 'Search Result')}>
          <TokenDisplay token={searchResult} />
        </Card>
      )}

      {/* All Tokens List */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('tokenExplorer.allTokens', 'All Tokens')} ({totalTokens})
          </h3>
        </div>

        {loadingTokens ? (
          <div className="flex justify-center py-12">
            <Spinner size="lg" label={t('tokenExplorer.loadingTokens', 'Loading tokens...')} />
          </div>
        ) : listError ? (
          // Fetch failure — never render as an empty list, which would read as
          // "no tokens exist" and mask the outage.
          <Card>
            <div className="text-center py-8" role="alert">
              <p className="text-red-600 dark:text-red-400 font-medium">
                {t('tokenExplorer.loadError', 'Could not load tokens')}
              </p>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 break-words">
                {listError.message}
              </p>
              <Button
                type="button"
                variant="secondary"
                className="mt-4"
                onClick={() => {
                  // Bypass the cached (failed) page and any stale event maps on retry.
                  pageCacheRef.current.delete(pageCacheKey(currentPage))
                  eventMapsRef.current = null
                  setReloadNonce((n) => n + 1)
                }}
              >
                {t('tokenExplorer.retry', 'Retry')}
              </Button>
            </div>
          </Card>
        ) : getFilteredTokens().length === 0 ? (
          <Card>
            <p className="text-center text-gray-500 dark:text-gray-400 py-8">
              {debouncedCreatorFilter
                ? t('tokenExplorer.noTokensForCreator', 'No tokens found for this creator address')
                : t('tokenExplorer.noTokens', 'No tokens have been deployed yet')}
            </p>
          </Card>
        ) : (
          <div className="space-y-4">
            {getFilteredTokens().map((token, index) => (
              <Card key={`${token.address || token.index}-${index}`}>
                <TokenDisplay token={token} showIndex />
              </Card>
            ))}
          </div>
        )}

        {totalPages > 1 && !loadingTokens && !listError && !debouncedCreatorFilter && (
          <PaginationControls
            page={currentPage}
            totalPages={totalPages}
            totalCount={totalTokens}
            pageSize={tokensPerPage}
            onPrev={() => setCurrentPage((p) => Math.max(1, p - 1))}
            onNext={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
          />
        )}
      </div>
    </div>
  )
}

interface TokenDisplayProps {
  token: TokenWithMetadata
  showIndex?: boolean
}

const TokenDisplay: React.FC<TokenDisplayProps> = ({ token, showIndex }) => {
  const { t } = useTranslation()
  const imageUrl = token.metadata?.image ? ipfsToGatewayUrl(token.metadata.image) : null

  return (
    <div className="space-y-4">
      {/* Token Header with Image */}
      <div className="flex gap-4 items-start">
        {imageUrl && (
          <img
            src={imageUrl}
            alt={`${token.name} logo`}
            className="w-16 h-16 rounded-lg object-cover flex-shrink-0 border border-gray-200 dark:border-gray-700"
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.display = 'none'
            }}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            {showIndex && token.index !== undefined && (
              <span className="text-sm font-mono text-gray-500 dark:text-gray-400">
                #{token.index}
              </span>
            )}
            <h4 className="text-lg font-semibold text-gray-900 dark:text-white">{token.name}</h4>
            <span className="text-sm font-mono text-gray-500 dark:text-gray-400">
              ({token.symbol})
            </span>
          </div>
          {token.metadata?.description && (
            // Clamped hard with no expand affordance: this is a list row, and a
            // single token must not be able to grow its card and push the rest
            // of the results off-screen.
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400 line-clamp-2 break-words">
              {token.metadata.description}
            </p>
          )}
        </div>
      </div>

      {/* Token Details */}
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
        {token.address && (
          <div>
            <dt className="text-gray-500 dark:text-gray-400">
              {t('tokenExplorer.address', 'Address')}
            </dt>
            <dd className="flex items-center gap-1 font-mono text-xs break-all text-gray-900 dark:text-gray-100 mt-1">
              <span title={token.address}>{formatAddress(token.address)}</span>
              <CopyButton value={token.address} ariaLabel="Copy token address" />
            </dd>
          </div>
        )}

        <div>
          <dt className="text-gray-500 dark:text-gray-400">
            {t('tokenExplorer.totalSupply', 'Total Supply')}
          </dt>
          <dd className="text-gray-900 dark:text-gray-100 mt-1 font-mono">
            {token.totalSupply ?? '—'}
          </dd>
        </div>

        <div>
          <dt className="text-gray-500 dark:text-gray-400">
            {t('tokenExplorer.decimals', 'Decimals')}
          </dt>
          <dd className="text-gray-900 dark:text-gray-100 mt-1">{token.decimals}</dd>
        </div>

        {token.creator && (
          <div>
            <dt className="text-gray-500 dark:text-gray-400">
              {t('tokenExplorer.creator', 'Creator')}
            </dt>
            <dd className="flex items-center gap-1 font-mono text-xs break-all text-gray-900 dark:text-gray-100 mt-1">
              <span title={token.creator}>{formatAddress(token.creator)}</span>
              <CopyButton value={token.creator} ariaLabel="Copy creator address" />
            </dd>
          </div>
        )}

        {token.createdAt && token.createdAt > 0 && (
          <div>
            <dt className="text-gray-500 dark:text-gray-400">
              {t('tokenExplorer.created', 'Created')}
            </dt>
            <dd className="text-gray-900 dark:text-gray-100 mt-1">
              {formatTimestamp(token.createdAt)}
            </dd>
          </div>
        )}

        {token.metadataUri && (
          <div className="sm:col-span-2">
            <dt className="text-gray-500 dark:text-gray-400">
              {t('tokenExplorer.metadataUri', 'Metadata URI')}
            </dt>
            <dd className="flex items-center gap-1 font-mono text-xs break-all text-gray-900 dark:text-gray-100 mt-1">
              <span className="truncate" title={token.metadataUri}>
                {token.metadataUri}
              </span>
              <CopyButton value={token.metadataUri} ariaLabel="Copy metadata URI" />
            </dd>
          </div>
        )}
      </dl>

      {/* View Details Link — only when the token address is known (resolved
          from events); the index-range listing alone carries no address. */}
      {token.address && (
        <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
          <Link
            to={`/tokens/${token.address}`}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline font-medium"
          >
            {t('tokenExplorer.viewDetails', 'View full details')} →
          </Link>
        </div>
      )}
    </div>
  )
}
