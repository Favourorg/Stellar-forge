import { useState, useEffect, useCallback } from 'react'
import { getNetworkDetails } from '@stellar/freighter-api'
import { STELLAR_CONFIG } from '../config/stellar'
import type { Network } from '../context/NetworkContext'

export interface NetworkMismatchState {
  /** Network name reported by Freighter (e.g. "TESTNET") */
  freighterNetwork: string | null
  /** Whether Freighter's passphrase differs from the app's expected passphrase */
  isMismatch: boolean
  /** Re-check manually (e.g. after user acts on the warning) */
  refresh: () => void
}

const POLL_INTERVAL_MS = 5_000

export function useNetworkMismatch(network: Network): NetworkMismatchState {
  const [freighterNetwork, setFreighterNetwork] = useState<string | null>(null)
  const [isMismatch, setIsMismatch] = useState(false)

  const check = useCallback(async () => {
    try {
      const details = await getNetworkDetails()
      if (details.error) {
        // Freighter not available — clear mismatch
        setFreighterNetwork(null)
        setIsMismatch(false)
        return
      }

      const expectedPassphrase = STELLAR_CONFIG[network].networkPassphrase
      setFreighterNetwork(details.network ?? null)
      setIsMismatch(details.networkPassphrase !== expectedPassphrase)
    } catch {
      setFreighterNetwork(null)
      setIsMismatch(false)
    }
  }, [network])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial check, then poll on an interval
    check()
    const id = setInterval(check, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [check])

  return { freighterNetwork, isMismatch, refresh: check }
}
