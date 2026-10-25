/** Critical-path smoke tests: app boot, demo import, account create, chart render, and the stress test running and re-running. */
import {
  test,
  expect,
  loadDemo,
  perYearChartSvg,
  successProbabilityCard,
  waitForStressTest,
} from './fixtures';

test.describe('smoke', () => {
  test('app boots and renders the dashboard', async ({ page }) => {
    const modalSeed = page.getByRole('button', { name: /load demo/i });
    const dashboardHeading = page.getByRole('heading', { name: /dashboard/i });
    // `.first()`: both can be on screen (dashboard behind the modal) and a two-element `.or()` trips strict mode.
    await expect(modalSeed.or(dashboardHeading).first()).toBeVisible({ timeout: 15_000 });
  });

  test('demo data import seeds the household', async ({ page }) => {
    await loadDemo(page);
  });

  test('account create flow round-trips through the list', async ({ page }) => {
    await loadDemo(page);
    await page.goto('/accounts');
    // PageHeader actions are always rendered as <button> ("Buttons and destructive actions" in docs/ui-conventions.md).
    await page.getByRole('button', { name: /add account/i }).first().click();
    // Scope fields to the modal: the list page's filter bar also has an "Owner" select. Listbox options are portaled outside the dialog.
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/account name/i).first().fill('E2E Test Account');
    await dialog.getByLabel(/institution/i).first().fill('E2E Bank');
    await dialog.getByRole('button', { name: /account type/i }).click();
    await page.getByRole('option', { name: /brokerage/i }).first().click();
    await dialog.getByRole('button', { name: /owner/i }).click();
    await page.getByRole('option').first().click();
    await dialog.getByRole('textbox', { name: /planning return/i }).fill('5');
    await dialog.getByRole('button', { name: /^create$/i }).click();
    await expect(page.getByText('E2E Test Account')).toBeVisible({ timeout: 5_000 });
  });

  test('Balance Projection page renders the chart', async ({ page }) => {
    await loadDemo(page);
    await page.goto('/balance-projection');
    await expect(
      page.getByRole('heading', { name: /balance projection/i }),
    ).toBeVisible({ timeout: 10_000 });
    // A bare `svg` locator would match an icon and pass without the chart.
    const chart = perYearChartSvg(page);
    await expect(chart).toBeVisible({ timeout: 10_000 });
    await expect(chart.locator('path').first()).toBeVisible({ timeout: 10_000 });
  });

  test('Plan stress-test page auto-runs and shows the headline cards', async ({
    page,
  }) => {
    await loadDemo(page);
    // The legacy URL redirects into Balance Projection, which embeds the stress test.
    await page.goto('/projections/monte-carlo');
    await expect(
      page.getByRole('heading', { name: /balance projection/i }),
    ).toBeVisible({ timeout: 10_000 });
    await waitForStressTest(page);
    await expect(successProbabilityCard(page)).toContainText(/\d+%/);
  });

  test('the embedded plan stress-test auto-reruns when the active scenario changes', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('/balance-projection');
    await waitForStressTest(page);
    const percent = async (): Promise<number> =>
      Number(
        /(\d+)%/.exec(await successProbabilityCard(page).innerText())?.[1],
      );
    const before = await percent();

    await page
      .getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('button', { name: /active scenario/i })
      .click();
    await page.getByRole('option', { name: /funds run out/i }).click();

    // Success probability holds the old run's value until the rerun lands; the outcomes stats change immediately, rerun or not.
    await expect.poll(percent, { timeout: 60_000 }).toBeLessThan(before - 10);
  });
});
