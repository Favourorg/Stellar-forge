import { renderHook, act } from '@testing-library/react'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { useTransaction } from './useTransaction'

describe('useTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('starts in idle state', () => {
    const builder = vi.fn()
    const { result } = renderHook(() => useTransaction(builder))
    expect(result.current.status).toBe('idle')
    expect(result.current.result).toBeNull()
    expect(result.current.error).toBeNull()
  })

  test('transitions through statuses on success', async () => {
    const builder = vi.fn().mockImplementation(async (onStatus) => {
      onStatus('simulating')
      onStatus('signing')
      onStatus('submitting')
      return 'tx-hash-123'
    })

    const { result } = renderHook(() => useTransaction(builder))

    await act(async () => {
      await result.current.execute()
    })

    expect(result.current.status).toBe('success')
    expect(result.current.result).toBe('tx-hash-123')
    expect(result.current.error).toBeNull()
  })

  test('sets error state on failure', async () => {
    const builder = vi.fn().mockRejectedValue(new Error('Transaction failed'))

    const { result } = renderHook(() => useTransaction(builder))

    await act(async () => {
      try {
        await result.current.execute()
      } catch {
        // expected
      }
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error?.message).toBe('Transaction failed')
    expect(result.current.result).toBeNull()
  })

  test('reset clears state back to idle', async () => {
    const builder = vi.fn().mockResolvedValue('tx-hash')

    const { result } = renderHook(() => useTransaction(builder))

    await act(async () => {
      await result.current.execute()
    })

    expect(result.current.status).toBe('success')

    act(() => {
      result.current.reset()
    })

    expect(result.current.status).toBe('idle')
    expect(result.current.result).toBeNull()
    expect(result.current.error).toBeNull()
  })
})
