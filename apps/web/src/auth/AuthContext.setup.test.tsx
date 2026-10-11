/**
 * Tests for first-time encryption activation in AuthContext:
 * `setupEncryption` — the fresh-setup happy path, the partial-failure retry,
 * the meta-only residue recovery, the wrong-password
 * gate, and the idempotent duplicate-slot path. The API, the
 * key-envelope client, the HDK cache, and the key-wrapping primitives are
 * mocked at the module boundary so the test exercises only the context's setup
 * orchestration. Split out of AuthContext.unlock.test.tsx to keep each file
 * under the 800-line cap; the unlock/PRF/cache lifecycle lives there.
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
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
// The mocked ApiRequestError — verify-password throws this on a wrong password.
import { ApiRequestError } from '../api/client';
import { SetupStepUpRequiredError } from './useZeroKnowledgeKey';
import type { StepUpProof } from '../components/useStepUp';

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

// --- Helpers ----------------------------------------------------------------

/** Snapshot of the reactive unlock flags, exposed for assertions. */
let captured: {
  login: (e: string, p: string) => Promise<void>;
  logout: () => Promise<void>;
  setupEncryption: (p: string, proof?: StepUpProof) => Promise<string>;
  isUnlocked: boolean;
  needsKeySetup: boolean;
  unlockResolved: boolean;
  isAuthenticated: boolean;
  getHdk: () => CryptoKey | null;
};

function Probe(): React.ReactElement {
  const auth = useAuth();
  captured = {
    login: auth.login,
    logout: auth.logout,
    setupEncryption: auth.setupEncryption,
    isUnlocked: auth.isUnlocked,
    needsKeySetup: auth.needsKeySetup,
    unlockResolved: auth.unlockResolved,
    isAuthenticated: auth.isAuthenticated,
    getHdk: auth.getHdk,
  };
  return (
    <div>
      <span data-testid="isUnlocked">{String(auth.isUnlocked)}</span>
      <span data-testid="needsKeySetup">{String(auth.needsKeySetup)}</span>
      <span data-testid="unlockResolved">{String(auth.unlockResolved)}</span>
      <span data-testid="isAuthenticated">{String(auth.isAuthenticated)}</span>
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

  /** Wire the happy-path setup primitives (HDK gen, slot wraps, tag, PUTs). */
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
    // Empty slot set after login → needsKeySetup true.
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
    // Both slots persisted atomically, one call, one version bump
    // — never a two-PUT sequence.
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
    // Atomic — a failed activation leaves state unchanged (there is no
    // half-committed state the way a two-PUT sequence could leave behind).
    expect(flag('isUnlocked')).toBe('false');
    expect(flag('needsKeySetup')).toBe('true');
    expect(captured.getHdk()).toBeNull();
    expect(cacheHdk).not.toHaveBeenCalled();
  });

  // Stranded household: a household already
  // holding a `password` slot but no `recovery` slot — an interrupted
  // pre-cutover activation, or any other cause — finishes through the repair
  // completion path, which recovers the ORIGINAL HDK by unwrapping the
  // existing password slot and PUTs only the missing recovery slot. Since
  // activation is now atomic, this state can no longer arise from a partial
  // failure of THIS client's own two-PUT write — the repair path stays
  // reachable regardless of how the household got here.
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
    unwrapSlot.mockResolvedValue(fakeHdk); // unwrap the existing password slot → original HDK

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    // A non-empty slot set never sets needsKeySetup (that flag only fires on a
    // genuinely empty set) — wait on the flag this scenario actually reaches.
    await waitFor(() => expect(flag('unlockResolved')).toBe('true'));

    let recoveryKey = '';
    await act(async () => {
      recoveryKey = await captured.setupEncryption('my-password');
    });

    // Repair completed: recovery key returned, unlocked, HDK cached.
    expect(recoveryKey).toBe('ABCD-EF12-3456-7890');
    expect(flag('isUnlocked')).toBe('true');
    expect(captured.getHdk()).toBe(fakeHdk);
    expect(cacheHdk).toHaveBeenCalledWith('hh-1', fakeHdk);
    // No fresh HDK — the existing password slot was unwrapped, not regenerated.
    expect(generateHdk).not.toHaveBeenCalled();
    expect(unwrapSlot).toHaveBeenCalledWith(passwordSlot, 'my-password');
    // Only the missing recovery slot was PUT (never the atomic activation
    // route — this household already holds a slot), at the next version (2).
    expect(activateKeyEnvelopes).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).toHaveBeenCalledTimes(1);
    expect(upsertKeyEnvelopeSlot.mock.calls[0][0]).toBe('recovery');
    expect(upsertKeyEnvelopeSlot.mock.calls[0][1].envelopeSetVersion).toBe(2);
  });

  // The repair branch's `STEP_UP_PROOF_MISSING` →
  // `SetupStepUpRequiredError` mapping (and its proof-forwarding sibling
  // below) exercised at the hook layer, not just re-asserted through a
  // hand-mocked `setupEncryption` in `LoginPage.test.tsx`.
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
    // The server refuses the missing-recovery-slot repair PUT because MFA is
    // enforced and no proof was supplied.
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
    // No partial completion — still locked, no key ever handed to the caller.
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

    // A stranded household on Email-OTP alone completes with the proof
    // riding alongside the slot in the PUT body.
    expect(recoveryKey).toBe('ABCD-EF12-3456-7890');
    expect(flag('isUnlocked')).toBe('true');
    expect(upsertKeyEnvelopeSlot).toHaveBeenCalledTimes(1);
    const [slotId, body] = upsertKeyEnvelopeSlot.mock.calls[0] as [string, Record<string, unknown>];
    expect(slotId).toBe('recovery');
    expect(body.method).toBe('email_otp');
    expect(body.code).toBe('123456');
    expect(body.envelopeSetVersion).toBe(2);
  });

  // Once BOTH slots are
  // committed, every remaining step is local. A failure there used to reject
  // setup with `needsKeySetup` still true, and the retry then re-minted the
  // `recovery` slot proofless — a replace of live key material the server
  // refuses with 400 STEP_UP_PROOF_MISSING on every attempt when MFA is
  // enforced, with no factor step in the setup form to collect one. Two
  // things close that: the post-commit steps are best-effort (the key is
  // always returned), and the retry path refuses a household that already
  // holds both slots instead of sending the doomed PUT.
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

    // The atomic activation committed → the one-time key reaches the caller
    // regardless.
    expect(activateKeyEnvelopes).toHaveBeenCalledTimes(1);
    expect(recoveryKey).toBe('ABCD-EF12-3456-7890');
    expect(flag('isUnlocked')).toBe('true');
    expect(flag('needsKeySetup')).toBe('false');
    expect(captured.getHdk()).toBe(fakeHdk);
    // Retried once, then fell back to the household-scoped floor — at the
    // single version this activation wrote (1, not 2 — one bump, not two).
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
    // This tab's login saw no slots (needsKeySetup) …
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    wireSetupSuccess();
    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(flag('needsKeySetup')).toBe('true'));

    // … but by submit time another tab completed setup: both slots are live.
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
    // No proofless replace of the live recovery slot was ever attempted, and
    // nothing new was minted against it.
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    expect(generateRecoverySlot).not.toHaveBeenCalled();
  });

  // Meta-only residue. The meta-first ordering means a prior attempt
  // can commit the envelope-set meta bump (version → 1) and then fail the slot
  // write, leaving the server at `{ slots: [], envelopeSetVersion: 1 }`. A
  // retry sees an empty LIVE slot set (fresh-activation path) but must
  // activate past the already-committed version — never re-using v1 — or the
  // atomic route's own meta condition rejects it as a version conflict.
  it('setupEncryption with meta-only residue (empty slots, version > 0) activates past the committed version', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    // Server reports the meta-only residue: no slots, but the version already
    // advanced to 1 from the prior failed attempt's committed meta bump.
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
    // Fresh HDK (no existing password slot to recover from), activated in one
    // call past the committed version: version 2 — never re-using v1.
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

  // A logout / user switch can land after getKeyEnvelopes returns but
  // before the first slot PUT. The PUT uses the live bearer token, so writing
  // then would land this setup material in a different session's envelope set.
  // setupEncryption must re-check staleness right before each upsert and bail.
  it('setupEncryption with a session switch between getKeyEnvelopes and the first PUT writes no slot', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    wireSetupSuccess();

    // Login-time fetch sees an empty set → needsKeySetup. The setup-time fetch
    // (the 2nd call) resolves the same empty set BUT first switches the session
    // out from under us (logout nulls claimsRef) so the staleness guard trips
    // before the first slot PUT.
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
    // The guard fired before any write: no envelope slot was persisted into the
    // now-different session, and no HDK was cached.
    expect(activateKeyEnvelopes).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    expect(cacheHdk).not.toHaveBeenCalled();
    expect(flag('isUnlocked')).toBe('false');
  });

  // setupEncryption must verify the entered password against the account
  // credential BEFORE wrapping the HDK with it. A wrong password surfaces inline
  // and creates NO envelope slot (else the account password could never unwrap it).
  it('setupEncryption with a wrong password throws and creates no envelope slot', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
    wireSetupSuccess();
    // verify-password rejects → the entered password is not the account password.
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
    // No slot created, no HDK generated, state unchanged.
    expect(activateKeyEnvelopes).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    expect(generateHdk).not.toHaveBeenCalled();
    expect(flag('isUnlocked')).toBe('false');
    expect(flag('needsKeySetup')).toBe('true');
    expect(captured.getHdk()).toBeNull();
    expect(cacheHdk).not.toHaveBeenCalled();
  });
});
