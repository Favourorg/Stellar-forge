// Environment variable validation

export const ENV = {
  network: import.meta.env.VITE_NETWORK || 'testnet',
  factoryContractId: import.meta.env.VITE_FACTORY_CONTRACT_ID ?? '',
  tokenWasmHash: import.meta.env.VITE_TOKEN_WASM_HASH ?? '',

  // Per-network factory contract IDs (Issue #1016)
  factoryContractIdTestnet:
    import.meta.env.VITE_FACTORY_CONTRACT_ID_TESTNET ??
    import.meta.env.VITE_FACTORY_CONTRACT_ID ??
    '',
  factoryContractIdMainnet:
    import.meta.env.VITE_FACTORY_CONTRACT_ID_MAINNET ?? '',
  factoryContractIdStandalone:
    import.meta.env.VITE_FACTORY_CONTRACT_ID_STANDALONE ?? '',

  // Per-network token WASM hashes (Issue #1016)
  tokenWasmHashTestnet:
    import.meta.env.VITE_TOKEN_WASM_HASH_TESTNET ??
    import.meta.env.VITE_TOKEN_WASM_HASH ??
    '',
  tokenWasmHashMainnet:
    import.meta.env.VITE_TOKEN_WASM_HASH_MAINNET ?? '',
  tokenWasmHashStandalone:
    import.meta.env.VITE_TOKEN_WASM_HASH_STANDALONE ?? '',

  // Explicit Mainnet Soroban RPC endpoint (Issue #1016)
  sorobanRpcUrlMainnet:
    import.meta.env.VITE_SOROBAN_RPC_URL_MAINNET ?? '',

  /*
   * Pinata credentials are deliberately absent. Vite inlines every `VITE_`
   * variable into the built JS, so reading them here published the key and
   * secret to every visitor (issue #921). They now live only in server env,
   * read by `api/_lib/pinata.ts`; the UI asks `/api/health/ipfs` whether
   * uploads are possible (see `useIpfsReady`).
   */
  /**
   * Off-chain indexer (issue #943). Defaults to **off**, so the app reads
   * directly from RPC unless a deployment explicitly opts in. Turning the flag
   * back off is the documented rollback: because the indexer is never a source
   * of truth, that loses speed, not data.
   */
  indexerEnabled: import.meta.env.VITE_INDEXER_ENABLED === 'true',
  /** Empty means same-origin, which is the normal Vercel deployment. */
  indexerBaseUrl: import.meta.env.VITE_INDEXER_BASE_URL ?? '',
} as const

export const isFactoryConfigured = (network?: 'testnet' | 'mainnet' | 'standalone'): boolean => {
  if (network === 'mainnet') return Boolean(ENV.factoryContractIdMainnet)
  if (network === 'standalone') return Boolean(ENV.factoryContractIdStandalone)
  return Boolean(ENV.factoryContractIdTestnet || ENV.factoryContractId)
}
export const isIndexerEnabled = (): boolean => ENV.indexerEnabled
