import { useEffect, useState } from 'react'
import { stellarService } from '../services/stellar'
import { captureTransactionError } from '../lib/monitoring/sentry'
import { STELLAR_CONFIG } from '../config/stellar'

export type TransactionPollStatus = 'pending' | 'success' | 'failed'

export interface UseTransactionPollingResult {
  status: TransactionPollStatus
  error?: string
  /** Sentry event ID for the polling failure, when available. */
  sentryEventId?: string
}

const POLL_INTERVAL_MS = 250
const TIMEOUT_MS = 60000

/**
 * Polls stellarService.getTransaction(txHash) until it resolves to a
 * terminal status (success/error) or TIMEOUT_MS elapses.
 *
 * On failure, captures a Sentry event tagged with the txHash, network, and
 * factoryContractId so support can correlate any error report to the on-chain
 * transaction without manual timestamp cross-referencing.
 */
export function useTransactionPolling(txHash: string): UseTransactionPollingResult {
  const [status, setStatus] = useState<TransactionPollStatus>('pending')
  const [error, setError] = useState<string | undefined>(undefined)
  const [sentryEventId, setSentryEventId] = useState<string | undefined>(undefined)

  useEffect(() => {
    // Reset to pending whenever txHash changes so a new poll cycle doesn't
    // briefly show the previous transaction's terminal status.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('pending')
    setError(undefined)
    setSentryEventId(undefined)

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
          const errorMessage = typeof result.error === 'string' ? result.error : 'Transaction failed'
          setError(errorMessage)

          // Capture to Sentry with full transaction correlation tags
          const eventId = captureTransactionError(
            new Error(`Transaction failed: ${errorMessage}`),
            {
              txHash,
              network: STELLAR_CONFIG.network,
              contractId: STELLAR_CONFIG.factoryContractId ?? undefined,
              functionName: 'pollTransaction',
            },
          )
          if (eventId) setSentryEventId(eventId)
        }
        // status === 'pending' — keep polling
      } catch (err) {
        if (settled) return
        settled = true
        clearInterval(intervalId)
        setStatus('failed')
        const errorMessage = err instanceof Error ? err.message : 'Transaction failed'
        setError(errorMessage)

        // Capture to Sentry with full transaction correlation tags
        const eventId = captureTransactionError(
          err instanceof Error ? err : new Error(errorMessage),
          {
            txHash,
            network: STELLAR_CONFIG.network,
            contractId: STELLAR_CONFIG.factoryContractId ?? undefined,
            functionName: 'pollTransaction',
          },
        )
        if (eventId) setSentryEventId(eventId)
      }
    }

    const intervalId = setInterval(poll, POLL_INTERVAL_MS)
    void poll()

    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      clearInterval(intervalId)
      setStatus('failed')
      const errorMessage = 'Timeout'
      setError(errorMessage)

      captureTransactionError(new Error(`Transaction polling timed out: ${txHash}`), {
        txHash,
        network: STELLAR_CONFIG.network,
        contractId: STELLAR_CONFIG.factoryContractId ?? undefined,
        functionName: 'pollTransaction',
      })
    }, TIMEOUT_MS)

    return () => {
      settled = true
      clearInterval(intervalId)
      clearTimeout(timeoutId)
    }
  }, [txHash])

  if (error === undefined) return { status, sentryEventId }
  return { status, error, sentryEventId }
}
