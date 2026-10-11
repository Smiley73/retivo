/**
 * Integration test for the SyncProvider <- AuthContext wiring.
 *
 * Regression guard: an earlier fix exposed a `getTokenRefresher()` from
 * api/client and passed its return value as a prop to SyncProvider.
 * Because `getTokenRefresher` returned the *current value* of the
 * module-level `refreshAccessToken` binding, and `configureApi` runs
 * inside an AuthProvider useEffect (post-commit), the prop was a
 * snapshot of the initial stub `async () => null`. The HttpSyncClient
 * captured that stub permanently — so a sync 401 never triggered the
 * real AuthContext refresh, defeating the fix.
 *
 * This test mounts the real AuthProvider + AuthAwareProviders tree,
 * stubs SyncProvider to capture its props, and asserts that invoking
 * the captured `refreshAccessToken` actually fires a fetch to
 * `/api/v1/auth/refresh`. If the snapshot bug ever returns, the
 * captured function will be the no-op stub and the assertion fails.
 */
// The unlock-gate path (initializeUnlockState's empty-slot branch) reads a
// rollback pin via `readEnvelopeSetPin` -> `readDeviceMetadata`, which opens
// a real IndexedDB through the `idb` package. jsdom has no IndexedDB of its
// own, so without this polyfill that read throws and initializeUnlockState's
// outer catch silently leaves `needsKeySetup`/`householdId` unresolved —
// not a momentary race, a permanent stall. Match the pattern other test
// files use for the same dependency (e.g. key-cache.test.ts, user-transition.test.ts).
import 'fake-indexeddb/auto';
import React from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedProps {
  refreshAccessToken?: () => Promise<string | null>;
  onDeviceMismatch?: () => void | Promise<void>;
  householdId?: string | null;
}

const capturedSyncProps: CapturedProps = {};
// Every distinct householdId value SyncProvider was rendered with, in order.
// The unlock-gate test asserts `null` precedes the real id (sync never starts
// against an unresolved unlock state).
const householdIdRenders: Array<string | null> = [];

vi.mock('./sync/SyncContext', () => ({
  SyncProvider: ({
    children,
    refreshAccessToken,
    onDeviceMismatch,
    householdId,
  }: {
    children: React.ReactNode;
    refreshAccessToken?: () => Promise<string | null>;
    onDeviceMismatch?: () => void | Promise<void>;
    householdId?: string | null;
  }) => {
    capturedSyncProps.refreshAccessToken = refreshAccessToken;
    capturedSyncProps.onDeviceMismatch = onDeviceMismatch;
    capturedSyncProps.householdId = householdId;
    householdIdRenders.push(householdId ?? null);
    return <>{children}</>;
  },
}));


vi.mock('./contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Unlock-gate collaborators. Mocked at the module boundary so the
// unlock-gate test can drive `initializeUnlockState` to a deterministic
// resolved state without a real IndexedDB / WebCrypto round-trip. The real
// refresh-prop wiring (the original regression guard) is untouched — the boot
// refresh still flows through the real api/client + fetch.
const loadCachedHdk = vi.fn();
const cacheHdk = vi.fn();
const clearCachedHdk = vi.fn();
vi.mock('./crypto/key-cache', () => ({
  loadCachedHdk: (...a: unknown[]) => loadCachedHdk(...a),
  cacheHdk: (...a: unknown[]) => cacheHdk(...a),
  clearCachedHdk: (...a: unknown[]) => clearCachedHdk(...a),
}));

const getKeyEnvelopes = vi.fn();
vi.mock('./auth/key-envelope-client', () => ({
  getKeyEnvelopes: () => getKeyEnvelopes(),
}));

// The user-transition guard touches IndexedDB on boot refresh; stub to a no-op
// so the valid-token boot path doesn't require a real IDB.
vi.mock('./auth/user-transition', () => ({
  clearLastUserId: vi.fn(),
  maybeResetForNewUser: vi.fn(async () => undefined),
  productionDeps: {},
}));

import { AuthProvider } from './auth/AuthContext';
import { AuthAwareProviders } from './AuthAwareProviders';
import { ApiRequestError } from './api/client';
import {
  consumeSignoutReason,
  SIGNOUT_REASON_DEVICE_MISMATCH,
} from './auth/IdleTimer';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A structurally valid JWT (decodeJwt only reads the body, no verification). */
function jwt(claims: { userId: string; householdId: string }): string {
  return `${b64url({ alg: 'none' })}.${b64url({ deviceId: 'dev-1', email: 'u@test.com', ...claims })}.sig`;
}

describe('AuthAwareProviders <- AuthContext wiring', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    capturedSyncProps.refreshAccessToken = undefined;
    capturedSyncProps.onDeviceMismatch = undefined;
    capturedSyncProps.householdId = undefined;
    householdIdRenders.length = 0;
    loadCachedHdk.mockReset();
    cacheHdk.mockReset();
    clearCachedHdk.mockReset();
    getKeyEnvelopes.mockReset();
    consumeSignoutReason(); // clear any leaked one-shot reason
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes a live refreshAccessToken to SyncProvider that hits /auth/refresh', async () => {
    // The bootstrap effect in AuthProvider calls refreshAccessToken once
    // on mount. Let it fail cleanly so we don't leave dangling promises.
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'no cookie' } }),
    );

    await act(async () => {
      render(
        <AuthProvider>
          <AuthAwareProviders>
            <div />
          </AuthAwareProviders>
        </AuthProvider>,
      );
    });

    expect(capturedSyncProps.refreshAccessToken).toBeTypeOf('function');

    // Drain fetches from boot, then call the captured prop and verify
    // it actually round-trips through apiRequest -> /auth/refresh.
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { accessToken: 'new-tok', expiresIn: 3600 }),
    );

    let result: string | null = '';
    await act(async () => {
      result = await capturedSyncProps.refreshAccessToken!();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/v1/auth/refresh');
    expect((init as RequestInit).method).toBe('POST');
    expect(result).not.toBeNull();
  });

  it('captured refreshAccessToken returns null and clears auth on 401', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'no cookie' } }),
    );

    await act(async () => {
      render(
        <AuthProvider>
          <AuthAwareProviders>
            <div />
          </AuthAwareProviders>
        </AuthProvider>,
      );
    });

    let result: string | null = 'unset';
    await act(async () => {
      result = await capturedSyncProps.refreshAccessToken!();
    });

    expect(result).toBeNull();
  });

  /**
   * Boot an authenticated, unlock-resolved session so `householdId` is
   * released to SyncProvider (mirrors the happy path: empty envelope
   * set → needsKeySetup → unlockResolved). Returns once `householdId` is the
   * real id, with the boot fetches drained so the next `fetchMock` mock drives
   * the refresh under test.
   */
  async function bootAuthenticated(): Promise<void> {
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    fetchMock.mockResolvedValue(
      jsonResponse(200, { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 }),
    );

    render(
      <AuthProvider>
        <AuthAwareProviders>
          <div />
        </AuthAwareProviders>
      </AuthProvider>,
    );

    // The boot chain (refreshAccessToken -> updateFromToken ->
    // initializeUnlockState -> loadCachedHdk -> getKeyEnvelopes ->
    // readEnvelopeSetPin -> setNeedsKeySetup/setUnlockResolved) is several
    // awaits deep; wait for the settled state rather than counting
    // microtask ticks (async-assertion race — see AuthAwareProviders.test.tsx
    // history / project memory on this suite).
    await waitFor(() => {
      expect(capturedSyncProps.householdId).toBe('hh-1');
    });
    fetchMock.mockClear();
  }

  it('preserves the session (householdId stays set) and returns null on a network error during refresh', async () => {
    await bootAuthenticated();
    // A raw (non-ApiRequestError) rejection models a network/abort failure.
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    let result: string | null = 'unset';
    await act(async () => {
      result = await capturedSyncProps.refreshAccessToken!();
    });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
    expect(capturedSyncProps.householdId).toBe('hh-1'); // session survives
  });

  it('preserves the session and returns null on a 5xx during refresh', async () => {
    await bootAuthenticated();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(503, { error: { code: 'UNAVAILABLE', message: 'down' } }),
    );

    let result: string | null = 'unset';
    await act(async () => {
      result = await capturedSyncProps.refreshAccessToken!();
    });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedSyncProps.householdId).toBe('hh-1');
  });

  it('preserves the session and returns null on a 429 during refresh', async () => {
    await bootAuthenticated();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }),
    );

    let result: string | null = 'unset';
    await act(async () => {
      result = await capturedSyncProps.refreshAccessToken!();
    });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedSyncProps.householdId).toBe('hh-1');
  });

  it('preserves the session and calls fetch once on a non-401 4xx during refresh', async () => {
    await bootAuthenticated();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: { code: 'BAD_REQUEST', message: 'nope' } }),
    );

    let result: string | null = 'unset';
    await act(async () => {
      result = await capturedSyncProps.refreshAccessToken!();
    });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
    expect(capturedSyncProps.householdId).toBe('hh-1');
  });

  it('tears down the session (householdId goes null) on a definitive 401 during refresh', async () => {
    await bootAuthenticated();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'gone' } }),
    );

    let result: string | null = 'unset';
    await act(async () => {
      result = await capturedSyncProps.refreshAccessToken!();
      await Promise.resolve();
    });

    expect(result).toBeNull();
    expect(capturedSyncProps.householdId).toBeNull(); // definitive sign-out
  });

  it('collapses concurrent refresh callers into a single /auth/refresh round-trip (inflight dedup)', async () => {
    await bootAuthenticated();
    // One slow refresh; both callers must share the single in-flight promise.
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    let r1: string | null = 'unset';
    let r2: string | null = 'unset';
    await act(async () => {
      const p1 = capturedSyncProps.refreshAccessToken!();
      const p2 = capturedSyncProps.refreshAccessToken!();
      release(jsonResponse(200, { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 }));
      [r1, r2] = await Promise.all([p1, p2]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // dedup
    expect(r1).not.toBeNull();
    expect(r1).toBe(r2);
  });

  it('does not re-POST /auth/refresh on a second call within the transient cooldown window', async () => {
    // Boot with real timers — bootAuthenticated's waitFor polls via the real
    // clock and never advances under vi.useFakeTimers().
    await bootAuthenticated();
    vi.useFakeTimers();
    try {
      // First call: transient failure (5xx) arms the cooldown.
      fetchMock.mockResolvedValueOnce(
        jsonResponse(503, { error: { code: 'UNAVAILABLE', message: 'down' } }),
      );
      await act(async () => {
        await capturedSyncProps.refreshAccessToken!();
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second call within the window: short-circuits without POSTing.
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 }),
      );
      let result: string | null = 'unset';
      await act(async () => {
        vi.advanceTimersByTime(1_000); // < cooldown window
        result = await capturedSyncProps.refreshAccessToken!();
      });
      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1); // still 1 — no second POST
      expect(capturedSyncProps.householdId).toBe('hh-1'); // session preserved

      // After the window elapses, a fresh refresh DOES POST again.
      let recovered: string | null = 'unset';
      await act(async () => {
        vi.advanceTimersByTime(5_000); // past the cooldown
        recovered = await capturedSyncProps.refreshAccessToken!();
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(recovered).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires /auth/refresh at most once across both sync legs within the cooldown after a transient failure', async () => {
    // Boot with real timers — bootAuthenticated's waitFor polls via the real
    // clock and never advances under vi.useFakeTimers().
    await bootAuthenticated();
    vi.useFakeTimers();
    try {
      // Leg 1 (syncRoundTrip flush): transient 5xx arms the cooldown.
      fetchMock.mockResolvedValueOnce(
        jsonResponse(503, { error: { code: 'UNAVAILABLE', message: 'down' } }),
      );
      // The remaining legs would each retry the still-expired token if the
      // cooldown didn't short-circuit them.
      await act(async () => {
        // flush → pull (one syncRoundTrip), then pull → flush (one poll tick):
        // four sequential refresh attempts, all inside the cooldown window.
        await capturedSyncProps.refreshAccessToken!(); // syncRoundTrip flush leg
        vi.advanceTimersByTime(200);
        await capturedSyncProps.refreshAccessToken!(); // syncRoundTrip pull leg
        vi.advanceTimersByTime(200);
        await capturedSyncProps.refreshAccessToken!(); // poll-tick pull leg
        vi.advanceTimersByTime(200);
        await capturedSyncProps.refreshAccessToken!(); // poll-tick flush leg
      });

      // Exactly one /auth/refresh POST fired — the cooldown collapsed the
      // other three legs (no cookie replay across the two-leg sequencing).
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(capturedSyncProps.householdId).toBe('hh-1'); // session preserved
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an ApiRequestError construction with status 401 as definitive', () => {
    // Guard the classifier's reliance on the real ApiRequestError class/status.
    const err = new ApiRequestError(401, { code: 'INVALID_REFRESH_TOKEN', message: 'x' });
    expect(err instanceof ApiRequestError).toBe(true);
    expect(err.status).toBe(401);
  });

  it('gates householdId on the unlock check: null until resolved, then released for an unencrypted household', async () => {
    // Boot refresh returns a valid session, so AuthContext sets householdId and
    // kicks off initializeUnlockState. Hold the envelope fetch open so we can
    // observe the unresolved window: SyncProvider must NOT yet see the real id.
    let releaseEnvelopes!: (v: { slots: unknown[]; envelopeSetVersion: number; envelopeSetTag: string }) => void;
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockReturnValue(
      new Promise((resolve) => {
        releaseEnvelopes = resolve;
      }),
    );
    fetchMock.mockResolvedValue(
      jsonResponse(200, { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 }),
    );

    await act(async () => {
      render(
        <AuthProvider>
          <AuthAwareProviders>
            <div />
          </AuthAwareProviders>
        </AuthProvider>,
      );
    });

    // unlockResolved is still false (envelope fetch pending) → gate closed even
    // though AuthContext already holds the real householdId.
    expect(capturedSyncProps.householdId).toBeNull();

    // Resolve with an empty slot set → needsKeySetup=true, unlockResolved=true →
    // gate opens and the real householdId flows to SyncProvider. Resolving the
    // envelope fetch still leaves a `readEnvelopeSetPin` (IndexedDB) await
    // before the gate opens, so wait for the settled state rather than a
    // single microtask flush.
    act(() => {
      releaseEnvelopes({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    });

    await waitFor(() => {
      expect(capturedSyncProps.householdId).toBe('hh-1');
    });
    // The pre-resolution render(s) passed null, before the real id — sync never
    // started against an unresolved unlock state.
    expect(householdIdRenders[0]).toBeNull();
    expect(householdIdRenders[householdIdRenders.length - 1]).toBe('hh-1');
    // Nothing else holds the release: no legal round trip stands between sign-in
    // and sync.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/auth/legal-')),
    ).toBe(false);
  });

  it('keeps householdId null for a resolved-but-locked encrypted household', async () => {
    // Envelopes exist but no cached HDK → isUnlocked=false, needsKeySetup=false,
    // unlockResolved=true. The gate must stay closed (null) so encrypted pull
    // responses are never written as-if-plaintext with getHdk()===null.
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    fetchMock.mockResolvedValue(
      jsonResponse(200, { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 }),
    );

    await act(async () => {
      render(
        <AuthProvider>
          <AuthAwareProviders>
            <div />
          </AuthAwareProviders>
        </AuthProvider>,
      );
      await Promise.resolve();
    });

    expect(capturedSyncProps.householdId).toBeNull();
    // Never released the real id at any render.
    expect(householdIdRenders.every((id) => id === null)).toBe(true);
  });

  it('forwards onDeviceMismatch that sets the signout reason and logs out', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'no cookie' } }),
    );

    await act(async () => {
      render(
        <AuthProvider>
          <AuthAwareProviders>
            <div />
          </AuthAwareProviders>
        </AuthProvider>,
      );
    });

    expect(capturedSyncProps.onDeviceMismatch).toBeTypeOf('function');

    // Drain boot fetches, then invoke the captured recovery callback and
    // verify it sets the device-mismatch signout reason + fires logout.
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

    await act(async () => {
      await capturedSyncProps.onDeviceMismatch!();
    });

    // The host set the one-shot signout reason (LoginPage consumes it)
    // and fired logout.
    expect(consumeSignoutReason()).toBe(SIGNOUT_REASON_DEVICE_MISMATCH);
    expect(fetchMock).toHaveBeenCalled();
    const calledLogout = fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/auth/logout'),
    );
    expect(calledLogout).toBe(true);
  });
});
