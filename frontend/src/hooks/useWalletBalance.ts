import { useState, useEffect } from 'react'
import { useWalletContext } from '../context/WalletContext'
import { useNetwork } from '../context/NetworkContext'
import { walletService } from '../services/wallet'

export interface PendingTransaction {
  id: string
  amount: string
  description: string
}

export interface UseWalletBalanceResult {
  balance: string | undefined
  pendingTransactions: PendingTransaction[]
  isLoading: boolean
  error: string | null
}

export function useWalletBalance(): UseWalletBalanceResult {
  const { wallet } = useWalletContext()
  const { network } = useNetwork()
  const [balance, setBalance] = useState<string | undefined>(wallet.balance)
  const [pendingTransactions, setPendingTransactions] = useState<PendingTransaction[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!wallet.address) return

    let cancelled = false
    setIsLoading(true)
    setError(null)

    walletService
      .getBalance(wallet.address, network)
      .then((bal) => {
        if (!cancelled) setBalance(bal)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to fetch balance')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [wallet.address, network])

  return { balance, pendingTransactions, isLoading, error }
}
