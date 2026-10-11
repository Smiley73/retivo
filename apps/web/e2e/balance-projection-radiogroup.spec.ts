/**
 * Balance Projection segmented control — keyboard + focus smoke.
 *
 * `<SegmentedRadioGroup>` is built on React Aria's `RadioGroup`/`Radio`.
 * This real-browser keyboard/focus assertion over it at
 * `BalanceProjectionPage` covers what a jsdom test cannot.
 *
 * Asserts the framework-independent radiogroup contract React Aria owns:
 *   1. The "Display unit" control is a real `radiogroup` with two
 *      `radio` options; the checked one is the sole tab stop.
 *   2. Arrow keys move AND select (selection-follows-focus), wrapping
 *      at both ends — focus follows the selection.
 *   3. Space/Enter on a focused option selects it.
 *
 * Driven through the live page reached from demo data, like the
 * dialog smoke.
 */
import { test, expect, loadDemo } from './fixtures';

test.describe('Balance Projection radiogroup (Headless UI) keyboard + focus', () => {
  test('Display-unit radiogroup: roving tab stop, arrow-selects with wrap', async ({
    page,
  }) => {
    // Seed demo data so the projection page has a scenario to render.
    await loadDemo(page);

    await page.goto('/balance-projection');
    await expect(
      page.getByRole('heading', { name: /balance projection/i }),
    ).toBeVisible({ timeout: 10_000 });

    const group = page.getByRole('radiogroup', { name: 'Display unit' });
    await expect(group).toBeVisible({ timeout: 10_000 });

    const today = page.getByRole('radio', { name: "Today's dollars" });
    const future = page.getByRole('radio', { name: 'Future dollars' });
    await expect(today).toBeVisible();
    await expect(future).toBeVisible();

    // Default selection = Today's dollars; it is the sole tab stop.
    // (React Aria renders NATIVE radio inputs — checkedness is the
    // `checked` property, not aria-checked.)
    await expect(today).toBeChecked();
    await expect(future).not.toBeChecked();
    await expect(today).toHaveAttribute('tabindex', '0');
    await expect(future).toHaveAttribute('tabindex', '-1');

    // Focus the checked radio, ArrowRight moves AND selects the next
    // option (selection-follows-focus) and focus follows.
    await today.focus();
    await expect(today).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(future).toBeChecked();
    await expect(today).not.toBeChecked();
    await expect(future).toBeFocused();

    // ArrowRight again wraps from last back to first.
    await page.keyboard.press('ArrowRight');
    await expect(today).toBeChecked();
    await expect(today).toBeFocused();

    // ArrowLeft wraps from first to last.
    await page.keyboard.press('ArrowLeft');
    await expect(future).toBeChecked();
    await expect(future).toBeFocused();

    // Space on a focused option keeps it selected (no throw / no
    // accidental deselect — radios have no "off" state).
    await page.keyboard.press(' ');
    await expect(future).toBeChecked();
  });
});
