import { describe, it, expect, vi, beforeEach } from 'vitest'

// Helper to re-import env module with specific env vars
async function loadEnv(vars: Record<string, string>) {
  vi.stubEnv('VITE_FACTORY_CONTRACT_ID', vars.VITE_FACTORY_CONTRACT_ID ?? '')
  vi.stubEnv('VITE_IPFS_API_KEY', vars.VITE_IPFS_API_KEY ?? '')
  vi.stubEnv('VITE_IPFS_API_SECRET', vars.VITE_IPFS_API_SECRET ?? '')
  // Force re-evaluation by resetting module registry
  vi.resetModules()
  return import('../config/env')
}

describe('env config', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('isFactoryConfigured returns false when VITE_FACTORY_CONTRACT_ID is empty', async () => {
    const { isFactoryConfigured } = await loadEnv({ VITE_FACTORY_CONTRACT_ID: '' })
    expect(isFactoryConfigured()).toBe(false)
  })

  it('isFactoryConfigured returns true when VITE_FACTORY_CONTRACT_ID is set', async () => {
    const { isFactoryConfigured } = await loadEnv({ VITE_FACTORY_CONTRACT_ID: 'CABC123' })
    expect(isFactoryConfigured()).toBe(true)
  })

  // Issue #921. Vite inlines every VITE_-prefixed variable into the built
  // bundle, so anything ENV reads from one is readable by every visitor.
  // Pinata credentials must never make that trip: they belong to the server
  // (PINATA_API_KEY / PINATA_API_SECRET, read by api/_lib/pinata.ts).
  it('never carries Pinata credentials, even when the VITE_ vars are set', async () => {
    const { ENV } = await loadEnv({
      VITE_IPFS_API_KEY: 'leaked-key',
      VITE_IPFS_API_SECRET: 'leaked-secret',
    })

    const serialised = JSON.stringify(ENV)
    expect(serialised).not.toContain('leaked-key')
    expect(serialised).not.toContain('leaked-secret')
  })

  it('exposes no IPFS-credential helper for components to gate on', async () => {
    // `isIpfsConfigured()` derived upload availability from client-side
    // secrets, which is what made shipping them look necessary. Readiness now
    // comes from the server via useIpfsReady() → GET /api/health/ipfs.
    const mod = await loadEnv({})
    expect(mod).not.toHaveProperty('isIpfsConfigured')
  })

  // Issue #1016: Per-network contract identity and explicit mainnet RPC
  it('resolves per-network factory contract IDs independently', async () => {
    vi.stubEnv('VITE_FACTORY_CONTRACT_ID_TESTNET', 'CTESTNET123')
    vi.stubEnv('VITE_FACTORY_CONTRACT_ID_MAINNET', 'CMAINNET456')
    vi.stubEnv('VITE_SOROBAN_RPC_URL_MAINNET', 'https://mainnet-rpc.example.com')
    vi.resetModules()

    const { ENV, isFactoryConfigured } = await import('../config/env')
    expect(ENV.factoryContractIdTestnet).toBe('CTESTNET123')
    expect(ENV.factoryContractIdMainnet).toBe('CMAINNET456')
    expect(ENV.sorobanRpcUrlMainnet).toBe('https://mainnet-rpc.example.com')

    expect(isFactoryConfigured('testnet')).toBe(true)
    expect(isFactoryConfigured('mainnet')).toBe(true)
    expect(isFactoryConfigured('standalone')).toBe(false)
  })

  it('falls back to VITE_FACTORY_CONTRACT_ID for testnet if VITE_FACTORY_CONTRACT_ID_TESTNET is unset', async () => {
    vi.stubEnv('VITE_FACTORY_CONTRACT_ID', 'CLEGACY789')
    vi.resetModules()

    const { ENV, isFactoryConfigured } = await import('../config/env')
    expect(ENV.factoryContractIdTestnet).toBe('CLEGACY789')
    expect(isFactoryConfigured('testnet')).toBe(true)
    expect(isFactoryConfigured('mainnet')).toBe(false)
  })
})
