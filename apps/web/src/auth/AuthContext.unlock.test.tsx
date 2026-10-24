// Zero-knowledge unlock lifecycle in AuthContext: `initializeUnlockState` after login, `unlockWithPassword`, `clearUnlockState`
// on logout, the `unlockResolved` gate and the staleness guard that keeps a stale household's HDK from overwriting a newer session.
import { act, cleanup, screen, waitFor } from '@testing-library/react';
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
  fakeHdk,
  flag,
  jwt,
  liveAccessToken,
  mountAuth,
  renderAuth,
  resetLiveAccessToken,
} from './auth-context.test-harness';
// The mocked KeyWrappingError, so assertions use the class the SUT throws.
import { KeyWrappingError } from '../crypto/key-wrapping';

const {
  apiRequest,
  getKeyEnvelopes,
  upsertKeyEnvelopeSlot,
  loadCachedHdk,
  cacheHdk,
  clearCachedHdk,
  unwrapSlot,
  verifyEnvelopeSetTag,
  unwrapPrfSlot,
  generateHdk,
  generatePasswordSlot,
  generateRecoverySlot,
  computeEnvelopeSetTag,
  readEnvelopeSetPin,
  maybeResetForNewUser,
  startAuthentication,
  startRegistration,
  addPrfEvalToOptions,
  derivePrfWrapKey,
  extractPrfResult,
} = authMocks;


// Refresh fails (boot) and login returns the token; verify-password succeeds by default, and a wrong-password test overrides it to reject.
function wireLogin(token: string): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') return { accessToken: token, expiresIn: 3600 };
    if (path === '/api/v1/auth/logout') return undefined;
    if (path === '/api/v1/auth/verify-password') return undefined;
    throw new Error(`unexpected api call ${path}`);
  });
}

// The discoverable passkey flow: boot refresh fails, authenticate/start returns options (optionally with a PRF salt) and finish returns the token; `refresh` returns the same token for same-session tests.
function wirePasskeyLogin(token: string, startOptions: Record<string, unknown> = {}): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') return { accessToken: token, expiresIn: 3600 };
    if (path === '/api/v1/auth/passkey/authenticate/start') return startOptions;
    if (path === '/api/v1/auth/passkey/authenticate/finish') {
      return { accessToken: token, expiresIn: 3600 };
    }
    if (path === '/api/v1/auth/logout') return undefined;
    throw new Error(`unexpected api call ${path}`);
  });
}

const prfEnvelopes = {
  slots: [{ slotType: 'passkey_prf', slotId: 's-prf' }],
  envelopeSetVersion: 1,
  envelopeSetTag: 'tag',
};

describe('AuthContext — unlock lifecycle', () => {
  beforeEach(() => {
    apiRequest.mockReset();
    getKeyEnvelopes.mockReset();
    upsertKeyEnvelopeSlot.mockReset();
    loadCachedHdk.mockReset();
    cacheHdk.mockReset();
    clearCachedHdk.mockReset();
    unwrapSlot.mockReset();
    verifyEnvelopeSetTag.mockReset();
    unwrapPrfSlot.mockReset();
    generateHdk.mockReset();
    generatePasswordSlot.mockReset();
    generateRecoverySlot.mockReset();
    computeEnvelopeSetTag.mockReset();
    // Default: no rollback pin (TOFU).
    readEnvelopeSetPin.mockReset();
    readEnvelopeSetPin.mockResolvedValue(0);
    startAuthentication.mockReset();
    startRegistration.mockReset();
    addPrfEvalToOptions.mockReset();
    derivePrfWrapKey.mockReset();
    extractPrfResult.mockReset();
    // Default: the cross-user drop succeeds.
    maybeResetForNewUser.mockReset();
    maybeResetForNewUser.mockResolvedValue(undefined);
    resetLiveAccessToken();
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('login with empty envelopes → needsKeySetup, not unlocked, resolved, no navigation', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('needsKeySetup')).toBe('true');
    expect(flag('isUnlocked')).toBe('false');
    expect(captured.getHdk()).toBeNull();
    expect(flag('lockedEnvelopeSetEmpty')).toBe('false');
  });

  it('blocked cross-user drop revokes the new session (logout AS B) before surfacing the modal — never adopts B', async () => {
    await renderAuth();
    const bToken = jwt({ userId: 'u-b', householdId: 'hh-b' });
    // User B authenticates but B's IDB drop fails closed because another tab holds A's working store open.
    maybeResetForNewUser.mockRejectedValue(new Error('DatabaseDropBlockedError'));
    // The revoke must target B's just-issued session, so record the token live when logout fires.
    let tokenLiveAtLogout: string | null = 'unset';
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') return { accessToken: bToken, expiresIn: 3600 };
      if (path === '/api/v1/auth/logout') {
        tokenLiveAtLogout = liveAccessToken();
        return undefined;
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.login('b@test.com', 'pw');
    });

    expect(tokenLiveAtLogout).toBe(bToken);
    expect(flag('isAuthenticated')).toBe('false');
  });

  // A blocked drop persists B's userId in a localStorage marker before the best-effort revoke; on the next boot refresh a
  // matching userId forces a retry of the drop before B's claims are adopted, so the household never renders over A's stale rows.

  const BLOCKED_RESET_KEY = 'retivo:blocked-reset:pending';

  it('blocked drop persists the blocked-reset marker (B userId) before the revoke', async () => {
    await renderAuth();
    const bToken = jwt({ userId: 'u-b', householdId: 'hh-b' });
    maybeResetForNewUser.mockRejectedValue(new Error('DatabaseDropBlockedError'));
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') return { accessToken: bToken, expiresIn: 3600 };
      if (path === '/api/v1/auth/logout') return undefined;
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.login('b@test.com', 'pw');
    });

    expect(localStorage.getItem(BLOCKED_RESET_KEY)).toBe('u-b');
  });

  it('reload with a pending marker + matching refresh: drop succeeds → marker cleared, claims adopted', async () => {
    const bToken = jwt({ userId: 'u-b', householdId: 'hh-b' });
    localStorage.setItem(BLOCKED_RESET_KEY, 'u-b');
    maybeResetForNewUser.mockResolvedValue(undefined);
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') return { accessToken: bToken, expiresIn: 3600 };
      throw new Error(`unexpected api call ${path}`);
    });

    await mountAuth();

    await waitFor(() => expect(flag('isAuthenticated')).toBe('true'));
    expect(localStorage.getItem(BLOCKED_RESET_KEY)).toBeNull();
    expect(maybeResetForNewUser).toHaveBeenCalled();
  });

  it('reload with a pending marker + matching refresh: drop still blocked → claims withheld, modal shown, marker persists', async () => {
    const bToken = jwt({ userId: 'u-b', householdId: 'hh-b' });
    localStorage.setItem(BLOCKED_RESET_KEY, 'u-b');
    maybeResetForNewUser.mockRejectedValue(new Error('DatabaseDropBlockedError'));
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') return { accessToken: bToken, expiresIn: 3600 };
      throw new Error(`unexpected api call ${path}`);
    });

    await mountAuth();

    await waitFor(() =>
      expect(screen.getByText('Close all other tabs to continue')).toBeInTheDocument(),
    );
    expect(flag('isAuthenticated')).toBe('false');
    expect(localStorage.getItem(BLOCKED_RESET_KEY)).toBe('u-b');
    expect(getKeyEnvelopes).not.toHaveBeenCalled();
  });

  it('reload with a pending marker but a DIFFERENT refreshed user clears the stale marker and adopts normally', async () => {
    // The marker is for B but the surviving refresh cookie is C's; a stale marker must not block C.
    const cToken = jwt({ userId: 'u-c', householdId: 'hh-c' });
    localStorage.setItem(BLOCKED_RESET_KEY, 'u-b');
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') return { accessToken: cToken, expiresIn: 3600 };
      throw new Error(`unexpected api call ${path}`);
    });

    await mountAuth();

    await waitFor(() => expect(flag('isAuthenticated')).toBe('true'));
    expect(localStorage.getItem(BLOCKED_RESET_KEY)).toBeNull();
    expect(maybeResetForNewUser).not.toHaveBeenCalled();
  });

  it('login with envelopes but no cached HDK → not unlocked, resolved, not needsKeySetup', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');
    expect(flag('needsKeySetup')).toBe('false');
  });

  it('unlockWithPassword with the correct password → unlocked, resolved stays true, HDK cached', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    const envelopes = {
      slots: [{ slotType: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    };
    getKeyEnvelopes.mockResolvedValue(envelopes);
    unwrapSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));

    await act(async () => {
      await captured.unlockWithPassword('correct');
    });

    expect(flag('isUnlocked')).toBe('true');
    expect(flag('unlockResolved')).toBe('true');
    expect(captured.getHdk()).toBe(fakeHdk);
    expect(cacheHdk).toHaveBeenCalledWith('hh-1', fakeHdk);
  });

  it('unlockWithPassword with the wrong password re-throws and stays locked', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    unwrapSlot.mockRejectedValue(new KeyWrappingError('wrong password'));

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));

    await expect(captured.unlockWithPassword('wrong')).rejects.toBeInstanceOf(KeyWrappingError);
    expect(flag('isUnlocked')).toBe('false');
    expect(captured.getHdk()).toBeNull();
    expect(cacheHdk).not.toHaveBeenCalled();
  });

  it('unlockWithRecovery with the correct recovery key → unlocked, HDK cached', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password' }, { slotType: 'recovery' }],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });
    unwrapSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));

    await act(async () => {
      await captured.unlockWithRecovery('ABCD-EF12-3456-7890');
    });

    expect(flag('isUnlocked')).toBe('true');
    expect(captured.getHdk()).toBe(fakeHdk);
    expect(cacheHdk).toHaveBeenCalledWith('hh-1', fakeHdk);
    expect(unwrapSlot).toHaveBeenCalledWith({ slotType: 'recovery' }, 'ABCD-EF12-3456-7890');
  });

  it('unlockWithRecovery with the wrong recovery key re-throws and stays locked', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password' }, { slotType: 'recovery' }],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });
    unwrapSlot.mockRejectedValue(new KeyWrappingError('wrong recovery key'));

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));

    await expect(captured.unlockWithRecovery('WRONG-KEY')).rejects.toBeInstanceOf(KeyWrappingError);
    expect(flag('isUnlocked')).toBe('false');
    expect(captured.getHdk()).toBeNull();
    expect(cacheHdk).not.toHaveBeenCalled();
  });

  it('cached HDK is trusted only after the envelope-set tag verifies', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(fakeHdk);
    const envelopes = {
      slots: [{ slotType: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    };
    getKeyEnvelopes.mockResolvedValue(envelopes);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await waitFor(() => expect(flag('isUnlocked')).toBe('true'));
    expect(verifyEnvelopeSetTag).toHaveBeenCalledWith(envelopes.slots, envelopes, fakeHdk);
    expect(captured.getHdk()).toBe(fakeHdk);
    expect(flag('unlockResolved')).toBe('true');
  });

  it('cached HDK is REJECTED (stays locked, cache cleared) when the envelope-set tag fails (slot tamper)', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(fakeHdk);
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tampered',
    });
    verifyEnvelopeSetTag.mockRejectedValue(new KeyWrappingError('tamper or rollback'));
    clearCachedHdk.mockResolvedValue(undefined);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');
    expect(captured.getHdk()).toBeNull();
    expect(clearCachedHdk).toHaveBeenCalled();
    expect(flag('needsKeySetup')).toBe('false');
    expect(flag('lockedEnvelopeSetEmpty')).toBe('false');
  });

  // A served empty slot set is doubted, not trusted as "needs setup", when the device has evidence of a real key (a cached HDK or a non-zero rollback pin): it stops at the locked screen instead of minting a new household key.
  it.each([
    ['a cached HDK', fakeHdk, 0],
    ['a non-zero rollback pin and no cached HDK', null, 3],
  ])('an empty slot set with %s → locked (not needsKeySetup), flag set, cached key NOT cleared', async (_name, cached, pin) => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(cached);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    readEnvelopeSetPin.mockResolvedValue(pin);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');
    expect(captured.getHdk()).toBeNull();
    expect(flag('needsKeySetup')).toBe('false');
    expect(flag('lockedEnvelopeSetEmpty')).toBe('true');
    expect(clearCachedHdk).not.toHaveBeenCalled();
    expect(verifyEnvelopeSetTag).not.toHaveBeenCalled();
  });

  // A missing or non-array `slots` field reads as empty rather than throwing, so a malformed response cannot detour a keyed device into setup.
  it('a malformed slots field (missing) on a device with a cached key reads as empty, not a throw', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(fakeHdk);
    getKeyEnvelopes.mockResolvedValue({ envelopeSetVersion: 0, envelopeSetTag: '' } as never);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');
    expect(flag('needsKeySetup')).toBe('false');
    expect(flag('lockedEnvelopeSetEmpty')).toBe('true');
    expect(clearCachedHdk).not.toHaveBeenCalled();
  });

  it('a malformed slots field (null) on a genuinely new device reads as empty and reaches ordinary setup (not a throw)', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({
      slots: null,
      envelopeSetVersion: 0,
      envelopeSetTag: '',
    } as never);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');
    expect(flag('needsKeySetup')).toBe('true');
    expect(flag('lockedEnvelopeSetEmpty')).toBe('false');
  });

  it('logout clears the unlock state: isUnlocked false, unlockResolved false, HDK null', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(fakeHdk);
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    verifyEnvelopeSetTag.mockResolvedValue(undefined);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('isUnlocked')).toBe('true'));
    expect(captured.getHdk()).toBe(fakeHdk);

    await act(async () => {
      await captured.logout();
    });

    expect(flag('isUnlocked')).toBe('false');
    expect(flag('unlockResolved')).toBe('false');
    expect(captured.getHdk()).toBeNull();
    expect(clearCachedHdk).not.toHaveBeenCalled();
  });

  it('staleness guard: a logout mid-initializeUnlockState discards the stale result', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    // Hold the envelope fetch open so initializeUnlockState is in flight while we log out underneath it.
    let releaseEnvelopes!: (v: unknown) => void;
    getKeyEnvelopes.mockReturnValue(
      new Promise((resolve) => {
        releaseEnvelopes = resolve;
      }),
    );

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await act(async () => {
      await captured.logout();
    });
    expect(flag('isUnlocked')).toBe('false');
    expect(flag('unlockResolved')).toBe('false');

    await act(async () => {
      releaseEnvelopes({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
      await Promise.resolve();
    });

    expect(flag('needsKeySetup')).toBe('false');
    expect(flag('unlockResolved')).toBe('false');
    expect(flag('isUnlocked')).toBe('false');
  });


  it('refreshAccessToken calls apiRequest with raiseWaitNotice: false (the shared client seam must not touch /auth/refresh)', async () => {
    await renderAuth();
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.refreshAccessToken();
    });

    expect(apiRequest).toHaveBeenCalledWith('/api/v1/auth/refresh', {
      method: 'POST',
      auth: false,
      raiseWaitNotice: false,
    });
  });


  it('fetchAccountRecord forwards the wait-notice opt-out to apiRequest when given one', async () => {
    await renderAuth();
    apiRequest.mockReset();
    apiRequest.mockResolvedValue({ email: 'u@test.com' });

    await act(async () => {
      await captured.fetchAccountRecord({ raiseWaitNotice: false });
    });

    expect(apiRequest).toHaveBeenCalledWith('/api/v1/auth/me', { raiseWaitNotice: false });
  });

  it('fetchAccountRecord passes no options to apiRequest when called bare (the Account card keeps its wait notice)', async () => {
    await renderAuth();
    apiRequest.mockReset();
    apiRequest.mockResolvedValue({ email: 'u@test.com' });

    await act(async () => {
      await captured.fetchAccountRecord();
    });

    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]).toEqual(['/api/v1/auth/me']);
  });


  it('same-session token refresh does NOT clear or re-derive unlock state (HDK preserved)', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(fakeHdk);
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    verifyEnvelopeSetTag.mockResolvedValue(undefined);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('isUnlocked')).toBe('true'));
    expect(captured.getHdk()).toBe(fakeHdk);

    loadCachedHdk.mockClear();
    getKeyEnvelopes.mockClear();
    verifyEnvelopeSetTag.mockClear();
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') {
        return {
          accessToken: jwt({ userId: 'u1', householdId: 'hh-1', email: 'renamed@test.com' }),
          expiresIn: 3600,
        };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.refreshAccessToken();
    });

    expect(captured.getHdk()).toBe(fakeHdk);
    expect(flag('isUnlocked')).toBe('true');
    expect(flag('unlockResolved')).toBe('true');
    expect(loadCachedHdk).not.toHaveBeenCalled();
    expect(getKeyEnvelopes).not.toHaveBeenCalled();
  });

  it('refresh for a DIFFERENT user clears the prior session and re-derives unlock state', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(fakeHdk);
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    verifyEnvelopeSetTag.mockResolvedValue(undefined);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('isUnlocked')).toBe('true'));

    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') {
        return { accessToken: jwt({ userId: 'u2', householdId: 'hh-2' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.refreshAccessToken();
    });

    await waitFor(() => expect(flag('needsKeySetup')).toBe('true'));
    expect(captured.getHdk()).toBeNull();
    expect(flag('isUnlocked')).toBe('false');
    expect(loadCachedHdk).toHaveBeenCalledWith('hh-2');
  });


  it('passkey login with a PRF result + passkey_prf slot → unlocked, HDK cached', async () => {
    await renderAuth();
    wirePasskeyLogin(jwt({ userId: 'u1', householdId: 'hh-1' }), {
      extensions: { prf: { eval: { first: 'c2FsdA' } } },
    });
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue(prfEnvelopes);
    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    const assertion = { id: 'cred', clientExtensionResults: { prf: { results: { first: 'x' } } } };
    startAuthentication.mockResolvedValue(assertion);
    extractPrfResult.mockReturnValue(new Uint8Array([1, 2, 3]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    unwrapPrfSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);

    await act(async () => {
      await captured.loginWithPasskey();
    });

    await waitFor(() => expect(flag('isUnlocked')).toBe('true'));
    expect(captured.getHdk()).toBe(fakeHdk);
    expect(cacheHdk).toHaveBeenCalledWith('hh-1', fakeHdk);
    expect(addPrfEvalToOptions).toHaveBeenCalled();
  });

  it('passkey login with NO PRF result → login succeeds, stays locked (password fallback)', async () => {
    await renderAuth();
    wirePasskeyLogin(jwt({ userId: 'u1', householdId: 'hh-1' }), {});
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue(prfEnvelopes);
    startAuthentication.mockResolvedValue({ id: 'cred', clientExtensionResults: {} });
    extractPrfResult.mockReturnValue(null);

    await act(async () => {
      await captured.loginWithPasskey();
    });

    await waitFor(() => expect(flag('isAuthenticated')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');
    expect(captured.getHdk()).toBeNull();
    expect(addPrfEvalToOptions).not.toHaveBeenCalled();
    expect(unwrapPrfSlot).not.toHaveBeenCalled();
  });

  it('passkey login where tryUnlockWithPrf throws (unwrap rejects) → login still succeeds, stays locked', async () => {
    await renderAuth();
    wirePasskeyLogin(jwt({ userId: 'u1', householdId: 'hh-1' }), {
      extensions: { prf: { eval: { first: 'c2FsdA' } } },
    });
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue(prfEnvelopes);
    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    startAuthentication.mockResolvedValue({
      id: 'cred',
      clientExtensionResults: { prf: { results: { first: 'x' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([1, 2, 3]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    unwrapPrfSlot.mockRejectedValue(new KeyWrappingError('prf unwrap failed'));

    let threw = false;
    await act(async () => {
      try {
        await captured.loginWithPasskey();
      } catch {
        threw = true;
      }
    });

    expect(threw).toBe(false);
    await waitFor(() => expect(flag('isAuthenticated')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');
    expect(captured.getHdk()).toBeNull();
  });

  it('passkey login: a logout mid-tryUnlockWithPrf (staleness guard) does NOT flip isUnlocked', async () => {
    await renderAuth();
    wirePasskeyLogin(jwt({ userId: 'u1', householdId: 'hh-1' }), {
      extensions: { prf: { eval: { first: 'c2FsdA' } } },
    });
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue(prfEnvelopes);
    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    startAuthentication.mockResolvedValue({
      id: 'cred',
      clientExtensionResults: { prf: { results: { first: 'x' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([1, 2, 3]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);

    // Hold the PRF unwrap open (unique to tryUnlockWithPrf, so initializeUnlockState cannot race it) to log out underneath it.
    let releaseUnwrap!: (v: CryptoKey) => void;
    unwrapPrfSlot.mockReturnValue(
      new Promise<CryptoKey>((resolve) => {
        releaseUnwrap = resolve;
      }),
    );

    await act(async () => {
      await captured.loginWithPasskey();
    });

    await act(async () => {
      await captured.logout();
    });
    expect(flag('isUnlocked')).toBe('false');

    await act(async () => {
      releaseUnwrap(fakeHdk);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(flag('isUnlocked')).toBe('false');
    expect(captured.getHdk()).toBeNull();
    expect(cacheHdk).not.toHaveBeenCalled();
  });

  // Whether the `password` slot needs re-wrapping is derived from the slot's `credentialRevision` against the response's
  // `currentCredentialRevision` on every key-envelopes read; there is no marker (see "Password change, password reset" in docs/security.md).

  function wireLockedSlotSetOwed(): void {
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({
      slots: [
        { slotType: 'password', slotId: 'password', credentialRevision: 'rev-old' },
        { slotType: 'recovery', slotId: 'recovery' },
      ],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
      currentCredentialRevision: 'rev-current',
    });
    unwrapSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);
    generatePasswordSlot.mockResolvedValue({ slotType: 'password', slotId: 'password' });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    upsertKeyEnvelopeSlot.mockResolvedValue(undefined);
  }

  function wireLockedSlotSetNotOwed(): void {
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({
      slots: [
        { slotType: 'password', slotId: 'password', credentialRevision: 'rev-current' },
        { slotType: 'recovery', slotId: 'recovery' },
      ],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
      currentCredentialRevision: 'rev-current',
    });
    unwrapSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);
  }

  it('a password sign-in retains the plaintext; an owed recovery unlock re-wraps the password slot under it, silently', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    wireLockedSlotSetOwed();

    await act(async () => {
      await captured.login('u@test.com', 'NewPassw0rd!Reset');
    });
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');

    await act(async () => {
      await captured.unlockWithRecovery('ABCD-EF12-3456-7890');
    });

    expect(flag('isUnlocked')).toBe('true');
    await waitFor(() =>
      expect(generatePasswordSlot).toHaveBeenCalledWith('hh-1', 'password', 'NewPassw0rd!Reset', fakeHdk),
    );
    expect(screen.queryByText(/re-enter your password/i)).toBeNull();
  });

  it('a household that owes nothing is never prompted and never re-wrapped', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    wireLockedSlotSetNotOwed();

    await act(async () => {
      await captured.login('u@test.com', 'SomePassw0rd!');
    });
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));

    await act(async () => {
      await captured.unlockWithRecovery('ABCD-EF12-3456-7890');
    });

    expect(flag('isUnlocked')).toBe('true');
    expect(generatePasswordSlot).not.toHaveBeenCalled();
    expect(screen.queryByText(/re-enter your password/i)).toBeNull();
  });

  it('a passkey (PRF) unlock on an owed household prompts instead of silently re-wrapping — no plaintext is in hand', async () => {
    await renderAuth();
    wirePasskeyLogin(jwt({ userId: 'u1', householdId: 'hh-1' }), {
      extensions: { prf: { eval: { first: 'c2FsdA' } } },
    });
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({
      slots: [
        { slotType: 'passkey_prf', slotId: 's-prf' },
        { slotType: 'password', slotId: 'password', credentialRevision: 'rev-old' },
      ],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
      currentCredentialRevision: 'rev-current',
    });
    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    const assertion = { id: 'cred', clientExtensionResults: { prf: { results: { first: 'x' } } } };
    startAuthentication.mockResolvedValue(assertion);
    extractPrfResult.mockReturnValue(new Uint8Array([1, 2, 3]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    unwrapPrfSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);

    await act(async () => {
      await captured.loginWithPasskey();
    });
    await waitFor(() => expect(flag('isUnlocked')).toBe('true'));

    await waitFor(() => expect(screen.getByText(/re-enter your password/i)).toBeInTheDocument());
    expect(generatePasswordSlot).not.toHaveBeenCalled();
  });


  it('a password sign-in that auto-unlocks from its cached key on this device re-wraps the owed password slot silently, with no unwrap failure', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(fakeHdk);
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password', credentialRevision: 'rev-old' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
      currentCredentialRevision: 'rev-current',
    });
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);
    generatePasswordSlot.mockResolvedValue({ slotType: 'password', slotId: 'password' });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    upsertKeyEnvelopeSlot.mockResolvedValue(undefined);

    await act(async () => {
      await captured.login('u@test.com', 'NewPassw0rd!Reset');
    });

    await waitFor(() => expect(flag('isUnlocked')).toBe('true'));
    expect(unwrapSlot).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(generatePasswordSlot).toHaveBeenCalledWith('hh-1', 'password', 'NewPassw0rd!Reset', fakeHdk),
    );
    expect(screen.queryByText(/re-enter your password/i)).toBeNull();
  });

  it('unlockWithPassword on an owed household prompts instead of silently re-wrapping — the unlock-form password is never used as a wrap source', async () => {
    // The session is established by a boot refresh, not `login()`, so no plaintext is retained and a silent rewrap could only come from forwarding the unlockWithPassword argument.
    const token = jwt({ userId: 'u1', householdId: 'hh-1' });
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password', credentialRevision: 'rev-old' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
      currentCredentialRevision: 'rev-current',
    });
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') return { accessToken: token, expiresIn: 3600 };
      throw new Error(`unexpected api call ${path}`);
    });
    await mountAuth();
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');

    unwrapSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);

    await act(async () => {
      await captured.unlockWithPassword('TypedIntoUnlockPrompt!');
    });

    expect(flag('isUnlocked')).toBe('true');
    await waitFor(() => expect(screen.getByText(/re-enter your password/i)).toBeInTheDocument());
    expect(generatePasswordSlot).not.toHaveBeenCalled();
  });

  // Most tests mock the re-wrap's outcome, so "the old password no longer opens the slot" would otherwise hold only by inspection.

  it('after a silent re-wrap, the OLD password no longer opens the password slot — only the NEW one does', async () => {
    await renderAuth();
    const token = jwt({ userId: 'u1', householdId: 'hh-1' });
    wireLogin(token);
    wireLockedSlotSetOwed();

    // A stateful unwrap standing in for overwrite-in-place: the slot only unwraps under the plaintext that most recently wrapped it; the recovery slot has its own secret.
    let currentWrapSecret = 'OldPassw0rd!';
    // The candidate secret is only staged: if `upsertKeyEnvelopeSlot` were never called or failed, nothing here may change what unwraps the slot.
    let pendingSlotPassword: string | null = null;
    unwrapSlot.mockImplementation(async (slot: { slotType: string }, password: string) => {
      if (slot.slotType === 'recovery') return fakeHdk;
      if (password !== currentWrapSecret) throw new KeyWrappingError('wrong password');
      return fakeHdk;
    });
    generatePasswordSlot.mockImplementation(
      async (_householdId: string, slotId: string, password: string) => {
        pendingSlotPassword = password;
        return { slotType: 'password', slotId };
      },
    );
    upsertKeyEnvelopeSlot.mockImplementation(async () => {
      if (pendingSlotPassword === null) {
        throw new Error('upsertKeyEnvelopeSlot called with no prepared slot');
      }
      currentWrapSecret = pendingSlotPassword;
      pendingSlotPassword = null;
    });
    getKeyEnvelopes.mockImplementation(async () => ({
      slots: [
        {
          slotType: 'password',
          slotId: 'password',
          credentialRevision: currentWrapSecret === 'NewPassw0rd!Reset' ? 'rev-current' : 'rev-old',
        },
        { slotType: 'recovery', slotId: 'recovery' },
      ],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
      currentCredentialRevision: 'rev-current',
    }));

    await act(async () => {
      await captured.login('u@test.com', 'NewPassw0rd!Reset');
    });
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');

    await act(async () => {
      await captured.unlockWithRecovery('ABCD-EF12-3456-7890');
    });

    await waitFor(() => expect(upsertKeyEnvelopeSlot).toHaveBeenCalled());
    await waitFor(() => expect(currentWrapSecret).toBe('NewPassw0rd!Reset'));

    // Remount to simulate a reload, so durability is checked on a fresh instance re-fetching from the mocked backend.
    cleanup();
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') return { accessToken: token, expiresIn: 3600 };
      if (path === '/api/v1/auth/logout') return undefined;
      if (path === '/api/v1/auth/verify-password') return undefined;
      throw new Error(`unexpected api call ${path}`);
    });
    loadCachedHdk.mockResolvedValue(null);
    await mountAuth();
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');

    await expect(captured.unlockWithPassword('OldPassw0rd!')).rejects.toBeInstanceOf(
      KeyWrappingError,
    );

    await act(async () => {
      await captured.unlockWithPassword('NewPassw0rd!Reset');
    });
    expect(flag('isUnlocked')).toBe('true');
  });
});

async function signupRenderAuth(): Promise<void> {
  await renderAuth();
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/signup') {
      return { userId: 'u-new', email: 'jane@example.test', verificationRequired: true };
    }
    throw new Error(`unexpected api call ${path}`);
  });
}

describe('AuthContext.signup — request body', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    apiRequest.mockReset();
    localStorage.clear();
  });
  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  function signupBody(): Record<string, unknown> {
    const call = apiRequest.mock.calls.find((c) => c[0] === '/api/v1/auth/signup');
    expect(call).toBeDefined();
    expect((call![1] as { auth: boolean }).auth).toBe(false);
    return (call![1] as { body: Record<string, unknown> }).body;
  }

  it('posts exactly email, password and the supplied profile fields', async () => {
    await signupRenderAuth();
    await captured.signup('jane@example.test', 'TestPassw0rd!Test', 'Jane', 'Smith', '1980-04-15');

    expect(signupBody()).toEqual({
      email: 'jane@example.test',
      password: 'TestPassw0rd!Test',
      firstName: 'Jane',
      lastName: 'Smith',
      birthdate: '1980-04-15',
    });
  });

  it('posts only email and password when no profile fields are supplied', async () => {
    await signupRenderAuth();
    await captured.signup('jane@example.test', 'TestPassw0rd!Test');

    expect(Object.keys(signupBody()).sort()).toEqual(['email', 'password']);
  });
});

function profileWireLogin(loginResponse: Record<string, unknown>): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') return loginResponse;
    if (path === '/api/v1/auth/logout') return undefined;
    if (path === '/api/v1/auth/verify-password') return undefined;
    throw new Error(`unexpected api call ${path}`);
  });
}

describe('AuthContext — sign-in writes nothing personal to browser storage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    apiRequest.mockReset();
    getKeyEnvelopes.mockReset();
    upsertKeyEnvelopeSlot.mockReset();
    loadCachedHdk.mockReset();
    cacheHdk.mockReset();
    clearCachedHdk.mockReset();
    unwrapSlot.mockReset();
    verifyEnvelopeSetTag.mockReset();
    maybeResetForNewUser.mockReset();
    maybeResetForNewUser.mockResolvedValue(undefined);
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('a login response carrying name and birthdate signs in and stores neither', async () => {
    await renderAuth();
    const token = jwt({ userId: 'u-new', householdId: 'hh-new' });
    profileWireLogin({
      accessToken: token,
      expiresIn: 3600,
      firstName: 'Jane',
      lastName: 'Smith',
      birthdate: '1990-04-15',
    });
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });

    await act(async () => {
      await captured.login('jane@test.com', 'pw');
    });

    await waitFor(() =>
      expect(screen.getByTestId('isAuthenticated').textContent).toBe('true'),
    );
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i)!;
        const entry = `${key}=${storage.getItem(key)}`;
        expect(entry).not.toContain('Jane');
        expect(entry).not.toContain('Smith');
        expect(entry).not.toContain('1990-04-15');
      }
    }
  });
});
