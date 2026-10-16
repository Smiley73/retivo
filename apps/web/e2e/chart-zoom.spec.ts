/**
 * Chart drag-zoom + Reset view — Playwright happy-path smoke.
 *
 * Verifies the wiring end-to-end against the Balance Projection page:
 *   1. Drag horizontally from left to right inside the projection chart
 *      plot area → "Reset view" button appears.
 *   2. Click "Reset view" → button disappears.
 *
 * Uses the demo dataset (seeded via the first-run modal) to ensure the
 * chart has rendered data and the plot area has a non-zero bounding box.
 * Real SVG layout is required for reliable coordinates — this is why the
 * check lives in Playwright rather than jsdom unit tests.
 */
import {
  test,
  expect,
  loadDemo,
  perYearChartSvg,
  waitForStressTest,
} from './fixtures';

test.describe('Chart drag-zoom + Reset view', () => {
  test('drag inside balance-projection chart zooms; Reset view restores', async ({
    page,
  }) => {
    // Seed demo data so the projection chart has data to render.
    await loadDemo(page);

    await page.goto('/balance-projection');
    await expect(
      page.getByRole('heading', { name: /balance projection/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Wait for the projection section to render (aria-label from
    // balance-projection-page-chart.tsx).
    const chartSection = page.locator('[aria-label="Per-year projection"]');
    await expect(chartSection).toBeVisible({ timeout: 10_000 });

    // Settle the page before measuring drag geometry: the chart Inner is
    // lazy (Suspense) and the section runs the MC stress test on mount —
    // while paths stream the page re-renders on every progress tick and a
    // drag started mid-run never arms the zoom.
    await waitForStressTest(page);
    const svg = perYearChartSvg(page);
    await expect(svg).toBeVisible({ timeout: 10_000 });
    await expect(svg.locator('path').first()).toBeVisible({ timeout: 10_000 });

    // Derive the bounding box of the SVG so we can synthesise a drag
    // that spans from ~20% to ~60% of the plot width. The drag must
    // land on the chart's own svg (the pointer handlers are bound to it),
    // not the section around it or the heading's info icon.
    // Scroll the chart into view first:
    // it sits below the fold, and mouse events at off-viewport
    // coordinates dispatch nowhere — the drag silently never arms.
    // Centre it (`block: 'center'`), not `scrollIntoViewIfNeeded()`'s
    // nearest-edge scroll: the page pins the
    // controls strip + tab row to the top of the viewport at `lg`, and a
    // nearest-edge scroll can leave the chart's top (and the drag's y
    // coordinate) directly under that strip, where a synthesized mousedown
    // never reaches the chart.
    await svg.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = await svg.boundingBox();
    expect(box).not.toBeNull();

    const x1 = box!.x + box!.width * 0.2;
    const x2 = box!.x + box!.width * 0.6;
    const y = box!.y + box!.height * 0.5;

    // Drag: mousedown at x1 → move to x2 → mouseup.
    // The drag span is 40% of the chart width; the demo dataset spans
    // ~30 years so a 40% drag covers ~12 years — well above the ≥1-year
    // minimum enforced by useChartZoom.
    await page.mouse.move(x1, y);
    await page.mouse.down();
    // Move in small steps so the chart's pointermove handler fires consistently.
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const xi = x1 + ((x2 - x1) * i) / steps;
      await page.mouse.move(xi, y);
    }
    await page.mouse.up();

    // After a valid drag, "Reset view" must appear.
    const resetBtn = page.getByRole('button', { name: /reset view/i });
    await expect(resetBtn).toBeVisible({ timeout: 10_000 });

    // Clicking Reset restores the full domain — the button should vanish.
    await resetBtn.click();
    await expect(resetBtn).not.toBeVisible({ timeout: 3_000 });
  });
});
