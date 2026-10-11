/**
 * Cross-page user journeys, layered on top of the smoke suite.
 *
 * Scope:
 *   1. Scenario change propagates: editing the active scenario's planned
 *      returns changes the Balance Projection headline stat.
 *   2. Data persistence round-trip: a created expense survives a hard
 *      reload (IndexedDB persistence + boot path).
 *
 * Both journeys are fully local (demo data, no API) — the Profile
 * export/import flows are password-gated against the API and live in
 * the API-coupled manual suite, not here.
 *
 * Each test runs against a freshly-cleared IndexedDB (see fixtures.ts).
 */
import { test, expect, loadDemo } from './fixtures';

test.describe('journeys', () => {
  test('editing the active scenario’s planned returns changes the projection headline', async ({
    page,
  }) => {
    await loadDemo(page);

    // Capture the "Planned · at horizon" stat (label div + value div are
    // siblings inside the Stat card).
    await page.goto('/balance-projection');
    await expect(
      page.getByRole('heading', { name: /balance projection/i }),
    ).toBeVisible({ timeout: 10_000 });
    const horizonValue = page
      .getByText('Planned · at horizon', { exact: true })
      .locator('xpath=following-sibling::div[1]');
    await expect(horizonValue).toBeVisible({ timeout: 15_000 });
    await expect(horizonValue).not.toHaveText('—', { timeout: 15_000 });
    const before = (await horizonValue.textContent())?.trim() ?? '';

    // Open the active scenario (the row carrying the "Active" badge).
    await page.goto('/scenarios');
    const activeRow = page
      .locator('.scenario-tree > *')
      .filter({ hasText: /active/i })
      .first();
    await expect(activeRow).toBeVisible({ timeout: 10_000 });
    await activeRow.getByRole('button', { name: /^edit /i }).click();

    // Scenario detail → Planned returns → override EVERY account with an
    // aggressively different return. One small account at -15% can move
    // the $M-rounded headline by less than the rounding step; all of
    // them cannot.
    await page
      .getByRole('button', { name: 'Configure planned-return overrides' })
      .click();
    await expect(
      page.getByRole('heading', { name: /planned returns/i }),
    ).toBeVisible({ timeout: 10_000 });
    const returns = page.getByRole('textbox', { name: / scenario return$/ });
    await expect(returns.first()).toBeVisible({ timeout: 10_000 });
    const count = await returns.count();
    for (let i = 0; i < count; i += 1) {
      const input = returns.nth(i);
      // Click before filling: the React Aria Table grid manages focus,
      // and fill()'s programmatic focus can be redirected to the row,
      // sending the inserted text nowhere. A click enters the cell the
      // way a user does and pins focus on the input.
      await input.click();
      await input.fill('-15');
      await input.blur();
      await expect(input).toHaveValue('-15.0');
    }
    // Save renders only while the grid is dirty.
    await page.getByRole('button', { name: /^save$/i }).click();

    // Back on Balance Projection the planned-at-horizon stat must move.
    await page.goto('/balance-projection');
    await expect(horizonValue).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await horizonValue.textContent())?.trim(), {
        timeout: 15_000,
      })
      .not.toBe(before);
  });

  test('a created expense survives a hard reload (IndexedDB round-trip)', async ({
    page,
  }) => {
    await loadDemo(page);

    await page.goto('/expenses');
    await page.getByRole('button', { name: /add expense/i }).first().click();
    await page.getByLabel(/^name$/i).first().fill('E2E Persistence Check');
    await page.getByLabel(/amount/i).first().fill('1234');
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('E2E Persistence Check')).toBeVisible({
      timeout: 10_000,
    });

    // Hard reload: the fixture only wipes IDB at test start, so the row
    // must come back from IndexedDB through the normal boot path. One
    // navigation only — reload() immediately followed by a goto() aborts
    // the boot-time session refresh mid-flight, which intermittently
    // bounces the app to /login (the page is already on /expenses, so
    // reload() alone exercises the same round-trip).
    await page.reload();
    await expect(page.getByText('E2E Persistence Check')).toBeVisible({
      timeout: 15_000,
    });
  });
});
