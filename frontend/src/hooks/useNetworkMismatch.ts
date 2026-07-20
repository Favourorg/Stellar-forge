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

// @stellar/freighter-api has no event/subscription mechanism for network
// changes — the only thing close, WatchWalletChanges, is itself a poller
// under the hood (fetchInfo on a setTimeout loop, default 3s). So this UI
// state is inherently poll-based and can be stale by up to one interval.
//
// 2s (down from 5s) is a stopgap that shrinks the *visible* staleness
// window for the banner, traded against 2.5x more requestNetworkDetails()
// calls to the extension. It is NOT what prevents a stale-network
// transaction from being signed — that gate is a synchronous, un-cached
// getNetworkDetails() check in WalletService.signTransaction (wallet.ts),
// which runs fresh immediately before every sign call regardless of this
// poll's cadence. See #927.
const POLL_INTERVAL_MS = 2_000

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
