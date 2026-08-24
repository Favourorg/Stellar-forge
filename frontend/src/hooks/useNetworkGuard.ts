import { useRef } from 'react'
import { useNetwork, type Network } from '../context/NetworkContext'

/**
 * Returns whether write operations should be blocked due to a network mismatch.
 * Use this in any form that submits on-chain transactions.
 *
 * The guard blocks for two reasons:
 *
 * 1. **Freighter mismatch** — the wallet extension is connected to a different
 *    network than the app (e.g. Freighter on mainnet while the app is set to
 *    testnet). This is the original check.
 *
 * 2. **Network drift** — the app's own selected network changed *after* this
 *    form was opened. The `useLocalStorage` hook used by `NetworkContext`
 *    listens for `storage` events from other browser tabs, so switching
 *    networks in Tab A silently re-targets Tab B's `StellarContext` to a
 *    different factory contract ID and RPC endpoint. Any form state captured
 *    under the previous network (token address, amount, token dropdown) was
 *    never validated against the new network, and allowing submission would
 *    build a transaction against the wrong contract with stale data.
 *
 *    The guard captures the network at form-mount time as a baseline. As long
 *    as the live network matches the baseline, the form is safe. If they
 *    diverge the form is blocked with a clear warning, and the user must
 *    review the form before submitting.
 */
export function useNetworkGuard(): { blocked: boolean; reason: string | null } {
  const { mismatch, network } = useNetwork()

  // Baseline: the network this form was opened under. Unlike `useState` this
  // ref is never updated, so it permanently captures the initial value.
  const openedNetworkRef = useRef<Network>(network)

  // ── 1. Network drift (app's own target changed since form opened) ────────
  const openedNetwork = openedNetworkRef.current
  if (network !== openedNetwork) {
    return {
      blocked: true,
      reason: `Network changed to ${network} while this form was open. Review the token address and amount before continuing.`,
    }
  }

  // ── 2. Freighter mismatch (wallet disagrees with app) ────────────────────
  if (mismatch.isMismatch) {
    const expected = network === 'mainnet' ? 'Mainnet' : 'Testnet'
    return {
      blocked: true,
      reason: `Switch Freighter to ${expected} to continue.`,
    }
  }

  return { blocked: false, reason: null }
}