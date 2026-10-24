// `signOutForDeviceClear` reports whether the server session is provably gone and tears local state down only on that
// proof; an ambiguous 401 leaves the session as `refreshAccessToken` left it. `apiRequest` is mocked, the provider is real.
import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', async () => (await import('./auth-context.test-harness')).apiClientMock());
vi.mock('./key-envelope-client', async () => (await import('./auth-context.test-harness')).keyEnvelopeClientMock());
vi.mock('../crypto/key-cache', async () => (await import('./auth-context.test-harness')).keyCacheMock());
vi.mock('../crypto/key-wrapping', async () => (await import('./auth-context.test-harness')).keyWrappingMock());
vi.mock('./user-transition', async () => (await import('./auth-context.test-harness')).userTransitionMock());
vi.mock('@simplewebauthn/browser', async () => (await import('./auth-context.test-harness')).webauthnBrowserMock());
vi.mock('../crypto/passkey-prf', async () => (await import('./auth-context.test-harness')).passkeyPrfMock());

import {
  authMocks,
  captured,
  flag,
  jwt,
  liveAccessToken,
  loginAsU1,
  renderAuth,
  resetLiveAccessToken,
} from './auth-context.test-harness';
import { ApiRequestError } from '../api/client';
import type { DeviceClearAttempt } from './types';

const { apiRequest, getKeyEnvelopes, loadCachedHdk, maybeResetForNewUser } = authMocks;

const EXPIRED = () => new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'Access token expired.' });

async function signOutForDeviceClear(): Promise<DeviceClearAttempt> {
  let result: DeviceClearAttempt | undefined;
  await act(async () => {
    result = await captured.signOutForDeviceClear();
  });
  return result!;
}

function expectSessionSurvived(): void {
  expect(flag('isAuthenticated')).toBe('true');
  expect(flag('householdId')).toBe('hh-1');
  expect(liveAccessToken()).toBeTruthy();
}

async function expectTornDown(): Promise<void> {
  await waitFor(() => expect(flag('isAuthenticated')).toBe('false'));
  expect(flag('householdId')).toBe('');
  expect(liveAccessToken()).toBeNull();
}

describe('AuthContext — fail-closed device-clear sign-out', () => {
  beforeEach(() => {
    apiRequest.mockReset();
    getKeyEnvelopes.mockReset();
    loadCachedHdk.mockReset();
    maybeResetForNewUser.mockReset();
    maybeResetForNewUser.mockResolvedValue(undefined);
    resetLiveAccessToken();
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

    expect(await signOutForDeviceClear()).toEqual({ proven: true });
    await expectTornDown();
  });

  // The API-Gateway-shaped 429 is the stage throttle's own body (`{"message":"Too Many Requests"}`, no `error`
  // envelope): `api/client.ts` maps it to UNKNOWN_ERROR + the status text, and the classifier reads the status.
  it.each<[string, () => Error]>([
    ['a network error', () => new Error('network down')],
    ['a 500', () => new ApiRequestError(500, { code: 'INTERNAL', message: 'Internal error.' })],
    [
      'an API-Gateway-shaped 429',
      () => new ApiRequestError(429, { code: 'UNKNOWN_ERROR', message: 'Too Many Requests' }),
    ],
  ])('401 from /auth/logout + %s on refresh → not proven, session survives', async (_name, refreshFailure) => {
    await renderAuth();
    await loginAsU1();

    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') throw EXPIRED();
      if (path === '/api/v1/auth/refresh') throw refreshFailure();
      throw new Error(`unexpected api call ${path}`);
    });

    expect((await signOutForDeviceClear()).proven).toBe(false);
    expectSessionSurvived();
  });

  it('401 from /auth/logout while the refresh cooldown is armed → not proven, no second POST to /auth/refresh', async () => {
    await renderAuth();
    await loginAsU1();

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
      if (path === '/api/v1/auth/logout') throw EXPIRED();
      if (path === '/api/v1/auth/refresh') {
        refreshCalls.push(path);
        throw new Error('must not POST /auth/refresh again — cooldown is armed');
      }
      throw new Error(`unexpected api call ${path}`);
    });

    expect((await signOutForDeviceClear()).proven).toBe(false);
    expect(refreshCalls.length).toBe(0);
    expect(flag('isAuthenticated')).toBe('true');
  });

  it('401 from /auth/logout + a definitive 401 from /auth/refresh → proven, existing session teardown still happens', async () => {
    await renderAuth();
    await loginAsU1();

    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') throw EXPIRED();
      if (path === '/api/v1/auth/refresh') {
        throw new ApiRequestError(401, {
          code: 'INVALID_REFRESH_TOKEN',
          message: 'Refresh token is invalid or expired.',
        });
      }
      throw new Error(`unexpected api call ${path}`);
    });

    expect(await signOutForDeviceClear()).toEqual({ proven: true });
    await expectTornDown();
  });

  it('401 from /auth/logout + a successful (non-definitive, token-bearing) refresh + a successful retried /auth/logout → proven, teardown ran', async () => {
    await renderAuth();
    await loginAsU1();

    let logoutCalls = 0;
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') {
        logoutCalls += 1;
        if (logoutCalls === 1) throw EXPIRED();
        return undefined;
      }
      if (path === '/api/v1/auth/refresh') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    expect(await signOutForDeviceClear()).toEqual({ proven: true });
    expect(logoutCalls).toBe(2);
    await expectTornDown();
  });

  it('401 from /auth/logout + a successful refresh + a failing retried /auth/logout → not proven, session reflects the refreshed (not torn-down) state', async () => {
    await renderAuth();
    await loginAsU1();

    let logoutCalls = 0;
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/logout') {
        logoutCalls += 1;
        if (logoutCalls === 1) throw EXPIRED();
        throw new ApiRequestError(500, { code: 'INTERNAL', message: 'Internal error.' });
      }
      if (path === '/api/v1/auth/refresh') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    expect((await signOutForDeviceClear()).proven).toBe(false);
    expect(logoutCalls).toBe(2);
    expectSessionSurvived();
  });

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

    await expectTornDown();
  });
});
