/**
 * Cross-user isolation in a browser: signing in as a different account drops the previous household's IndexedDB.
 * Runs serially on the one seeded dev user.
 */
import { test, expect, loadDemo, signInSeededDevUser } from './fixtures';
import { purgeHouseholdState } from './server-state';

test.describe.configure({ mode: 'serial' });

const LAST_USER_STORAGE_KEY = 'retivo.auth.lastUserId';

test.describe('cross-user security', () => {
  test('signing in as a different account leaves the previous household’s local data unavailable', async ({
    page,
  }) => {
    await loadDemo(page);
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();

    // A same-user logout keeps the local store (fast re-login), so household A's data is still on disk here.
    await page.getByRole('button', { name: /^sign out$/i }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });

    // Empty the server household so a bootstrap has nothing to re-pull, then make the device's last user differ.
    await purgeHouseholdState();
    await page.evaluate(
      (key) => localStorage.setItem(key, 'e2e-other-household-user'),
      LAST_USER_STORAGE_KEY,
    );

    await signInSeededDevUser(page);
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible({
      timeout: 30_000,
    });

    // An empty workspace re-arms the first-run modal; had the store survived, household A's members would render instead.
    // 60s: the modal opens only after the post-sign-in sync settles.
    await expect(
      page.getByRole('dialog', { name: /try the demo dataset/i }),
    ).toBeVisible({ timeout: 60_000 });
  });
});
