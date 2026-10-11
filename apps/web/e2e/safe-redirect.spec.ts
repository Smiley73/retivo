/**
 * Local security E2E — open-redirect guard.
 *
 * `safeRedirect`/`safeReturnTo` (apps/web/src/auth/safe-redirect.ts) are unit-
 * tested against jsdom's own URL parser, which is the same `whatwg-url`
 * implementation the guard calls — so a green unit suite only proves the
 * guard agrees with the parser it uses, never that a real browser navigation
 * actually stays on-origin. This suite closes that gap: it opens
 * `ExpenseFormPage` (a real `safeReturnTo` consumer) with a crafted
 * `?returnTo=` carrying a raw tab that the WHATWG URL parser strips before
 * resolving the authority — turning the target protocol-relative on an
 * attacker origin under the OLD prefix-matching check — and confirms the
 * Back affordance keeps the browser on the app's own origin. A second case
 * confirms a legitimate focus-restore `returnTo` (the shape the canonical
 * Edit link on the Expenses page produces) still lands on its intended
 * local route.
 */
import { test, expect, loadDemo } from './fixtures';

test.describe('safe-redirect open-redirect guard', () => {
  test('a crafted returnTo carrying a raw tab cannot escape the app origin', async ({
    page,
  }) => {
    await loadDemo(page);
    // The app's own trusted origin, captured before the crafted navigation
    // so the assertion below states the actual security property (stayed
    // on THIS origin) rather than merely "isn't evil.example".
    const appOrigin = new URL(page.url()).origin;

    // Decodes, once the browser resolves the query string, to
    // `/\t/evil.example` — exactly the shape the finding names: a raw tab
    // the URL parser strips before deciding where the authority begins.
    await page.goto('/expenses/new?returnTo=%2F%09%2Fevil.example');
    await page.getByRole('link', { name: /back/i }).click();

    await expect(page).toHaveURL(`${appOrigin}/expenses`);
  });

  test('a legitimate focus-restore returnTo lands on the intended local route', async ({
    page,
  }) => {
    await loadDemo(page);

    // `demo-exp-dining-out` is a real row in the demo dataset, so the
    // focus-restoration effect (ExpensesPage.tsx) finds a match:
    // it scrolls the row into view and focuses its Edit button, then always
    // strips `focusExpenseId` from the URL. Asserting on the focused
    // button — rather than the transient pre-strip URL — proves the
    // legitimate returnTo actually reached and drove ExpensesPage, without
    // racing the strip.
    const target = '/expenses?focusExpenseId=demo-exp-dining-out';
    await page.goto(`/expenses/new?returnTo=${encodeURIComponent(target)}`);
    await page.getByRole('link', { name: /back/i }).click();

    await expect(page).toHaveURL(/\/expenses$/);
    await expect(
      page.locator('li[data-expense-id="demo-exp-dining-out"] button[aria-label="Edit"]'),
    ).toBeFocused();
  });
});
