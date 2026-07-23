/**
 * AnalyticsOptOut component tests — issue #948
 *
 * Verifies that the opt-out checkbox:
 *  - Renders only when VITE_PLAUSIBLE_DOMAIN is configured.
 *  - Correctly reflects the current opt-out state.
 *  - Toggles opt-out on change and suppresses events immediately.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AnalyticsOptOut } from './AnalyticsOptOut'
import { isOptedOut, trackEvent } from '../services/analytics'

beforeEach(() => {
  localStorage.clear()
  vi.stubEnv('VITE_PLAUSIBLE_DOMAIN', 'example.com')
})

afterEach(() => {
  localStorage.clear()
  delete window.plausible
  vi.unstubAllEnvs()
})

describe('AnalyticsOptOut component', () => {
  it('renders the opt-out checkbox when VITE_PLAUSIBLE_DOMAIN is set', () => {
    render(<AnalyticsOptOut />)
    expect(screen.getByRole('checkbox', { name: /opt out of analytics/i })).toBeInTheDocument()
  })

  it('renders nothing when VITE_PLAUSIBLE_DOMAIN is not configured', () => {
    vi.stubEnv('VITE_PLAUSIBLE_DOMAIN', '')
    const { container } = render(<AnalyticsOptOut />)
    expect(container.firstChild).toBeNull()
  })

  it('checkbox is unchecked when user has NOT opted out', () => {
    render(<AnalyticsOptOut />)
    const checkbox = screen.getByRole('checkbox', { name: /opt out of analytics/i })
    expect(checkbox).not.toBeChecked()
  })

  it('checkbox is checked when user HAS opted out (persisted in localStorage)', () => {
    localStorage.setItem('analytics_opt_out', 'true')
    render(<AnalyticsOptOut />)
    const checkbox = screen.getByRole('checkbox', { name: /opt out of analytics/i })
    expect(checkbox).toBeChecked()
  })

  it('checking the checkbox opts the user out immediately (persisted + service updated)', () => {
    render(<AnalyticsOptOut />)
    const checkbox = screen.getByRole('checkbox', { name: /opt out of analytics/i })

    fireEvent.click(checkbox)

    expect(checkbox).toBeChecked()
    expect(isOptedOut()).toBe(true)
    expect(localStorage.getItem('analytics_opt_out')).toBe('true')
  })

  it('un-checking the checkbox opts the user back in immediately', () => {
    localStorage.setItem('analytics_opt_out', 'true')
    render(<AnalyticsOptOut />)
    const checkbox = screen.getByRole('checkbox', { name: /opt out of analytics/i })

    fireEvent.click(checkbox)

    expect(checkbox).not.toBeChecked()
    expect(isOptedOut()).toBe(false)
    expect(localStorage.getItem('analytics_opt_out')).toBeNull()
  })

  it('analytics events are suppressed immediately after checking the opt-out box — no reload required', () => {
    const plausible = vi.fn()
    window.plausible = plausible

    render(<AnalyticsOptOut />)
    const checkbox = screen.getByRole('checkbox', { name: /opt out of analytics/i })

    // Opt out via UI
    fireEvent.click(checkbox)

    // Any tracking call fired in the same session is suppressed
    trackEvent('should_be_suppressed')
    expect(plausible).not.toHaveBeenCalled()
  })

  it('analytics events fire again after un-checking the opt-out box', () => {
    localStorage.setItem('analytics_opt_out', 'true')
    const plausible = vi.fn()
    window.plausible = plausible

    render(<AnalyticsOptOut />)
    const checkbox = screen.getByRole('checkbox', { name: /opt out of analytics/i })

    // Opt back in via UI
    fireEvent.click(checkbox)

    trackEvent('should_fire')
    expect(plausible).toHaveBeenCalledOnce()
  })

  it('has an accessible aria-label on the checkbox', () => {
    render(<AnalyticsOptOut />)
    const checkbox = screen.getByRole('checkbox', { name: /opt out of analytics/i })
    expect(checkbox).toHaveAttribute('aria-label', 'Opt out of analytics')
  })
})
