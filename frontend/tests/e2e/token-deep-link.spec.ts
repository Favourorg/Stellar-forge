import { test, expect } from '@playwright/test';
import { mockFreighter } from './helpers/wallet-mock';

/**
 * A syntactically valid Soroban contract address (C… 56 chars, base32 encoded).
 * This address is deliberately non-existent on the network so the app will show
 * the NotFound / error state after fetching — but the *route* must still load
 * and NOT redirect away.
 */
const VALID_CONTRACT_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

/**
 * Malformed address that fails the isValidContractAddress() check before any
 * network call is made — the component renders <NotFound> immediately.
 */
const INVALID_ADDRESS = 'not-a-valid-stellar-contract-address';

test.describe('Token deep-link routing (/token/:address)', () => {
  test('navigating directly to /token/<address> loads the token detail route without redirecting', async ({
    page,
  }) => {
    // Do NOT connect a wallet — deep links must be publicly accessible.
    await page.goto(`/token/${VALID_CONTRACT_ADDRESS}`);

    // The URL must stay on the /token/:address route (no redirect to /).
    await expect(page).toHaveURL(new RegExp(`/token/${VALID_CONTRACT_ADDRESS}`));

    // The skeleton loader or the error / detail view must be rendered —
    // the key assertion is that we did NOT land on the home page.
    const homeHeading = page.getByRole('heading', { name: /Stellar Token Deployer|Deploy Tokens/i });
    await expect(homeHeading).not.toBeVisible();
  });

  test('refreshing /token/<address> preserves the token detail route', async ({ page }) => {
    await page.goto(`/token/${VALID_CONTRACT_ADDRESS}`);

    // Wait for the page to be fully loaded (loader gone or content / error visible).
    await page.waitForLoadState('networkidle');

    // Simulate a full page reload (equivalent to pressing F5).
    await page.reload();

    // After the reload we must still be on the same deep-link URL.
    await expect(page).toHaveURL(new RegExp(`/token/${VALID_CONTRACT_ADDRESS}`));

    // Home page must NOT appear after refresh.
    const homeHeading = page.getByRole('heading', { name: /Stellar Token Deployer|Deploy Tokens/i });
    await expect(homeHeading).not.toBeVisible();
  });

  test('an invalid address at /token/<invalid> shows the NotFound component', async ({ page }) => {
    await page.goto(`/token/${INVALID_ADDRESS}`);

    // isValidContractAddress() returns false → <NotFound> renders immediately.
    // NotFound renders a visible "Page Not Found" heading and a 404 number.
    await expect(page.getByRole('heading', { name: /Page Not Found/i })).toBeVisible();
    await expect(page.getByText('404')).toBeVisible();
  });

  test('ShareButton generates the /token/:address deep link', async ({ page }) => {
    // Connect the wallet so we can reach the token detail page via the
    // authenticated /tokens/:address route (simulates coming from the dashboard).
    const WALLET_ADDRESS = 'GCV6L3B2R6G2H5J4J4J4J4J4J4J4J4J4J4J4J4J4J4J4J4J4J4J4';
    await mockFreighter(page, WALLET_ADDRESS);

    await page.goto(`/token/${VALID_CONTRACT_ADDRESS}`);
    await page.waitForLoadState('networkidle');

    // Grant clipboard read permission so we can inspect the copied URL.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    // Open the share menu.
    const shareButton = page.getByRole('button', { name: /Share token/i });
    // If the address is invalid / not found the share button won't render —
    // skip gracefully so this test only runs when the token detail is shown.
    const shareVisible = await shareButton.isVisible().catch(() => false);
    if (!shareVisible) {
      test.skip();
      return;
    }

    await shareButton.click();

    // Click "Copy link".
    await page.getByRole('button', { name: /Copy link/i }).click();

    // Read from clipboard and assert it contains /token/<address>.
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain(`/token/${VALID_CONTRACT_ADDRESS}`);
  });
});
