/**
 * Classification tests for `AuthContext.signOutForDeviceClear`:
 * it reports whether the server session is
 * provably gone as a result of THAT attempt, and only tears local session
 * state down on that proof. An ambiguous 401 — a transient refresh failure, or
 * the cooldown short-circuit — must leave the session exactly as
 * `refreshAccessToken` left it: `not proven`, nothing torn down. Every other
 * `logout()` caller (idle timeout here) keeps its unconditional teardown.
 * Follows the module-mock harness in `AuthContext.unlock.test.tsx` —
 * `apiRequest` mocked at the boundary, the real provider rendered.
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Live access-token getter AuthContext configures, so a test can observe which token is active.
let liveAccessToken: () => string | null = () => null;
vi.mock('../api/client', async () => (await import('./auth-context.test-harness')).apiClientMock((opts) => {
  liveAccessToken = opts.getAccessToken;
}));
vi.mock('./key-envelope-client', async () => (await import('./auth-context.test-harness')).keyEnvelopeClientMock());
vi.mock('../crypto/key-cache', async () => (await import('./auth-context.test-harness')).keyCacheMock());
vi.mock('../crypto/key-wrapping', async () => (await import('./auth-context.test-harness')).keyWrappingMock());
vi.mock('./user-transition', async () => (await import('./auth-context.test-harness')).userTransitionMock());
vi.mock('@simplewebauthn/browser', async () => (await import('./auth-context.test-harness')).webauthnBrowserMock());
vi.mock('../crypto/passkey-prf', async () => (await import('./auth-context.test-harness')).passkeyPrfMock());

import { AuthProvider, useAuth } from './AuthContext';
import { authMocks, jwt } from './auth-context.test-harness';
import { ApiRequestError } from '../api/client';
import type { DeviceClearAttempt } from './types';

const { apiRequest, getKeyEnvelopes, loadCachedHdk, maybeResetForNewUser } = authMocks;

// --- Helpers ----------------------------------------------------------------

let captured: {
  login: (e: string, p: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshAccessToken: () => Promise<string | null>;
  signOutForDeviceClear: () => Promise<DeviceClearAttempt>;
};

function Probe(): React.ReactElement {
  const auth = useAuth();
  captured = {
    login: auth.login,
    logout: auth.logout,
    refreshAccessToken: auth.refreshAccessToken,
    signOutForDeviceClear: auth.signOutForDeviceClear,
  };
  return (
    <div>
      <span data-testid="isAuthenticated">{String(auth.isAuthenticated)}</span>
      <span data-testid="householdId">{auth.householdId ?? ''}</span>
    </div>
  );
}

function flag(id: string): string {
  return screen.getByTestId(id).textContent ?? '';
}

/** Render the provider with the boot refresh resolving to "signed out". */
async function renderAuth(): Promise<void> {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    throw new Error(`unexpected api call ${path}`);
  });
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(flag('isAuthenticated')).toBe('false'));
}

/** Sign in as a fresh user with an empty (no-encryption) key-envelope set. */
async function loginAsU1(): Promise<void> {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') {
      return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
    }
    throw new Error(`unexpected api call ${path}`);
  });
  loadCachedHdk.mockResolvedValue(null);
  getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
  await act(async () => {
    await captured.login('u@test.com', 'pw');
  });
  await waitFor(() => expect(flag('isAuthenticated')).toBe('true'));
  expect(liveAccessToken()).toBeTruthy();
}

describe('AuthContext — fail-closed device-clear sign-out', () => {
  beforeEach(() => {
    apiRequest.mockReset();
    getKeyEnvelopes.mockReset();
    loadCachedHdk.mockReset();
    maybeResetForNewUser.mockReset();
    maybeResetForNewUser.mockResolvedValue(undefined);
    liveAccessToken = () => null;
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('204 from /auth/logout → proven; local teardown ran', async () => {
    await renderAuth();
    await loginAsU1();

    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') return undefined;
      throw new Error(`unexpected api call ${path}`);
    });

    let result: DeviceClearAttempt | undefined;
    await act(async () => {
      result = await captured.signOutForDeviceClear();
    });

    expect(result).toEqual({ proven: true });
    await waitFor(() => expect(flag('isAuthenticated')).toBe('false'));
    expect(flag('householdId')).toBe('');
    expect(liveAccessToken()).toBeNull();
  });

  it('401 from /auth/logout + a transient (non-ApiRequestError network) refresh failure → not proven, session survives', async () => {
    await renderAuth();
    await loginAsU1();

    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') {
        throw new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'Access token expired.' });
      }
      if (path === '/api/v1/auth/refresh') throw new Error('network down');
      throw new Error(`unexpected api call ${path}`);
    });

    let result: DeviceClearAttempt | undefined;
    await act(async () => {
      result = await captured.signOutForDeviceClear();
    });

    expect(result?.proven).toBe(false);
    // The assertion that fails if the teardown is left unconditional: the
    // session must survive a transient failure.
    expect(flag('isAuthenticated')).toBe('true');
    expect(flag('householdId')).toBe('hh-1');
    expect(liveAccessToken()).toBeTruthy();
  });

  it('401 from /auth/logout + a transient (500) refresh failure → not proven, session survives', async () => {
    await renderAuth();
    await loginAsU1();

    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') {
        throw new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'Access token expired.' });
      }
      if (path === '/api/v1/auth/refresh') {
        throw new ApiRequestError(500, { code: 'INTERNAL', message: 'Internal error.' });
      }
      throw new Error(`unexpected api call ${path}`);
    });

    let result: DeviceClearAttempt | undefined;
    await act(async () => {
      result = await captured.signOutForDeviceClear();
    });

    expect(result?.proven).toBe(false);
    expect(flag('isAuthenticated')).toBe('true');
    expect(flag('householdId')).toBe('hh-1');
    expect(liveAccessToken()).toBeTruthy();
  });

  // API Gateway's stage throttle (infrastructure `apiThrottleRatePerSec` /
  // `apiThrottleBurst`) answers a burst with its OWN 429 — body
  // `{"message":"Too Many Requests"}`, no `error` envelope — before the
  // Lambda runs. Reaching /auth/refresh through it must be classified
  // transient like any other non-401: the session survives.
  it('401 from /auth/logout + a transient (API-Gateway-shaped 429) refresh failure → not proven, session survives', async () => {
    await renderAuth();
    await loginAsU1();

    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') {
        throw new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'Access token expired.' });
      }
      if (path === '/api/v1/auth/refresh') {
        // api/client.ts maps a body without an `error` envelope to
        // UNKNOWN_ERROR + the status text; the status is what the classifier reads.
        throw new ApiRequestError(429, { code: 'UNKNOWN_ERROR', message: 'Too Many Requests' });
      }
      throw new Error(`unexpected api call ${path}`);
    });

    let result: DeviceClearAttempt | undefined;
    await act(async () => {
      result = await captured.signOutForDeviceClear();
    });

    expect(result?.proven).toBe(false);
    expect(flag('isAuthenticated')).toBe('true');
    expect(flag('householdId')).toBe('hh-1');
    expect(liveAccessToken()).toBeTruthy();
  });

  it('401 from /auth/logout while the refresh cooldown is armed → not proven, no second POST to /auth/refresh', async () => {
    await renderAuth();
    await loginAsU1();

    // Arm the transient-refresh cooldown with a prior refresh attempt.
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') {
        throw new ApiRequestError(500, { code: 'INTERNAL', message: 'Internal error.' });
      }
      throw new Error(`unexpected api call ${path}`);
    });
    await act(async () => {
      await captured.refreshAccessToken();
    });

    const refreshCalls: unknown[] = [];
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') {
        throw new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'Access token expired.' });
      }
      if (path === '/api/v1/auth/refresh') {
        refreshCalls.push(path);
        throw new Error('must not POST /auth/refresh again — cooldown is armed');
      }
      throw new Error(`unexpected api call ${path}`);
    });

    let result: DeviceClearAttempt | undefined;
    await act(async () => {
      result = await captured.signOutForDeviceClear();
    });

    expect(result?.proven).toBe(false);
    // The cooldown short-circuit is invisible unless we count calls.
    expect(refreshCalls.length).toBe(0);
    expect(flag('isAuthenticated')).toBe('true');
  });

  it('401 from /auth/logout + a definitive 401 from /auth/refresh → proven, existing session teardown still happens', async () => {
    await renderAuth();
    await loginAsU1();

    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') {
        throw new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'Access token expired.' });
      }
      if (path === '/api/v1/auth/refresh') {
        throw new ApiRequestError(401, {
          code: 'INVALID_REFRESH_TOKEN',
          message: 'Refresh token is invalid or expired.',
        });
      }
      throw new Error(`unexpected api call ${path}`);
    });

    let result: DeviceClearAttempt | undefined;
    await act(async () => {
      result = await captured.signOutForDeviceClear();
    });

    expect(result).toEqual({ proven: true });
    await waitFor(() => expect(flag('isAuthenticated')).toBe('false'));
    expect(flag('householdId')).toBe('');
    expect(liveAccessToken()).toBeNull();
  });

  it('401 from /auth/logout + a successful (non-definitive, token-bearing) refresh + a successful retried /auth/logout → proven, teardown ran', async () => {
    await renderAuth();
    await loginAsU1();

    let logoutCalls = 0;
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') {
        logoutCalls += 1;
        if (logoutCalls === 1) {
          throw new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'Access token expired.' });
        }
        return undefined;
      }
      if (path === '/api/v1/auth/refresh') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    let result: DeviceClearAttempt | undefined;
    await act(async () => {
      result = await captured.signOutForDeviceClear();
    });

    expect(result).toEqual({ proven: true });
    expect(logoutCalls).toBe(2);
    await waitFor(() => expect(flag('isAuthenticated')).toBe('false'));
    expect(flag('householdId')).toBe('');
    expect(liveAccessToken()).toBeNull();
  });

  it('401 from /auth/logout + a successful refresh + a failing retried /auth/logout → not proven, session reflects the refreshed (not torn-down) state', async () => {
    await renderAuth();
    await loginAsU1();

    let logoutCalls = 0;
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') {
        logoutCalls += 1;
        if (logoutCalls === 1) {
          throw new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'Access token expired.' });
        }
        throw new ApiRequestError(500, { code: 'INTERNAL', message: 'Internal error.' });
      }
      if (path === '/api/v1/auth/refresh') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    let result: DeviceClearAttempt | undefined;
    await act(async () => {
      result = await captured.signOutForDeviceClear();
    });

    expect(result?.proven).toBe(false);
    expect(logoutCalls).toBe(2);
    // Left exactly as the refresh path left it: the session survives, still
    // authenticated with the freshly-refreshed token — not torn down.
    expect(flag('isAuthenticated')).toBe('true');
    expect(flag('householdId')).toBe('hh-1');
    expect(liveAccessToken()).toBeTruthy();
  });

  // Unchanged-callers guard: `logout()` (what `handleIdleTimeout` calls) stays
  // best-effort and unconditional — a rejected `/auth/logout` still tears
  // local state down, unlike `signOutForDeviceClear` above.
  it('an idle timeout whose /auth/logout request rejects still tears local state down (logout() unchanged)', async () => {
    await renderAuth();
    await loginAsU1();

    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') throw new Error('network down');
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.logout();
    });

    await waitFor(() => expect(flag('isAuthenticated')).toBe('false'));
    expect(flag('householdId')).toBe('');
    expect(liveAccessToken()).toBeNull();
  });
});
