/** Cross-page journeys: a scenario edit moves the projection headline, and a created expense survives a hard reload. */
import { test, expect, loadDemo } from './fixtures';

test.describe('journeys', () => {
  test('editing the active scenario’s planned returns changes the projection headline', async ({
    page,
  }) => {
    await loadDemo(page);

    // xpath: the stat's label and value are sibling divs.
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

    // The row carrying the "Active" badge.
    await page.goto('/scenarios');
    const activeRow = page
      .locator('.scenario-tree > *')
      .filter({ hasText: /active/i })
      .first();
    await expect(activeRow).toBeVisible({ timeout: 10_000 });
    await activeRow.getByRole('button', { name: /^edit /i }).click();

    // Override every account: one small account can move the $M-rounded headline by less than the rounding step.
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
      // Click before fill: a React Aria Table can redirect fill()'s focus to the row.
      await input.click();
      await input.fill('-15');
      await input.blur();
      await expect(input).toHaveValue('-15.0');
    }
    await page.getByRole('button', { name: /^save$/i }).click();

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

    // Reload only: a reload followed by a goto aborts the boot-time session refresh and bounces to /login.
    await page.reload();
    await expect(page.getByText('E2E Persistence Check')).toBeVisible({
      timeout: 15_000,
    });
  });
});
