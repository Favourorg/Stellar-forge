# Codebase Audit Issues — 2026-08

This file tracks issues identified during the August 2026 codebase audit (30 issues total).

| # | Area | Severity | Title | Status |
|---|------|----------|-------|--------|
| 1 | — | — | *(pending)* | Open |
| 2 | — | — | *(pending)* | Open |
| 3 | — | — | *(pending)* | Open |
| 4 | — | — | *(pending)* | Open |
| 5 | — | — | *(pending)* | Open |
| 6 | — | — | *(pending)* | Open |
| 7 | — | — | *(pending)* | Open |
| 8 | — | — | *(pending)* | Open |
| 9 | — | — | *(pending)* | Open |
| 10 | — | — | *(pending)* | Open |
| 11 | — | — | *(pending)* | Open |
| 12 | — | — | *(pending)* | Open |
| 13 | — | — | *(pending)* | Open |
| 14 | — | — | *(pending)* | Open |
| 15 | — | — | *(pending)* | Open |
| 16 | — | — | *(pending)* | Open |
| 17 | — | — | *(pending)* | Open |
| 18 | — | — | *(pending)* | Open |
| 19 | — | — | *(pending)* | Open |
| 20 | — | — | *(pending)* | Open |
| 21 | — | — | *(pending)* | Open |
| 22 | — | — | *(pending)* | Open |
| 23 | — | — | *(pending)* | Open |
| 24 | — | — | *(pending)* | Open |
| 25 | — | — | *(pending)* | Open |
| **26** | **API (`api/_lib/rateLimit.ts`)** | **Medium-Low** | **`clientIp()` had inverted/incorrect X-Forwarded-For parsing** | **✅ Resolved** |
| 27 | — | — | *(pending)* | Open |
| 28 | — | — | *(pending)* | Open |
| 29 | — | — | *(pending)* | Open |
| 30 | — | — | *(pending)* | Open |

---

## Issue 26 — `clientIp()` had inverted/incorrect X-Forwarded-For parsing

**Area:** API (`api/_lib/rateLimit.ts`)  
**Severity:** Medium-Low  
**Status:** ✅ Resolved

### Description

`clientIp()` (formerly at `rateLimit.ts:93–105`) took the **rightmost** entry of a
comma-separated `X-Forwarded-For` header as the trusted client IP. The inline comment
showed `"203.0.113.1, 10.0.0.1" -> use "10.0.0.1" (Vercel's edge)"` — treating what
appears to be a private/internal address as the "trusted client IP."

This was wrong in two compounding ways:

1. **Standard XFF semantics**: The client IP is the **leftmost** entry; subsequent entries
   are proxies appended in order. Taking the rightmost yields a proxy IP, not the client.
2. **Vercel's actual behaviour**: [Vercel's documentation](https://vercel.com/docs/headers/request-headers#x-forwarded-for)
   states that `x-forwarded-for` contains *"The public IP address of the client that made
   the request"* and that Vercel **overwrites** the header (does not forward external IPs)
   to prevent IP spoofing. On Vercel, the header is always a single IP — the real client
   IP — making multi-hop parsing entirely moot.

The function was **not called anywhere** in `api/`, so there was no active bug, but it
was a latent security issue: if it had been wired into an unauthenticated endpoint
(e.g., issue #1101's IP-based rate limiting on `/api/auth/challenge`) without correction,
it would have either failed to distinguish clients or been trivially spoofable.

### Resolution

`clientIp()` and its associated `VercelRequest` import were **removed** from
`rateLimit.ts` as dead code. The corresponding tests in `rateLimit.test.ts` (which
pinned the unverified direction and would have stayed green even if the parsing was
backwards) were also removed.

The remaining four `isRateLimited` tests continue to pass.

### Follow-up

If IP-based rate limiting is needed in the future (e.g., for issue #1101), re-add a
`clientIp()` helper that reads `req.headers['x-forwarded-for']` directly as a single
string (Vercel's documented behaviour), with a fallback to `x-real-ip` or
`req.socket.remoteAddress`. Do **not** attempt multi-hop parsing unless deploying behind
a custom proxy with Vercel's Enterprise Trusted Proxy feature enabled.
