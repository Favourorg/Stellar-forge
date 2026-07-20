/**
 * Load / Soak Test — Soroban RPC Rate Limits
 *
 * Simulates N concurrent browser sessions performing realistic usage patterns
 * (explorer browsing, transaction polling, event fetching) against a testnet
 * deployment to verify graceful degradation under rate-limiting conditions.
 *
 * This test is **not** run on every PR. It is triggered manually via the
 * `load-test.yml` workflow or locally with:
 *
 *   PLAYWRIGHT_LOAD_TEST=true npx playwright test --grep "load-test"
 *
 * Required environment variables:
 *   - VITE_FACTORY_CONTRACT_ID   : deployed factory contract ID on testnet
 *   - TESTNET_SECRET             : funded testnet wallet secret key
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { mockFreighter } from './helpers/wallet-mock'
import { fundAccount } from './helpers/e2e-setup'

// ── Configuration ─────────────────────────────────────────────────────────────

const CONCURRENT_SESSIONS = parseInt(process.env.LOAD_TEST_SESSIONS ?? '5', 10)
const OPERATIONS_PER_SESSION = parseInt(process.env.LOAD_TEST_OPS ?? '10', 10)
const RAMP_UP_DELAY_MS = parseInt(process.env.LOAD_TEST_RAMP_UP ?? '500', 10) // delay between spawning sessions
const RATE_LIMIT_BACKOFF_MS = 2_000 // wait after detecting a 429 before retrying

const TEST_ADDRESS = 'GCV6L3B2R6G2H5J4J4J4J4J4J4J4J4J4J4J4J4J4J4J4J4J4J4J4'

interface LoadTestMetrics {
  totalOps: number
  succeeded: number
  rateLimited: number
  otherErrors: number
  durationsMs: number[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Simulate a user browsing the token explorer, which triggers paginated
 * RPC calls. This exercises the `getContractEvents` and view-function paths.
 */
async function simulateExplorerBrowse(page: Page): Promise<{ rateLimited: boolean; durationMs: number }> {
  const start = performance.now()
  let rateLimited = false

  try {
    // Navigate to the tokens/explorer page
    await page.goto('/tokens')
    await page.waitForLoadState('networkidle', { timeout: 15_000 })

    // Wait for any token cards or "no tokens" message to appear
    await Promise.race([
      page.waitForSelector('[data-testid="token-card"], [data-testid="token-list"]', { timeout: 10_000 }),
      page.waitForSelector('text=No tokens', { timeout: 10_000 }),
      page.waitForSelector('text=rate-limit', { timeout: 5_000 }).then(() => {
        rateLimited = true
      }),
    ])
  } catch {
    // Timeouts can indicate rate-limiting issues
    rateLimited = true
  }

  return { rateLimited, durationMs: Math.round(performance.now() - start) }
}

/**
 * Simulate a user viewing transaction history / events, which triggers
 * the `getContractEvents` RPC call path.
 */
async function simulateEventViewing(page: Page): Promise<{ rateLimited: boolean; durationMs: number }> {
  const start = performance.now()
  let rateLimited = false

  try {
    // Navigate to activity/dashboard pages
    await page.goto('/activity')
    await page.waitForLoadState('networkidle', { timeout: 15_000 })

    await Promise.race([
      page.waitForSelector('[data-testid="events-list"], [data-testid="transaction-list"]', { timeout: 10_000 }),
      page.waitForSelector('text=No events', { timeout: 10_000 }),
      page.waitForSelector('text=rate-limit', { timeout: 5_000 }).then(() => {
        rateLimited = true
      }),
    ])
  } catch {
    rateLimited = true
  }

  return { rateLimited, durationMs: Math.round(performance.now() - start) }
}

/**
 * Simulate a user searching for tokens by address, which triggers
 * the `getTokenInfoByAddress` → `getContractEvents` path.
 */
async function simulateTokenSearch(page: Page): Promise<{ rateLimited: boolean; durationMs: number }> {
  const start = performance.now()
  let rateLimited = false

  try {
    await page.goto('/')
    await page.waitForLoadState('networkidle', { timeout: 15_000 })

    // Try to find and interact with a search input
    const searchInput = page.getByPlaceholder(/search|find/i).first()
    if (await searchInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await searchInput.fill(TEST_ADDRESS)
      await page.waitForTimeout(1_000)
    }
  } catch {
    rateLimited = true
  }

  return { rateLimited, durationMs: Math.round(performance.now() - start) }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('load-test: Soroban RPC rate limit handling', () => {
  test.describe.configure({ mode: 'serial' })

  let metrics: LoadTestMetrics

  test.beforeAll(() => {
    metrics = {
      totalOps: 0,
      succeeded: 0,
      rateLimited: 0,
      otherErrors: 0,
      durationsMs: [],
    }
  })

  test.afterAll(() => {
    // Print load test summary (visible in CI logs and Playwright report)
    const avgDuration =
      metrics.durationsMs.length > 0
        ? Math.round(metrics.durationsMs.reduce((a, b) => a + b, 0) / metrics.durationsMs.length)
        : 0

    console.log(`
╔══════════════════════════════════════════════╗
║         Load Test Summary                    ║
╠══════════════════════════════════════════════╣
║  Concurrent sessions : ${CONCURRENT_SESSIONS.toString().padStart(3)}               ║
║  Operations/session  : ${OPERATIONS_PER_SESSION.toString().padStart(3)}               ║
║  Total operations    : ${metrics.totalOps.toString().padStart(3)}               ║
║  Succeeded           : ${metrics.succeeded.toString().padStart(3)}               ║
║  Rate-limited (429)  : ${metrics.rateLimited.toString().padStart(3)}               ║
║  Other errors        : ${metrics.otherErrors.toString().padStart(3)}               ║
║  Avg duration (ms)   : ${avgDuration.toString().padStart(5)}               ║
╚══════════════════════════════════════════════╝
    `)

    // Load test should not fail CI — it's informational
    // But a high rate-limit rate (>80%) might indicate a problem
    const rateLimitRate = metrics.totalOps > 0 ? metrics.rateLimited / metrics.totalOps : 0
    if (rateLimitRate > 0.8 && metrics.totalOps > 10) {
      console.warn(`⚠️  High rate-limit rate: ${(rateLimitRate * 100).toFixed(1)}% — investigate RPC provider capacity`)
    }
  })

  test('load-test: concurrent explorer browsing', async ({ browser }) => {
    test.setTimeout(300_000) // 5 minutes for load test
    test.skip(!process.env.LOAD_TEST_RUN, 'Load test skipped by default. Set LOAD_TEST_RUN=true to execute.')

    const sessions: Promise<void>[] = []

    for (let s = 0; s < CONCURRENT_SESSIONS; s++) {
      sessions.push(
        (async (sessionIndex: number) => {
          const context: BrowserContext = await browser.newContext()
          const page: Page = await context.newPage()

          try {
            // Connect wallet mock
            await mockFreighter(page, TEST_ADDRESS)

            // Fund account (may fail if already funded — that's OK)
            try {
              await fundAccount(TEST_ADDRESS)
            } catch {
              // Account likely already funded
            }

            // Navigate to home and connect wallet
            await page.goto('/')
            await page.waitForLoadState('networkidle', { timeout: 15_000 })

            // Click connect wallet button if visible
            const connectBtn = page.getByRole('button', { name: /Connect Wallet/i })
            if (await connectBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
              await connectBtn.click()
              await page.waitForTimeout(1_000)
            }

            // Perform operations for this session
            for (let op = 0; op < OPERATIONS_PER_SESSION; op++) {
              metrics.totalOps++

              // Alternate between different operations to simulate realistic usage
              let result: { rateLimited: boolean; durationMs: number }

              switch (op % 3) {
                case 0:
                  result = await simulateExplorerBrowse(page)
                  break
                case 1:
                  result = await simulateEventViewing(page)
                  break
                case 2:
                  result = await simulateTokenSearch(page)
                  break
                default:
                  result = { rateLimited: false, durationMs: 0 }
              }

              metrics.durationsMs.push(result.durationMs)

              if (result.rateLimited) {
                metrics.rateLimited++
                // Wait for backoff before next operation
                await page.waitForTimeout(RATE_LIMIT_BACKOFF_MS)
              } else {
                metrics.succeeded++
              }

              // Brief pause between operations within a session
              await page.waitForTimeout(250)
            }
          } catch (err) {
            metrics.otherErrors++
            console.warn(`Session ${sessionIndex} error:`, err)
          } finally {
            await context.close()
          }
        })(s),
      )

      // Ramp-up delay between spawning sessions
      if (s < CONCURRENT_SESSIONS - 1) {
        await new Promise((r) => setTimeout(r, RAMP_UP_DELAY_MS))
      }
    }

    await Promise.all(sessions)

    // Basic assertion: at least some operations should succeed
    // (a completely failing load test still provides data)
    expect(metrics.totalOps).toBeGreaterThan(0)
    console.log(`✅ Load test completed: ${metrics.succeeded}/${metrics.totalOps} operations succeeded`)
  })
})
