/** Playwright fixtures: each test starts from a purged server, a wiped browser and a signed-in seeded dev user. */
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { purgeHouseholdState } from './server-state';

/** The per-year chart's `<svg>`; a bare `svg` locator resolves to an icon. CSS so it still matches while the Overview panel is hidden. */
export function perYearChartSvg(page: Page): Locator {
  return page.locator(
    '[aria-label="Per-year projection"] [role="img"][aria-label="Balance projection chart"] svg',
  );
}

/** The "Success probability" card; `aria-busy` while a run is in flight or stale. */
export function successProbabilityCard(page: Page): Locator {
  return page
    .locator('div[aria-busy]')
    .filter({ hasText: /^Success probability/i });
}

/**
 * Wait until the embedded stress test has landed and none is about to start:
 * - sync badge reads "Synced" (after a reload a second run starts once the pull changes the data);
 * - outcomes stats show dollar values (the label is on screen from first paint with "—");
 * - success card is not `aria-busy`.
 */
export async function waitForStressTest(page: Page): Promise<void> {
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
    successProbabilityCard(page).and(page.locator('[aria-busy="false"]')),
  ).toHaveCount(1, { timeout: 60_000 });
}

/**
 * Load the demo data from the first-run modal and wait for the household to sync.
 * The modal closing is the "seed is on disk" signal; the dashboard heading renders behind it too early.
 */
export async function loadDemo(page: Page): Promise<void> {
  const modal = page.getByRole('dialog', { name: /try the demo dataset/i });
  // 60s: the modal opens only after the post-sign-in sync settles.
  await modal
    .getByRole('button', { name: /load demo data/i })
    .click({ timeout: 60_000 });
  await expect(modal).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible({
    timeout: 15_000,
  });
  // A sync ack landing mid-test can re-render state under an in-progress form edit.
  // Click the badge to retry a failed push. 120s: the seed's encrypt+push competes with cold Vite.
  const badge = page
    .getByRole('button', {
      name: /^(synced\b|syncing|offline|sync failed|sync blocked)/i,
    })
    .first();
  await expect
    .poll(
      async () => {
        const label = ((await badge.textContent().catch(() => '')) ?? '').trim();
        if (/sync failed/i.test(label)) await badge.click().catch(() => {});
        return label;
      },
      { timeout: 120_000 },
    )
    .toMatch(/^synced\b/i);
}

async function resetBrowserAndServer(page: Page): Promise<void> {
  await purgeHouseholdState();
  await page.context().clearCookies();
  // IndexedDB lives on the document, so load the origin before wiping it, then reload so the wipe takes effect.
  await page.goto('/');
  await page.evaluate(async () => {
    const dbs = await window.indexedDB.databases?.();
    if (!dbs) return;
    await Promise.all(
      dbs.map(
        ({ name }) =>
          new Promise<void>((resolve) => {
            if (!name) return resolve();
            const req = window.indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          }),
      ),
    );
  });
  await page.goto('/');
}

/** Sign in as the seeded dev user and finish first-time encryption setup, stopping at the recovery-key Continue click. */
export async function signInSeededDevUser(page: Page): Promise<void> {
  // 60s: the first navigation pays Vite's cold transform of the app.
  await page
    .getByRole('button', { name: /^sign in$/i })
    .click({ timeout: 60_000 });
  await page
    .getByRole('button', { name: /set up encryption/i })
    .click({ timeout: 30_000 });
  // React Aria hides the native checkbox input; click the label.
  await page
    .getByText('I have saved my recovery key')
    .click({ timeout: 30_000 });
  await page.getByRole('button', { name: /^continue$/i }).click();
}

export interface CapturedSession {
  accessToken: string;
  /** API origin the SPA resolved, read off its own request. */
  apiOrigin: string;
}

/** Read the bearer token and API origin off the signed-in app's next authenticated request. */
export async function captureAccessToken(page: Page): Promise<CapturedSession> {
  const [request] = await Promise.all([
    page.waitForRequest(
      (r) => (r.headers()['authorization'] ?? '').startsWith('Bearer '),
      { timeout: 30_000 },
    ),
    page.goto('/workspace'),
  ]);
  const authorization = request.headers()['authorization'] ?? '';
  return {
    accessToken: authorization.slice('Bearer '.length),
    apiOrigin: new URL(request.url()).origin,
  };
}

export interface AuthedFetchResult {
  status: number;
  /** `error.code` from the API error envelope, or null on success / non-JSON. */
  code: string | null;
  /** Parsed JSON body, or null. */
  body: unknown;
}

/** Issue an authenticated JSON request from inside the page, echoing the `csrf-token` cookie as `X-CSRF-Token` when `csrf` is set. */
export async function authedFetch(
  page: Page,
  accessToken: string | null,
  apiOrigin: string,
  opts: { method: string; path: string; body?: unknown; csrf?: boolean },
): Promise<AuthedFetchResult> {
  return page.evaluate(
    async ({ method, path, body, token, csrf, base }) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (csrf) {
        const match = document.cookie.match(/(?:^|; )csrf-token=([^;]*)/);
        if (match) headers['X-CSRF-Token'] = decodeURIComponent(match[1]!);
      }
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'include',
      });
      let parsed: unknown = null;
      try {
        parsed = await res.clone().json();
      } catch {
        parsed = null;
      }
      const envelopeCode =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? (parsed as { error?: { code?: unknown } }).error?.code
          : null;
      return {
        status: res.status,
        code: typeof envelopeCode === 'string' ? envelopeCode : null,
        body: parsed,
      };
    },
    {
      method: opts.method,
      path: opts.path,
      body: opts.body,
      token: accessToken,
      csrf: opts.csrf ?? false,
      base: apiOrigin,
    },
  );
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await resetBrowserAndServer(page);
    await signInSeededDevUser(page);
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible({
      timeout: 30_000,
    });
    await use(page);
  },
});

export { expect, type Page };
