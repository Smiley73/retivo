/**
 * Shared Playwright fixtures. Each test gets a fully fresh workspace:
 *
 *  1. Server reset — the seeded dev user's household-scoped rows
 *     (sync state + key envelope) are purged straight against
 *     DynamoDB Local (see server-state.ts). Without this, the next
 *     bootstrap would just re-pull the previous test's data.
 *  2. Local reset — cookies cleared + every IndexedDB database
 *     deleted in the page context (the wipe runs via `evaluate`
 *     because IDB lives on the document, not the runner).
 *  3. Sign-in — the suite runs against the full local stack
 *     (emulators + API + web; CI boots all three), authenticating as
 *     the seeded `dev@local.test` user whose credentials the login
 *     page prefills on localhost dev builds. The purge re-arms the
 *     first-time encryption setup, so the fixture walks
 *     Sign in → Set up encryption → recovery-key confirm; the app
 *     then lands on the dashboard with zero members, which pops the
 *     first-run "Load demo data?" modal the tests build on.
 */
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { purgeHouseholdState } from './server-state';

/**
 * The `<svg>` of the Balance Projection page's per-year projection chart.
 *
 * `section.locator('svg').first()` (or a bare `page.locator('svg')`) is the
 * wrong handle: the section heading's info icon and the sidebar icons are
 * `<svg>` elements that come first, so it resolves to a small icon and a test
 * on it never touches the chart. The chart is the `role="img"` frame named by
 * the chart's `ariaLabel`, matched with CSS so it still resolves while the
 * Overview panel is force-mounted but hidden (a role query skips hidden
 * elements).
 */
export function perYearChartSvg(page: Page): Locator {
  return page.locator(
    '[aria-label="Per-year projection"] [role="img"][aria-label="Balance projection chart"] svg',
  );
}

/**
 * Click "Load demo data" on the first-run modal and wait for the seed to
 * land. The dialog stays open (its button flips to "Loading…") while the
 * loader writes IndexedDB and closes only after every entity has been
 * persisted — the dialog disappearing is therefore the only trustworthy
 * "demo data is on disk" signal. Waiting for the dashboard heading is NOT
 * enough: the dashboard already renders behind the modal, so the heading
 * is visible before the seed even starts, and a navigation fired at that
 * point reloads the app against a half-written (or empty) workspace and
 * re-arms this very modal.
 */
export async function loadDemo(page: Page): Promise<void> {
  const modal = page.getByRole('dialog', { name: /try the demo dataset/i });
  // 60s: AppShell opens this modal only after the post-sign-in sync
  // settles with zero members — on a cold CI runner that settle has
  // been observed outliving a 15s wait.
  await modal
    .getByRole('button', { name: /load demo data/i })
    .click({ timeout: 60_000 });
  await expect(modal).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible({
    timeout: 15_000,
  });
  // The seeder enqueues hundreds of mutations; wait for the push/ack
  // cycle to drain before handing the page to the test. A sync ack
  // landing mid-test can re-render page state out from under an
  // in-progress form edit.
  //
  // Badge states: "Syncing…" → "Synced <relative time>" (bare "Synced"
  // until the first timestamp lands — match \b, not a trailing space).
  // A transient client-side error parks it at "Sync failed" until the
  // next backoff retry; clicking the badge retries immediately, and
  // polling (1s cadence) leaves the retried push room to finish before
  // the next look. On timeout the failure message names the stuck
  // state via the last polled label.
  //
  // 120s: the seed's encrypt+push runs client-side and competes for
  // the CI runner's 2 vCPUs with Vite's cold on-demand transforms.
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

/**
 * Reset the browser + server so a fresh test starts from a purged, signed-out
 * state: wipe the household-scoped server rows, clear cookies, delete every
 * IndexedDB database, and land on `/login`.
 */
export async function resetBrowserAndServer(page: Page): Promise<void> {
  await purgeHouseholdState();
  await page.context().clearCookies();
  // Navigate to the origin first so `indexedDB` is available, then
  // wipe before the test body runs.
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
  // Reload so the cleared IDB takes effect; '/' routes the signed-out
  // browser to /login (the seeded dev user exists, so hasUsers=true).
  await page.goto('/');
}

/**
 * Sign in as the seeded dev user and complete first-time encryption setup,
 * stopping at the recovery-key Continue click (the app shell loads after it).
 * On a purged household this always walks Sign in → Set up encryption →
 * recovery-key confirm; the password field is prefilled by the dev-credentials
 * path.
 */
export async function signInSeededDevUser(page: Page): Promise<void> {
  // Generous ceiling: the first navigation of a CI run pays Vite's
  // cold on-demand transform of the whole login/app module graph.
  await page
    .getByRole('button', { name: /^sign in$/i })
    .click({ timeout: 60_000 });
  // Fresh (purged) household → first-time encryption setup; the
  // password field is prefilled by the same dev-credentials path.
  await page
    .getByRole('button', { name: /set up encryption/i })
    .click({ timeout: 30_000 });
  // Recovery-key modal: Continue is gated on the saved-key checkbox.
  // React Aria's Checkbox visually hides the native input, so `.check()`
  // can't act on it — click the visible label instead.
  await page
    .getByText('I have saved my recovery key')
    .click({ timeout: 30_000 });
  await page.getByRole('button', { name: /^continue$/i }).click();
}

export interface CapturedSession {
  /** Bearer access token pulled off the SPA's own authenticated request. */
  accessToken: string;
  /**
   * The API origin the SPA actually resolved (`new URL(req).origin` of its own
   * authenticated call). Captured from live traffic rather than reconstructed,
   * so it reflects whatever `VITE_API_BASE_URL` / api-base-url.ts resolved to —
   * the repo's single source of truth for the API base — instead of a
   * hardcoded `http://<hostname>:3001`.
   */
  apiOrigin: string;
}

/**
 * Read the current access token AND the resolved API origin off the signed-in
 * app's own traffic.
 *
 * The SPA keeps the access token in memory (AuthContext) and attaches it as
 * `Authorization: Bearer <token>` to every authenticated call (api/client.ts) —
 * the ~1s sync poll loop alone emits one continuously. Navigating to an
 * authenticated page guarantees prompt traffic; we then read the bearer AND the
 * request's origin off the next such request rather than reaching into React
 * state or hardcoding the API base. Used by the security E2E specs to
 * replay/forge requests with the real session token against the real API
 * origin.
 */
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
  /** Parsed JSON body (payload on success, envelope on error), or null. */
  body: unknown;
}

/**
 * Issue an authenticated JSON request from INSIDE the page, mirroring how the
 * SPA's api/client.ts talks to the API: `apiOrigin` is the SPA's own resolved
 * API base (captured from live traffic by `captureAccessToken`, so it honors
 * `VITE_API_BASE_URL` / api-base-url.ts rather than a hardcoded host:port), the
 * bearer rides on `Authorization`, and — for state-changing methods — the
 * `X-CSRF-Token` header echoes the non-HttpOnly `csrf-token` cookie
 * (double-submit). Running in the browser means the request carries the real
 * same-origin `Origin` + cookies. Returns status + error code + parsed body so
 * a test can assert on the API envelope directly.
 */
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
    // The app shell is up once the dashboard heading lands — the first-run
    // effect opens the demo modal shortly after.
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible({
      timeout: 30_000,
    });
    await use(page);
  },
});

export { expect, type Page };
