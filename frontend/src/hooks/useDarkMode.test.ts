import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDarkMode } from './useDarkMode'

describe('useDarkMode', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  function setMatchMedia(matches: boolean) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: () => ({
        matches,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    })
  }

  it('falls back to OS preference when no stored preference exists', () => {
    setMatchMedia(true)
    const { result } = renderHook(() => useDarkMode())
    expect(result.current[0]).toBe(true)
  })

  it('persists preference to localStorage and survives remount', () => {
    setMatchMedia(false)
    const { result, unmount } = renderHook(() => useDarkMode())
    expect(result.current[0]).toBe(false)

    act(() => {
      result.current[1](true)
    })

    expect(window.localStorage.getItem('darkMode')).toBe(JSON.stringify(true))

    unmount()
    const { result: result2 } = renderHook(() => useDarkMode())
    expect(result2.current[0]).toBe(true)
  })
})
