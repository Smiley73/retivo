/** Real-browser modal behaviour React Aria owns and jsdom cannot exercise: Esc, scrim click, focus trap and focus restore. */
import { test, expect, loadDemo } from './fixtures';

test.describe('dialog (Headless UI) keyboard + focus', () => {
  test('Esc + scrim close the modal and focus is trapped then restored', async ({
    page,
  }) => {
    await loadDemo(page);

    await page.goto('/account-balances');
    // Level 1: a section heading ("Account balances over time") also matches the name.
    await expect(
      page.getByRole('heading', { level: 1, name: /account balances/i }),
    ).toBeVisible({ timeout: 10_000 });

    const editBalances = page
      .getByRole('button', { name: /balances for /i })
      .first();
    await expect(editBalances).toBeVisible({ timeout: 10_000 });
    await editBalances.click();

    const addYear = page.getByRole('button', { name: /^add year$/i });
    await expect(addYear).toBeVisible({ timeout: 10_000 });
    await addYear.focus();
    await addYear.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // No aria-modal check: React Aria hides the background with `ariaHideOutside` instead.
    await expect
      .poll(async () =>
        dialog.evaluate((d) => d.contains(document.activeElement)),
      )
      .toBe(true);

    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      expect(
        await dialog.evaluate((d) => d.contains(document.activeElement)),
      ).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(addYear).toBeFocused();

    await addYear.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    // Corner click: the scrim covers the viewport, away from the centred panel.
    await page.mouse.click(8, 8);
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(addYear).toBeFocused();
  });
});
