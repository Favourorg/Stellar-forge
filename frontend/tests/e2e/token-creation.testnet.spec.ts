import { test, expect, type Page } from '@playwright/test'
import { Keypair, Transaction, Networks } from 'stellar-sdk'
import { fundAccount } from './helpers/e2e-setup'
import './helpers/wallet-mock' // augments the global Window type with `freighter`

declare global {
  interface Window {
    signWithSecret?: (xdr: string) => Promise<{ signedTxXdr: string }>
  }
}

// Use TESTNET_SECRET exposed by CI as E2E_TESTNET_WALLET_SECRET or TESTNET_SECRET
const SECRET = process.env.TESTNET_SECRET || process.env.E2E_TESTNET_WALLET_SECRET

test.describe('Token Creation (testnet)', () => {
  if (!SECRET) {
    test.skip(true, 'Testnet secret not provided; skipping live test')
    return
  }

  const keypair = Keypair.fromSecret(SECRET)
  const ADDRESS = keypair.publicKey()

  test.beforeEach(async ({ page }: { page: Page }) => {
    // Expose a Node-side signer to the browser context so the app can call
    // `freighter.signTransaction` and receive a correctly-signed XDR.
    await page.exposeFunction('signWithSecret', async (xdr: string) => {
      // Sign the XDR using the provided secret in the test runner (Node)
      const tx = new Transaction(xdr, Networks.TESTNET)
      tx.sign(keypair)
      return { signedTxXdr: tx.toXDR() }
    })

    // Mock the Freighter API in the page and delegate signing to `signWithSecret`.
    await page.addInitScript((addr: string) => {
      window.freighter = {
        isConnected: () => Promise.resolve({ isConnected: true }),
        getAddress: () => Promise.resolve({ address: addr }),
        requestAccess: () => Promise.resolve({ address: addr }),
        signTransaction: (xdr: string) =>
          window.signWithSecret?.(xdr) ?? Promise.reject(new Error('signWithSecret not exposed')),
        getNetwork: () => Promise.resolve({ network: 'TESTNET' }),
      }
    }, ADDRESS)

    // Ensure the account has test XLM
    try {
      await fundAccount(ADDRESS)
    } catch (e) {
      console.warn('Friendbot funding failed (may already be funded):', e)
    }

    await page.goto('/')
    await page.getByRole('button', { name: /Connect Wallet/i }).click()
  })

  test('deploys a token and shows deployed address', async ({ page }: { page: Page }) => {
    await page.getByRole('link', { name: /Create Token/i }).first().click()

    await page.getByLabel(/Token Name/i).fill('E2E Test Token')
    await page.getByLabel(/Token Symbol/i).fill('E2ET')
    await page.getByLabel(/Initial Supply/i).fill('10')
    await page.getByLabel(/Decimals/i).fill('7')

    await page.getByRole('button', { name: /Create/i }).click()

    // Deployment on testnet can take a while; increase timeout
    await expect(page.getByText(ADDRESS), { timeout: 120_000 }).toBeVisible()
  })
})
