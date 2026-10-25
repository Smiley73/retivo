/**
 * Auth-boundary invariants in a browser: CSRF/Origin rejection and access-token revocation on logout.
 * MFA replay and device binding are not driven here: the local stack runs without enforced MFA.
 */
import { test, expect, loadDemo, captureAccessToken, authedFetch } from './fixtures';

test.describe.configure({ mode: 'serial' });

test.describe('auth security boundary', () => {
  test('state-changing requests without a valid CSRF token or Origin are rejected', async ({
    page,
  }) => {
    const KEY_ENVELOPES = '/api/v1/auth/key-envelopes';

    const { apiOrigin } = await captureAccessToken(page);

    // No X-CSRF-Token header; CSRF runs ahead of the auth guard, so no bearer is needed.
    const missingCsrf = await authedFetch(page, null, apiOrigin, {
      method: 'PUT',
      path: `${KEY_ENVELOPES}/e2e-csrf-probe`,
      body: {},
      csrf: false,
    });
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.code).toBe('CSRF_TOKEN_MISMATCH');

    // Valid CSRF token, forged Origin. page.request, unlike browser fetch, can set Origin and shares the context's cookies.
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
    await loadDemo(page);

    const { accessToken: token, apiOrigin } = await captureAccessToken(page);

    const before = await authedFetch(page, token, apiOrigin, {
      method: 'GET',
      path: '/api/v1/auth/key-envelopes',
    });
    expect(before.status).toBe(200);

    await page.getByRole('button', { name: /^sign out$/i }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });

    // Poll: the denylist write takes a moment to propagate on the emulator.
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
});
