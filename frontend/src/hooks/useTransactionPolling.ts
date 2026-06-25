import { useEffect, useState } from 'react'
import { stellarService } from '../services/stellar'

export type TransactionPollStatus = 'pending' | 'success' | 'failed'

export interface UseTransactionPollingResult {
  status: TransactionPollStatus
  error?: string
}

const POLL_INTERVAL_MS = 250
const TIMEOUT_MS = 60000

/**
 * Polls stellarService.getTransaction(txHash) until it resolves to a
 * terminal status (success/error) or TIMEOUT_MS elapses.
 */
export function useTransactionPolling(txHash: string): UseTransactionPollingResult {
  const [status, setStatus] = useState<TransactionPollStatus>('pending')
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    // Reset to pending whenever txHash changes so a new poll cycle doesn't
    // briefly show the previous transaction's terminal status.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('pending')
    setError(undefined)

    let settled = false

    const poll = async () => {
      try {
        const result = await stellarService.getTransaction(txHash)
        if (settled) return

        if (result.status === 'success') {
          settled = true
          clearInterval(intervalId)
          setStatus('success')
        } else if (result.status === 'error' || result.status === 'failed') {
          settled = true
          clearInterval(intervalId)
          setStatus('failed')
          setError(typeof result.error === 'string' ? result.error : 'Transaction failed')
        }
        // status === 'pending' — keep polling
      } catch (err) {
        if (settled) return
        settled = true
        clearInterval(intervalId)
        setStatus('failed')
        setError(err instanceof Error ? err.message : 'Transaction failed')
      }
    }

    const intervalId = setInterval(poll, POLL_INTERVAL_MS)
    void poll()

    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      clearInterval(intervalId)
      setStatus('failed')
      setError('Timeout')
    }, TIMEOUT_MS)

    return () => {
      settled = true
      clearInterval(intervalId)
      clearTimeout(timeoutId)
    }
  }, [txHash])

  return error === undefined ? { status } : { status, error }
}
