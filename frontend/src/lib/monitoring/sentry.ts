import * as Sentry from '@sentry/react'
import type { SeverityLevel, Scope } from '@sentry/react'
import type React from 'react'

const IS_PRODUCTION = import.meta.env.MODE === 'production'
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN
const IS_SENTRY_ENABLED = IS_PRODUCTION && SENTRY_DSN

if (IS_SENTRY_ENABLED) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION ?? 'unknown',
    tracesSampleRate: 0.2,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0.05,
    integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    beforeSend: scrubSensitiveData,
  })
}

/**
 * Regex patterns to identify wallet addresses and sensitive data
 * Stellar addresses are 56 characters starting with 'G' or 'C' (contract)
 */
const STELLAR_ADDRESS_PATTERN = /\b[GC][A-Z2-7]{54}\b/g
const PRIVATE_KEY_PATTERN = /S[A-Z2-7]{55}/g

/**
 * Scrub sensitive data (wallet addresses, private keys) from error context
 * before sending to Sentry to ensure privacy compliance
 */
function scrubSensitiveData(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (!event) return event

  // Scrub from message
  if (event.message) {
    event.message = event.message
      .replace(STELLAR_ADDRESS_PATTERN, '[WALLET_ADDRESS]')
      .replace(PRIVATE_KEY_PATTERN, '[PRIVATE_KEY]')
  }

  // Scrub from exception messages
  if (event.exception?.values) {
    event.exception.values.forEach((exception: { value?: string }) => {
      if (exception.value) {
        exception.value = exception.value
          .replace(STELLAR_ADDRESS_PATTERN, '[WALLET_ADDRESS]')
          .replace(PRIVATE_KEY_PATTERN, '[PRIVATE_KEY]')
      }
    })
  }

  // Scrub from tags and extras
  if (event.tags) {
    Object.keys(event.tags).forEach((key) => {
      const value = event.tags?.[key]
      if (typeof value === 'string') {
        event.tags![key] = value
          .replace(STELLAR_ADDRESS_PATTERN, '[WALLET_ADDRESS]')
          .replace(PRIVATE_KEY_PATTERN, '[PRIVATE_KEY]')
      }
    })
  }

  if (event.extra) {
    Object.keys(event.extra).forEach((key) => {
      const value = event.extra?.[key]
      if (typeof value === 'string') {
        event.extra![key] = value
          .replace(STELLAR_ADDRESS_PATTERN, '[WALLET_ADDRESS]')
          .replace(PRIVATE_KEY_PATTERN, '[PRIVATE_KEY]')
      }
    })
  }

  return event
}

export interface ErrorContext {
  [key: string]: unknown
}

/**
 * Context for contract call errors
 */
export interface ContractErrorContext extends ErrorContext {
  network?: 'testnet' | 'mainnet' | 'standalone'
  contractId?: string
  functionName?: string
  params?: Record<string, unknown>
}

/**
 * Context for transaction lifecycle errors.
 * Extends ContractErrorContext with the transaction hash so every Sentry event
 * captured during or after a transaction can be correlated to the on-chain tx.
 */
export interface TransactionErrorContext extends ContractErrorContext {
  /** Stellar transaction hash (64 hex characters) */
  txHash?: string
}

export function captureException(error: Error, context?: ErrorContext): void {
  if (!IS_SENTRY_ENABLED) return
  Sentry.withScope((scope: Scope) => {
    if (context) scope.setExtras(context)
    Sentry.captureException(error)
  })
}

/**
 * Capture contract call errors with structured context
 * This helps track failed RPC calls and contract invocations in production
 */
export function captureContractError(error: Error, context: ContractErrorContext & { txHash?: string }): void {
  if (!IS_SENTRY_ENABLED) return

  Sentry.withScope((scope: Scope) => {
    // Add tags for filtering and grouping in Sentry
    if (context.network) scope.setTag('network', context.network)
    if (context.contractId) scope.setTag('contractId', context.contractId)
    if (context.functionName) scope.setTag('functionName', context.functionName)
    // Tag txHash when available so the event can be correlated to the on-chain transaction
    if (context.txHash) scope.setTag('txHash', context.txHash)

    // Add context as extras
    const extras: Record<string, unknown> = {}
    if (context.network) extras.network = context.network
    if (context.contractId) extras.contractId = context.contractId
    if (context.functionName) extras.functionName = context.functionName
    if (context.params) extras.params = context.params
    if (context.txHash) extras.txHash = context.txHash

    scope.setExtras(extras)
    Sentry.captureException(error)
  })
}

/**
 * Capture a transaction lifecycle error with full structured correlation context.
 *
 * Tags every captured event with:
 *   - `txHash`          — the Stellar transaction hash (allows direct pivot to on-chain data)
 *   - `network`         — testnet/mainnet (avoids cross-environment noise in alerts)
 *   - `contractId`      — factory contract ID (correlates events across upgrade deploys)
 *   - `functionName`    — the RPC method that failed
 *
 * This is the primary capture function for any error that occurs during the
 * simulate → sign → submit → poll lifecycle of a Soroban transaction.
 *
 * Returns the Sentry event ID so callers can surface it alongside the txHash
 * in the "Report an issue" affordance — giving support both pieces of context
 * in one step.
 */
export function captureTransactionError(
  error: Error,
  context: TransactionErrorContext,
): string | undefined {
  if (!IS_SENTRY_ENABLED) return undefined

  Sentry.withScope((scope: Scope) => {
    if (context.txHash) scope.setTag('txHash', context.txHash)
    if (context.network) scope.setTag('network', context.network)
    if (context.contractId) scope.setTag('contractId', context.contractId)
    if (context.functionName) scope.setTag('functionName', context.functionName)

    const extras: Record<string, unknown> = {}
    if (context.txHash) extras.txHash = context.txHash
    if (context.network) extras.network = context.network
    if (context.contractId) extras.contractId = context.contractId
    if (context.functionName) extras.functionName = context.functionName
    if (context.params) extras.params = context.params

    scope.setExtras(extras)
    Sentry.captureException(error)
  })

  // lastEventId() returns the ID of the most recently captured event —
  // safe to read immediately after withScope because withScope is synchronous.
  return Sentry.lastEventId() ?? undefined
}

export function captureMessage(message: string, level: SeverityLevel = 'info'): void {
  if (!IS_SENTRY_ENABLED) return
  Sentry.captureMessage(message, level)
}

export interface UserContext {
  id: string
  email?: string
  username?: string
}

export function setUserContext(user: UserContext): void {
  if (!IS_SENTRY_ENABLED) return
  Sentry.setUser(user)
}

export function setTag(key: string, value: string): void {
  if (!IS_SENTRY_ENABLED) return
  Sentry.setTag(key, value)
}

export function withSentryProfiler<P extends object>(
  Component: React.ComponentType<P>,
): React.ComponentType<P> {
  if (!IS_SENTRY_ENABLED) return Component
  return Sentry.withProfiler(Component)
}
