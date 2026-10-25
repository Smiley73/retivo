/**
 * Open-redirect guard in a real browser: jsdom and `safeReturnTo` share one URL parser, so only a browser proves a crafted `?returnTo=` stays on-origin.
 */
import { test, expect, loadDemo } from './fixtures';

test.describe('safe-redirect open-redirect guard', () => {
  test('a crafted returnTo carrying a raw tab cannot escape the app origin', async ({
    page,
  }) => {
    await loadDemo(page);
    const appOrigin = new URL(page.url()).origin;

    // Decodes to `/\t/evil.example`: the URL parser strips the tab and reads the rest as a protocol-relative authority.
    await page.goto('/expenses/new?returnTo=%2F%09%2Fevil.example');
    await page.getByRole('link', { name: /back/i }).click();

    await expect(page).toHaveURL(`${appOrigin}/expenses`);
  });
});
