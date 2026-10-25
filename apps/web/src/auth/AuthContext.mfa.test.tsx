// Two-phase (enforced MFA) login: a password login returning `mfaRequired` sets `mfaChallenge` and adopts no session;
// `verifyMfa` POSTs the chosen factor, adopts the session through the shared cross-user-reset and unlock path, and clears the challenge.
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', async () => (await import('./auth-context.test-harness')).apiClientMock());
vi.mock('./key-envelope-client', async () => (await import('./auth-context.test-harness')).keyEnvelopeClientMock());
vi.mock('../crypto/key-cache', async () => (await import('./auth-context.test-harness')).keyCacheMock());
vi.mock('../crypto/key-wrapping', async () => (await import('./auth-context.test-harness')).keyWrappingMock());
vi.mock('./user-transition', async () => (await import('./auth-context.test-harness')).userTransitionMock());
vi.mock('@simplewebauthn/browser', async () => (await import('./auth-context.test-harness')).webauthnBrowserMock());
vi.mock('../crypto/passkey-prf', async () => (await import('./auth-context.test-harness')).passkeyPrfMock());

import { authMocks, captured, jwt, renderAuth } from './auth-context.test-harness';
import type { VerifyMfaResult } from './types';

const { apiRequest, getKeyEnvelopes, loadCachedHdk, maybeResetForNewUser, startAuthentication } = authMocks;

describe('AuthContext — two-phase MFA login', () => {
  beforeEach(() => {
    apiRequest.mockReset();
    getKeyEnvelopes.mockReset();
    loadCachedHdk.mockReset();
    startAuthentication.mockReset();
    maybeResetForNewUser.mockReset();
    maybeResetForNewUser.mockResolvedValue(undefined);
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sets mfaChallenge (and adopts no session) when login returns mfaRequired', async () => {
    await renderAuth();
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') {
        return {
          mfaRequired: true,
          challengeToken: 'chal-tok',
          methods: ['totp'],
          recoveryMethods: ['email_otp'],
        };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await waitFor(() => expect(captured.mfaChallenge).not.toBeNull());
    expect(captured.mfaChallenge).toEqual({
      challengeToken: 'chal-tok',
      methods: ['totp'],
      recoveryMethods: ['email_otp'],
    });
    expect(captured.isAuthenticated).toBe(false);
  });

  it('verifyMfa POSTs the factor, clears the challenge, and adopts the session', async () => {
    await renderAuth();
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: null });

    apiRequest.mockImplementation(async (path: string, opts?: any) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') {
        return {
          mfaRequired: true,
          challengeToken: 'chal-tok',
          methods: ['totp'],
          recoveryMethods: [],
        };
      }
      if (path === '/api/v1/auth/mfa/verify') {
        expect(opts.body).toMatchObject({
          challengeToken: 'chal-tok',
          method: 'totp',
          code: '123456',
          rememberDevice: true,
        });
        expect(typeof opts.body.deviceId).toBe('string');
        return {
          accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }),
          expiresIn: 3600,
          deviceRemembered: true,
        };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(captured.mfaChallenge).not.toBeNull());

    let result: VerifyMfaResult | undefined;
    await act(async () => {
      result = await captured.verifyMfa('totp', '123456', true);
    });

    expect(result).toEqual({ deviceRemembered: true });
    await waitFor(() => expect(captured.isAuthenticated).toBe(true));
    expect(captured.mfaChallenge).toBeNull();
  });

  it('clears blockedReset and mfaChallenge when cross-user reset is blocked during verifyMfa', async () => {
    await renderAuth();
    // A blocked cross-user IDB drop fails closed with the blocking modal; its Retry runs the `reauth` callback, which must clear both the overlay and the challenge.
    maybeResetForNewUser.mockRejectedValue(new Error('DatabaseDropBlockedError'));

    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') {
        return {
          mfaRequired: true,
          challengeToken: 'chal-tok',
          methods: ['totp'],
          recoveryMethods: [],
        };
      }
      if (path === '/api/v1/auth/mfa/verify') {
        return {
          accessToken: jwt({ userId: 'u-b', householdId: 'hh-b' }),
          expiresIn: 3600,
          deviceRemembered: false,
        };
      }
      // The blocked drop revokes the just-issued session before the modal.
      if (path === '/api/v1/auth/logout') return undefined;
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.login('b@test.com', 'pw');
    });
    await waitFor(() => expect(captured.mfaChallenge).not.toBeNull());

    let result: VerifyMfaResult | undefined;
    await act(async () => {
      result = await captured.verifyMfa('totp', '123456', false);
    });

    expect(result).toEqual({ deviceRemembered: false });
    expect(captured.isAuthenticated).toBe(false);
    await waitFor(() =>
      expect(screen.getByText('Close all other tabs to continue')).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Retry' }));
    });

    await waitFor(() =>
      expect(screen.queryByText('Close all other tabs to continue')).not.toBeInTheDocument(),
    );
    expect(captured.mfaChallenge).toBeNull();
    expect(captured.isAuthenticated).toBe(false);
  });

  it('verifyMfaWithPasskey fetches scoped options, asserts, verifies, and adopts the session', async () => {
    await renderAuth();
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: null });
    startAuthentication.mockResolvedValue({ id: 'cred-1', response: {}, type: 'public-key' });

    apiRequest.mockImplementation(async (path: string, opts?: any) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') {
        return {
          mfaRequired: true,
          challengeToken: 'chal-tok',
          methods: ['passkey'],
          recoveryMethods: ['email_otp'],
        };
      }
      if (path === '/api/v1/auth/mfa/passkey/start') {
        expect(opts.body).toEqual({ challengeToken: 'chal-tok' });
        return { challenge: 'webauthn-chal', allowCredentials: [{ id: 'cred-1' }] };
      }
      if (path === '/api/v1/auth/mfa/verify') {
        expect(opts.body).toMatchObject({
          challengeToken: 'chal-tok',
          method: 'passkey',
          rememberDevice: true,
        });
        expect(opts.body.response).toEqual({ id: 'cred-1', response: {}, type: 'public-key' });
        expect(opts.body.code).toBeUndefined();
        return {
          accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }),
          expiresIn: 3600,
          deviceRemembered: true,
        };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(captured.mfaChallenge).not.toBeNull());

    let result: VerifyMfaResult | undefined;
    await act(async () => {
      result = await captured.verifyMfaWithPasskey(true);
    });

    expect(result).toEqual({ deviceRemembered: true });
    // The retained challenge password drove the unlock, so there is no second password prompt.
    expect(startAuthentication).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(captured.isAuthenticated).toBe(true));
    expect(captured.mfaChallenge).toBeNull();
  });

  it('verifyMfaWithPasskey rethrows a cancelled assertion and keeps the challenge', async () => {
    await renderAuth();
    startAuthentication.mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'));

    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') {
        return {
          mfaRequired: true,
          challengeToken: 'chal-tok',
          methods: ['passkey'],
          recoveryMethods: ['email_otp'],
        };
      }
      if (path === '/api/v1/auth/mfa/passkey/start') {
        return { challenge: 'webauthn-chal', allowCredentials: [] };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(captured.mfaChallenge).not.toBeNull());

    await act(async () => {
      await expect(captured.verifyMfaWithPasskey(false)).rejects.toBeInstanceOf(DOMException);
    });

    // The challenge is preserved so the user can retry or pick a recovery factor.
    expect(captured.mfaChallenge).not.toBeNull();
    expect(captured.isAuthenticated).toBe(false);
  });

  it('sendEmailOtp POSTs the challenge token', async () => {
    await renderAuth();
    apiRequest.mockImplementation(async (path: string, opts?: any) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') {
        return {
          mfaRequired: true,
          challengeToken: 'chal-tok',
          methods: ['email_otp'],
          recoveryMethods: [],
        };
      }
      if (path === '/api/v1/auth/mfa/email/send') {
        expect(opts.body).toEqual({ challengeToken: 'chal-tok' });
        return undefined;
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(captured.mfaChallenge).not.toBeNull());

    await act(async () => {
      await captured.sendEmailOtp();
    });
    expect(
      apiRequest.mock.calls.some((c) => c[0] === '/api/v1/auth/mfa/email/send'),
    ).toBe(true);
  });

  it('clearMfaChallenge abandons the pending challenge', async () => {
    await renderAuth();
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') {
        return {
          mfaRequired: true,
          challengeToken: 'chal-tok',
          methods: ['totp'],
          recoveryMethods: [],
        };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(captured.mfaChallenge).not.toBeNull());

    act(() => {
      captured.clearMfaChallenge();
    });
    await waitFor(() => expect(captured.mfaChallenge).toBeNull());
  });
});
