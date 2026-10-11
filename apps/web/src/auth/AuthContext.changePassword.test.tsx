/**
 * Tests for the atomic password change.
 * `changePassword` prepares the re-wrapped `password` slot BEFORE the
 * request — it travels IN the `POST /auth/change-password` body so the
 * server commits the credential and the key together, or (a recovery-only
 * household) commits the credential alone. Offered only on an unlocked
 * workspace. The former swallow-and-complete behaviour is GONE: a failure of
 * preparation or of the request now means the change did not happen. The
 * API, the key-envelope client, the HDK cache, and the key-wrapping
 * primitives are mocked at the module boundary so the test exercises only
 * the context's orchestration.
 */
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', async () => (await import('./auth-context.test-harness')).apiClientMock());
vi.mock('./key-envelope-client', async () => (await import('./auth-context.test-harness')).keyEnvelopeClientMock());
vi.mock('../crypto/key-cache', async () => (await import('./auth-context.test-harness')).keyCacheMock());
vi.mock('../crypto/key-wrapping', async () => (await import('./auth-context.test-harness')).keyWrappingMock());
vi.mock('./user-transition', async () => (await import('./auth-context.test-harness')).userTransitionMock());
vi.mock('@simplewebauthn/browser', async () => (await import('./auth-context.test-harness')).webauthnBrowserMock());
vi.mock('../crypto/passkey-prf', async () => (await import('./auth-context.test-harness')).passkeyPrfMock());

import { AuthProvider, useAuth } from './AuthContext';
import { authMocks, jwt, fakeHdk } from './auth-context.test-harness';
import { ApiRequestError } from '../api/client';

const {
  apiRequest,
  getKeyEnvelopes,
  upsertKeyEnvelopeSlot,
  loadCachedHdk,
  cacheHdk,
  clearCachedHdk,
  unwrapSlot,
  verifyEnvelopeSetTag,
  generatePasswordSlot,
  computeEnvelopeSetTag,
  writeEnvelopeSetPin,
  raiseEnvelopeSetPinFloor,
} = authMocks;

// --- Helpers ----------------------------------------------------------------

let captured: {
  login: (e: string, p: string) => Promise<void>;
  changePassword: (cur: string, next: string) => Promise<void>;
  getHdk: () => CryptoKey | null;
  isUnlocked: boolean;
  needsKeySetup: boolean;
  isAuthenticated: boolean;
  unlockResolved: boolean;
};

function Probe(): React.ReactElement {
  const auth = useAuth();
  captured = {
    login: auth.login,
    changePassword: auth.changePassword,
    getHdk: auth.getHdk,
    isUnlocked: auth.isUnlocked,
    needsKeySetup: auth.needsKeySetup,
    isAuthenticated: auth.isAuthenticated,
    unlockResolved: auth.unlockResolved,
  };
  return <div data-testid="isUnlocked">{String(auth.isUnlocked)}</div>;
}

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
  await waitFor(() => expect(captured.isAuthenticated).toBe(false));
}

/** Route api calls: refresh fails (boot), login returns a token; verify-password
 * (the in-place session write-authority grant `changePassword` runs before the
 * commit) succeeds; change-password is wired per-test via
 * `apiRequest.mockImplementation` overrides. */
function wire(token: string): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') return { accessToken: token, expiresIn: 3600 };
    if (path === '/api/v1/auth/verify-password') return undefined;
    throw new Error(`unexpected api call ${path}`);
  });
}

/** Log in with a device-cached HDK that verifies → session unlocked, HDK held. */
async function loginUnlocked(): Promise<void> {
  wire(jwt({ userId: 'u1', householdId: 'hh-1' }));
  loadCachedHdk.mockResolvedValue(fakeHdk);
  getKeyEnvelopes.mockResolvedValue({
    slots: [{ slotType: 'password', slotId: 'password' }, { slotType: 'recovery', slotId: 'recovery' }],
    envelopeSetVersion: 2,
    envelopeSetTag: 'tag',
  });
  verifyEnvelopeSetTag.mockResolvedValue(undefined);
  await act(async () => {
    await captured.login('u@test.com', 'pw');
  });
  await waitFor(() => expect(captured.isUnlocked).toBe(true));
}

/** Log in with no cached key and a slot set → authenticated but locked (no HDK). */
async function loginLocked(): Promise<void> {
  wire(jwt({ userId: 'u1', householdId: 'hh-1' }));
  loadCachedHdk.mockResolvedValue(null);
  getKeyEnvelopes.mockResolvedValue({
    slots: [{ slotType: 'password', slotId: 'password' }],
    envelopeSetVersion: 1,
    envelopeSetTag: 'tag',
  });
  await act(async () => {
    await captured.login('u@test.com', 'pw');
  });
  await waitFor(() => expect(captured.unlockResolved).toBe(true));
  expect(captured.isUnlocked).toBe(false);
}

describe('AuthContext — atomic password change', () => {
  beforeEach(() => {
    apiRequest.mockReset();
    getKeyEnvelopes.mockReset();
    upsertKeyEnvelopeSlot.mockReset();
    loadCachedHdk.mockReset();
    cacheHdk.mockReset();
    clearCachedHdk.mockReset();
    unwrapSlot.mockReset();
    verifyEnvelopeSetTag.mockReset();
    generatePasswordSlot.mockReset();
    computeEnvelopeSetTag.mockReset();
    writeEnvelopeSetPin.mockReset();
    writeEnvelopeSetPin.mockResolvedValue(undefined);
    raiseEnvelopeSetPinFloor.mockReset();
    // Defaults to a confirmed (persisted) raise; the persistence-failure
    // path is exercised by its own test below, which
    // overrides this to `false`.
    raiseEnvelopeSetPinFloor.mockReturnValue(true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('commits the re-wrapped slot INSIDE the change-password request when unlocked and the server accepts', async () => {
    await renderAuth();
    await loginUnlocked();

    // The prepare step re-fetches the slot set, then re-wraps.
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password' }, { slotType: 'recovery', slotId: 'recovery' }],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });
    const newSlot = { slotType: 'password', slotId: 'password', wrappedKey: 'new' };
    generatePasswordSlot.mockResolvedValue(newSlot);
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    apiRequest.mockImplementation(async (path: string, opts?: { body?: Record<string, unknown> }) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/verify-password') return undefined;
      if (path === '/api/v1/auth/change-password') {
        // The re-wrapped slot rides IN this one request — no separate PUT.
        expect(opts?.body).toMatchObject({
          currentPassword: 'old-pw',
          newPassword: 'new-pw',
          slot: newSlot,
          envelopeSetVersion: 3,
          expectedEnvelopeSetVersion: 2,
          envelopeSetTag: 'new-tag',
        });
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.changePassword('old-pw', 'new-pw');
    });

    // No separate best-effort PUT — the swallow-and-complete client rotate
    // path is gone from this flow.
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    // Rollback-pin advanced to the just-written set version ONLY after the
    // server confirmed the commit: leaving the pin at the old version 2
    // would let a replayed old set silently undo the change.
    expect(writeEnvelopeSetPin).toHaveBeenCalledWith(3, 'dev-1');
  });

  it('a household with no password slot commits the credential alone (server-confirmed no-slot exception)', async () => {
    await renderAuth();
    await loginUnlocked();

    // No password slot — a recovery-only household.
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'recovery', slotId: 'recovery' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });

    apiRequest.mockImplementation(async (path: string, opts?: { body?: Record<string, unknown> }) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/verify-password') return undefined;
      if (path === '/api/v1/auth/change-password') {
        expect(opts?.body).toEqual({ currentPassword: 'old-pw', newPassword: 'new-pw' });
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    writeEnvelopeSetPin.mockClear();
    await act(async () => {
      await captured.changePassword('old-pw', 'new-pw');
    });

    expect(generatePasswordSlot).not.toHaveBeenCalled();
    expect(writeEnvelopeSetPin).not.toHaveBeenCalled();
  });

  it('refuses to change the password while the workspace is locked', async () => {
    await renderAuth();
    await loginLocked();
    expect(captured.getHdk()).toBeNull();

    getKeyEnvelopes.mockClear();

    await expect(captured.changePassword('old-pw', 'new-pw')).rejects.toThrow();

    expect(getKeyEnvelopes).not.toHaveBeenCalled();
    expect(apiRequest).not.toHaveBeenCalledWith(
      '/api/v1/auth/change-password',
      expect.anything(),
    );
  });

  it('a rejected commit surfaces an error, the rollback pin stays at the old version, and no separate write happens (INVERTS the former swallow-and-complete behaviour)', async () => {
    await renderAuth();
    await loginUnlocked();

    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    generatePasswordSlot.mockResolvedValue({ slotType: 'password', slotId: 'password' });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/verify-password') return undefined;
      if (path === '/api/v1/auth/change-password') {
        throw new ApiRequestError(409, {
          code: 'STALE_ENVELOPE_VERSION',
          message: 'Envelope-set version is stale or non-monotonic.',
        });
      }
      throw new Error(`unexpected api call ${path}`);
    });

    writeEnvelopeSetPin.mockClear();
    await expect(captured.changePassword('old-pw', 'new-pw')).rejects.toThrow();

    // The change did not happen: no separate PUT, and the pin was never
    // advanced to the version this rejected attempt would have written (2).
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    expect(writeEnvelopeSetPin).not.toHaveBeenCalledWith(2, expect.anything());
  });

  it('a tampered/rolled-back slot set aborts the whole change before any request is sent', async () => {
    await renderAuth();
    await loginUnlocked();

    // The prepare step re-fetches the slot set. A tampered set (slot
    // stripped/reordered/injected) fails verifyEnvelopeSetTag against the
    // in-memory HDK — the change must not proceed.
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password' }],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tampered',
    });
    verifyEnvelopeSetTag.mockReset();
    verifyEnvelopeSetTag.mockRejectedValue(new Error('envelope set tag mismatch'));

    await expect(captured.changePassword('old-pw', 'new-pw')).rejects.toThrow();

    // Tamper detected before any re-wrap or request: no new slot generated,
    // no change-password call at all (the change did not happen).
    expect(generatePasswordSlot).not.toHaveBeenCalled();
    expect(apiRequest).not.toHaveBeenCalledWith(
      '/api/v1/auth/change-password',
      expect.anything(),
    );
  });

  it('verifies the current password INTO the session before the commit — the in-place write-authority grant, so stale/missing session authority is repaired rather than looping on a reload prompt', async () => {
    await renderAuth();
    await loginUnlocked();

    const calls: string[] = [];
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password' }],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });
    generatePasswordSlot.mockResolvedValue({ slotType: 'password', slotId: 'password' });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    apiRequest.mockImplementation(async (path: string, opts?: { body?: Record<string, unknown> }) => {
      calls.push(path);
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/verify-password') {
        // `purpose: 'change_password'`: required so
        // the server's LegalAcceptanceGuard exemption recognizes this
        // session-authority-repair call while legally blocked — a bare body
        // is not exempt and would 428 before change-password is ever sent.
        expect(opts?.body).toEqual({ currentPassword: 'old-pw', purpose: 'change_password' });
        return undefined;
      }
      if (path === '/api/v1/auth/change-password') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.changePassword('old-pw', 'new-pw');
    });

    // A successful `POST /auth/verify-password` stamps the session row's
    // recorded write authority in place, so a session whose revision is
    // stale or missing (a passwordless-passkey sign-in, a pre-rollout chain
    // that never carried one, one superseded by a reset) reaches the commit
    // repaired — the server's UPGRADE_REQUIRED answer then only ever means
    // a stale bundle, which the reload prompt can actually fix.
    const verifyIdx = calls.indexOf('/api/v1/auth/verify-password');
    const changeIdx = calls.indexOf('/api/v1/auth/change-password');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(changeIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(changeIdx);
  });

  it('a failed password verification aborts before the change request is ever sent (not-sent)', async () => {
    await renderAuth();
    await loginUnlocked();

    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/verify-password') {
        throw new ApiRequestError(401, {
          code: 'INVALID_CREDENTIALS',
          message: 'Current password is incorrect.',
        });
      }
      throw new Error(`unexpected api call ${path}`);
    });

    await expect(captured.changePassword('wrong-pw', 'new-pw')).rejects.toMatchObject({
      name: 'PasswordChangeNotSentError',
      message: 'Current password is incorrect.',
    });
    expect(apiRequest).not.toHaveBeenCalledWith(
      '/api/v1/auth/change-password',
      expect.anything(),
    );
  });

  it('a post-commit rollback-pin failure retries once, then fails CLOSED: locks the workspace and reports the known-committed outcome, never an unknown server outcome', async () => {
    await renderAuth();
    await loginUnlocked();

    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password' }],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });
    generatePasswordSlot.mockResolvedValue({ slotType: 'password', slotId: 'password', wrappedKey: 'new' });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/verify-password') return undefined;
      if (path === '/api/v1/auth/change-password') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });
    // The pre-flight verify pins the OLD version (2) fine; the post-commit
    // confirm write to the version this change committed (3) fails
    // persistently — a broken IndexedDB after the server's 200.
    writeEnvelopeSetPin.mockImplementation(async (version: number) => {
      if (version === 3) throw new Error('idb broken');
    });

    // The known-success outcome surfaces as its own error type — never the
    // "may or may not have gone through" classification for a confirmed 200.
    await expect(captured.changePassword('old-pw', 'new-pw')).rejects.toMatchObject({
      name: 'PasswordChangeCommittedError',
    });

    // The pin write was retried once (two attempts at the committed version)…
    expect(writeEnvelopeSetPin.mock.calls.filter((c) => c[0] === 3)).toHaveLength(2);
    // …then the device failed closed: with the pin still trusting the
    // predecessor version, a replayed old envelope set would not read as a
    // rollback — so the cached HDK is dropped and the workspace locks until
    // a fresh unlock re-verifies and re-pins the served set.
    expect(clearCachedHdk).toHaveBeenCalled();
    await waitFor(() => expect(captured.isUnlocked).toBe(false));
    // Even though the durable deviceMetadata pin write never landed, the
    // independent rollback floor was durably raised to the committed version
    // — a later replay of the still-valid old (v2) set
    // is rejected on THIS device regardless of whether the metadata write
    // ever recovers, not merely blocked by the current session being locked.
    // Scoped to the signed-in household so the floor
    // can never leak into a different household's pin on the same device.
    expect(raiseEnvelopeSetPinFloor).toHaveBeenCalledWith(3, 'hh-1');
  });

  it('a post-commit rollback-pin failure that ALSO fails to persist the localStorage floor still fails closed, never as though the floor were raised', async () => {
    await renderAuth();
    await loginUnlocked();

    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password' }],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });
    generatePasswordSlot.mockResolvedValue({ slotType: 'password', slotId: 'password', wrappedKey: 'new' });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/verify-password') return undefined;
      if (path === '/api/v1/auth/change-password') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });
    // Both the durable deviceMetadata write AND the localStorage fallback
    // fail to persist — the write "succeeds" from the caller's point of view
    // (no throw) but the read-back verification reports it never landed.
    writeEnvelopeSetPin.mockImplementation(async (version: number) => {
      if (version === 3) throw new Error('idb broken');
    });
    raiseEnvelopeSetPinFloor.mockReturnValue(false);

    // Still fails closed with the known-committed classification — a total
    // persistence failure must never be treated as though the floor were
    // durably raised, and must never resolve as a silent success.
    await expect(captured.changePassword('old-pw', 'new-pw')).rejects.toMatchObject({
      name: 'PasswordChangeCommittedError',
    });

    expect(raiseEnvelopeSetPinFloor).toHaveBeenCalledWith(3, 'hh-1');
    expect(clearCachedHdk).toHaveBeenCalled();
    await waitFor(() => expect(captured.isUnlocked).toBe(false));
  });
});
