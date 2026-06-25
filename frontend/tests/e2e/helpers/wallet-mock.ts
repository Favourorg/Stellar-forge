import { Page } from '@playwright/test'

export interface FreighterMock {
  isConnected: () => Promise<{ isConnected: boolean }>
  getAddress: () => Promise<{ address: string }>
  requestAccess: () => Promise<{ address: string }>
  signTransaction: (xdr: string) => Promise<{ signedTxXdr: string }>
  getNetwork: () => Promise<{ network: string }>
}

declare global {
  interface Window {
    freighter?: FreighterMock
  }
}

/**
 * Mocks the Freighter wallet browser extension on the page.
 *
 * @stellar/freighter-api v6.0.1 uses two mechanisms:
 *   1. window.freighter presence check (isConnected shortcircuits to truthy when set)
 *   2. postMessage protocol (FREIGHTER_EXTERNAL_MSG_REQUEST / RESPONSE) for getAddress,
 *      signTransaction, etc.
 *
 * Key design: WatchWalletChanges.fetchInfo() calls REQUEST_PUBLIC_KEY then
 * REQUEST_NETWORK_DETAILS in sequence. We intentionally do NOT respond to
 * REQUEST_NETWORK_DETAILS — that makes the watcher hang at the second await and
 * never fire its auto-connect callback, so "Connect Wallet" remains visible.
 * Explicit connect() only sends REQUEST_PUBLIC_KEY, so it still works.
 *
 * ToS is pre-accepted via localStorage so the modal does not block connect().
 */
export async function mockFreighter(page: Page, address: string) {
  await page.addInitScript((mockAddress: string) => {
    // Pre-accept Terms of Service so the modal doesn't block wallet connection
    localStorage.setItem('stellar_forge_tos_accepted', 'true')

    // Set window.freighter so isConnected() returns {isConnected: <truthy>} immediately
    window.freighter = {
      isConnected: () => Promise.resolve({ isConnected: true }),
      getAddress: () => Promise.resolve({ address: mockAddress }),
      requestAccess: () => Promise.resolve({ address: mockAddress }),
      signTransaction: (xdr: string) => Promise.resolve({ signedTxXdr: xdr }),
      getNetwork: () => Promise.resolve({ network: 'STANDALONE' }),
    }

    // Intercept the postMessage protocol used by freighter-api for getAddress(),
    // signTransaction(), REQUEST_NETWORK_DETAILS, etc.
    // Request format:  { source: 'FREIGHTER_EXTERNAL_MSG_REQUEST', messageId: number, type: string, ... }
    // Response format: { source: 'FREIGHTER_EXTERNAL_MSG_RESPONSE', messagedId: number, ... }
    // Note: 'messagedId' (with trailing 'd') is the Freighter library's key name.
    window.addEventListener('message', (event) => {
      const data = event.data as Record<string, unknown>
      if (!data || data['source'] !== 'FREIGHTER_EXTERNAL_MSG_REQUEST') return

      const messageId = data['messageId']
      const type = data['type'] as string

      const base: Record<string, unknown> = {
        source: 'FREIGHTER_EXTERNAL_MSG_RESPONSE',
        messagedId: messageId,
      }

      switch (type) {
        case 'REQUEST_CONNECTION_STATUS':
          window.postMessage({ ...base, isConnected: true }, '*')
          break
        case 'REQUEST_PUBLIC_KEY':
          window.postMessage({ ...base, publicKey: mockAddress }, '*')
          break
        case 'REQUEST_ACCESS':
          window.postMessage({ ...base, publicKey: mockAddress }, '*')
          break
        case 'REQUEST_NETWORK_DETAILS':
          // Intentionally no response: WatchWalletChanges.fetchInfo() awaits _() after A().
          // Without a response _() hangs forever, so the watcher callback never fires and
          // the wallet does not auto-connect on mount.  Explicit connect() is unaffected
          // because getAddress() only sends REQUEST_PUBLIC_KEY, not REQUEST_NETWORK_DETAILS.
          break
        case 'REQUEST_ALLOWED_STATUS':
          window.postMessage({ ...base, isAllowed: true }, '*')
          break
        case 'SET_ALLOWED_STATUS':
          window.postMessage({ ...base, isAllowed: true }, '*')
          break
        case 'SUBMIT_TRANSACTION':
          window.postMessage(
            {
              ...base,
              signedTransaction: data['transactionXdr'],
              signerAddress: mockAddress,
            },
            '*',
          )
          break
        default:
          // Don't respond to unknown message types
          break
      }
    })
  }, address)
}
