/**
 * Critical-path smoke tests for the web app. Six checks that establish
 * the framework is wired + the top user flows render without errors.
 *
 * Scope (locked in planning):
 *   1. App boots
 *   2. Demo data import works and populates the household
 *   3. Account create flow round-trips a value
 *   4. Balance Projection page renders the chart
 *   5. Plan stress-test page auto-runs and shows result cards
 *   6. Switching the active scenario re-runs the plan stress test and the
 *      new run's result replaces the displayed one
 *
 * Each test runs against a freshly-cleared IndexedDB (see fixtures.ts).
 * The suite is deliberately small — future PRs can layer in deeper
 * coverage now that the framework, fixture, and dev-server lifecycle
 * are proven.
 */
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
    // The first-run modal opens on a freshly-cleared workspace.
    // Either the modal is visible (zero data) or the dashboard is
    // (data present from a prior run that didn't get wiped). Both
    // are acceptable boot states; assert at least one is on screen.
    const modalSeed = page.getByRole('button', { name: /load demo/i });
    const dashboardHeading = page.getByRole('heading', { name: /dashboard/i });
    // `.first()`: post-sign-in both can be on screen at once (dashboard
    // behind the first-run modal) and a 2-element .or() trips strict mode.
    await expect(modalSeed.or(dashboardHeading).first()).toBeVisible({ timeout: 15_000 });
  });

  test('demo data import seeds the household', async ({ page }) => {
    // loadDemo asserts the full round-trip: modal click → seed persisted
    // (modal closed) → dashboard interactive.
    await loadDemo(page);
  });

  test('account create flow round-trips through the list', async ({ page }) => {
    // Seed: demo data first so the Accounts page has the standard
    // layout (member chooser, AccountType picker default).
    await loadDemo(page);
    await page.goto('/accounts');
    // PageHeader actions are always rendered as <button> ("Buttons and destructive actions" in docs/ui-conventions.md).
    await page.getByRole('button', { name: /add account/i }).first().click();
    // Scope form fields to the modal: the Accounts list page has its own
    // filter bar whose Owner select shares the accessible name "Owner"
    // with the modal's owner field, so page-wide lookups trip strict mode.
    // Listbox options stay page-scoped — React Aria portals them outside
    // the dialog subtree.
    const dialog = page.getByRole('dialog');
    // The modal requires name + institution + type + owner before Create
    // enables (tax treatment auto-derives from the chosen type).
    await dialog.getByLabel(/account name/i).first().fill('E2E Test Account');
    await dialog.getByLabel(/institution/i).first().fill('E2E Bank');
    await dialog.getByRole('button', { name: /account type/i }).click();
    await page.getByRole('option', { name: /brokerage/i }).first().click();
    await dialog.getByRole('button', { name: /owner/i }).click();
    await page.getByRole('option').first().click();
    // Planning Return % is also required before Create enables.
    await dialog.getByRole('textbox', { name: /planning return/i }).fill('5');
    // The account modal's primary action is Create (Update on edit).
    await dialog.getByRole('button', { name: /^create$/i }).click();
    await expect(page.getByText('E2E Test Account')).toBeVisible({ timeout: 5_000 });
  });

  test('Balance Projection page renders the chart', async ({ page }) => {
    await loadDemo(page);
    await page.goto('/balance-projection');
    await expect(
      page.getByRole('heading', { name: /balance projection/i }),
    ).toBeVisible({ timeout: 10_000 });
    // The chart's own `<svg>` appears once the data is ready. A bare
    // `page.locator('svg')` would match a sidebar icon and pass without it.
    const chart = perYearChartSvg(page);
    await expect(chart).toBeVisible({ timeout: 10_000 });
    await expect(chart.locator('path').first()).toBeVisible({ timeout: 10_000 });
  });

  test('Plan stress-test page auto-runs and shows the headline cards', async ({
    page,
  }) => {
    await loadDemo(page);
    // Legacy /projections/monte-carlo URL now redirects to the
    // Balance Projection page, where the stress test embeds inline.
    await page.goto('/projections/monte-carlo');
    // The legacy MC page redirects into Balance Projection, where the
    // stress test renders as the "Monte Carlo outcomes" section.
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

    // Switch the sidebar's active scenario to the demo scenario that runs out
    // of money (about 30% against the base's 100%).
    await page
      .getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('button', { name: /active scenario/i })
      .click();
    await page.getByRole('option', { name: /funds run out/i }).click();

    // The success probability is the signal: it holds the superseded run's
    // value until the debounced auto-rerun lands. The outcomes stats are not —
    // their "At retirement" row re-reads the old run at the new retirement age
    // straight away, so it changes whether or not a rerun ever happens. Only
    // the run-out scenario's run can pull the figure this far down, which a
    // reseeded rerun of the base plan never would.
    await expect.poll(percent, { timeout: 60_000 }).toBeLessThan(before - 10);
  });
});
