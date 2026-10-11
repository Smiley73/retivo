/**
 * Tests for the zero-knowledge unlock lifecycle in AuthContext:
 * `initializeUnlockState` after login, `unlockWithPassword`, `clearUnlockState`
 * on logout, the `unlockResolved` gate, and the staleness guard that stops a
 * stale household's HDK from overwriting a newer session. The API, the
 * key-envelope client, the HDK cache, and the key-wrapping unwrap are mocked at
 * the module boundary so the test exercises only the context's orchestration.
 */
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
import { authMocks, jwt, fakeHdk } from './auth-context.test-harness';
// Pull the mocked KeyWrappingError so assertions use the same class the SUT throws.
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

// --- Helpers ----------------------------------------------------------------

/** Snapshot of the reactive unlock flags, exposed for assertions. */
let captured: {
  login: (e: string, p: string) => Promise<void>;
  loginWithPasskey: () => Promise<void>;
  refreshAccessToken: () => Promise<string | null>;
  resetPassword: (token: string, p: string) => Promise<void>;
  unlockWithPassword: (p: string) => Promise<void>;
  unlockWithRecovery: (k: string) => Promise<void>;
  setupEncryption: (p: string) => Promise<string>;
  logout: () => Promise<void>;
  isUnlocked: boolean;
  needsKeySetup: boolean;
  unlockResolved: boolean;
  isAuthenticated: boolean;
  lockedEnvelopeSetEmpty: boolean;
  getHdk: () => CryptoKey | null;
};

function Probe(): React.ReactElement {
  const auth = useAuth();
  captured = {
    login: auth.login,
    loginWithPasskey: auth.loginWithPasskey,
    refreshAccessToken: auth.refreshAccessToken,
    resetPassword: auth.resetPassword,
    unlockWithPassword: auth.unlockWithPassword,
    unlockWithRecovery: auth.unlockWithRecovery,
    setupEncryption: auth.setupEncryption,
    logout: auth.logout,
    isUnlocked: auth.isUnlocked,
    needsKeySetup: auth.needsKeySetup,
    unlockResolved: auth.unlockResolved,
    isAuthenticated: auth.isAuthenticated,
    lockedEnvelopeSetEmpty: auth.lockedEnvelopeSetEmpty,
    getHdk: auth.getHdk,
  };
  return (
    <div>
      <span data-testid="isUnlocked">{String(auth.isUnlocked)}</span>
      <span data-testid="needsKeySetup">{String(auth.needsKeySetup)}</span>
      <span data-testid="unlockResolved">{String(auth.unlockResolved)}</span>
      <span data-testid="isAuthenticated">{String(auth.isAuthenticated)}</span>
      <span data-testid="lockedEnvelopeSetEmpty">{String(auth.lockedEnvelopeSetEmpty)}</span>
    </div>
  );
}

function flag(id: string): string {
  return screen.getByTestId(id).textContent ?? '';
}

/** Render the provider with the boot refresh resolving to "signed out". */
async function renderAuth(): Promise<void> {
  // Boot effect calls /auth/refresh first; fail it so boot settles unauthenticated.
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

/**
 * Route api calls: refresh fails (boot), login returns the given token.
 * `verify-password` resolves (success) by default — setupEncryption gates on it
 * a wrong-password test overrides this route to reject.
 */
function wireLogin(token: string): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') return { accessToken: token, expiresIn: 3600 };
    if (path === '/api/v1/auth/logout') return undefined;
    if (path === '/api/v1/auth/verify-password') return undefined;
    throw new Error(`unexpected api call ${path}`);
  });
}

/**
 * Route api calls for the discoverable passkey flow: boot refresh fails, the
 * authenticate/start returns request options (optionally carrying a PRF salt),
 * authenticate/finish returns the access token. `refresh` (used by a re-auth /
 * idle "stay signed in") returns the same token for same-session-refresh tests.
 */
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

/** A PRF `passkey_prf` slot set with a verifiable tag. */
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
    // Default: no rollback pin (TOFU). The empty-set tests
    // override this to simulate a device that already carries one.
    readEnvelopeSetPin.mockReset();
    readEnvelopeSetPin.mockResolvedValue(0);
    startAuthentication.mockReset();
    startRegistration.mockReset();
    addPrfEvalToOptions.mockReset();
    derivePrfWrapKey.mockReset();
    extractPrfResult.mockReset();
    // Default: the cross-user drop succeeds (no-op). The blocked-drop test
    // overrides this to reject.
    maybeResetForNewUser.mockReset();
    maybeResetForNewUser.mockResolvedValue(undefined);
    liveAccessToken = () => null;
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
    // A genuinely unkeyed household (no cache, no pin)
    // reaches ordinary first-time setup — the locked-empty-set flag never
    // fires here (unchanged TOFU).
    expect(flag('lockedEnvelopeSetEmpty')).toBe('false');
  });

  it('blocked cross-user drop revokes the new session (logout AS B) before surfacing the modal — never adopts B', async () => {
    await renderAuth();
    const bToken = jwt({ userId: 'u-b', householdId: 'hh-b' });
    // The new user B authenticates, but B's IDB drop fails closed (another tab
    // holds the previous user A's working store open).
    maybeResetForNewUser.mockRejectedValue(new Error('DatabaseDropBlockedError'));
    // Record the access token that was live at the moment logout fired — the fix
    // swaps the ref to B's token so the revoke targets B's just-issued session.
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

    // Logout fired during the blocked drop, carrying B's token (so B's refresh
    // cookie + access token are revoked → a reload falls back to signed-out).
    expect(tokenLiveAtLogout).toBe(bToken);
    // B's claims were never adopted — the session is not authenticated and the
    // new household is never exposed over A's stale rows.
    expect(flag('isAuthenticated')).toBe('false');
  });

  // --- Cross-reload blocked-reset marker ------------------------------
  // A blocked drop persists B's userId in a localStorage marker BEFORE the
  // best-effort revoke (so it survives even when the revoke fails). On the next
  // boot refresh a matching userId forces a retry of the IDB drop before B's
  // claims are adopted — the household never renders over A's stale rows until
  // the drop actually succeeds.

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
    // Simulate the state left behind by a blocked drop: the marker is set for B,
    // and B's refresh cookie survived (the revoke failed), so the boot refresh
    // returns B's token.
    const bToken = jwt({ userId: 'u-b', householdId: 'hh-b' });
    localStorage.setItem(BLOCKED_RESET_KEY, 'u-b');
    // The retry drop now succeeds (the other tab released its IDB handle).
    maybeResetForNewUser.mockResolvedValue(undefined);
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') return { accessToken: bToken, expiresIn: 3600 };
      throw new Error(`unexpected api call ${path}`);
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    // The retry drop succeeded → marker cleared and B's claims are adopted.
    await waitFor(() => expect(flag('isAuthenticated')).toBe('true'));
    expect(localStorage.getItem(BLOCKED_RESET_KEY)).toBeNull();
    expect(maybeResetForNewUser).toHaveBeenCalled();
  });

  it('reload with a pending marker + matching refresh: drop still blocked → claims withheld, modal shown, marker persists', async () => {
    const bToken = jwt({ userId: 'u-b', householdId: 'hh-b' });
    localStorage.setItem(BLOCKED_RESET_KEY, 'u-b');
    // The retry drop is STILL blocked (the other tab has not released the IDB).
    maybeResetForNewUser.mockRejectedValue(new Error('DatabaseDropBlockedError'));
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') return { accessToken: bToken, expiresIn: 3600 };
      throw new Error(`unexpected api call ${path}`);
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    // updateFromToken was never reached → B's claims are NOT adopted.
    await waitFor(() =>
      expect(screen.getByText('Close all other tabs to continue')).toBeInTheDocument(),
    );
    expect(flag('isAuthenticated')).toBe('false');
    // The marker persists so a subsequent reload re-guards until the drop works.
    expect(localStorage.getItem(BLOCKED_RESET_KEY)).toBe('u-b');
    // The envelope fetch (post-claim unlock init) never ran — claims withheld.
    expect(getKeyEnvelopes).not.toHaveBeenCalled();
  });

  it('reload with a pending marker but a DIFFERENT refreshed user clears the stale marker and adopts normally', async () => {
    // The marker is for B, but the surviving refresh cookie is actually C's
    // (e.g. B's revoke succeeded; an unrelated session signed in). The stale
    // marker must not block C — clear it and adopt C's claims normally.
    const cToken = jwt({ userId: 'u-c', householdId: 'hh-c' });
    localStorage.setItem(BLOCKED_RESET_KEY, 'u-b');
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') return { accessToken: cToken, expiresIn: 3600 };
      throw new Error(`unexpected api call ${path}`);
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(flag('isAuthenticated')).toBe('true'));
    expect(localStorage.getItem(BLOCKED_RESET_KEY)).toBeNull();
    // No drop retry — the marker was for a different user.
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
    // Unwrapped the recovery slot (not the password slot) with the entered key.
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
    loadCachedHdk.mockResolvedValue(fakeHdk); // device already has the key cached
    const envelopes = {
      slots: [{ slotType: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    };
    getKeyEnvelopes.mockResolvedValue(envelopes);
    verifyEnvelopeSetTag.mockResolvedValue(undefined); // tag verifies

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await waitFor(() => expect(flag('isUnlocked')).toBe('true'));
    // Verified against the live slot set BEFORE the unlock was trusted.
    expect(verifyEnvelopeSetTag).toHaveBeenCalledWith(envelopes.slots, envelopes, fakeHdk);
    expect(captured.getHdk()).toBe(fakeHdk);
    expect(flag('unlockResolved')).toBe('true');
  });

  it('cached HDK is REJECTED (stays locked, cache cleared) when the envelope-set tag fails (slot tamper)', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(fakeHdk); // device has a cached key
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tampered',
    });
    // Server stripped/reordered/injected a slot → HDK-keyed tag mismatch.
    verifyEnvelopeSetTag.mockRejectedValue(new KeyWrappingError('tamper or rollback'));
    clearCachedHdk.mockResolvedValue(undefined);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    // Never trusted the unverified cached key.
    expect(flag('isUnlocked')).toBe('false');
    expect(captured.getHdk()).toBeNull();
    // The stale/untrustworthy cached key was dropped; the user must re-unlock
    // with a password (needsKeySetup stays false — there IS a slot set).
    expect(clearCachedHdk).toHaveBeenCalled();
    expect(flag('needsKeySetup')).toBe('false');
    // The non-empty failed-tag branch is unchanged — the
    // empty-set flag never fires for a genuine tamper on a non-empty set.
    expect(flag('lockedEnvelopeSetEmpty')).toBe('false');
  });

  // A served EMPTY slot set on a device that already holds
  // a cached HDK is doubted, not trusted as "this household needs setup" —
  // the cached key survives on disk and the device stops at the locked
  // screen with the new flag set, rather than being walked into minting a
  // brand-new household key over an existing one.
  it('cached HDK with an empty slot set → locked (not needsKeySetup), flag set, cached key NOT cleared', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(fakeHdk); // device already has a real cached key
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');
    expect(captured.getHdk()).toBeNull();
    // Not routed into first-time setup — this device has evidence of a real
    // key, so the server's empty response is doubted rather than trusted.
    expect(flag('needsKeySetup')).toBe('false');
    expect(flag('lockedEnvelopeSetEmpty')).toBe('true');
    // The cached key is left on disk — the server's claim is what is in
    // doubt, and a transient empty response must not cost the offline key.
    expect(clearCachedHdk).not.toHaveBeenCalled();
    // The tag is never verified against an empty set.
    expect(verifyEnvelopeSetTag).not.toHaveBeenCalled();
  });

  // Same empty-set doubt, but via the rollback-pin evidence rather than a
  // cached key (a device that unlocked before but cleared its IDB cache).
  it('no cached HDK + empty slot set + a non-zero rollback pin → locked, flag set (not needsKeySetup)', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    readEnvelopeSetPin.mockResolvedValue(3);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');
    expect(flag('needsKeySetup')).toBe('false');
    expect(flag('lockedEnvelopeSetEmpty')).toBe('true');
    expect(clearCachedHdk).not.toHaveBeenCalled();
  });

  // A missing/non-array `slots` field reads as empty rather than throwing —
  // never a false needsKeySetup detour off a malformed response when this
  // device already has evidence of a real key.
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
    loadCachedHdk.mockResolvedValue(fakeHdk); // device already has the key cached
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    verifyEnvelopeSetTag.mockResolvedValue(undefined); // cached key verifies, unlocking

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
    // A bare same-user logout must NOT clear the IDB key cache.
    expect(clearCachedHdk).not.toHaveBeenCalled();
  });

  it('staleness guard: a logout mid-initializeUnlockState discards the stale result', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    // Hold the envelope fetch open so initializeUnlockState is in-flight while
    // we log out underneath it.
    let releaseEnvelopes!: (v: unknown) => void;
    getKeyEnvelopes.mockReturnValue(
      new Promise((resolve) => {
        releaseEnvelopes = resolve;
      }),
    );

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });

    // Logout while the envelope fetch is still pending.
    await act(async () => {
      await captured.logout();
    });
    expect(flag('isUnlocked')).toBe('false');
    expect(flag('unlockResolved')).toBe('false');

    // Now let the stale fetch resolve with a populated (empty) set: the
    // staleness guard must drop it without flipping needsKeySetup/unlockResolved.
    await act(async () => {
      releaseEnvelopes({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
      await Promise.resolve();
    });

    expect(flag('needsKeySetup')).toBe('false');
    expect(flag('unlockResolved')).toBe('false');
    expect(flag('isUnlocked')).toBe('false');
  });

  // --- /auth/refresh opts out of the shared wait notice ----------------

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

  // --- Same-session token refresh preserves unlock state --------------

  it('same-session token refresh does NOT clear or re-derive unlock state (HDK preserved)', async () => {
    await renderAuth();
    // Login + cached-HDK unlock for u1/hh-1 so we have a live in-memory HDK.
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

    // A silent refresh for the SAME user+household (different email claim, same
    // identity). The refresh endpoint returns a fresh token; the re-init path
    // must be skipped so the cached HDK + unlock flags survive untouched.
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

    // unlock state untouched: HDK preserved, still unlocked, no re-init work.
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

    // Refresh resolves to a DIFFERENT household → the prior HDK must be dropped
    // and unlock re-derived (here: empty set for the new household).
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

  // --- loginWithPasskey → tryUnlockWithPrf orchestration --------------

  it('passkey login with a PRF result + passkey_prf slot → unlocked, HDK cached', async () => {
    await renderAuth();
    wirePasskeyLogin(jwt({ userId: 'u1', householdId: 'hh-1' }), {
      // Server start options carry a PRF salt → addPrfEvalToOptions is invoked.
      extensions: { prf: { eval: { first: 'c2FsdA' } } },
    });
    loadCachedHdk.mockResolvedValue(null);
    // initializeUnlockState fetches the envelopes (no cached key) AND
    // tryUnlockWithPrf fetches them again; both see the PRF slot set.
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
    // The PRF eval was forwarded to the authenticator because the start options
    // carried a salt.
    expect(addPrfEvalToOptions).toHaveBeenCalled();
  });

  it('passkey login with NO PRF result → login succeeds, stays locked (password fallback)', async () => {
    await renderAuth();
    wirePasskeyLogin(jwt({ userId: 'u1', householdId: 'hh-1' }), {}); // no PRF salt
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue(prfEnvelopes);
    startAuthentication.mockResolvedValue({ id: 'cred', clientExtensionResults: {} });
    extractPrfResult.mockReturnValue(null); // authenticator returned no PRF result

    await act(async () => {
      await captured.loginWithPasskey();
    });

    await waitFor(() => expect(flag('isAuthenticated')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');
    expect(captured.getHdk()).toBeNull();
    // No salt in the start options → the PRF eval is never forwarded.
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

    // The fire-and-forget PRF failure must not propagate out of login.
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

    // Hold the PRF path's unwrap open (it is unique to tryUnlockWithPrf, so it
    // can't be raced by initializeUnlockState) so we can log out underneath it.
    let releaseUnwrap!: (v: CryptoKey) => void;
    unwrapPrfSlot.mockReturnValue(
      new Promise<CryptoKey>((resolve) => {
        releaseUnwrap = resolve;
      }),
    );

    await act(async () => {
      await captured.loginWithPasskey();
    });

    // Log out while the PRF unlock is still mid-flight (blocked on unwrap).
    await act(async () => {
      await captured.logout();
    });
    expect(flag('isUnlocked')).toBe('false');

    // Now let the stale PRF unwrap resolve: the staleness guard (checked after
    // unwrap + tag verify) must drop the result without flipping isUnlocked /
    // caching the HDK.
    await act(async () => {
      releaseUnwrap(fakeHdk);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(flag('isUnlocked')).toBe('false');
    expect(captured.getHdk()).toBeNull();
    expect(cacheHdk).not.toHaveBeenCalled();
  });

  // --- Derived post-reset re-wrap ------
  // Whether the `password` slot needs re-wrapping is DERIVED from two
  // server-authored fields on every `GET /auth/key-envelopes` read: the
  // slot's own `credentialRevision` and the response's
  // `currentCredentialRevision`. Not equal (including a slot carrying no
  // revision at all) means owed. There is no marker anywhere — reset only
  // drops the password; a login retains the plaintext it was given for the
  // unlock window, and the derive runs on every unlock-state transition
  // (the `isUnlocked` rising-edge effect in AuthContext.tsx).
  // See "Password change, password reset" in docs/security.md.

  /** A locked, OWED session: no cached key, a password slot whose recorded
   * revision does not match the credential's current one (recovery slot
   * present so `unlockWithRecovery` can open it). */
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
    // rotatePasswordSlot path: re-fetch slots, re-wrap, recompute tag, PUT.
    generatePasswordSlot.mockResolvedValue({ slotType: 'password', slotId: 'password' });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    upsertKeyEnvelopeSlot.mockResolvedValue(undefined);
  }

  /** A locked, NOT-owed session: the password slot's recorded revision
   * already matches the credential's current one. */
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

    // The re-wrap fired under the RETAINED sign-in password — silently, no prompt.
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

    // No plaintext was ever retained (a primary passkey login carries none) —
    // the derive prompts rather than rotating.
    await waitFor(() => expect(screen.getByText(/re-enter your password/i)).toBeInTheDocument());
    expect(generatePasswordSlot).not.toHaveBeenCalled();
  });

  // --- The two isUnlocked-rising-edge trigger paths against an owed slot
  // set — the cached-key auto-unlock (no explicit unlock call at all) and the
  // explicit unlockWithPassword branch.

  it('a password sign-in that auto-unlocks from its cached key on this device re-wraps the owed password slot silently, with no unwrap failure', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    // Returning device: the HDK is already cached, so initializeUnlockState's
    // cached-key path (not an explicit unlock call) is what flips isUnlocked.
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

    // The rising edge fired from the CACHED-KEY auto-unlock path
    // (initializeUnlockState) — no unwrap ever ran for this household, and no
    // explicit unlock method was called.
    await waitFor(() => expect(flag('isUnlocked')).toBe('true'));
    expect(unwrapSlot).not.toHaveBeenCalled();
    // The re-wrap completed on the derived compare alone, silently, under the
    // plaintext this sign-in retained.
    await waitFor(() =>
      expect(generatePasswordSlot).toHaveBeenCalledWith('hh-1', 'password', 'NewPassw0rd!Reset', fakeHdk),
    );
    expect(screen.queryByText(/re-enter your password/i)).toBeNull();
  });

  it('unlockWithPassword on an owed household prompts instead of silently re-wrapping — the unlock-form password is never used as a wrap source', async () => {
    // Session established via a boot refresh, NOT `login()` — no plaintext is
    // ever retained by useDerivedRewrap, so a silent rewrap below could only
    // come from (incorrectly) forwarding the unlockWithPassword argument.
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
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');

    unwrapSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);

    await act(async () => {
      await captured.unlockWithPassword('TypedIntoUnlockPrompt!');
    });

    expect(flag('isUnlocked')).toBe('true');
    // No plaintext was ever retained by this session — the derive prompts
    // rather than silently rotating under the unlock-form's password.
    await waitFor(() => expect(screen.getByText(/re-enter your password/i)).toBeInTheDocument());
    expect(generatePasswordSlot).not.toHaveBeenCalled();
  });

  // --- Two claims about the re-wrap: most tests mock
  // rotatePasswordSlot/unwrapSlot's OUTCOME rather than its overwrite-in-
  // place SEMANTICS, so "the old password no longer opens the slot" would
  // otherwise be true only by inspection of generatePasswordSlot, never by a test.

  it('after a silent re-wrap, the OLD password no longer opens the password slot — only the NEW one does', async () => {
    await renderAuth();
    const token = jwt({ userId: 'u1', householdId: 'hh-1' });
    wireLogin(token);
    wireLockedSlotSetOwed();

    // Stateful unwrap standing in for generatePasswordSlot's real
    // overwrite-in-place semantics: the slot only unwraps under whichever
    // plaintext most recently wrapped it. The OLD password is the wrap
    // secret pre-reset. A recovery-slot unwrap is unaffected (it has its own
    // secret, the recovery key, never touched by a password re-wrap).
    let currentWrapSecret = 'OldPassw0rd!';
    // The candidate secret is only STAGED here: this
    // mock must not be able to satisfy the test below on its own (if
    // `upsertKeyEnvelopeSlot` were never called, its PUT deleted, or the
    // write failed, nothing here may change what actually unwraps the slot).
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
    // The wrap secret only advances once a write actually COMMITS through
    // `upsertKeyEnvelopeSlot` — the one call production code makes to
    // durably persist the re-wrapped slot.
    upsertKeyEnvelopeSlot.mockImplementation(async () => {
      if (pendingSlotPassword === null) {
        throw new Error('upsertKeyEnvelopeSlot called with no prepared slot');
      }
      currentWrapSecret = pendingSlotPassword;
      pendingSlotPassword = null;
    });
    // Subsequent reads (including the remount below, simulating a reload)
    // reflect the persisted state above rather than a fixed snapshot.
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

    // The silent re-wrap actually PUT the new slot, and that write is what
    // committed the new wrap secret.
    await waitFor(() => expect(upsertKeyEnvelopeSlot).toHaveBeenCalled());
    await waitFor(() => expect(currentWrapSecret).toBe('NewPassw0rd!Reset'));

    // Remount (simulates a reload) so the durability check below exercises a
    // FRESH component instance re-fetching from the mocked backend, not any
    // in-memory state left over from the instance that ran the re-wrap.
    cleanup();
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') return { accessToken: token, expiresIn: 3600 };
      if (path === '/api/v1/auth/logout') return undefined;
      if (path === '/api/v1/auth/verify-password') return undefined;
      throw new Error(`unexpected api call ${path}`);
    });
    loadCachedHdk.mockResolvedValue(null);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));
    expect(flag('isUnlocked')).toBe('false');

    // The OLD password, which opened the slot before the re-wrap, no
    // longer does.
    await expect(captured.unlockWithPassword('OldPassw0rd!')).rejects.toBeInstanceOf(
      KeyWrappingError,
    );

    // The NEW password does.
    await act(async () => {
      await captured.unlockWithPassword('NewPassw0rd!Reset');
    });
    expect(flag('isUnlocked')).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// Moved from AuthContext.signup.test.tsx
// ---------------------------------------------------------------------------

/**
 * Tests that AuthContext.signup() posts exactly the fields the signup endpoint
 * accepts. The server rejects unknown fields, so a leftover acknowledgement key
 * would turn every signup into a 400.
 *
 * The API and the crypto/key-envelope/user-transition/WebAuthn shims are mocked
 * at the module boundary so only the context's signup orchestration is
 * exercised.
 */

type SignupFn = ReturnType<typeof useAuth>['signup'];
let signupCaptured: { signup: SignupFn };

function SignupProbe(): React.ReactElement {
  const auth = useAuth();
  signupCaptured = { signup: auth.signup };
  return <span data-testid="isAuthenticated">{String(auth.isAuthenticated)}</span>;
}

async function signupRenderAuth(): Promise<void> {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/signup') {
      return { userId: 'u-new', email: 'jane@example.test', verificationRequired: true };
    }
    throw new Error(`unexpected api call ${path}`);
  });
  render(
    <AuthProvider>
      <SignupProbe />
    </AuthProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId('isAuthenticated').textContent).toBe('false'),
  );
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
    await signupCaptured.signup('jane@example.test', 'TestPassw0rd!Test', 'Jane', 'Smith', '1980-04-15');

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
    await signupCaptured.signup('jane@example.test', 'TestPassw0rd!Test');

    expect(Object.keys(signupBody()).sort()).toEqual(['email', 'password']);
  });
});

// ---------------------------------------------------------------------------
// Moved from AuthContext.profile-handoff.test.tsx
// ---------------------------------------------------------------------------

/**
 * Tests for the signup-profile handoff in AuthContext. A successful login
 * that returns `{ firstName, lastName, birthdate }` must persist them to
 * `retivo:signup-profile:<userId>` (keyed by the userId in the access
 * token) so App.tsx's first-run effect can seed the primary HouseholdMember.
 *
 * Two security-relevant negatives are covered: a login with no profile fields
 * never writes the key, and a blocked cross-user IDB reset (which bails before
 * adopting the new claims) never writes user B's PII to localStorage.
 *
 * The API, key-envelope client, HDK cache, key-wrapping, user-transition guard,
 * and WebAuthn shims are mocked at the module boundary so only the context's
 * login orchestration is exercised.
 */

let profileCaptured: { login: (e: string, p: string) => Promise<void> };

function ProfileProbe(): React.ReactElement {
  const auth = useAuth();
  profileCaptured = { login: auth.login };
  return <span data-testid="isAuthenticated">{String(auth.isAuthenticated)}</span>;
}

/** Render the provider with the boot refresh resolving to "signed out". */
async function profileRenderAuth(): Promise<void> {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    throw new Error(`unexpected api call ${path}`);
  });
  render(
    <AuthProvider>
      <ProfileProbe />
    </AuthProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId('isAuthenticated').textContent).toBe('false'),
  );
}

/** Route boot refresh (fail) + login returning the given response fields. */
function profileWireLogin(loginResponse: Record<string, unknown>): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') return loginResponse;
    if (path === '/api/v1/auth/logout') return undefined;
    if (path === '/api/v1/auth/verify-password') return undefined;
    throw new Error(`unexpected api call ${path}`);
  });
}

describe('AuthContext — signup-profile handoff', () => {
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

  it('login with profile fields writes retivo:signup-profile:<userId> to localStorage', async () => {
    await profileRenderAuth();
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
      await profileCaptured.login('jane@test.com', 'pw');
    });

    const raw = localStorage.getItem('retivo:signup-profile:u-new');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      firstName: 'Jane',
      lastName: 'Smith',
      birthdate: '1990-04-15',
    });
  });

  it('login without profile fields does not write the signup-profile key', async () => {
    await profileRenderAuth();
    const token = jwt({ userId: 'u-new', householdId: 'hh-new' });
    profileWireLogin({ accessToken: token, expiresIn: 3600 });
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });

    await act(async () => {
      await profileCaptured.login('jane@test.com', 'pw');
    });

    expect(localStorage.getItem('retivo:signup-profile:u-new')).toBeNull();
  });

  it('blocked cross-user IDB reset does not write user B profile to localStorage', async () => {
    await profileRenderAuth();
    const bToken = jwt({ userId: 'u-b', householdId: 'hh-b' });
    // B's IDB drop fails closed → login bails before adopting B's claims.
    maybeResetForNewUser.mockRejectedValue(new Error('cross-user reset blocked'));
    profileWireLogin({
      accessToken: bToken,
      expiresIn: 3600,
      firstName: 'Eve',
      lastName: 'B',
      birthdate: '1985-07-20',
    });

    await act(async () => {
      await profileCaptured.login('b@test.com', 'pw');
    });

    // B's PII was never persisted — the login bailed at the blocked reset.
    expect(localStorage.getItem('retivo:signup-profile:u-b')).toBeNull();
  });
});
