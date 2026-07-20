import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from './UI/Button'
import { Card } from './UI/Card'
import { TransactionHistory } from './TransactionHistory'
import { useWallet } from '../hooks/useWallet'
import { stellarService } from '../services/stellar'
import type { FactoryTokenInfo } from '../services/stellar'
import { STELLAR_CONFIG } from '../config/stellar'

export const TokenDashboard: React.FC = () => {
  const { wallet } = useWallet()
  const [tokens, setTokens] = useState<FactoryTokenInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null)

  const loadTokens = useCallback(async () => {
    if (!wallet.address) {
      setTokens([])
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const tokenList = await stellarService.getTokensByCreator(wallet.address)
      setTokens(tokenList)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch tokens'
      setError(message)
      setTokens([])
    } finally {
      setIsLoading(false)
    }
  }, [wallet.address])

  useEffect(() => {
    loadTokens()
  }, [loadTokens])

  const handleCopyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address)
      setCopiedAddress(address)
      setTimeout(() => setCopiedAddress(null), 1800)
    } catch {
      setError('Unable to copy token address. Check browser clipboard permissions and try again.')
    }
  }

  const formatCreationDate = useMemo(
    () => (createdAt: number) => new Date(createdAt * 1000).toLocaleString(),
    []
  )

  const factoryContractId = STELLAR_CONFIG.factoryContractId

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-gray-900">Token Dashboard</h2>
        <p className="text-sm text-gray-600">All tokens created by your connected wallet.</p>
      </div>

      {error && (
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-sm text-red-700">{error}</p>
            <Button type="button" variant="outline" onClick={loadTokens}>
              Retry
            </Button>
          </div>
        </Card>
      )}

      {isLoading && (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 3 }, (_, idx) => (
            <Card key={idx}>
              <div className="animate-pulse space-y-3">
                <div className="h-5 bg-gray-200 rounded w-2/3" />
                <div className="h-4 bg-gray-200 rounded w-1/3" />
                <div className="h-4 bg-gray-200 rounded w-full" />
                <div className="h-4 bg-gray-200 rounded w-5/6" />
              </div>
            </Card>
          ))}
        </div>
      )}

      {!isLoading && !error && tokens.length === 0 && (
        <Card>
          <div className="text-center py-6">
            <p className="text-gray-700 font-medium">No tokens created yet</p>
            <p className="text-sm text-gray-500 mt-1">
              Create your first token to see it listed on this dashboard.
            </p>
          </div>
        </Card>
      )}

      {!isLoading && !error && tokens.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {tokens.map((token) => (
            <Card key={`${token.index}-${token.tokenAddress || token.symbol}`}>
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    {token.tokenAddress ? (
                      <Link to={`/tokens/${token.tokenAddress}`} className="hover:underline">
                        <h3 className="text-lg font-semibold text-gray-900">{token.name}</h3>
                      </Link>
                    ) : (
                      <h3 className="text-lg font-semibold text-gray-900">{token.name}</h3>
                    )}
                    <p className="text-sm text-gray-500">{token.symbol}</p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-700">
                    {token.decimals} decimals
                  </span>
                </div>

                <div className="text-sm text-gray-700 space-y-1 break-all">
                  <p>
                    <span className="font-medium">Created:</span> {formatCreationDate(token.createdAt)}
                  </p>
                  <p>
                    <span className="font-medium">Address:</span>{' '}
                    {token.tokenAddress || 'Unavailable from contract response'}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2 pt-2">
                  {token.tokenAddress ? (
                    <Link
                      to={`/tokens/${token.tokenAddress}`}
                      className="inline-flex items-center justify-center px-3 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700"
                    >
                      View Details
                    </Link>
                  ) : (
                    <Button type="button" size="sm" disabled>
                      View Details
                    </Button>
                  )}

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!token.tokenAddress}
                    onClick={() => handleCopyAddress(token.tokenAddress)}
                  >
                    {copiedAddress === token.tokenAddress ? 'Copied!' : 'Copy Address'}
                  </Button>

                  {token.tokenAddress && (
                    <a
                      href={stellarService.getExplorerContractUrl(token.tokenAddress)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center px-3 py-2 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                    >
                      View on Stellar Expert
                    </a>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {factoryContractId && (
        <div className="space-y-2">
          <h2 className="text-base font-semibold text-gray-800">Recent Activity</h2>
          <TransactionHistory contractId={factoryContractId} />
        </div>
      )}
    </div>
  )
}

export const Dashboard = TokenDashboard
