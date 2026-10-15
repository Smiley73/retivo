/**
 * Balance Projection tabbed views + pinned controls strip
 * — the browser-only guarantees jsdom
 * structurally cannot prove (see `BalanceProjectionPage.views.test.tsx` for
 * the URL/keyboard/`[data-inert]` shell invariants jsdom CAN prove):
 * switching tabs, a deep link, keyboard focus-then-activate, the strip's
 * top staying at the viewport top after scrolling a long view, and that a
 * chart in a now-hidden panel keeps the same measured width as one in the
 * selected panel (never the 800px jsdom-only fallback, never 0).
 */
import type { Page } from '@playwright/test';
import { test, expect, loadDemo, perYearChartSvg } from './fixtures';

/**
 * Waits until the page's embedded stress test has landed and nothing is about
 * to start it again, before the test touches geometry or clicks. A run spawns
 * workers that pull the engine's modules from Vite and saturates the CI
 * runner's two vCPUs for tens of seconds: a tab switch then renders slower
 * than an assertion's 5s window, and the progress row leaving the pinned strip
 * when the run lands shrinks the strip, which scroll anchoring turns into a
 * `scrollY` jump. Three conditions, in order:
 * - The sync badge reads "Synced". After a (re)load the page first shows the
 *   result cached by the previous run, then the pull changes the household's
 *   data and a second run starts; the badge reads "Refreshing…" until then.
 * - The outcomes stats read dollar values instead of "—" (`includeHidden`
 *   because the Overview panel that holds them stays mounted but hidden while
 *   another view is selected).
 * - The success card is not `aria-busy`, which it is while a run is in flight
 *   or the shown result is stale for the current inputs.
 */
async function settleStressTest(page: Page): Promise<void> {
  await expect(
    page.getByRole('button', { name: /^synced\b/i }).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole('region', {
      name: /monte carlo outcomes/i,
      includeHidden: true,
    }),
  ).toContainText(/\$\d/, { timeout: 60_000 });
  await expect(
    page
      .locator('div[aria-busy="false"]')
      .filter({ hasText: /^Success probability/i }),
  ).toHaveCount(1, { timeout: 60_000 });
}

test.describe('Balance Projection tabbed views + pinned controls strip', () => {
  test('switches tabs, deep-links, keyboard-activates, and keeps the strip pinned while scrolling', async ({
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

    // Default view is Overview.
    await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    await settleStressTest(page);

    // Clicking a tab switches the view and rewrites the URL (no reload).
    await cashflowTab.click();
    await expect(cashflowTab).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('radiogroup', { name: 'Cashflow chart granularity' }),
    ).toBeVisible();
    // At the top of the page the strip is already in view, so a switch must
    // not scroll the page title away.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // The screen-only hide is a two-part join: styles.css matches
    // `.bp-view-panel[data-inert]`, and the page must put that class on the
    // SAME element React Aria decorates with `data-inert`. Count proves the
    // join (four non-selected panels carry both — five views total, one
    // selected); hidden proves the rule actually applies under real CSS —
    // jsdom applies no stylesheet, and `styles.test.ts` only reads the CSS
    // text. Count goes first because `toBeHidden()` alone is also satisfied
    // by a locator matching nothing.
    const inertPanels = page.locator('.bp-view-panel[data-inert]');
    await expect(inertPanels).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(inertPanels.nth(i)).toBeHidden();
    }
    await expect(page).toHaveURL(/\?view=cashflow$/);

    // Deep link: a fresh load with `?view=` selects that view directly.
    await page.goto('/balance-projection?view=taxes');
    await expect(
      page.getByRole('tab', { name: 'Taxes & distributions' }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('heading', { name: /Tax & Health-Cost Burden/ }),
    ).toBeVisible({ timeout: 10_000 });

    // Keyboard: arrow keys move focus along the row without switching;
    // Enter switches the focused tab (keyboardActivation="manual").
    await page.goto('/balance-projection');
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Settle again after the reloads above: each one re-mounts the page, and
    // its post-load pull can start a second run. Measured mid-run, the wheel's
    // scroll can land after the scrollY read, and the strip shrinking under
    // the Overview tab fails Playwright's click stability check, whose retry
    // scrolls the tab to the viewport bottom.
    await settleStressTest(page);
    await page.getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(cashflowTab).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Enter');
    await expect(cashflowTab).toHaveAttribute('aria-selected', 'true');

    // Pinning: switch to Accounts (a long view), scroll it, and the strip's
    // top stays at the viewport top rather than scrolling away with it.
    await accountsTab.click();
    await expect(accountsTab).toHaveAttribute('aria-selected', 'true');
    const strip = page.getByRole('group', { name: 'Projection controls' });
    await expect(strip).toBeVisible();
    await page.mouse.wheel(0, 3000);
    await expect(strip).toBeVisible();
    // Prove the page actually scrolled — otherwise a strip that scrolled
    // off with the content (stripBox.y deeply negative) would still
    // satisfy a one-sided `toBeLessThan(5)` below. `mouse.wheel` returns
    // before the scroll lands, so poll for it.
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(200);
    const stripBox = await strip.boundingBox();
    expect(stripBox).not.toBeNull();
    expect(stripBox!.y).toBeGreaterThanOrEqual(0);
    expect(stripBox!.y).toBeLessThan(5);

    // Switching tabs from a scrolled-away position scrolls the strip
    // to the actual viewport top — any document `scroll-padding-top` (there
    // is none; focus clearance is measured per focus instead) would land
    // the anchor, and the strip beneath it, that far below the top.
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    const overviewStripBox = await strip.boundingBox();
    expect(overviewStripBox).not.toBeNull();
    expect(overviewStripBox!.y).toBeGreaterThanOrEqual(0);
    expect(overviewStripBox!.y).toBeLessThan(5);

    // The hidden views must not add scroll space below the visible one: an
    // absolutely positioned descendant of a non-positioned, clipped panel
    // (the sr-only spans inside the hidden views) escapes the clip and
    // extends the document to its static position. The document must end
    // where the app shell ends, and scrolling to the very bottom must leave
    // the sticky sidebar at the viewport top rather than sliding it up
    // when its container runs out.
    const heights = await page.evaluate(() => ({
      document: document.documentElement.scrollHeight,
      shell: document.body.scrollHeight,
    }));
    expect(heights.document).toBeLessThanOrEqual(heights.shell + 1);
    await page.mouse.wheel(0, 100_000);
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

    // Overview's per-year chart, selected.
    const overviewChart = perYearChartSvg(page);
    await expect(overviewChart).toBeVisible({ timeout: 10_000 });
    const selectedBox = await overviewChart.boundingBox();
    expect(selectedBox).not.toBeNull();
    expect(selectedBox!.width).toBeGreaterThan(0);

    // Switch away — Overview's panel is now the hidden, force-mounted one.
    await page.getByRole('tab', { name: 'Cash flow' }).click();
    await expect(page.getByRole('tab', { name: 'Cash flow' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    const hiddenBox = await overviewChart.boundingBox();
    expect(hiddenBox).not.toBeNull();
    // Never zero (the `display:none` hazard) and never a stale 800px
    // jsdom-only fallback re-measured against a different container — the
    // screen-only hide preserves the SAME layout width it had selected.
    expect(hiddenBox!.width).toBeCloseTo(selectedBox!.width, 0);
  });

  // The `lg` breakpoint itself: the content column is ~704px wide here, so
  // the controls group wraps to two rows and the stuck strip is at its
  // tallest (measured 141px vs 97px at 1280px) — the width at which a fixed
  // focus reserve would be most wrong in either direction.
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
      // The sticky container is the parent of the controls group.
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
      // The strip's height and the document's scroll position are measured
      // below, so the run's progress row must be gone before the first one.
      await settleStressTest(page);

      // Park focus on the control AFTER the disclosure, then scroll so the
      // disclosure sits 40px below the viewport top — under the stuck strip.
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

      // Shift+Tab onto the covered control: it must end up below the strip's
      // bottom edge while the strip is STILL stuck (so this proves clearance
      // from a stuck strip, not a strip that scrolled away).
      await page.keyboard.press('Shift+Tab');
      await expect(disclosure).toBeFocused();
      const stripAfter = (await strip.boundingBox())!;
      expect(stripAfter.y).toBeGreaterThanOrEqual(0);
      expect(stripAfter.y).toBeLessThan(1);
      const disclosureAfter = (await disclosure.boundingBox())!;
      expect(disclosureAfter.y).toBeGreaterThanOrEqual(
        stripAfter.y + stripAfter.height,
      );

      // The reverse direction: focus entering the strip's OWN controls from
      // panel content must not move the document (a fixed scroll-padding
      // reserve covering the stuck strip made the browser chase the sticky
      // element by hundreds of pixels here).
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
