// `setupEncryption` (first-time activation): the fresh-setup happy path, the partial-failure retry, meta-only residue
// recovery, the wrong-password gate and the idempotent duplicate-slot path.
import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', async () => (await import('./auth-context.test-harness')).apiClientMock());
vi.mock('./key-envelope-client', async () => (await import('./auth-context.test-harness')).keyEnvelopeClientMock());
vi.mock('../crypto/key-cache', async () => (await import('./auth-context.test-harness')).keyCacheMock());
vi.mock('../crypto/key-wrapping', async () => (await import('./auth-context.test-harness')).keyWrappingMock());
vi.mock('./user-transition', async () => (await import('./auth-context.test-harness')).userTransitionMock());
vi.mock('@simplewebauthn/browser', async () => (await import('./auth-context.test-harness')).webauthnBrowserMock());
vi.mock('../crypto/passkey-prf', async () => (await import('./auth-context.test-harness')).passkeyPrfMock());

import { authMocks, captured, fakeHdk, flag, jwt, renderAuth } from './auth-context.test-harness';
// The mocked ApiRequestError: verify-password throws it on a wrong password.
import { ApiRequestError } from '../api/client';
import { SetupStepUpRequiredError } from './useZeroKnowledgeKey';

const {
  apiRequest,
  getKeyEnvelopes,
  upsertKeyEnvelopeSlot,
  activateKeyEnvelopes,
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
  writeEnvelopeSetPin,
  raiseEnvelopeSetPinFloor,
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

describe('AuthContext — setupEncryption (first-time activation)', () => {
  beforeEach(() => {
    apiRequest.mockReset();
    getKeyEnvelopes.mockReset();
    upsertKeyEnvelopeSlot.mockReset();
    activateKeyEnvelopes.mockReset();
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
    startAuthentication.mockReset();
    startRegistration.mockReset();
    addPrfEvalToOptions.mockReset();
    derivePrfWrapKey.mockReset();
    extractPrfResult.mockReset();
    writeEnvelopeSetPin.mockReset();
    writeEnvelopeSetPin.mockResolvedValue(undefined);
    raiseEnvelopeSetPinFloor.mockReset();
    raiseEnvelopeSetPinFloor.mockReturnValue(true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function wireSetupSuccess(): void {
    generateHdk.mockResolvedValue(fakeHdk);
    generatePasswordSlot.mockResolvedValue({ slotId: 'password', slotType: 'password' });
    generateRecoverySlot.mockResolvedValue({
      slot: { slotId: 'recovery', slotType: 'recovery' },
      recoveryKey: 'ABCD-EF12-3456-7890',
    });
    computeEnvelopeSetTag.mockResolvedValue('tag');
    upsertKeyEnvelopeSlot.mockResolvedValue(undefined);
    activateKeyEnvelopes.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);
  }

  it('setupEncryption keys the household → unlocked, needsKeySetup false, HDK cached, recovery key returned', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    wireSetupSuccess();

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('needsKeySetup')).toBe('true'));

    let recoveryKey = '';
    await act(async () => {
      recoveryKey = await captured.setupEncryption('my-password');
    });

    expect(recoveryKey).toBe('ABCD-EF12-3456-7890');
    expect(flag('isUnlocked')).toBe('true');
    expect(flag('needsKeySetup')).toBe('false');
    expect(captured.getHdk()).toBe(fakeHdk);
    expect(cacheHdk).toHaveBeenCalledWith('hh-1', fakeHdk);
    // Both slots persist in one call and one version bump, never a two-PUT sequence.
    expect(activateKeyEnvelopes).toHaveBeenCalledTimes(1);
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    const activated = activateKeyEnvelopes.mock.calls[0][0] as {
      slots: Array<{ slotId: string }>;
      envelopeSetVersion: number;
    };
    expect(activated.slots.map((s) => s.slotId)).toEqual(['password', 'recovery']);
    expect(activated.envelopeSetVersion).toBe(1);
  });

  it('setupEncryption surfaces an error and stays locked when the activation call fails', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    wireSetupSuccess();
    activateKeyEnvelopes.mockRejectedValue(new Error('network'));

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('needsKeySetup')).toBe('true'));

    await expect(captured.setupEncryption('my-password')).rejects.toThrow('network');
    expect(flag('isUnlocked')).toBe('false');
    expect(flag('needsKeySetup')).toBe('true');
    expect(captured.getHdk()).toBeNull();
    expect(cacheHdk).not.toHaveBeenCalled();
  });

  // A household holding a `password` slot but no `recovery` slot finishes through the repair path, which recovers the original
  // HDK by unwrapping the existing password slot and PUTs only the missing recovery slot.
  it('setupEncryption completes a stranded household (password slot only, no recovery slot) through the repair path', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    const passwordSlot = { slotId: 'password', slotType: 'password' };
    getKeyEnvelopes.mockResolvedValue({
      slots: [passwordSlot],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    wireSetupSuccess();
    unwrapSlot.mockResolvedValue(fakeHdk);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    // A non-empty slot set never sets needsKeySetup, so wait on unlockResolved.
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));

    let recoveryKey = '';
    await act(async () => {
      recoveryKey = await captured.setupEncryption('my-password');
    });

    expect(recoveryKey).toBe('ABCD-EF12-3456-7890');
    expect(flag('isUnlocked')).toBe('true');
    expect(captured.getHdk()).toBe(fakeHdk);
    expect(cacheHdk).toHaveBeenCalledWith('hh-1', fakeHdk);
    expect(generateHdk).not.toHaveBeenCalled();
    expect(unwrapSlot).toHaveBeenCalledWith(passwordSlot, 'my-password');
    expect(activateKeyEnvelopes).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).toHaveBeenCalledTimes(1);
    expect(upsertKeyEnvelopeSlot.mock.calls[0][0]).toBe('recovery');
    expect(upsertKeyEnvelopeSlot.mock.calls[0][1].envelopeSetVersion).toBe(2);
  });

  // The repair branch maps `STEP_UP_PROOF_MISSING` to `SetupStepUpRequiredError`, exercised at the hook layer rather than through a mocked `setupEncryption`.
  it('setupEncryption maps a proofless repair PUT refusal (STEP_UP_PROOF_MISSING) to SetupStepUpRequiredError', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    const passwordSlot = { slotId: 'password', slotType: 'password' };
    getKeyEnvelopes.mockResolvedValue({
      slots: [passwordSlot],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    wireSetupSuccess();
    unwrapSlot.mockResolvedValue(fakeHdk);
    // The server refuses the repair PUT because MFA is enforced and no proof was supplied.
    upsertKeyEnvelopeSlot.mockRejectedValue(
      new ApiRequestError(400, {
        code: 'STEP_UP_PROOF_MISSING',
        message: 'A fresh factor is required.',
      }),
    );

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));

    await expect(captured.setupEncryption('my-password')).rejects.toBeInstanceOf(
      SetupStepUpRequiredError,
    );
    expect(flag('isUnlocked')).toBe('false');
  });

  it('setupEncryption forwards a supplied step-up proof on the repair PUT', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    const passwordSlot = { slotId: 'password', slotType: 'password' };
    getKeyEnvelopes.mockResolvedValue({
      slots: [passwordSlot],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    wireSetupSuccess();
    unwrapSlot.mockResolvedValue(fakeHdk);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));

    let recoveryKey = '';
    await act(async () => {
      recoveryKey = await captured.setupEncryption('my-password', {
        method: 'email_otp',
        code: '123456',
      });
    });

    expect(recoveryKey).toBe('ABCD-EF12-3456-7890');
    expect(flag('isUnlocked')).toBe('true');
    expect(upsertKeyEnvelopeSlot).toHaveBeenCalledTimes(1);
    const [slotId, body] = upsertKeyEnvelopeSlot.mock.calls[0] as [string, Record<string, unknown>];
    expect(slotId).toBe('recovery');
    expect(body.method).toBe('email_otp');
    expect(body.code).toBe('123456');
    expect(body.envelopeSetVersion).toBe(2);
  });

  // Once both slots are committed every remaining step is local and best-effort, and a retry refuses a household that already
  // holds both slots: a proofless replace of the live recovery slot is refused with STEP_UP_PROOF_MISSING on every attempt.
  it('setupEncryption still completes and returns the recovery key when the post-commit pin write keeps failing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    wireSetupSuccess();
    writeEnvelopeSetPin.mockRejectedValue(new Error('idb unavailable'));
    raiseEnvelopeSetPinFloor.mockReturnValue(false);

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('needsKeySetup')).toBe('true'));

    let recoveryKey = '';
    await act(async () => {
      recoveryKey = await captured.setupEncryption('my-password');
    });

    expect(activateKeyEnvelopes).toHaveBeenCalledTimes(1);
    expect(recoveryKey).toBe('ABCD-EF12-3456-7890');
    expect(flag('isUnlocked')).toBe('true');
    expect(flag('needsKeySetup')).toBe('false');
    expect(captured.getHdk()).toBe(fakeHdk);
    expect(writeEnvelopeSetPin).toHaveBeenCalledTimes(2);
    expect(raiseEnvelopeSetPinFloor).toHaveBeenCalledWith(1, 'hh-1');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('setupEncryption still returns the recovery key when the device key-cache write fails after activation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    wireSetupSuccess();
    cacheHdk.mockRejectedValue(new Error('quota exceeded'));

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('needsKeySetup')).toBe('true'));

    let recoveryKey = '';
    await act(async () => {
      recoveryKey = await captured.setupEncryption('my-password');
    });

    expect(recoveryKey).toBe('ABCD-EF12-3456-7890');
    expect(flag('isUnlocked')).toBe('true');
    expect(flag('needsKeySetup')).toBe('false');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('setupEncryption refuses to re-mint the recovery slot when the household already holds both slots', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    wireSetupSuccess();
    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('needsKeySetup')).toBe('true'));

    getKeyEnvelopes.mockResolvedValue({
      slots: [
        { slotId: 'password', slotType: 'password' },
        { slotId: 'recovery', slotType: 'recovery' },
      ],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });
    unwrapSlot.mockResolvedValue(fakeHdk);

    await expect(captured.setupEncryption('my-password')).rejects.toThrow(/already set up/i);
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    expect(generateRecoverySlot).not.toHaveBeenCalled();
  });

  // Meta-only residue: a prior attempt can commit the meta bump (version 1) and then fail the slot write, so a retry must
  // activate past the committed version or the atomic route rejects it as a version conflict.
  it('setupEncryption with meta-only residue (empty slots, version > 0) activates past the committed version', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 1, envelopeSetTag: 'tag' });
    wireSetupSuccess();

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('needsKeySetup')).toBe('true'));

    let recoveryKey = '';
    await act(async () => {
      recoveryKey = await captured.setupEncryption('my-password');
    });

    expect(recoveryKey).toBe('ABCD-EF12-3456-7890');
    expect(flag('isUnlocked')).toBe('true');
    expect(flag('needsKeySetup')).toBe('false');
    expect(captured.getHdk()).toBe(fakeHdk);
    expect(generateHdk).toHaveBeenCalled();
    expect(unwrapSlot).not.toHaveBeenCalled();
    expect(activateKeyEnvelopes).toHaveBeenCalledTimes(1);
    const activated = activateKeyEnvelopes.mock.calls[0][0] as {
      slots: Array<{ slotId: string }>;
      envelopeSetVersion: number;
    };
    expect(activated.slots.map((s) => s.slotId)).toEqual(['password', 'recovery']);
    expect(activated.envelopeSetVersion).toBe(2);
  });

  // A logout or user switch can land before the first slot PUT; the PUT uses the live bearer token, so setupEncryption must re-check staleness before each upsert.
  it('setupEncryption with a session switch between getKeyEnvelopes and the first PUT writes no slot', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    wireSetupSuccess();

    let envelopeFetches = 0;
    getKeyEnvelopes.mockImplementation(async () => {
      envelopeFetches += 1;
      if (envelopeFetches >= 2) await captured.logout();
      return { slots: [], envelopeSetVersion: 0, envelopeSetTag: '' };
    });

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('needsKeySetup')).toBe('true'));

    await expect(captured.setupEncryption('my-password')).rejects.toThrow(/session ended/i);
    expect(activateKeyEnvelopes).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    expect(cacheHdk).not.toHaveBeenCalled();
    expect(flag('isUnlocked')).toBe('false');
  });

  // The entered password must be verified against the account credential before it wraps the HDK, or the account password could never unwrap it.
  it('setupEncryption with a wrong password throws and creates no envelope slot', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    wireSetupSuccess();
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      if (path === '/api/v1/auth/verify-password') {
        throw new ApiRequestError(401, {
          code: 'INVALID_CREDENTIALS',
          message: 'Current password is incorrect.',
        });
      }
      if (path === '/api/v1/auth/logout') return undefined;
      throw new Error(`unexpected api call ${path}`);
    });

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('needsKeySetup')).toBe('true'));

    await expect(captured.setupEncryption('wrong-password')).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    expect(activateKeyEnvelopes).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    expect(generateHdk).not.toHaveBeenCalled();
    expect(flag('isUnlocked')).toBe('false');
    expect(flag('needsKeySetup')).toBe('true');
    expect(captured.getHdk()).toBeNull();
    expect(cacheHdk).not.toHaveBeenCalled();
  });
});
