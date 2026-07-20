// Environment variable validation

export const ENV = {
  network: import.meta.env.VITE_NETWORK || 'testnet',
  factoryContractId: import.meta.env.VITE_FACTORY_CONTRACT_ID ?? '',
  tokenWasmHash: import.meta.env.VITE_TOKEN_WASM_HASH ?? '',
  // Non-secret advertisement flag. The Pinata credentials themselves live only
  // on the server (PINATA_API_KEY/PINATA_API_SECRET, read by api/ipfs/*); this
  // just lets the UI disable upload controls on a deployment that never
  // configured the proxy, instead of failing at submit time.
  ipfsEnabled: (import.meta.env.VITE_IPFS_ENABLED ?? 'true') !== 'false',
} as const

export const isFactoryConfigured = (): boolean => Boolean(ENV.factoryContractId)
export const isIpfsConfigured = (): boolean => ENV.ipfsEnabled
