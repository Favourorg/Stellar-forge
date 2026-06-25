import { createContext, useContext, useCallback, ReactNode } from 'react'
import { STELLAR_CONFIG } from '../config/stellar'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { useNetworkMismatch, type NetworkMismatchState } from '../hooks/useNetworkMismatch'

export type Network = 'testnet' | 'mainnet' | 'standalone'

const STORAGE_KEY = 'stellarforge_network'

interface NetworkContextValue {
  network: Network
  switchNetwork: (n: Network) => void
  rpcUrl: string
  horizonUrl: string
  networkPassphrase: string
  mismatch: NetworkMismatchState
}

const NetworkContext = createContext<NetworkContextValue | null>(null)

function NetworkProviderInner({
  children,
  network,
  switchNetwork,
}: {
  children: ReactNode
  network: Network
  switchNetwork: (n: Network) => void
}) {
  const mismatch = useNetworkMismatch(network)
  const cfg = STELLAR_CONFIG[network]

  return (
    <NetworkContext.Provider
      value={{
        network,
        switchNetwork,
        rpcUrl: cfg.sorobanRpcUrl,
        horizonUrl: cfg.horizonUrl,
        networkPassphrase: cfg.networkPassphrase,
        mismatch,
      }}
    >
      {children}
    </NetworkContext.Provider>
  )
}

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [network, setNetwork] = useLocalStorage<Network>(
    STORAGE_KEY,
    (STELLAR_CONFIG.network as Network) ?? 'testnet',
  )

  const switchNetwork = useCallback(
    (n: Network) => {
      setNetwork(n)
    },
    [setNetwork],
  )

  return (
    <NetworkProviderInner network={network} switchNetwork={switchNetwork}>
      {children}
    </NetworkProviderInner>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext)
  if (!ctx) throw new Error('useNetwork must be used within a NetworkProvider')
  return ctx
}
