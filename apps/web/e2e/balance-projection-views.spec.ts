/**
 * Browser-only guarantees of the Balance Projection tabs and pinned controls strip: tab switching, strip position while scrolling,
 * and hidden panels keeping their chart width. URL and keyboard shell invariants are in `BalanceProjectionPage.views.test.tsx`.
 */
import {
  test,
  expect,
  loadDemo,
  perYearChartSvg,
  waitForStressTest,
} from './fixtures';

test.describe('Balance Projection tabbed views + pinned controls strip', () => {
  test('switches tabs and keeps the strip pinned while scrolling', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('/balance-projection');
    await expect(
      page.getByRole('heading', { name: /balance projection/i }),
    ).toBeVisible({ timeout: 10_000 });

    const tabs = page.getByRole('tablist', { name: 'Projection views' });
    await expect(tabs).toBeVisible({ timeout: 10_000 });
    const overviewTab = page.getByRole('tab', { name: 'Overview' });
    const cashflowTab = page.getByRole('tab', { name: 'Cash flow' });
    const accountsTab = page.getByRole('tab', { name: 'Accounts' });

    await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    await waitForStressTest(page);

    await cashflowTab.click();
    await expect(cashflowTab).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('radiogroup', { name: 'Cashflow chart granularity' }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // Count first: `toBeHidden()` passes on an empty locator. Hidden proves the rule applies under real CSS, which jsdom does not load.
    const inertPanels = page.locator('.bp-view-panel[data-inert]');
    await expect(inertPanels).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      await expect(inertPanels.nth(i)).toBeHidden();
    }
    await expect(page).toHaveURL(/\?view=cashflow$/);

    await accountsTab.click();
    await expect(accountsTab).toHaveAttribute('aria-selected', 'true');
    const strip = page.getByRole('group', { name: 'Projection controls' });
    await expect(strip).toBeVisible();
    // Open the table so the view is long enough for the scroll check; the label flips Show/Hide, so match the stable part.
    const yearTable = page.getByRole('button', { name: /year-by-year table/i });
    await yearTable.click();
    await expect(yearTable).toHaveAttribute('aria-expanded', 'true');
    await page.mouse.wheel(0, 3000);
    await expect(strip).toBeVisible();
    // Poll: `mouse.wheel` returns before the scroll lands; without it a strip scrolled away with the content would pass `toBeLessThan(5)`.
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(200);
    const stripBox = await strip.boundingBox();
    expect(stripBox).not.toBeNull();
    expect(stripBox!.y).toBeGreaterThanOrEqual(0);
    expect(stripBox!.y).toBeLessThan(5);

    // Switching tabs from a scrolled position lands the strip at the viewport top (the document has no `scroll-padding-top`).
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    const overviewStripBox = await strip.boundingBox();
    expect(overviewStripBox).not.toBeNull();
    expect(overviewStripBox!.y).toBeGreaterThanOrEqual(0);
    expect(overviewStripBox!.y).toBeLessThan(5);

    // Hidden views must add no scroll space: their absolutely positioned sr-only spans escape the clipped panel and extend the document.
    const heights = await page.evaluate(() => ({
      document: document.documentElement.scrollHeight,
      shell: document.body.scrollHeight,
    }));
    expect(heights.document).toBeLessThanOrEqual(heights.shell + 1);
    // Wait for the bottom first (`mouse.wheel` returns before the scroll lands), on a document taller than the viewport.
    expect(heights.document).toBeGreaterThan(page.viewportSize()!.height);
    await page.mouse.wheel(0, 100_000);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.scrollY + window.innerHeight >=
            document.documentElement.scrollHeight - 1,
        ),
      )
      .toBe(true);
    const sidebarBox = await page
      .getByRole('complementary', { name: 'Primary navigation' })
      .boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(sidebarBox!.y).toBeGreaterThanOrEqual(-1);
    expect(sidebarBox!.y).toBeLessThan(1);
  });

  test('a hidden panel keeps its chart at the same measured width as the selected panel', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('/balance-projection');
    await expect(
      page.getByRole('heading', { name: /balance projection/i }),
    ).toBeVisible({ timeout: 10_000 });
    // The tab switch below renders slower than its 5s assertion while a run holds the CPU.
    await waitForStressTest(page);

    const overviewChart = perYearChartSvg(page);
    await expect(overviewChart).toBeVisible({ timeout: 10_000 });
    const selectedBox = await overviewChart.boundingBox();
    expect(selectedBox).not.toBeNull();
    expect(selectedBox!.width).toBeGreaterThan(0);

    await page.getByRole('tab', { name: 'Cash flow' }).click();
    await expect(page.getByRole('tab', { name: 'Cash flow' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    const hiddenBox = await overviewChart.boundingBox();
    expect(hiddenBox).not.toBeNull();
    // Never zero (`display:none`) or a re-measured fallback.
    expect(hiddenBox!.width).toBeCloseTo(selectedBox!.width, 0);
  });

  test('deep-links the Compare tab with a scenario selected and shows the headline figures', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('/balance-projection?view=compare&with=demo-scenario-delay');
    await expect(page.getByRole('tab', { name: 'Compare' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('button', { name: /Compare with/ })).toContainText(
      'Delay — work to 70',
      { timeout: 10_000 },
    );
    const endingBalance = page.getByRole('row', {
      name: /Ending balance at the horizon/,
    });
    const figures = endingBalance.getByRole('gridcell');
    await expect(figures.nth(0)).toHaveText(/^\$\d/, { timeout: 10_000 });
    await expect(figures.nth(1)).toHaveText(/^\$\d/);
  });

  // At the `lg` breakpoint the controls wrap to two rows and the stuck strip is tallest.
  test.describe('at the lg breakpoint, where the controls group wraps', () => {
    test.use({ viewport: { width: 1024, height: 768 } });

    test('keyboard focus is scrolled clear of the stuck strip, and focusing a strip control does not move the page (WCAG 2.4.11)', async ({
      page,
    }) => {
      await loadDemo(page);
      await page.goto('/balance-projection?view=accounts');
      await expect(
        page.getByRole('tablist', { name: 'Projection views' }),
      ).toBeVisible({ timeout: 10_000 });
      // xpath: the sticky container is the controls group's parent.
      const strip = page
        .getByRole('group', { name: 'Projection controls' })
        .locator('xpath=..');
      const disclosure = page.getByRole('button', {
        name: 'Show account-by-account projection',
      });
      const yearTable = page.getByRole('button', {
        name: 'Show year-by-year table',
      });
      await expect(disclosure).toBeVisible();
      await expect(strip).toHaveCSS('position', 'sticky');
      // The run's progress row changes the strip's height, so wait before measuring.
      await waitForStressTest(page);

      // Park focus after the disclosure, then scroll so the disclosure sits under the stuck strip.
      await yearTable.focus();
      await disclosure.evaluate((el) =>
        window.scrollTo({
          top: el.getBoundingClientRect().top + window.scrollY - 40,
          behavior: 'instant',
        }),
      );
      const stuckStrip = (await strip.boundingBox())!;
      expect(stuckStrip.y).toBeGreaterThanOrEqual(0);
      expect(stuckStrip.y).toBeLessThan(1);
      expect((await disclosure.boundingBox())!.y).toBeLessThan(
        stuckStrip.height,
      );

      // The covered control must end up below the strip's bottom edge while the strip is still stuck.
      await page.keyboard.press('Shift+Tab');
      await expect(disclosure).toBeFocused();
      const stripAfter = (await strip.boundingBox())!;
      expect(stripAfter.y).toBeGreaterThanOrEqual(0);
      expect(stripAfter.y).toBeLessThan(1);
      const disclosureAfter = (await disclosure.boundingBox())!;
      expect(disclosureAfter.y).toBeGreaterThanOrEqual(
        stripAfter.y + stripAfter.height,
      );

      // Focus entering the strip's own controls must not move the document.
      const before = await page.evaluate(() => window.scrollY);
      await page.keyboard.press('Shift+Tab');
      await expect(page.getByRole('tab', { name: 'Accounts' })).toBeFocused();
      expect(await page.evaluate(() => window.scrollY)).toBe(before);
      await page.locator('#balance-projection-basis').focus();
      await expect(page.locator('#balance-projection-basis')).toBeFocused();
      expect(await page.evaluate(() => window.scrollY)).toBe(before);
    });
  });
});
