/**
 * Analytics opt-out tests — issue #948
 *
 * These tests prove that:
 *  1. When opt-out is set, ZERO analytics events are dispatched.
 *  2. Opt-out takes effect IMMEDIATELY (in-session, no reload required).
 *  3. Opt-in restores normal event dispatching.
 *  4. Missing VITE_PLAUSIBLE_DOMAIN also suppresses all events.
 *  5. Every public tracking call site (trackEvent, trackPageView) is covered.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isOptedOut, setOptOut, trackEvent, trackPageView } from './analytics'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Install a spy on window.plausible and return it. */
function stubPlausible() {
  const spy = vi.fn()
  window.plausible = spy
  return spy
}

/** Remove window.plausible so "not configured" tests work cleanly. */
function removePlausible() {
  delete window.plausible
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear()
  // Default: plausible domain IS configured so tests can focus on opt-out logic.
  vi.stubEnv('VITE_PLAUSIBLE_DOMAIN', 'example.com')
})

afterEach(() => {
  localStorage.clear()
  removePlausible()
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// isOptedOut / setOptOut
// ---------------------------------------------------------------------------

describe('isOptedOut', () => {
  it('returns false when localStorage is empty', () => {
    expect(isOptedOut()).toBe(false)
  })

  it('returns true when opt-out flag is set to "true"', () => {
    localStorage.setItem('analytics_opt_out', 'true')
    expect(isOptedOut()).toBe(true)
  })

  it('returns false when opt-out flag has any other value', () => {
    localStorage.setItem('analytics_opt_out', '1')
    expect(isOptedOut()).toBe(false)
  })
})

describe('setOptOut', () => {
  it('sets opt-out flag in localStorage when called with true', () => {
    setOptOut(true)
    expect(localStorage.getItem('analytics_opt_out')).toBe('true')
    expect(isOptedOut()).toBe(true)
  })

  it('removes opt-out flag from localStorage when called with false', () => {
    localStorage.setItem('analytics_opt_out', 'true')
    setOptOut(false)
    expect(localStorage.getItem('analytics_opt_out')).toBeNull()
    expect(isOptedOut()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// trackEvent — opt-out suppression
// ---------------------------------------------------------------------------

describe('trackEvent', () => {
  it('fires window.plausible when analytics is enabled and user has NOT opted out', () => {
    const plausible = stubPlausible()
    trackEvent('token_created', { symbol: 'TEST' })
    expect(plausible).toHaveBeenCalledOnce()
    expect(plausible).toHaveBeenCalledWith('token_created', { props: { symbol: 'TEST' } })
  })

  it('does NOT fire window.plausible when user opts out BEFORE the call', () => {
    const plausible = stubPlausible()
    setOptOut(true)
    trackEvent('token_created')
    expect(plausible).not.toHaveBeenCalled()
  })

  it('suppresses events IMMEDIATELY after opt-out — no reload required', () => {
    const plausible = stubPlausible()

    // First call fires normally
    trackEvent('page_view')
    expect(plausible).toHaveBeenCalledTimes(1)

    // Opt-out mid-session
    setOptOut(true)

    // Subsequent calls in the same session are suppressed instantly
    trackEvent('token_created')
    trackEvent('mint_tokens')
    expect(plausible).toHaveBeenCalledTimes(1) // no additional calls
  })

  it('resumes firing after user opts back in — immediate in-session effect', () => {
    const plausible = stubPlausible()

    setOptOut(true)
    trackEvent('page_view')
    expect(plausible).toHaveBeenCalledTimes(0)

    // Opt back in during the same session
    setOptOut(false)
    trackEvent('token_created')
    expect(plausible).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire when VITE_PLAUSIBLE_DOMAIN is not set', () => {
    vi.stubEnv('VITE_PLAUSIBLE_DOMAIN', '')
    const plausible = stubPlausible()
    trackEvent('token_created')
    expect(plausible).not.toHaveBeenCalled()
  })

  it('passes event props correctly to plausible', () => {
    const plausible = stubPlausible()
    trackEvent('mint', { amount: 1000, symbol: 'XLM', success: true })
    expect(plausible).toHaveBeenCalledWith('mint', {
      props: { amount: 1000, symbol: 'XLM', success: true },
    })
  })

  it('calls plausible with no second argument when props is omitted', () => {
    const plausible = stubPlausible()
    trackEvent('wallet_connect')
    expect(plausible).toHaveBeenCalledWith('wallet_connect', undefined)
  })

  it('does not throw when window.plausible is undefined', () => {
    removePlausible()
    expect(() => trackEvent('token_created')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// trackPageView — opt-out suppression
// ---------------------------------------------------------------------------

describe('trackPageView', () => {
  it('fires window.plausible when user has NOT opted out', () => {
    const plausible = stubPlausible()
    trackPageView('/create')
    expect(plausible).toHaveBeenCalledOnce()
    expect(plausible).toHaveBeenCalledWith('pageview', {
      u: `${window.location.origin}/create`,
    })
  })

  it('does NOT fire window.plausible when user opts out BEFORE the call', () => {
    const plausible = stubPlausible()
    setOptOut(true)
    trackPageView('/create')
    expect(plausible).not.toHaveBeenCalled()
  })

  it('suppresses page-view events IMMEDIATELY after opt-out — no reload required', () => {
    const plausible = stubPlausible()

    trackPageView('/')
    expect(plausible).toHaveBeenCalledTimes(1)

    // Opt-out mid-session
    setOptOut(true)

    trackPageView('/create')
    trackPageView('/tokens')
    expect(plausible).toHaveBeenCalledTimes(1) // no new calls
  })

  it('does NOT fire when VITE_PLAUSIBLE_DOMAIN is not set', () => {
    vi.stubEnv('VITE_PLAUSIBLE_DOMAIN', '')
    const plausible = stubPlausible()
    trackPageView('/create')
    expect(plausible).not.toHaveBeenCalled()
  })

  it('does not throw when window.plausible is undefined', () => {
    removePlausible()
    expect(() => trackPageView('/create')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Full session simulation: every tracking call site suppressed after opt-out
// ---------------------------------------------------------------------------

describe('opt-out suppresses ALL tracking call sites for the remainder of the session', () => {
  it('zero analytics events dispatched after opt-out across every call site', () => {
    const plausible = stubPlausible()

    // --- Phase 1: analytics active, events fire normally ---
    trackPageView('/')
    trackEvent('wallet_connect')
    trackEvent('token_created', { symbol: 'ABC' })
    trackPageView('/tokens')
    trackEvent('mint_tokens', { amount: 500 })

    const callsBeforeOptOut = plausible.mock.calls.length
    expect(callsBeforeOptOut).toBe(5)

    // --- Phase 2: user opts out (mid-session) ---
    setOptOut(true)

    // --- Phase 3: every call site fires — none should reach plausible ---
    trackPageView('/create') // App.tsx call site
    trackEvent('token_created') // generic trackEvent
    trackPageView('/mint') // another page view
    trackEvent('burn_tokens') // generic trackEvent
    trackEvent('metadata_set') // generic trackEvent

    // Plausible call count must NOT have increased
    expect(plausible.mock.calls.length).toBe(callsBeforeOptOut)
  })
})
