// `regenerateRecoveryKey` is prepare-then-commit: it re-authenticates by unwrapping the `password` slot, verifies the set and
// mints a fresh `recovery` slot without persisting; nothing changes server-side until `activate()`. Every failure surfaces.
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


type Proof = StepUpProof;

function wire(token: string): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') return { accessToken: token, expiresIn: 3600 };
    throw new Error(`unexpected api call ${path}`);
  });
}

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

    let pending: { recoveryKey: string; activate: () => Promise<void> } | undefined;
    await act(async () => {
      pending = await captured.regenerateRecoveryKey('account-pw');
    });

    expect(unwrapSlot).toHaveBeenCalledWith(
      { slotType: 'password', slotId: 'password' },
      'account-pw',
    );
    expect(generateRecoverySlot).toHaveBeenCalledWith('hh-1', 'recovery', fakeHdk);
    expect(pending?.recoveryKey).toBe('ABCD-EF01-2345-6789');
    // Prepare must not persist: until `activate()`, nothing is tagged or written and the pin is not advanced, so cancelling keeps the previous recovery key in force.
    expect(computeEnvelopeSetTag).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
    expect(writeEnvelopeSetPin.mock.calls.at(-1)).toEqual([2, 'dev-1']);

    await act(async () => {
      await pending!.activate();
    });

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
    // The pin advances to the written version: left at 2, a server replay of the old set would silently restore the old key.
    expect(writeEnvelopeSetPin.mock.calls.at(-1)).toEqual([3, 'dev-1']);
  });

  // Activation replaces the live `recovery` slot, which the server refuses without a fresh second factor when `AUTH_MFA_ENFORCED`
  // is on, so the collected proof must reach the PUT body as `method` + `code`, or `method` + `response` with no `code`.
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

    // The server DTO's XOR rejects a `code` beside a passkey `response`.
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
    unwrapSlot.mockRejectedValue(new Error('wrong password'));

    let threw = false;
    await act(async () => {
      try {
        await captured.regenerateRecoveryKey('wrong-pw');
      } catch {
        threw = true;
      }
    });

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

    // activate throws so the UI never says a fresh key is live when the write never landed.
    expect(threw).toBe(true);
  });

  it('throws when the account has no password slot to re-auth against', async () => {
    await renderAuth();
    await loginUnlocked();

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
