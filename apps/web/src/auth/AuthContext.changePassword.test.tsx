// `changePassword` prepares the re-wrapped `password` slot before the request and sends it in the same
// `POST /auth/change-password` body; a failure of preparation or of the request means the change did not happen.
import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', async () => (await import('./auth-context.test-harness')).apiClientMock());
vi.mock('./key-envelope-client', async () => (await import('./auth-context.test-harness')).keyEnvelopeClientMock());
vi.mock('../crypto/key-cache', async () => (await import('./auth-context.test-harness')).keyCacheMock());
vi.mock('../crypto/key-wrapping', async () => (await import('./auth-context.test-harness')).keyWrappingMock());
vi.mock('./user-transition', async () => (await import('./auth-context.test-harness')).userTransitionMock());
vi.mock('@simplewebauthn/browser', async () => (await import('./auth-context.test-harness')).webauthnBrowserMock());
vi.mock('../crypto/passkey-prf', async () => (await import('./auth-context.test-harness')).passkeyPrfMock());

import { authMocks, captured, fakeHdk, jwt, renderAuth } from './auth-context.test-harness';
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

// Refresh fails (boot), login returns a token and verify-password succeeds; change-password is wired per test.
function wire(token: string): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') return { accessToken: token, expiresIn: 3600 };
    if (path === '/api/v1/auth/verify-password') return undefined;
    throw new Error(`unexpected api call ${path}`);
  });
}

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
    // Defaults to a confirmed (persisted) raise.
    raiseEnvelopeSetPinFloor.mockReturnValue(true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('commits the re-wrapped slot INSIDE the change-password request when unlocked and the server accepts', async () => {
    await renderAuth();
    await loginUnlocked();

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

    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    // The rollback pin advances only after the server confirms the commit: left at the old version it would let a replayed old set undo the change.
    expect(writeEnvelopeSetPin).toHaveBeenCalledWith(3, 'dev-1');
  });

  it('a household with no password slot commits the credential alone (server-confirmed no-slot exception)', async () => {
    await renderAuth();
    await loginUnlocked();

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

    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    expect(writeEnvelopeSetPin).not.toHaveBeenCalledWith(2, expect.anything());
  });

  it('a tampered/rolled-back slot set aborts the whole change before any request is sent', async () => {
    await renderAuth();
    await loginUnlocked();

    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password' }],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tampered',
    });
    verifyEnvelopeSetTag.mockReset();
    verifyEnvelopeSetTag.mockRejectedValue(new Error('envelope set tag mismatch'));

    await expect(captured.changePassword('old-pw', 'new-pw')).rejects.toThrow();

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
        // `purpose: 'change_password'` lets the server's LegalAcceptanceGuard exemption recognise this session-authority repair while legally blocked; a bare body would 428.
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

    // A successful verify-password repairs a stale or missing session write authority in place, so the commit's UPGRADE_REQUIRED only ever means a stale bundle.
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

  // Whether or not the localStorage floor persists, the outcome is the same: never a silent success.
  it.each([
    ['the floor persists', true],
    ['the floor ALSO fails to persist', false],
  ])('a post-commit rollback-pin failure where %s retries once, then fails CLOSED: locks the workspace and reports the known-committed outcome, never an unknown server outcome', async (_name, floorPersisted) => {
    raiseEnvelopeSetPinFloor.mockReturnValue(floorPersisted);
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
    // The post-commit confirm write to the committed version (3) fails persistently, like a broken IndexedDB after the server's 200.
    writeEnvelopeSetPin.mockImplementation(async (version: number) => {
      if (version === 3) throw new Error('idb broken');
    });

    // A confirmed 200 surfaces as its own error type, never the "may or may not have gone through" classification.
    await expect(captured.changePassword('old-pw', 'new-pw')).rejects.toMatchObject({
      name: 'PasswordChangeCommittedError',
    });

    expect(writeEnvelopeSetPin.mock.calls.filter((c) => c[0] === 3)).toHaveLength(2);
    // The device fails closed: with the pin trusting the predecessor, a replayed old set would not read as a rollback, so the cached HDK is dropped and the workspace locks.
    expect(clearCachedHdk).toHaveBeenCalled();
    await waitFor(() => expect(captured.isUnlocked).toBe(false));
    // The independent rollback floor was raised for the committed version, scoped to the signed-in household, so a replay of the old set is rejected here even if the metadata write never recovers.
    expect(raiseEnvelopeSetPinFloor).toHaveBeenCalledWith(3, 'hh-1');
  });
});
