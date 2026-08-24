import { describe, it, expect } from 'vitest'
import { buildCSPString, CSP_DIRECTIVES, type CSPDirectives } from '../../csp/policy'
import { NETWORK_CONFIGS } from '../../config/stellar'

describe('buildCSPString', () => {
  it('serializes directives into a valid CSP string', () => {
    const directives: CSPDirectives = {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'font-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': [],
      'worker-src': ['blob:'],
    }
    const result = buildCSPString(directives)
    expect(result).toContain("default-src 'self'")
    expect(result).toContain("script-src 'self'")
    expect(result).toContain('upgrade-insecure-requests')
    // bare keyword — no trailing space
    expect(result).not.toMatch(/upgrade-insecure-requests\s+;/)
  })

  it('never includes unsafe-inline or unsafe-eval in script-src', () => {
    const result = buildCSPString(CSP_DIRECTIVES)
    const scriptSrcMatch = result.match(/script-src ([^;]+)/)
    const scriptSrc = scriptSrcMatch?.[1] ?? ''
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'unsafe-eval'")
  })

  it('style-src no longer includes unsafe-inline', () => {
    const result = buildCSPString(CSP_DIRECTIVES)
    const styleSrcMatch = result.match(/style-src ([^;]+)/)
    expect(styleSrcMatch).not.toBeNull()
    if (styleSrcMatch) {
      const styleSrc = styleSrcMatch[1]
      expect(styleSrc).not.toContain("'unsafe-inline'")
      expect(styleSrc).toContain("'self'")
    }
  })

  it('includes all required connect-src origins', () => {
    const result = buildCSPString(CSP_DIRECTIVES)
    expect(result).toContain('https://horizon.stellar.org')
    expect(result).toContain('https://horizon-testnet.stellar.org')
    expect(result).toContain('https://soroban-testnet.stellar.org')
    expect(result).toContain('https://api.pinata.cloud')
    expect(result).toContain('https://*.ingest.sentry.io')
  })

  it('connect-src matches the exact RPC and Horizon URLs in config/stellar.ts (testnet + mainnet)', () => {
    // Regression guard: the CSP must never drift from the URLs the app actually
    // issues requests to. Pulling them from the config (rather than hardcoding)
    // makes this test fail on the *next* host change, not the current one.
    const connectSrc = CSP_DIRECTIVES['connect-src'].join(' ')

    for (const network of ['testnet', 'mainnet'] as const) {
      const { horizonUrl, sorobanRpcUrl } = NETWORK_CONFIGS[network]
      expect(connectSrc, `${network} horizonUrl`).toContain(horizonUrl)
      expect(connectSrc, `${network} sorobanRpcUrl`).toContain(sorobanRpcUrl)
    }
  })

  it('connect-src disallows the stale rpc-mainnet.stellar.org host', () => {
    const connectSrc = CSP_DIRECTIVES['connect-src'].join(' ')
    expect(connectSrc).not.toContain('rpc-mainnet.stellar.org')
  })

  it('connect-src contains the correct mainnet Soroban RPC host', () => {
    const connectSrc = CSP_DIRECTIVES['connect-src'].join(' ')
    expect(connectSrc).toContain('https://soroban-mainnet.stellar.org')
  })

  it('emits upgrade-insecure-requests as a bare keyword', () => {
    const result = buildCSPString(CSP_DIRECTIVES)
    expect(result).toMatch(/(^|; )upgrade-insecure-requests(;|$)/)
  })
})
