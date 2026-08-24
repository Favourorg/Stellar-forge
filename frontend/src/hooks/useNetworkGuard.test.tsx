import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useNetworkGuard } from './useNetworkGuard'

// ── Hook-level tests (mock useNetwork) ──────────────────────────────────────

let mockNetwork = 'testnet'
let mockMismatch = { isMismatch: false, freighterNetwork: null, refresh: vi.fn() }

vi.mock('../context/NetworkContext', async () => {
  const actual = await vi.importActual('../context/NetworkContext')
  return {
    ...(actual as object),
    useNetwork: () => ({
      network: mockNetwork,
      switchNetwork: vi.fn(),
      rpcUrl:
        mockNetwork === 'mainnet'
          ? 'https://soroban-mainnet.stellar.org'
          : 'https://soroban-testnet.stellar.org',
      horizonUrl:
        mockNetwork === 'mainnet'
          ? 'https://horizon.stellar.org'
          : 'https://horizon-testnet.stellar.org',
      networkPassphrase:
        mockNetwork === 'mainnet'
          ? 'Public Global Stellar Network ; September 2015'
          : 'Test SDF Network ; September 2015',
      mismatch: mockMismatch,
    }),
  }
})

describe('useNetworkGuard (hook level)', () => {
  beforeEach(() => {
    mockNetwork = 'testnet'
    mockMismatch = { isMismatch: false, freighterNetwork: null, refresh: vi.fn() }
  })

  it('returns blocked=false when network is stable and no mismatch', () => {
    const { result } = renderHook(() => useNetworkGuard())
    expect(result.current.blocked).toBe(false)
    expect(result.current.reason).toBeNull()
  })

  it('blocks when network drifts after mount', () => {
    // First render: captures testnet as baseline
    const { result, rerender } = renderHook(() => useNetworkGuard())
    expect(result.current.blocked).toBe(false)

    // Simulate network change (cross-tab storage event, or same-tab switch)
    mockNetwork = 'mainnet'
    rerender()

    expect(result.current.blocked).toBe(true)
    expect(result.current.reason).toContain('Network changed to mainnet')
    expect(result.current.reason).toContain('Review the token address')
  })

  it('blocks when Freighter mismatches the app network', () => {
    mockMismatch = { isMismatch: true, freighterNetwork: 'MAINNET', refresh: vi.fn() }

    const { result } = renderHook(() => useNetworkGuard())
    expect(result.current.blocked).toBe(true)
    expect(result.current.reason).toContain('Switch Freighter')
  })

  it('prioritizes drift over mismatch when both apply', () => {
    // First render captures testnet
    const { result, rerender } = renderHook(() => useNetworkGuard())

    // Network changed to mainnet AND Freighter is on standalone
    mockNetwork = 'mainnet'
    mockMismatch = { isMismatch: true, freighterNetwork: 'STANDALONE', refresh: vi.fn() }
    rerender()

    // Drift check comes first
    expect(result.current.blocked).toBe(true)
    expect(result.current.reason).toContain('Network changed to mainnet')
  })

  it('unblocks when re-mounted under the same network', () => {
    // First instance under testnet
    const { result: result1 } = renderHook(() => useNetworkGuard())
    expect(result1.current.blocked).toBe(false)

    // Hooks unmount, new instance under mainnet
    mockNetwork = 'mainnet'
    const { result: result2 } = renderHook(() => useNetworkGuard())
    expect(result2.current.blocked).toBe(false)
  })
})