// `useProfileExport`'s `verifyForExport`: the access token captured for the export transport must be fresh before the export-authorization cookie is minted and never refreshed during the export (see `downloadExport` in `use-profile-export.ts`); a password verification landing seconds before token expiry must not mint the cookie for a stale token.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useProfileExport } from './use-profile-export';
import { clearAllStores } from '../db/store';

const verifyPasswordMock = vi.fn().mockResolvedValue(undefined);
const refreshAccessTokenMock = vi.fn().mockResolvedValue('fresh-token');
const getHdkMock = vi.fn(() => null);

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    verifyPassword: verifyPasswordMock,
    getHdk: getHdkMock,
    refreshAccessToken: refreshAccessTokenMock,
  }),
}));

// Swap the real `getCurrentAccessToken`/`configureApi` for a controllable stub so tests can simulate a token with a chosen remaining TTL (the refresh regression test asserts `refreshAccessToken` is not called when the token has most of its life left).
let currentAccessToken: string | null = null;
vi.mock('../api/client', () => ({
  getCurrentAccessToken: () => currentAccessToken,
}));

// A syntactically valid unsigned JWT: `decodeJwt` only reads the payload and never verifies the signature.
function fakeJwt(claims: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'RS256' })}.${b64url(claims)}.fake-signature`;
}

describe('useProfileExport — verifyForExport freshness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyPasswordMock.mockResolvedValue(undefined);
    // Mirror the real `refreshAccessToken`'s side effect: a successful refresh updates the token `getCurrentAccessToken()` next returns.
    refreshAccessTokenMock.mockImplementation(async () => {
      currentAccessToken = fakeJwt({
        userId: 'u1',
        householdId: 'h1',
        exp: Math.floor(Date.now() / 1000) + 5 * 60,
      });
      return currentAccessToken;
    });
    currentAccessToken = null;
  });

  it('refreshes the access token BEFORE re-verifying the password, so a near-expiry token is not what mints the export cookie', async () => {
    const order: string[] = [];
    refreshAccessTokenMock.mockImplementation(async () => {
      order.push('refresh');
      currentAccessToken = fakeJwt({
        userId: 'u1',
        householdId: 'h1',
        exp: Math.floor(Date.now() / 1000) + 5 * 60,
      });
      return currentAccessToken;
    });
    verifyPasswordMock.mockImplementation(async () => {
      order.push('verify');
    });

    const { result } = renderHook(() => useProfileExport());
    await result.current.verifyForExport('correct-password');

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(verifyPasswordMock).toHaveBeenCalledTimes(1);
    expect(verifyPasswordMock).toHaveBeenCalledWith('correct-password', {
      purpose: 'data_export',
    });
    // The refresh must complete before verifyPassword mints the cookie, or a token near expiry when the prompt opened is what gets bound to the export cookie.
    expect(order).toEqual(['refresh', 'verify']);
  });

  it('still verifies the password even when the refresh attempt is transient-fails (no worse than before this fix)', async () => {
    // A transient refresh failure leaves an existing token untouched rather than clearing it.
    currentAccessToken = fakeJwt({
      userId: 'u1',
      householdId: 'h1',
      exp: Math.floor(Date.now() / 1000) + 10,
    });
    refreshAccessTokenMock.mockResolvedValue(null);

    const { result } = renderHook(() => useProfileExport());
    await result.current.verifyForExport('correct-password');

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(verifyPasswordMock).toHaveBeenCalledTimes(1);
  });

  // Refreshing unconditionally, even when the captured token has most of its life left, creates a cross-tab race against a sibling tab's concurrent `/auth/refresh` on the shared rotating cookie; the loser gets a 401 and is logged out. Refresh only when the token needs it.
  it('does NOT refresh when the captured token still has most of its TTL left (avoids the cross-tab refresh race)', async () => {
    currentAccessToken = fakeJwt({
      userId: 'u1',
      householdId: 'h1',
      exp: Math.floor(Date.now() / 1000) + 4 * 60, // 4 minutes left, well above the near-expiry threshold
    });

    const { result } = renderHook(() => useProfileExport());
    await result.current.verifyForExport('correct-password');

    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(verifyPasswordMock).toHaveBeenCalledTimes(1);
    expect(verifyPasswordMock).toHaveBeenCalledWith('correct-password', {
      purpose: 'data_export',
    });
  });

  it('DOES refresh when the captured token is within the near-expiry threshold', async () => {
    currentAccessToken = fakeJwt({
      userId: 'u1',
      householdId: 'h1',
      exp: Math.floor(Date.now() / 1000) + 10, // 10 seconds left
    });

    const { result } = renderHook(() => useProfileExport());
    await result.current.verifyForExport('correct-password');

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(verifyPasswordMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes when there is no captured token at all', async () => {
    currentAccessToken = null;

    const { result } = renderHook(() => useProfileExport());
    await result.current.verifyForExport('correct-password');

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  // Regression: a token with 61s left, above the old 60s threshold (which only covered verifyPassword's own round trip), skipped the refresh although the five-minute export window it is bound to can outlive it.
  it('DOES refresh a token with 61 seconds remaining, comfortably inside the export window', async () => {
    currentAccessToken = fakeJwt({
      userId: 'u1',
      householdId: 'h1',
      exp: Math.floor(Date.now() / 1000) + 61,
    });

    const { result } = renderHook(() => useProfileExport());
    await result.current.verifyForExport('correct-password');

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(verifyPasswordMock).toHaveBeenCalledTimes(1);
  });

  // The token `downloadExport` is later handed must be the exact one `verifyForExport` used to mint the cookie, not a second `getCurrentAccessToken()` read that a same-tab background refresh could have raced in between.
  it('returns the exact (possibly refreshed) token used to mint the export cookie', async () => {
    currentAccessToken = fakeJwt({
      userId: 'u1',
      householdId: 'h1',
      exp: Math.floor(Date.now() / 1000) + 10,
    });
    refreshAccessTokenMock.mockImplementation(async () => {
      currentAccessToken = 'refreshed-token-xyz';
      return 'refreshed-token-xyz';
    });

    const { result } = renderHook(() => useProfileExport());
    const token = await result.current.verifyForExport('correct-password');

    expect(token).toBe('refreshed-token-xyz');
  });
});

// `downloadExport`'s core invariant, the same captured token feeding both the sync transport and `fetchAccountExport`, was never exercised end to end (other tests mock `exportServerData`). This drives the real `exportServerData` → `createExportSyncTransport`/`HttpSyncClient` → `fetchAccountExport` chain, stubbing only `fetch`, and inspects the `Authorization` header every request carried.
describe('useProfileExport — downloadExport token wiring (real exportServerData)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllStores();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-export');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await clearAllStores();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('sends the identical captured token to the sync transport (bootstrap + pull) AND fetchAccountExport, and never refreshes mid-export', async () => {
    currentAccessToken = 'captured-token-abc';
    const authHeaders: { url: string; auth: string | null }[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      const u = String(url);
      authHeaders.push({ url: u, auth });
      if (u.includes('/sync/bootstrap')) {
        return jsonResponse({
          snapshotId: null,
          workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
          postSnapshotMutations: [],
          syncCursor: '1',
          timestamp: '2026-01-01T00:00:00.000Z',
        });
      }
      if (u.includes('/sync/pull')) {
        return jsonResponse({ changes: [], newCursor: '1', hasMore: false });
      }
      if (u.includes('/auth/account-export')) {
        return jsonResponse({ user: { userId: 'u-1' }, history: [], nextCursor: null });
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useProfileExport());
    await result.current.downloadExport('hh-1', 'captured-token-abc');

    expect(authHeaders.some((h) => h.url.includes('/sync/bootstrap'))).toBe(true);
    expect(authHeaders.some((h) => h.url.includes('/sync/pull'))).toBe(true);
    expect(authHeaders.some((h) => h.url.includes('/auth/account-export'))).toBe(true);

    // Every request carried the same bearer token, which the export-authorization cookie's jti binding depends on.
    const distinctAuthValues = new Set(authHeaders.map((h) => h.auth));
    expect(distinctAuthValues).toEqual(new Set(['Bearer captured-token-abc']));

    // No mid-export refresh: it would rotate the jti and orphan the minted export-authorization cookie.
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  // The account-export deadline must come from the captured token's own `exp` (the cookie's TTL is designed to match it), not restart a fresh 5-minute window when `fetchAccountExport` starts, which would let a served wait sleep well past the real expiry.
  it('derives the account-export deadline from the exact captured token, so a served wait past its real remaining life fails visibly', async () => {
    const nearExpiryToken = fakeJwt({
      userId: 'u1',
      householdId: 'h1',
      exp: Math.floor(Date.now() / 1000) + 30, // only 30s of real life left
    });
    currentAccessToken = nearExpiryToken;
    const fetchMock = vi.fn().mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/sync/bootstrap')) {
        return jsonResponse({
          snapshotId: null,
          workspaceSnapshot: { householdId: 'hh-1', aggregates: [] },
          postSnapshotMutations: [],
          syncCursor: '1',
          timestamp: '2026-01-01T00:00:00.000Z',
        });
      }
      if (u.includes('/sync/pull')) {
        return jsonResponse({ changes: [], newCursor: '1', hasMore: false });
      }
      if (u.includes('/auth/account-export')) {
        // A served wait (60s) longer than the 30s of authorization life the captured token has left.
        return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        });
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useProfileExport());
    await expect(
      result.current.downloadExport('hh-1', nearExpiryToken),
    ).rejects.toThrow(/export session window/);

    // Failed on the very first attempt with no sleep started: the deadline check ran against the token's real ~30s of life, not a fresh 5-minute window.
    const accountExportCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/auth/account-export'),
    );
    expect(accountExportCalls).toHaveLength(1);
  });
});
