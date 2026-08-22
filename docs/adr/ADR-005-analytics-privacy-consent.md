# ADR-005: Analytics Privacy and Consent (Plausible + Opt-Out)

**Status:** Accepted  
**Date:** 2026-07-17  
**Relates to:** [Issue #948](https://github.com/Favourorg/Stellar-forge/issues/948)

---

## Context

StellarForge includes a lightweight analytics integration using
[Plausible](https://plausible.io) — a privacy-first, cookieless analytics
provider.  Plausible collects no PII, sets no cookies, and is GDPR-compliant
by design.

Nonetheless, the app includes an explicit opt-out mechanism
(`AnalyticsOptOut.tsx`) because:

1. **GDPR (EU)** — Art. 6(1)(f) legitimate interest only applies where the
   user's interests do not override the controller's.  Providing an easy
   opt-out is a common mitigation and aligns with the spirit of data
   minimisation.
2. **CCPA (California)** — Users have the right to opt out of the "sale" or
   "sharing" of personal information.  Even though Plausible collects
   aggregate data that is not personal information, offering an opt-out
   satisfies the broadest reasonable reading of the CCPA requirement.
3. **User trust** — Explicit opt-out UI signals transparency and builds trust
   with the developer community that uses this dApp.

---

## Decision

### Provider: Plausible

Plausible was chosen for analytics because:

- No cookies, no cross-site tracking, no fingerprinting.
- Aggregated statistics only — no individual user profiles.
- Self-hostable; the `VITE_PLAUSIBLE_DOMAIN` env var gates the entire
  analytics subsystem.  If the var is unset (e.g., in development, tests,
  or a self-hosted deployment that opts out entirely), **zero** analytics
  calls are made.

### Opt-out mechanism

The opt-out preference is stored in `localStorage` under the key
`analytics_opt_out`.  The analytics service (`src/services/analytics.ts`)
reads this key on **every** tracking call via `isOptedOut()`:

```
isEnabled() → !isOptedOut() && VITE_PLAUSIBLE_DOMAIN configured
```

This means opt-out takes effect **immediately in the current session** —
no page reload is required.  A user who toggles the opt-out checkbox
mid-session will have all subsequent analytics calls suppressed within
the same page load.

### What is tracked

Only two categories of events are tracked:

| Event | Call site | Contains PII? |
|-------|-----------|---------------|
| `pageview` | `App.tsx` `useEffect` on route change | No — path only (e.g. `/create`) |
| Custom events (`token_created`, `mint_tokens`, etc.) | `trackEvent()` callers | No — event name + optional non-PII props |

**Wallet addresses are never included in analytics events.** This is
enforced by code review and by the `trackEvent` type signature which
accepts only `string | number | boolean` props (no complex objects that
could accidentally include addresses).

---

## Regulatory compliance analysis

| Requirement | Satisfied? | How |
|-------------|-----------|-----|
| No PII collected | ✅ | Plausible design + prop type constraint |
| No cookies | ✅ | Plausible is cookieless by default |
| Opt-out available | ✅ | `AnalyticsOptOut` component in app footer |
| Opt-out persisted | ✅ | `localStorage` (survives reload) |
| Opt-out takes effect immediately | ✅ | `isOptedOut()` read on every call |
| Opt-out backed by tests | ✅ | `analytics.test.ts`, `useAnalytics.test.ts`, `AnalyticsOptOut.test.tsx` |
| New bypass call sites detected | ✅ | `scripts/check-analytics-bypass.mjs` (CI-enforced) |
| Analytics disabled when unconfigured | ✅ | `VITE_PLAUSIBLE_DOMAIN` guard |

---

## Consequences

- Any new tracking call site **must** go through `trackEvent()` or
  `trackPageView()` from `src/services/analytics.ts`.  Direct use of
  `window.plausible` bypasses the consent check and is blocked by the
  CI lint rule (`npm run check:analytics-bypass`).
- To add a new allowed caller that imports from `services/analytics`
  directly (as `App.tsx` does for page-view tracking), add it to
  `ALLOWED_PATHS` in `scripts/check-analytics-bypass.mjs` with a comment
  justifying the exception.
- Removing or weakening the opt-out check in `isEnabled()` / `isOptedOut()`
  requires updating this ADR and the test suite.
