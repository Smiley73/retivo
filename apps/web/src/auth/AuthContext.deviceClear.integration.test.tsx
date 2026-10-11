/**
 * Integration coverage for `signOutForDeviceClear` against the REAL
 * `api/client.ts` `apiRequest`.
 *
 * `AuthContext.deviceClear.test.tsx` mocks `../api/client` at the module
 * boundary with a bare stub that has no retry-on-401 logic of its own, so it
 * cannot see whether `apiRequest`'s own hidden refresh-and-retry (client.ts,
 * "Retry once on 401") ever fires for the device-clear logout call. This
 * suite mounts the real `AuthProvider` with only `global.fetch` mocked (the
 * pattern used by `AuthAwareProviders.test.tsx`) so the actual call graph is
 * exercised: it proves the definitive-refresh path makes exactly the two
 * fetches the flow needs (the initial `/auth/logout` and the classifying
 * `/auth/refresh`) and never a third, would-be-duplicate `/auth/refresh` that
 * a later transient result (e.g. a 429 throttle response) could use to
 * overwrite an already-definitive verdict.
 */
import React from 'react';
import { act, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./key-envelope-client', async () => (await import('./auth-context.test-harness')).keyEnvelopeClientMock());
vi.mock('../crypto/key-cache', async () => (await import('./auth-context.test-harness')).keyCacheMock());
vi.mock('../crypto/key-wrapping', async () => (await import('./auth-context.test-harness')).keyWrappingMock());
vi.mock('./user-transition', async () => (await import('./auth-context.test-harness')).userTransitionMock());
vi.mock('@simplewebauthn/browser', async () => (await import('./auth-context.test-harness')).webauthnBrowserMock());
vi.mock('../crypto/passkey-prf', async () => (await import('./auth-context.test-harness')).passkeyPrfMock());

import { AuthProvider, useAuth } from './AuthContext';
import { authMocks } from './auth-context.test-harness';
import type { DeviceClearAttempt } from './types';

const { getKeyEnvelopes, loadCachedHdk, maybeResetForNewUser } = authMocks;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let captured: { signOutForDeviceClear: () => Promise<DeviceClearAttempt> };

function Probe(): React.ReactElement {
  const auth = useAuth();
  captured = { signOutForDeviceClear: auth.signOutForDeviceClear };
  return <span data-testid="isAuthenticated">{String(auth.isAuthenticated)}</span>;
}

function flag(): string {
  return screen.getByTestId('isAuthenticated').textContent ?? '';
}

describe('signOutForDeviceClear against the real api/client apiRequest', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    loadCachedHdk.mockReset();
    getKeyEnvelopes.mockReset();
    maybeResetForNewUser.mockReset();
    maybeResetForNewUser.mockResolvedValue(undefined);
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Boot the real provider against a signed-out cookie, draining boot fetches. */
  async function bootSignedOut(): Promise<void> {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'no cookie' } }),
    ); // boot refresh: signed out
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });

    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    await waitFor(() => expect(flag()).toBe('false'));
    fetchMock.mockClear();
  }

  it('a definitive 401 refresh classification is never overwritten by a later transient result: exactly 2 fetches (logout, refresh), no third', async () => {
    await bootSignedOut();

    // No live access token post-boot-signed-out, so `auth: true` requests
    // carry no bearer — that's fine, this suite only asserts the NUMBER and
    // TARGETS of fetches apiRequest issues for one attempt, not the
    // authenticated-session bookkeeping (covered by the mocked-boundary
    // suite in AuthContext.deviceClear.test.tsx).
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Access token expired.' } }),
    ); // /auth/logout -> 401
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'gone' } }),
    ); // /auth/refresh -> definitive 401

    let result: DeviceClearAttempt | undefined;
    await act(async () => {
      result = await captured.signOutForDeviceClear();
    });

    expect(result).toEqual({ proven: true });
    // Exactly two fetches: the initial /auth/logout and the classifying
    // /auth/refresh. If apiRequest's own hidden retry-on-401 fired (the bug
    // this suite guards), a bare 401 without a retry token means apiRequest
    // would still only issue that one extra /auth/refresh call itself before
    // signOutForDeviceClear's explicit performRefresh() issues its OWN,
    // second /auth/refresh call — three fetches total. Two proves the
    // built-in retry never ran.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const targets = fetchMock.mock.calls.map(([url]) => String(url));
    expect(targets[0]).toContain('/api/v1/auth/logout');
    expect(targets[1]).toContain('/api/v1/auth/refresh');
  });
});
