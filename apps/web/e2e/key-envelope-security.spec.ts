/**
 * Local security E2E — cross-user isolation + key-envelope concurrency.
 *
 * Runs against the full local emulator stack (see e2e/fixtures.ts) and confirms,
 * end to end, two invariants (the gated `apps/api/src/test/key-envelope.spec.ts`
 * and the web `auth/user-transition.test.ts` suites remain the authoritative
 * regression guard — these Playwright specs are additive confirmation):
 *
 *   1. Account switch — signing in as an account whose id differs from the one
 *      the device last served drops the previous household's IndexedDB working
 *      store before the new claims take effect, so the prior household's data is
 *      unavailable to the new session (auth/user-transition.ts cross-user guard).
 *   2. Stale key-envelope writer conflict + refetch/retry — a writer that no
 *      longer holds the current envelope-set version is rejected with
 *      `409 STALE_ENVELOPE_VERSION` (the server checks the version the writer
 *      expects against the stored one before writing), and succeeds after
 *      refetching the current version and retrying. The write transaction's own
 *      version condition is the backstop for two truly concurrent writers,
 *      which sequential requests here cannot reproduce.
 *
 * Runs serially — the whole suite shares the one seeded dev user.
 */
import {
  test,
  expect,
  loadDemo,
  captureAccessToken,
  authedFetch,
  signInSeededDevUser,
} from './fixtures';
import { purgeHouseholdState } from './server-state';

test.describe.configure({ mode: 'serial' });

const KEY_ENVELOPES = '/api/v1/auth/key-envelopes';
// Opaque, non-empty envelope-set tag — the server stores it verbatim (never
// recomputes it), so any bounded non-empty value satisfies the DTO.
const OPAQUE_TAG = 'e2e-opaque-envelope-set-tag';
const LAST_USER_STORAGE_KEY = 'retivo.auth.lastUserId';

/**
 * A minimal, DTO-valid slot body. `wrappedKey` is stored opaquely (never
 * decrypted), so a short placeholder is accepted; the server overrides
 * `householdId` from the JWT. The slot is a `recovery` slot because the
 * server pins a `password` slot to its one canonical id, and these writers
 * need distinct ids to race on the envelope-set version.
 */
function makeSlot(slotId: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    householdId: 'placeholder-overridden-by-server',
    slotId,
    slotType: 'recovery',
    wrappedKey: 'AAAA',
    encryptionVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

test.describe('key-envelope + cross-user security', () => {
  test('signing in as a different account leaves the previous household’s local data unavailable', async ({
    page,
  }) => {
    // Seed household A's data into this device's IndexedDB.
    await loadDemo(page);
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();

    // Sign out. A same-user logout deliberately KEEPS the local working store
    // (AuthContext: fast re-login), so the demo aggregates are still on disk here
    // — exactly the state the cross-user guard must not expose to a different
    // account.
    await page.getByRole('button', { name: /^sign out$/i }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });

    // Empty the server household so a post-drop bootstrap has nothing to re-pull
    // (isolates the assertion to the LOCAL drop, not a server round-trip), then
    // point the device's "last user" tracker at a different account id. The real
    // cross-user guard (auth/user-transition.ts) drops IndexedDB whenever the
    // account now signing in differs from the one the device last served.
    await purgeHouseholdState();
    await page.evaluate(
      (key) => localStorage.setItem(key, 'e2e-other-household-user'),
      LAST_USER_STORAGE_KEY,
    );

    // Sign back in as the dev user (now a DIFFERENT id than the tracker) → the
    // interactive login runs the cross-user guard → the previous household's
    // IndexedDB is dropped before the new claims take effect. The purge re-armed
    // first-time encryption, so the sign-in walks the encryption-setup path.
    await signInSeededDevUser(page);
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible({
      timeout: 30_000,
    });

    // Previous household data is gone: the fresh, empty workspace re-arms the
    // first-run demo modal (zero members). Had the guard NOT dropped the store,
    // household A's demo members would still render and this modal would not
    // appear. 60s: the modal opens only after the post-sign-in sync settles with
    // zero members (see loadDemo).
    await expect(
      page.getByRole('dialog', { name: /try the demo dataset/i }),
    ).toBeVisible({ timeout: 60_000 });
  });

  test('a stale key-envelope writer is rejected, then succeeds after refetch + retry', async ({
    page,
  }) => {
    const { accessToken: token, apiOrigin } = await captureAccessToken(page);

    // First-time encryption setup during sign-in created the initial slot + meta,
    // so the household already has an envelope-set version to build on.
    const initial = await authedFetch(page, token, apiOrigin, {
      method: 'GET',
      path: KEY_ENVELOPES,
    });
    expect(initial.status).toBe(200);
    const base = (initial.body as { envelopeSetVersion: number }).envelopeSetVersion;

    // A first writer advances the set base → base+1.
    const firstWrite = await authedFetch(page, token, apiOrigin, {
      method: 'PUT',
      path: `${KEY_ENVELOPES}/e2e-conflict-a`,
      csrf: true,
      body: {
        slot: makeSlot('e2e-conflict-a'),
        envelopeSetVersion: base + 1,
        expectedEnvelopeSetVersion: base,
        envelopeSetTag: OPAQUE_TAG,
      },
    });
    expect(firstWrite.status).toBe(204);

    // A stale writer still holding `base` now tries to advance base → base+1, but
    // the stored version already moved to base+1, so the version it expects no
    // longer matches the stored one → 409 STALE_ENVELOPE_VERSION. The boundary
    // single-step check passes (base+1 == base + 1), so the conflict comes from
    // the stored-version comparison, not the arithmetic guard. These requests
    // are sequential, so the write transaction's own version condition (the
    // backstop for truly concurrent writers) is not what rejects it here.
    const staleWrite = await authedFetch(page, token, apiOrigin, {
      method: 'PUT',
      path: `${KEY_ENVELOPES}/e2e-conflict-b`,
      csrf: true,
      body: {
        slot: makeSlot('e2e-conflict-b'),
        envelopeSetVersion: base + 1,
        expectedEnvelopeSetVersion: base,
        envelopeSetTag: OPAQUE_TAG,
      },
    });
    expect(staleWrite.status).toBe(409);
    expect(staleWrite.code).toBe('STALE_ENVELOPE_VERSION');

    // Refetch the current version and retry — the write now advances the set
    // cleanly (the client's real refetch-on-409 recovery, key-envelope-client.ts).
    const refetched = await authedFetch(page, token, apiOrigin, {
      method: 'GET',
      path: KEY_ENVELOPES,
    });
    expect(refetched.status).toBe(200);
    const current = (refetched.body as { envelopeSetVersion: number }).envelopeSetVersion;
    expect(current).toBe(base + 1);

    const retry = await authedFetch(page, token, apiOrigin, {
      method: 'PUT',
      path: `${KEY_ENVELOPES}/e2e-conflict-b`,
      csrf: true,
      body: {
        slot: makeSlot('e2e-conflict-b'),
        envelopeSetVersion: current + 1,
        expectedEnvelopeSetVersion: current,
        envelopeSetTag: OPAQUE_TAG,
      },
    });
    expect(retry.status).toBe(204);
  });
});
