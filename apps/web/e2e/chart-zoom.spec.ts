/** Drag-zoom and Reset view on the Balance Projection chart; needs real SVG layout, so it runs in a browser rather than jsdom. */
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
    await loadDemo(page);

    await page.goto('/balance-projection');
    await expect(
      page.getByRole('heading', { name: /balance projection/i }),
    ).toBeVisible({ timeout: 10_000 });

    const chartSection = page.locator('[aria-label="Per-year projection"]');
    await expect(chartSection).toBeVisible({ timeout: 10_000 });

    // A drag started while the stress test streams never arms the zoom.
    await waitForStressTest(page);
    const svg = perYearChartSvg(page);
    await expect(svg).toBeVisible({ timeout: 10_000 });
    await expect(svg.locator('path').first()).toBeVisible({ timeout: 10_000 });

    // Centre the chart: a nearest-edge scroll can land it under the pinned controls strip, where mousedown never reaches it.
    await svg.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = await svg.boundingBox();
    expect(box).not.toBeNull();

    const x1 = box!.x + box!.width * 0.2;
    const x2 = box!.x + box!.width * 0.6;
    const y = box!.y + box!.height * 0.5;

    await page.mouse.move(x1, y);
    await page.mouse.down();
    // Small steps so the pointermove handler fires consistently.
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const xi = x1 + ((x2 - x1) * i) / steps;
      await page.mouse.move(xi, y);
    }
    await page.mouse.up();

    const resetBtn = page.getByRole('button', { name: /reset view/i });
    await expect(resetBtn).toBeVisible({ timeout: 10_000 });

    await resetBtn.click();
    await expect(resetBtn).not.toBeVisible({ timeout: 3_000 });
  });
});
