import { useState, useCallback, useEffect } from 'react'
import { stellarService } from '../services/stellar'

/*
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  Transaction-status tracking has exactly one implementation.     │
 * │                                                                  │
 * │  All transaction-related hooks live in this file to prevent      │
 * │  divergence. If you need a new way to track a transaction's      │
 * │  status, extend the API here rather than creating a separate     │
 * │  hook file.                                                      │
 * │                                                                  │
 * │  Consumers:                                                      │
 * │    • useTransaction          – MintForm, BurnForm, AdminPanel,    │
 * │                                 TokenCreateForm                  │
 * │    • useTransactionPolling   – TransactionStatus                 │
 * └──────────────────────────────────────────────────────────────────┘
 */

export type TransactionStatus =
  | 'idle'
  | 'simulating'
  | 'signing'
  | 'submitting'
  | 'polling'
  | 'success'
  | 'error'

export interface UseTransactionResult<T> {
  /** Run the transaction. Resolves with the result or throws on error. */
  execute: () => Promise<T>
  reset: () => void
  status: TransactionStatus
  result: T | null
  error: Error | null
}

/**
 * Centralises transaction lifecycle: simulate → sign → submit → poll.
 *
 * @param builder - Async function that performs the full transaction and returns a result.
 *                  Use the `onStatusChange` callback to report fine-grained status transitions.
 */
export function useTransaction<T>(
  builder: (onStatusChange: (status: TransactionStatus) => void) => Promise<T>,
): UseTransactionResult<T> {
  const [status, setStatus] = useState<TransactionStatus>('idle')
  const [result, setResult] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const execute = useCallback(async (): Promise<T> => {
    setStatus('simulating')
    setResult(null)
    setError(null)
    try {
      const value = await builder(setStatus)
      setResult(value)
      setStatus('success')
      return value
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      setError(e)
      setStatus('error')
      throw e
    }
  }, [builder])

  const reset = useCallback(() => {
    setStatus('idle')
    setResult(null)
    setError(null)
  }, [])

  return { execute, reset, status, result, error }
}

// ─── Polling (post-submission status check) ────────────────────────────────

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
 *
 * Thin, justified wrapper: TransactionStatus.tsx needs to poll an
 * *already-submitted* transaction by hash independently of the builder
 * lifecycle that useTransaction manages. Keeping the polling primitive
 * co-located here ensures both paths draw from the same implementation.
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
