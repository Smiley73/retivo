/**
 * Local security E2E — session/auth boundary.
 *
 * Runs against the full local emulator stack (see e2e/fixtures.ts) and confirms,
 * end to end, two auth-boundary invariants the unit/integration suites also
 * cover (the gated `apps/api/src/test/*.spec.ts` suites remain the authoritative
 * regression guard — these Playwright specs are additive confirmation):
 *
 *   1. CSRF / Origin rejection — a state-changing request without a valid
 *      double-submit CSRF token, and a cross-origin write with a forged Origin,
 *      are both refused before any handler runs (csrf.middleware.ts /
 *      origin-check.middleware.ts).
 *   2. Logout access-token revocation — after sign-out the previously-valid
 *      access token can no longer perform an authenticated call, because logout
 *      denylists its jti (auth.controller logout() → RevokedToken →
 *      JwtAuthGuard).
 *
 * The two MFA-challenge journeys that also belong in this file
 * (completed-challenge replay rejection; device-ID substitution rejection) are
 * `test.skip` below: the local dev stack runs `AUTH_MFA_ENFORCED=false` and the
 * shared sign-in fixture authenticates via the seeded dev-credentials path,
 * which never issues an MFA challenge token — so there is no real challenge to
 * replay or rebind against the current harness. See the skip comment.
 *
 * Runs serially — the whole suite shares the one seeded dev user.
 */
import { test, expect, loadDemo, captureAccessToken, authedFetch } from './fixtures';

test.describe.configure({ mode: 'serial' });

test.describe('auth security boundary', () => {
  test('state-changing requests without a valid CSRF token or Origin are rejected', async ({
    page,
  }) => {
    const KEY_ENVELOPES = '/api/v1/auth/key-envelopes';

    // Resolve the API origin the SPA itself uses (honors VITE_API_BASE_URL via
    // api-base-url.ts) from its own live traffic, rather than hardcoding a
    // host:port. The access token is unused here on purpose (see below).
    const { apiOrigin } = await captureAccessToken(page);

    // Same-origin write with the csrf-token cookie present but NO X-CSRF-Token
    // header → the double-submit check fails. The CSRF middleware runs ahead of
    // the auth guard, so this is refused before any handler and needs no bearer.
    const missingCsrf = await authedFetch(page, null, apiOrigin, {
      method: 'PUT',
      path: `${KEY_ENVELOPES}/e2e-csrf-probe`,
      body: {},
      csrf: false,
    });
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.code).toBe('CSRF_TOKEN_MISMATCH');

    // Cross-origin write carrying a VALID CSRF token but a forged Origin header →
    // refused by the Origin check (defense in depth beyond CSRF). Issued from the
    // Node request context so the Origin can be forged (a real browser fetch
    // cannot override it). page.request shares the browser context's cookies, so
    // the csrf-token cookie rides along and the CSRF check passes — isolating the
    // failure to the Origin boundary.
    const csrfCookie = (await page.context().cookies()).find(
      (c) => c.name === 'csrf-token',
    );
    const forgedOrigin = await page.request.put(
      `${apiOrigin}${KEY_ENVELOPES}/e2e-origin-probe`,
      {
        headers: {
          Origin: 'https://evil.example.com',
          'X-CSRF-Token': csrfCookie?.value ?? '',
          'Content-Type': 'application/json',
        },
        data: {},
        failOnStatusCode: false,
      },
    );
    expect(forgedOrigin.status()).toBe(403);
    expect(((await forgedOrigin.json()) as { error: { code: string } }).error.code).toBe(
      'ORIGIN_MISMATCH',
    );
  });

  test('logout revokes the access token so it can no longer make authenticated calls', async ({
    page,
  }) => {
    // loadDemo dismisses the first-run modal and lands a stable, synced
    // dashboard so the sidebar "Sign out" control is reachable.
    await loadDemo(page);

    const { accessToken: token, apiOrigin } = await captureAccessToken(page);

    // The captured token authenticates a protected read today.
    const before = await authedFetch(page, token, apiOrigin, {
      method: 'GET',
      path: '/api/v1/auth/key-envelopes',
    });
    expect(before.status).toBe(200);

    // Sign out → the server denylists this access token's jti in logout().
    await page.getByRole('button', { name: /^sign out$/i }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });

    // The same token is now refused: the JwtAuthGuard's RevokedToken check fails
    // closed with 401 ACCESS_TOKEN_REVOKED. Poll the status to absorb the
    // denylist write's propagation on the local emulator before asserting.
    await expect
      .poll(
        async () =>
          (
            await authedFetch(page, token, apiOrigin, {
              method: 'GET',
              path: '/api/v1/auth/key-envelopes',
            })
          ).status,
        { timeout: 15_000 },
      )
      .toBe(401);
    const after = await authedFetch(page, token, apiOrigin, {
      method: 'GET',
      path: '/api/v1/auth/key-envelopes',
    });
    expect(after.code).toBe('ACCESS_TOKEN_REVOKED');
  });

  // HARNESS GAP — MFA challenge journeys are unrunnable against the current local
  // stack. `AUTH_MFA_ENFORCED=false` in local dev and the shared sign-in fixture
  // (fixtures.ts → signInSeededDevUser) uses the no-MFA dev-credentials path, so
  // the app never issues an MFA challenge token: there is no completed challenge
  // to replay and no device-bound challenge to substitute. The authoritative
  // regression guard for both remains the gated emulator suite
  // `apps/api/src/test/mfa.spec.ts`. Re-enable once the e2e fixture can
  // drive a real enforced-MFA sign-in.
  test.skip(
    'a completed MFA challenge cannot be replayed sequentially or concurrently',
    () => {},
  );
  test.skip(
    'an MFA challenge bound to one device is rejected for a substituted device',
    () => {},
  );
});
