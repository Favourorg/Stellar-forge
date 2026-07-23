import { useState, useCallback, useEffect } from 'react'
import { stellarService } from '../services/stellar'
import { captureTransactionError } from '../lib/monitoring/sentry'
import { STELLAR_CONFIG } from '../config/stellar'
import { nextBackoffDelay } from '../utils/pollWithBackoff'

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
  'idle' | 'simulating' | 'signing' | 'submitting' | 'polling' | 'success' | 'error'

// ── Reconciliation policy ───────────────────────────────────────────────────
//
// Every write-path component MUST follow this policy:
//
// 1. No optimistic cache mutation.
//    Never add/update/remove entries in any shared cache (useTokens,
//    useFactoryState, TokenDashboard, etc.) before the transaction is
//    confirmed on-chain. A phantom entry that looks real but doesn't exist
//    on the ledger is worse than a brief loading state.
//
// 2. Only call refresh() after a CONFIRMED success.
//    The `onSuccess` callback (or equivalent) is the one place where
//    caches should be invalidated. Listen for `status === 'success'` (not
//    just "the promise resolved") and call refresh() / refetch() / re-run
//    the relevant query hook.
//
// 3. On failure or timeout, do NOT mutate any cache.
//    Show an error toast. If the transaction timed out, communicate
//    uncertainty: "Transaction submitted but not yet confirmed — check
//    the explorer for the final status." Never silently treat a timeout
//    as either success or failure.
//
//    Timeout guards are the component's responsibility — wrap the
//    builder call with Promise.race against a timeout and surface the
//    uncertainty banner when the race is lost.
//
// 4. Prefer useTransaction over ad-hoc loading states.
//    The hook centralises simulate → sign → submit → poll. Components
//    that roll their own isDeploying / isSubmitting state bypass this
//    lifecycle and risk drifting from the policy.

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
  /** Sentry event ID for the polling failure, when available. */
  sentryEventId?: string
}

const INITIAL_DELAY_MS = 500
const MAX_DELAY_MS = 4000
const TIMEOUT_MS = 60000

/**
 * Polls stellarService.getTransaction(txHash) until it resolves to a
 * terminal status (success/error) or TIMEOUT_MS elapses. Uses the same
 * exponential-backoff-with-jitter schedule (via nextBackoffDelay) as
 * stellar-impl.ts's pollTransaction, so there is one growth curve for
 * "poll a transaction hash until terminal status" across the codebase.
 *
 * Thin, justified wrapper: TransactionStatus.tsx needs to poll an
 * *already-submitted* transaction by hash independently of the builder
 * lifecycle that useTransaction manages. Keeping the polling primitive
 * co-located here ensures both paths draw from the same implementation.
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
    let attempt = 0
    let pollTimeoutId: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const result = await stellarService.getTransaction(txHash)
        if (settled) return

        if (result.status === 'success') {
          settled = true
          clearTimeout(pollTimeoutId)
          setStatus('success')
        } else if (result.status === 'error' || result.status === 'failed') {
          settled = true
          clearTimeout(pollTimeoutId)
          setStatus('failed')
          const errorMessage =
            typeof result.error === 'string' ? result.error : 'Transaction failed'
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
        } else {
          // status === 'pending' — schedule the next attempt with backoff
          const delay = nextBackoffDelay(attempt, {
            initialDelayMs: INITIAL_DELAY_MS,
            maxDelayMs: MAX_DELAY_MS,
          })
          attempt += 1
          pollTimeoutId = setTimeout(poll, delay)
        }
      } catch (err) {
        if (settled) return
        settled = true
        clearTimeout(pollTimeoutId)
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

    void poll()

    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      clearTimeout(pollTimeoutId)
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
      clearTimeout(pollTimeoutId)
      clearTimeout(timeoutId)
    }
  }, [txHash])

  if (error === undefined) return sentryEventId ? { status, sentryEventId } : { status }
  return sentryEventId ? { status, error, sentryEventId } : { status, error }
}
