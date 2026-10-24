// The SyncProvider <- AuthContext wiring: the real AuthProvider + AuthAwareProviders tree with SyncProvider stubbed to capture props.
// `getTokenRefresher()` once returned a snapshot of the initial stub (`configureApi` runs post-commit), so a sync 401 never reached the real refresh.
// jsdom has no IndexedDB; without this polyfill `readEnvelopeSetPin` throws and initializeUnlockState silently leaves `needsKeySetup`/`householdId` unresolved forever.
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
// Every householdId SyncProvider was rendered with, in order: sync must never start against an unresolved unlock state.
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

// Unlock-gate collaborators are mocked so `initializeUnlockState` resolves deterministically without a real IndexedDB or WebCrypto.
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

// The user-transition guard touches IndexedDB on boot refresh; stub it so the valid-token boot path needs no real IDB.
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

// decodeJwt only reads the body.
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
    consumeSignoutReason();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes a live refreshAccessToken to SyncProvider that hits /auth/refresh', async () => {
    // The boot effect calls refreshAccessToken once on mount; let it fail cleanly.
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

  // Boots an authenticated, unlock-resolved session so `householdId` reaches SyncProvider, with the boot fetches drained.
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

    // The boot chain is several awaits deep, so wait for the settled state rather than counting microtask ticks.
    await waitFor(() => {
      expect(capturedSyncProps.householdId).toBe('hh-1');
    });
    fetchMock.mockClear();
  }

  it('preserves the session (householdId stays set) and returns null on a network error during refresh', async () => {
    await bootAuthenticated();
    // A raw (non-ApiRequestError) rejection models a network or abort failure.
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    let result: string | null = 'unset';
    await act(async () => {
      result = await capturedSyncProps.refreshAccessToken!();
    });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedSyncProps.householdId).toBe('hh-1');
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(capturedSyncProps.householdId).toBeNull();
  });

  it('collapses concurrent refresh callers into a single /auth/refresh round-trip (inflight dedup)', async () => {
    await bootAuthenticated();
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).not.toBeNull();
    expect(r1).toBe(r2);
  });

  it('does not re-POST /auth/refresh on a second call within the transient cooldown window', async () => {
    // Real timers for the boot: bootAuthenticated's waitFor polls the real clock and never advances under fake timers.
    await bootAuthenticated();
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(503, { error: { code: 'UNAVAILABLE', message: 'down' } }),
      );
      await act(async () => {
        await capturedSyncProps.refreshAccessToken!();
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 }),
      );
      let result: string | null = 'unset';
      await act(async () => {
        vi.advanceTimersByTime(1_000);
        result = await capturedSyncProps.refreshAccessToken!();
      });
      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(capturedSyncProps.householdId).toBe('hh-1');

      let recovered: string | null = 'unset';
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        recovered = await capturedSyncProps.refreshAccessToken!();
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(recovered).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires /auth/refresh at most once across both sync legs within the cooldown after a transient failure', async () => {
    // Real timers for the boot: bootAuthenticated's waitFor polls the real clock and never advances under fake timers.
    await bootAuthenticated();
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(503, { error: { code: 'UNAVAILABLE', message: 'down' } }),
      );
      // Without the cooldown each remaining leg would retry the still-expired token.
      await act(async () => {
        // flush then pull (one syncRoundTrip), then pull then flush (one poll tick): four refresh attempts inside the cooldown window.
        await capturedSyncProps.refreshAccessToken!();
        vi.advanceTimersByTime(200);
        await capturedSyncProps.refreshAccessToken!();
        vi.advanceTimersByTime(200);
        await capturedSyncProps.refreshAccessToken!();
        vi.advanceTimersByTime(200);
        await capturedSyncProps.refreshAccessToken!();
      });

      // One /auth/refresh POST: the cooldown collapsed the other three legs.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(capturedSyncProps.householdId).toBe('hh-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an ApiRequestError construction with status 401 as definitive', () => {
    const err = new ApiRequestError(401, { code: 'INVALID_REFRESH_TOKEN', message: 'x' });
    expect(err instanceof ApiRequestError).toBe(true);
    expect(err.status).toBe(401);
  });

  it('gates householdId on the unlock check: null until resolved, then released for an unencrypted household', async () => {
    // Hold the envelope fetch open to observe the unresolved window: SyncProvider must not yet see the real id.
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

    expect(capturedSyncProps.householdId).toBeNull();

    // Resolving the envelope fetch still leaves a `readEnvelopeSetPin` IndexedDB await before the gate opens, so wait for the settled state.
    act(() => {
      releaseEnvelopes({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    });

    await waitFor(() => {
      expect(capturedSyncProps.householdId).toBe('hh-1');
    });
    expect(householdIdRenders[0]).toBeNull();
    expect(householdIdRenders[householdIdRenders.length - 1]).toBe('hh-1');
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/auth/legal-')),
    ).toBe(false);
  });

  it('keeps householdId null for a resolved-but-locked encrypted household', async () => {
    // Envelopes without a cached HDK leave the gate closed, so encrypted pull responses are never written as plaintext with getHdk() null.
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

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

    await act(async () => {
      await capturedSyncProps.onDeviceMismatch!();
    });

    expect(consumeSignoutReason()).toBe(SIGNOUT_REASON_DEVICE_MISMATCH);
    expect(fetchMock).toHaveBeenCalled();
    const calledLogout = fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/auth/logout'),
    );
    expect(calledLogout).toBe(true);
  });
});
