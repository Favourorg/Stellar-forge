// e2e/network-mismatch.spec.ts
import { test, expect } from '@playwright/test'
import { mockSorobanRpc } from './helpers/rpc-mocks'
import { FREIGHTER_MAINNET, FREIGHTER_TESTNET, mockFreighter } from './helpers/wallet-mock'

const APP_URL = '/' // adjust to your dev server URL
const FACTORY_CONTRACT = 'G...FACTORY' // use a dummy ID (must be a valid StrKey)
const TOKEN_CONTRACT = 'G...TOKEN' // dummy token ID

test.describe('Network Mismatch Guard', () => {
  test.beforeEach(async ({ page }) => {
    // Set the app's expected network to TESTNET (default)
    await page.goto(APP_URL)
    await page.evaluate(() => {
      localStorage.setItem('stellarforge_network', 'TESTNET')
    })
    // Mock the RPC to avoid real calls
    await mockSorobanRpc(page, FACTORY_CONTRACT, TOKEN_CONTRACT)
  })

  test('should block MintForm when Freighter is on MAINNET', async ({ page }) => {
    await mockFreighter(page, 'G...USER', FREIGHTER_MAINNET)
    await page.goto(APP_URL)
    // Navigate to Mint form (adjust selectors to match your app)
    await page.click('text=Mint')
    await page.waitForSelector('button[type="submit"]')
    const submitBtn = page.locator('button[type="submit"]')
    await expect(submitBtn).toBeDisabled()
    // Also check for a warning message (if present)
    const warning = page.locator('text=Network mismatch')
    await expect(warning).toBeVisible()
  })

  test('should block BurnForm when Freighter is on MAINNET', async ({ page }) => {
    await mockFreighter(page, 'G...USER', FREIGHTER_MAINNET)
    await page.goto(APP_URL)
    await page.click('text=Burn')
    await page.waitForSelector('button[type="submit"]')
    await expect(page.locator('button[type="submit"]')).toBeDisabled()
  })

  test('should block SetMetadataForm when Freighter is on MAINNET', async ({ page }) => {
    await mockFreighter(page, 'G...USER', FREIGHTER_MAINNET)
    await page.goto(APP_URL)
    await page.click('text=Set Metadata')
    await page.waitForSelector('button[type="submit"]')
    await expect(page.locator('button[type="submit"]')).toBeDisabled()
  })

  test('should block AdminPanel actions when Freighter is on MAINNET', async ({ page }) => {
    await mockFreighter(page, 'G...USER', FREIGHTER_MAINNET)
    await page.goto(APP_URL)
    await page.click('text=Admin')
    await page.waitForSelector('button:has-text("Execute")')
    await expect(page.locator('button:has-text("Execute")')).toBeDisabled()
  })

  test('should block CreateToken (via TokenForm) when Freighter is on MAINNET', async ({
    page,
  }) => {
    await mockFreighter(page, 'G...USER', FREIGHTER_MAINNET)
    await page.goto(APP_URL)
    await page.click('text=Create Token')
    // TokenForm renders inside the CreateToken route; its submit button is disabled.
    await page.waitForSelector('button[type="submit"]')
    await expect(page.locator('button[type="submit"]')).toBeDisabled()
  })

  test('should allow all forms when Freighter matches the app network (TESTNET)', async ({
    page,
  }) => {
    // Default mock uses TESTNET
    await mockFreighter(page, 'G...USER', FREIGHTER_TESTNET)
    await page.goto(APP_URL)
    await page.click('text=Mint')
    await page.waitForSelector('button[type="submit"]')
    await expect(page.locator('button[type="submit"]')).toBeEnabled()
    // Similarly for others – you can add more checks.
  })
})
