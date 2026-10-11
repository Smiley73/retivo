/**
 * Dialog keyboard + focus smoke.
 *
 * The shared `<Modal>` / `<ConfirmDialog>` are built on React Aria's
 * `Modal`/`Dialog`. The Vitest suites cover the contract in
 * jsdom; this Playwright smoke proves the real-browser behaviors React Aria
 * owns and jsdom can't fully exercise:
 *   1. Esc closes the dialog.
 *   2. Backdrop (scrim) click closes the dialog.
 *   3. Focus is trapped inside the panel while open and restored to the
 *      opener element on close.
 *
 * Driven through a real in-app `<Modal>`: the "Add Year" balance-entry
 * modal on the per-account balances page, reached from demo data.
 */
import { test, expect, loadDemo } from './fixtures';

test.describe('dialog (Headless UI) keyboard + focus', () => {
  test('Esc + scrim close the modal and focus is trapped then restored', async ({
    page,
  }) => {
    // Seed demo data so the balances list has accounts.
    await loadDemo(page);

    await page.goto('/account-balances');
    await expect(
      page.getByRole('heading', { name: /account balances/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Open the per-account balances page via the first Edit/View button.
    const editBalances = page
      .getByRole('button', { name: /balances for /i })
      .first();
    await expect(editBalances).toBeVisible({ timeout: 10_000 });
    await editBalances.click();

    // The page-header primary action opens the shared <Modal>.
    const addYear = page.getByRole('button', { name: /^add year$/i });
    await expect(addYear).toBeVisible({ timeout: 10_000 });
    await addYear.focus();
    await addYear.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // No aria-modal assertion: the shared Modal is a React Aria Dialog,
    // which hides the background tree (ariaHideOutside) instead of
    // setting aria-modal. The focus-trap + Esc/scrim checks below are
    // the real modal contract.

    // Focus moved into the dialog (React Aria auto-focus / focus trap).
    await expect
      .poll(async () =>
        dialog.evaluate((d) => d.contains(document.activeElement)),
      )
      .toBe(true);

    // Tab cycles stay inside the panel — focus never escapes to the
    // page behind the scrim.
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      expect(
        await dialog.evaluate((d) => d.contains(document.activeElement)),
      ).toBe(true);
    }

    // Esc closes; focus returns to the trigger button.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(addYear).toBeFocused();

    // Reopen, then close via a backdrop (scrim) click.
    await addYear.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    // The scrim covers the viewport; click near a corner, away from the
    // centered panel.
    await page.mouse.click(8, 8);
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(addYear).toBeFocused();
  });
});
