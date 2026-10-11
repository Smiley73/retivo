/**
 * Tests for `regenerateRecoveryKey` in AuthContext. The
 * recovery-key card lets a signed-in user mint a fresh recovery key after
 * proving the current account password.
 *
 * The flow is **prepare-then-commit**: the call re-authenticates by unwrapping
 * the `password` slot with the entered password (a wrong password throws before
 * anything is minted), verifies the envelope set against tamper/rollback, mints
 * a fresh `recovery` slot + key, and returns `{ recoveryKey, activate }` —
 * WITHOUT persisting anything. Nothing changes server-side until the user
 * confirms they've saved the key and the caller invokes `activate()`, which
 * re-fetches the set, re-verifies, PUTs the rotated slot at the next monotonic
 * version, and advances the rollback pin. Cancelling (never calling `activate`)
 * leaves the previous recovery key fully in force.
 *
 * Like the rest of the write surface (and unlike best-effort
 * `rotatePasswordSlot`), every failure — wrong password, tamper/rollback, PUT
 * failure — surfaces rather than being swallowed. The API, key-envelope client,
 * HDK cache, and key-wrapping primitives are mocked at the module boundary so
 * the test exercises only the orchestration.
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
import type { StepUpProof } from '../components/useStepUp';

const {
  apiRequest,
  getKeyEnvelopes,
  upsertKeyEnvelopeSlot,
  loadCachedHdk,
  cacheHdk,
  clearCachedHdk,
  unwrapSlot,
  verifyEnvelopeSetTag,
  generateRecoverySlot,
  computeEnvelopeSetTag,
  writeEnvelopeSetPin,
} = authMocks;

// --- Helpers ----------------------------------------------------------------

type Proof = StepUpProof;

let captured: {
  login: (e: string, p: string) => Promise<void>;
  regenerateRecoveryKey: (
    password: string,
  ) => Promise<{ recoveryKey: string; activate: (proof?: Proof) => Promise<void> }>;
  isUnlocked: boolean;
  isAuthenticated: boolean;
};

function Probe(): React.ReactElement {
  const auth = useAuth();
  captured = {
    login: auth.login,
    regenerateRecoveryKey: auth.regenerateRecoveryKey,
    isUnlocked: auth.isUnlocked,
    isAuthenticated: auth.isAuthenticated,
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

function wire(token: string): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') return { accessToken: token, expiresIn: 3600 };
    throw new Error(`unexpected api call ${path}`);
  });
}

/** Log in with a device-cached HDK that verifies → session unlocked, HDK held. */
async function loginUnlocked(): Promise<void> {
  wire(jwt({ userId: 'u1', householdId: 'hh-1' }));
  loadCachedHdk.mockResolvedValue(fakeHdk);
  getKeyEnvelopes.mockResolvedValue({
    slots: [
      { slotType: 'password', slotId: 'password' },
      { slotType: 'recovery', slotId: 'recovery' },
    ],
    envelopeSetVersion: 2,
    envelopeSetTag: 'tag',
  });
  verifyEnvelopeSetTag.mockResolvedValue(undefined);
  await act(async () => {
    await captured.login('u@test.com', 'pw');
  });
  await waitFor(() => expect(captured.isUnlocked).toBe(true));
}

describe('AuthContext — regenerateRecoveryKey', () => {
  beforeEach(() => {
    apiRequest.mockReset();
    getKeyEnvelopes.mockReset();
    upsertKeyEnvelopeSlot.mockReset();
    loadCachedHdk.mockReset();
    cacheHdk.mockReset();
    clearCachedHdk.mockReset();
    unwrapSlot.mockReset();
    verifyEnvelopeSetTag.mockReset();
    generateRecoverySlot.mockReset();
    computeEnvelopeSetTag.mockReset();
    writeEnvelopeSetPin.mockReset();
    writeEnvelopeSetPin.mockResolvedValue(undefined);
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prepares a fresh key without persisting; activate() rotates at version+1 and advances the pin', async () => {
    await renderAuth();
    await loginUnlocked();

    // The regenerate path re-fetches the slot set, re-auths by unwrapping the
    // password slot with the entered password, then mints a fresh recovery slot.
    getKeyEnvelopes.mockResolvedValue({
      slots: [
        { slotType: 'password', slotId: 'password' },
        { slotType: 'recovery', slotId: 'recovery' },
      ],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });
    unwrapSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    const newSlot = { slotType: 'recovery', slotId: 'recovery', wrappedKey: 'fresh' };
    generateRecoverySlot.mockResolvedValue({
      slot: newSlot,
      recoveryKey: 'ABCD-EF01-2345-6789',
    });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    upsertKeyEnvelopeSlot.mockResolvedValue(undefined);

    // --- Prepare phase ------------------------------------------------------
    let pending: { recoveryKey: string; activate: () => Promise<void> } | undefined;
    await act(async () => {
      pending = await captured.regenerateRecoveryKey('account-pw');
    });

    // Re-auth: the entered password unwraps the password slot (proves it + yields
    // the canonical HDK to re-wrap).
    expect(unwrapSlot).toHaveBeenCalledWith(
      { slotType: 'password', slotId: 'password' },
      'account-pw',
    );
    // Fresh recovery slot wraps the SAME HDK under the existing recovery slotId.
    expect(generateRecoverySlot).toHaveBeenCalledWith('hh-1', 'recovery', fakeHdk);
    // The caller receives the new grouped recovery-key display string to show once.
    expect(pending?.recoveryKey).toBe('ABCD-EF01-2345-6789');
    // PREPARE MUST NOT PERSIST: until the user confirms via activate(), nothing is
    // tagged or written and the rollback pin is NOT advanced past the verified
    // version. So the previous recovery key stays fully in force on cancel.
    expect(computeEnvelopeSetTag).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    expect(writeEnvelopeSetPin.mock.calls.at(-1)).toEqual([2, 'dev-1']);

    // --- Commit phase (user confirmed) -------------------------------------
    await act(async () => {
      await pending!.activate();
    });

    // Tag over the full next slot set: the unchanged password slot + the fresh
    // recovery slot, at the next monotonic version.
    expect(computeEnvelopeSetTag).toHaveBeenCalledWith(
      [{ slotType: 'password', slotId: 'password' }, newSlot],
      3,
      fakeHdk,
    );
    expect(upsertKeyEnvelopeSlot).toHaveBeenCalledWith('recovery', {
      slot: newSlot,
      envelopeSetVersion: 3,
      envelopeSetTag: 'new-tag',
    });
    // Rollback pin advanced to the just-written version: leaving it at 2
    // would let a server replay the old set and silently restore the old key.
    expect(writeEnvelopeSetPin.mock.calls.at(-1)).toEqual([3, 'dev-1']);
  });

  // Activation always
  // REPLACES the live `recovery` slot, which the server refuses without a
  // fresh second factor when `AUTH_MFA_ENFORCED` is on. The proof the card
  // collects must reach the PUT body as the `stepUpProofFields` wire shape —
  // `method` + `code` for the code factors, `method` + `response` (no `code`)
  // for a passkey — or the deployed flow dead-ends on STEP_UP_PROOF_MISSING.
  it('activate(proof) carries the collected step-up factor on the recovery-slot PUT body', async () => {
    await renderAuth();
    await loginUnlocked();

    getKeyEnvelopes.mockResolvedValue({
      slots: [
        { slotType: 'password', slotId: 'password' },
        { slotType: 'recovery', slotId: 'recovery' },
      ],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });
    unwrapSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    const newSlot = { slotType: 'recovery', slotId: 'recovery', wrappedKey: 'fresh' };
    generateRecoverySlot.mockResolvedValue({ slot: newSlot, recoveryKey: 'ABCD-EF01-2345-6789' });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    upsertKeyEnvelopeSlot.mockResolvedValue(undefined);

    // A code factor: `method` + `code`, nothing else added to the body.
    let pending!: { recoveryKey: string; activate: (proof?: Proof) => Promise<void> };
    await act(async () => {
      pending = await captured.regenerateRecoveryKey('account-pw');
      await pending.activate({ method: 'totp', code: '123456' });
    });
    expect(upsertKeyEnvelopeSlot).toHaveBeenLastCalledWith('recovery', {
      slot: newSlot,
      envelopeSetVersion: 3,
      envelopeSetTag: 'new-tag',
      method: 'totp',
      code: '123456',
    });
    expect('response' in (upsertKeyEnvelopeSlot.mock.calls.at(-1)![1] as object)).toBe(false);

    // A passkey factor: `method` + `response`, and NO `code` key rides along
    // (the server DTO's XOR rejects a `code` beside a passkey `response`).
    const assertion = { id: 'cred-1', type: 'public-key' } as unknown as NonNullable<
      StepUpProof['response']
    >;
    await act(async () => {
      pending = await captured.regenerateRecoveryKey('account-pw');
      await pending.activate({ method: 'passkey', response: assertion });
    });
    const body = upsertKeyEnvelopeSlot.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(body.method).toBe('passkey');
    expect(body.response).toBe(assertion);
    expect('code' in body).toBe(false);

    // No proof (flag-off floor): the body carries no step-up fields at all.
    await act(async () => {
      pending = await captured.regenerateRecoveryKey('account-pw');
      await pending.activate();
    });
    const bare = upsertKeyEnvelopeSlot.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect('method' in bare).toBe(false);
    expect('code' in bare).toBe(false);
    expect('response' in bare).toBe(false);
  });

  it('throws on a wrong password and mints nothing (re-auth fails closed)', async () => {
    await renderAuth();
    await loginUnlocked();

    getKeyEnvelopes.mockResolvedValue({
      slots: [
        { slotType: 'password', slotId: 'password' },
        { slotType: 'recovery', slotId: 'recovery' },
      ],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });
    // A wrong password fails to unwrap the password slot (KeyWrappingError).
    unwrapSlot.mockRejectedValue(new Error('wrong password'));

    let threw = false;
    await act(async () => {
      try {
        await captured.regenerateRecoveryKey('wrong-pw');
      } catch {
        threw = true;
      }
    });

    // Surfaced (NOT best-effort) and nothing minted/persisted against a bad password.
    expect(threw).toBe(true);
    expect(generateRecoverySlot).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
  });

  it('throws and mints nothing when the slot set fails the envelope-set tag (tamper/rollback)', async () => {
    await renderAuth();
    await loginUnlocked();

    getKeyEnvelopes.mockResolvedValue({
      slots: [
        { slotType: 'password', slotId: 'password' },
        { slotType: 'recovery', slotId: 'recovery' },
      ],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tampered',
    });
    unwrapSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockReset();
    verifyEnvelopeSetTag.mockRejectedValue(new Error('envelope set tag mismatch'));

    let threw = false;
    await act(async () => {
      try {
        await captured.regenerateRecoveryKey('account-pw');
      } catch {
        threw = true;
      }
    });

    // Tamper detected before any re-wrap: the rotation never blesses the set.
    expect(threw).toBe(true);
    expect(generateRecoverySlot).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
  });

  it('surfaces a key-envelope PUT failure from activate() (NOT best-effort, unlike rotatePasswordSlot)', async () => {
    await renderAuth();
    await loginUnlocked();

    getKeyEnvelopes.mockResolvedValue({
      slots: [
        { slotType: 'password', slotId: 'password' },
        { slotType: 'recovery', slotId: 'recovery' },
      ],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });
    unwrapSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    generateRecoverySlot.mockResolvedValue({
      slot: { slotType: 'recovery', slotId: 'recovery' },
      recoveryKey: 'ABCD-EF01-2345-6789',
    });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    upsertKeyEnvelopeSlot.mockRejectedValue(new Error('server 500'));

    // Prepare succeeds (no PUT yet); the failure only surfaces on activate().
    let pending: { recoveryKey: string; activate: () => Promise<void> } | undefined;
    await act(async () => {
      pending = await captured.regenerateRecoveryKey('account-pw');
    });
    expect(pending?.recoveryKey).toBe('ABCD-EF01-2345-6789');

    let threw = false;
    await act(async () => {
      try {
        await pending!.activate();
      } catch {
        threw = true;
      }
    });

    // The PUT failed: activate throws so the UI never tells the user a fresh key
    // is live when the write never landed (the old key stays in force).
    expect(threw).toBe(true);
  });

  it('throws when the account has no password slot to re-auth against', async () => {
    await renderAuth();
    await loginUnlocked();

    // A recovery-only household: no password slot, so there is no re-auth proof.
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'recovery', slotId: 'recovery' }],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });

    let threw = false;
    await act(async () => {
      try {
        await captured.regenerateRecoveryKey('account-pw');
      } catch {
        threw = true;
      }
    });

    expect(threw).toBe(true);
    expect(unwrapSlot).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
  });

  it('falls back to the canonical "recovery" slot id when no recovery slot exists yet', async () => {
    await renderAuth();
    await loginUnlocked();

    // Password slot present but no recovery slot (e.g. a household that never
    // completed the recovery step): mint one under the canonical 'recovery' id.
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password' }],
      envelopeSetVersion: 4,
      envelopeSetTag: 'tag',
    });
    unwrapSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    const newSlot = { slotType: 'recovery', slotId: 'recovery' };
    generateRecoverySlot.mockResolvedValue({ slot: newSlot, recoveryKey: 'KEY' });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    upsertKeyEnvelopeSlot.mockResolvedValue(undefined);

    await act(async () => {
      const pending = await captured.regenerateRecoveryKey('account-pw');
      await pending.activate();
    });

    expect(generateRecoverySlot).toHaveBeenCalledWith('hh-1', 'recovery', fakeHdk);
    // Tag over [password, freshRecovery] at version+1; PUT keyed to 'recovery'.
    expect(computeEnvelopeSetTag).toHaveBeenCalledWith(
      [{ slotType: 'password', slotId: 'password' }, newSlot],
      5,
      fakeHdk,
    );
    expect(upsertKeyEnvelopeSlot).toHaveBeenCalledWith('recovery', {
      slot: newSlot,
      envelopeSetVersion: 5,
      envelopeSetTag: 'new-tag',
    });
  });
});
