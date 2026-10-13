// Stellar network configuration
import { ENV } from './env'

export type Network = 'testnet' | 'mainnet' | 'standalone'

const NETWORK_LABELS: Record<Network, string> = {
  testnet: 'Testnet',
  mainnet: 'Mainnet',
  standalone: 'Standalone',
}

/** Human-readable network name for UI copy ("Testnet", "Mainnet", …). */
export function networkLabel(network: Network): string {
  return NETWORK_LABELS[network]
}

export interface NetworkConfig {
  networkPassphrase: string
  horizonUrl: string
  sorobanRpcUrl: string
  factoryContractId: string
  tokenWasmHash: string
}

export const NETWORK_CONFIGS: Record<Network, NetworkConfig> = {
  testnet: {
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    factoryContractId: ENV.factoryContractIdTestnet,
    tokenWasmHash: ENV.tokenWasmHashTestnet,
  },
  mainnet: {
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: ENV.sorobanRpcUrlMainnet || 'https://soroban-mainnet.stellar.org',
    factoryContractId: ENV.factoryContractIdMainnet,
    tokenWasmHash: ENV.tokenWasmHashMainnet,
  },
  standalone: {
    networkPassphrase: 'Standalone Network ; February 2017',
    horizonUrl: 'http://localhost:8000',
    sorobanRpcUrl: 'http://localhost:8000/soroban/rpc',
    factoryContractId: ENV.factoryContractIdStandalone,
    tokenWasmHash: ENV.tokenWasmHashStandalone,
  },
}

export interface NetworkValidationResult {
  isConfigured: boolean
  missingVars: string[]
}

export function validateNetworkConfig(network: Network): NetworkValidationResult {
  const missingVars: string[] = []
  const cfg = NETWORK_CONFIGS[network]

  if (!cfg.factoryContractId) {
    if (network === 'testnet') {
      missingVars.push('VITE_FACTORY_CONTRACT_ID_TESTNET (or VITE_FACTORY_CONTRACT_ID)')
    } else if (network === 'mainnet') {
      missingVars.push('VITE_FACTORY_CONTRACT_ID_MAINNET')
    } else {
      missingVars.push('VITE_FACTORY_CONTRACT_ID_STANDALONE')
    }
  }

  return {
    isConfigured: missingVars.length === 0,
    missingVars,
  }
}

export function isNetworkConfigured(network: Network): boolean {
  return validateNetworkConfig(network).isConfigured
}

const DEFAULT_NETWORK: Network = 'testnet'

function isSupportedNetwork(value: string): value is Network {
  return value in NETWORK_CONFIGS
}

// Clamp the configured network to one we have config for. An unrecognized
// VITE_NETWORK (e.g. "standalone") would otherwise leave every consumer of
// STELLAR_CONFIG[network] dereferencing undefined and crash the whole app.
export const resolvedNetwork: Network = isSupportedNetwork(ENV.network)
  ? ENV.network
  : DEFAULT_NETWORK

export const STELLAR_CONFIG = {
  network: resolvedNetwork,
  get factoryContractId(): string {
    return NETWORK_CONFIGS[resolvedNetwork]?.factoryContractId ?? ''
  },
  get tokenWasmHash(): string {
    return NETWORK_CONFIGS[resolvedNetwork]?.tokenWasmHash ?? ''
  },
  ...NETWORK_CONFIGS,
}
