import { Page } from '@playwright/test'

/**
 * Mocks the Freighter wallet for E2E tests.
 *
 * `@stellar/freighter-api` talks to the browser extension over a
 * `window.postMessage` request/response channel — it does NOT call methods on a
 * `window.freighter` object. So we:
 *   1. set `window.freighter = true` so `isConnected()` reports the wallet as
 *      installed (the api short-circuits on this flag), and
 *   2. answer the `FREIGHTER_EXTERNAL_MSG_REQUEST` messages the api posts with a
 *      matching `FREIGHTER_EXTERNAL_MSG_RESPONSE` carrying the mock account.
 */
export async function mockFreighter(page: Page, address: string) {
  await page.addInitScript((mockAddress: string) => {
    // Marks Freighter as installed for isConnected().
    ;(window as unknown as { freighter: boolean }).freighter = true;

    const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

    window.addEventListener('message', (event: MessageEvent) => {
      const req = event.data;
      if (!req || req.source !== 'FREIGHTER_EXTERNAL_MSG_REQUEST') return;

      // Build the response payload for the requested operation.
      const payload: Record<string, unknown> = {};
      switch (req.type) {
        case 'REQUEST_CONNECTION_STATUS':
          payload.isConnected = true;
          break;
        case 'REQUEST_ACCESS':
        case 'REQUEST_PUBLIC_KEY':
          payload.publicKey = mockAddress;
          break;
        case 'REQUEST_NETWORK':
        case 'REQUEST_NETWORK_DETAILS':
          // The api reads a nested `networkDetails` object off the response.
          payload.networkDetails = {
            network: 'TESTNET',
            networkName: 'TESTNET',
            networkUrl: 'https://horizon-testnet.stellar.org',
            networkPassphrase: TESTNET_PASSPHRASE,
            sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
          };
          break;
        case 'REQUEST_ALLOWED_STATUS':
        case 'SET_ALLOWED_STATUS':
          payload.isAllowed = true;
          break;
        case 'SUBMIT_TRANSACTION':
          // Echo the XDR back as the "signed" transaction.
          payload.signedTransaction = req.transactionXdr;
          payload.signerAddress = mockAddress;
          break;
        case 'REQUEST_USER_INFO':
          payload.userInfo = { publicKey: mockAddress };
          break;
        default:
          break;
      }

      // The api matches responses on `messagedId` (note the upstream typo) and
      // requires this exact source string.
      window.postMessage(
        {
          source: 'FREIGHTER_EXTERNAL_MSG_RESPONSE',
          messagedId: req.messageId,
          ...payload,
        },
        window.location.origin,
      );
    });
  }, address);
}
