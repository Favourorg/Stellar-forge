import { describe, it, expect, vi, beforeEach } from 'vitest'

// Helper to re-import env module with specific env vars
async function loadEnv(vars: Record<string, string>) {
  vi.stubEnv('VITE_FACTORY_CONTRACT_ID', vars.VITE_FACTORY_CONTRACT_ID ?? '')
  for (const [key, value] of Object.entries(vars)) {
    if (key !== 'VITE_FACTORY_CONTRACT_ID') vi.stubEnv(key, value)
  }
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

  // Pinata credentials live server-side (api/ipfs/*), so the client can't and
  // shouldn't inspect them. isIpfsConfigured now only reports whether this
  // deployment advertises a working upload proxy.
  it('isIpfsConfigured defaults to true when the flag is unset', async () => {
    const { isIpfsConfigured } = await loadEnv({})
    expect(isIpfsConfigured()).toBe(true)
  })

  it('isIpfsConfigured returns false when explicitly disabled', async () => {
    const { isIpfsConfigured } = await loadEnv({ VITE_IPFS_ENABLED: 'false' })
    expect(isIpfsConfigured()).toBe(false)
  })

  it('does not expose Pinata credentials to the client bundle', async () => {
    const { ENV } = await loadEnv({
      VITE_IPFS_API_KEY: 'key',
      VITE_IPFS_API_SECRET: 'secret',
    })
    expect(Object.keys(ENV)).not.toContain('ipfsApiKey')
    expect(Object.keys(ENV)).not.toContain('ipfsApiSecret')
    expect(JSON.stringify(ENV)).not.toContain('secret')
  })
})
