/**
 * Tests for the passkey-PRF key-envelope flows in AuthContext:
 * `enrollPasskeyForEncryption` (targeted WebAuthn assertion → PRF
 * secret → `passkey_prf` slot PUT bound to the credential) and the
 * `tryUnlockWithPrf` slot-selection-by-credentialBinding behavior. The API, the
 * key-envelope client, the HDK cache, the key-wrapping primitives, and the
 * WebAuthn/PRF plumbing are mocked at the module boundary so the test exercises
 * only the hook's orchestration, not the WebCrypto / WebAuthn leaves (which have
 * their own unit tests).
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
// Pull the mocked KeyWrappingError so assertions use the same class the SUT throws.
import { KeyWrappingError } from '../crypto/key-wrapping';
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
  unwrapPrfSlot,
  generateHdk,
  generatePasswordSlot,
  generateRecoverySlot,
  generatePasskeyPrfSlot,
  computeEnvelopeSetTag,
  writeEnvelopeSetPin,
  startAuthentication,
  addPrfEvalToOptions,
  derivePrfWrapKey,
  extractPrfResult,
  generatePrfSalt,
} = authMocks;

// --- Helpers ----------------------------------------------------------------

type Proof = StepUpProof;

let captured: {
  login: (e: string, p: string) => Promise<void>;
  loginWithPasskey: () => Promise<void>;
  enrollPasskeyForEncryption: (
    credentialId: string,
    currentPassword: string,
    proof?: Proof,
  ) => Promise<void>;
  unlockWithPasskey: () => Promise<void>;
  logout: () => Promise<void>;
  getHdk: () => CryptoKey | null;
  isUnlocked: boolean;
  isAuthenticated: boolean;
  unlockResolved: boolean;
};

function Probe(): React.ReactElement {
  const auth = useAuth();
  captured = {
    login: auth.login,
    loginWithPasskey: auth.loginWithPasskey,
    enrollPasskeyForEncryption: auth.enrollPasskeyForEncryption,
    unlockWithPasskey: auth.unlockWithPasskey,
    logout: auth.logout,
    getHdk: auth.getHdk,
    isUnlocked: auth.isUnlocked,
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

/** Password login with a device-cached HDK that verifies → session unlocked. */
async function loginUnlocked(): Promise<void> {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') {
      return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
    }
    if (path === '/api/v1/auth/passkey/authenticate/start') {
      return { challenge: 'c', allowCredentials: [] };
    }
    throw new Error(`unexpected api call ${path}`);
  });
  loadCachedHdk.mockResolvedValue(fakeHdk);
  getKeyEnvelopes.mockResolvedValue({
    slots: [{ slotType: 'password', slotId: 'password' }],
    envelopeSetVersion: 1,
    envelopeSetTag: 'tag',
  });
  verifyEnvelopeSetTag.mockResolvedValue(undefined);
  await act(async () => {
    await captured.login('u@test.com', 'pw');
  });
  await waitFor(() => expect(captured.isUnlocked).toBe(true));
}

describe('AuthContext — passkey-PRF enrollment', () => {
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
    generatePasskeyPrfSlot.mockReset();
    generatePasswordSlot.mockReset();
    generateRecoverySlot.mockReset();
    computeEnvelopeSetTag.mockReset();
    startAuthentication.mockReset();
    addPrfEvalToOptions.mockReset();
    derivePrfWrapKey.mockReset();
    extractPrfResult.mockReset();
    generatePrfSalt.mockReset();
    writeEnvelopeSetPin.mockReset();
    writeEnvelopeSetPin.mockResolvedValue(undefined);
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('enrolls a passkey: targeted assertion → PRF secret → slot PUT with credentialBinding', async () => {
    await renderAuth();
    await loginUnlocked();

    generatePrfSalt.mockReturnValue('prf-salt');
    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    startAuthentication.mockResolvedValue({
      id: 'cred-1',
      clientExtensionResults: { prf: { results: { first: 'x' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([9, 9, 9]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    const prfSlot = {
      slotType: 'passkey_prf',
      slotId: 'passkey_prf',
      credentialBinding: 'cred-1',
      prfSalt: 'prf-salt',
    };
    generatePasskeyPrfSlot.mockResolvedValue(prfSlot);
    // Re-fetch before the PUT: existing password slot, version 1.
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    upsertKeyEnvelopeSlot.mockResolvedValue(undefined);

    await act(async () => {
      await captured.enrollPasskeyForEncryption('cred-1', 'my-pw');
    });

    // The targeted assertion overrode allowCredentials to the chosen credential.
    const assertOpts = startAuthentication.mock.calls[0][0] as { optionsJSON: unknown };
    expect(addPrfEvalToOptions).toHaveBeenCalled();
    const overriddenOptions = addPrfEvalToOptions.mock.calls[0][0] as {
      allowCredentials: { id: string; type: string }[];
    };
    expect(overriddenOptions.allowCredentials).toEqual([{ id: 'cred-1', type: 'public-key' }]);
    expect(assertOpts.optionsJSON).toEqual({ withPrf: true });

    // The PRF slot was generated bound to the credential and PUT at the next version.
    expect(generatePasskeyPrfSlot).toHaveBeenCalledWith(
      'hh-1',
      'passkey_prf',
      expect.anything(),
      fakeHdk,
      'prf-salt',
      'cred-1',
    );
    expect(upsertKeyEnvelopeSlot).toHaveBeenCalledWith('passkey_prf', {
      slot: prfSlot,
      envelopeSetVersion: 2,
      envelopeSetTag: 'new-tag',
      currentPassword: 'my-pw',
    });
    // Rollback-pin advanced to the just-written set version: leaving the
    // pin at the old version 1 would let an adversarial server replay the old
    // set and silently undo the enrollment. The verify-step pin (old version 1)
    // is followed by the post-PUT bump to 2. The session's deviceId is threaded
    // so the pin persists even before the first sync wrote deviceMetadata.
    expect(writeEnvelopeSetPin).toHaveBeenCalledWith(2, 'dev-1');
    expect(writeEnvelopeSetPin.mock.calls.at(-1)).toEqual([2, 'dev-1']);
  });

  // Re-enrolling while a
  // `passkey_prf` slot already exists REPLACES it, which the server refuses
  // without a fresh second factor when `AUTH_MFA_ENFORCED` is on. The proof
  // the card collects must reach the PUT body as the `stepUpProofFields` wire
  // shape; with no proof the body must carry no step-up fields at all.
  it('enrollPasskeyForEncryption(credentialId, proof) carries the step-up factor on the passkey_prf PUT body', async () => {
    await renderAuth();
    await loginUnlocked();

    generatePrfSalt.mockReturnValue('prf-salt');
    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    startAuthentication.mockResolvedValue({
      id: 'cred-2',
      clientExtensionResults: { prf: { results: { first: 'x' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([9, 9, 9]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    const prfSlot = {
      slotType: 'passkey_prf',
      slotId: 'passkey_prf',
      credentialBinding: 'cred-2',
      prfSalt: 'prf-salt',
    };
    generatePasskeyPrfSlot.mockResolvedValue(prfSlot);
    // An existing PRF slot bound to another passkey: this enrollment replaces it.
    getKeyEnvelopes.mockResolvedValue({
      slots: [
        { slotType: 'password', slotId: 'password' },
        { slotType: 'passkey_prf', slotId: 'passkey_prf', credentialBinding: 'cred-1' },
      ],
      envelopeSetVersion: 2,
      envelopeSetTag: 'tag',
    });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    upsertKeyEnvelopeSlot.mockResolvedValue(undefined);

    await act(async () => {
      await captured.enrollPasskeyForEncryption('cred-2', 'my-pw', { method: 'totp', code: '123456' });
    });
    expect(upsertKeyEnvelopeSlot).toHaveBeenLastCalledWith('passkey_prf', {
      slot: prfSlot,
      envelopeSetVersion: 3,
      envelopeSetTag: 'new-tag',
      currentPassword: 'my-pw',
      method: 'totp',
      code: '123456',
    });
    expect('response' in (upsertKeyEnvelopeSlot.mock.calls.at(-1)![1] as object)).toBe(false);

    // A passkey factor rides as `response` with NO `code` key (server DTO XOR).
    const assertion = { id: 'cred-1', type: 'public-key' } as unknown as NonNullable<
      StepUpProof['response']
    >;
    await act(async () => {
      await captured.enrollPasskeyForEncryption('cred-2', 'my-pw', {
        method: 'passkey',
        response: assertion,
      });
    });
    const body = upsertKeyEnvelopeSlot.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(body.method).toBe('passkey');
    expect(body.response).toBe(assertion);
    expect('code' in body).toBe(false);

    // No proof: the password floor still rides, but no step-up fields at all.
    await act(async () => {
      await captured.enrollPasskeyForEncryption('cred-2', 'my-pw');
    });
    const bare = upsertKeyEnvelopeSlot.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(bare.currentPassword).toBe('my-pw');
    expect('method' in bare).toBe(false);
    expect('code' in bare).toBe(false);
    expect('response' in bare).toBe(false);
  });

  it('rejects enrollment when the credential is not enrolled (server 422)', async () => {
    await renderAuth();
    await loginUnlocked();

    generatePrfSalt.mockReturnValue('prf-salt');
    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    startAuthentication.mockResolvedValue({
      id: 'cred-x',
      clientExtensionResults: { prf: { results: { first: 'x' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([1]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    generatePasskeyPrfSlot.mockResolvedValue({
      slotType: 'passkey_prf',
      slotId: 'passkey_prf',
      credentialBinding: 'cred-x',
    });
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    // The server rejects the binding (credential not enrolled) with a 422.
    upsertKeyEnvelopeSlot.mockRejectedValue(new Error('CREDENTIAL_NOT_FOUND'));

    await expect(captured.enrollPasskeyForEncryption('cred-x', 'my-pw')).rejects.toThrow(
      'CREDENTIAL_NOT_FOUND',
    );
  });

  it('rejects enrollment and issues no PUT when the fetched slot set fails the envelope-set tag', async () => {
    await renderAuth();
    await loginUnlocked();

    generatePrfSalt.mockReturnValue('prf-salt');
    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    startAuthentication.mockResolvedValue({
      id: 'cred-1',
      clientExtensionResults: { prf: { results: { first: 'x' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([9, 9, 9]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    generatePasskeyPrfSlot.mockResolvedValue({
      slotType: 'passkey_prf',
      slotId: 'passkey_prf',
      credentialBinding: 'cred-1',
    });
    // A tampered (stripped/injected) slot set: the re-fetch returns slots whose
    // HDK-keyed set tag does not verify. loginUnlocked() left the tag mock
    // resolving, so flip it to reject for the enrollment re-fetch.
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'password', slotId: 'password' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tampered-tag',
    });
    verifyEnvelopeSetTag.mockRejectedValue(new Error('envelope set tag mismatch'));
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    upsertKeyEnvelopeSlot.mockResolvedValue(undefined);

    await expect(captured.enrollPasskeyForEncryption('cred-1', 'my-pw')).rejects.toThrow(
      'envelope set tag mismatch',
    );
    // A tampered set must never be blessed: no slot is re-tagged or persisted.
    expect(computeEnvelopeSetTag).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
  });

  // --- First-time key setup, then enrolling a passkey, then unlocking
  // by that passkey, must never prompt for a re-wrap (the password slot's
  // credentialRevision already matches the account's current one, so
  // nothing is ever owed for this device).

  it('setup → enroll a passkey → sign back in via that passkey is never prompted for a re-wrap', async () => {
    await renderAuth();

    // The password slot's recorded credentialRevision already matches the
    // account's current one —
    // nothing is owed. Reused across every fetch below.
    const notOwedEnvelopes = {
      slots: [{ slotType: 'password', slotId: 'password', credentialRevision: 'rev-1' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
      currentCredentialRevision: 'rev-1',
    };
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      if (path === '/api/v1/auth/logout') return undefined;
      if (path === '/api/v1/auth/passkey/authenticate/start') {
        return { challenge: 'c', allowCredentials: [] };
      }
      if (path === '/api/v1/auth/passkey/authenticate/finish') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });
    loadCachedHdk.mockResolvedValue(fakeHdk);
    getKeyEnvelopes.mockResolvedValue(notOwedEnvelopes);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);

    // Password sign-in, cached-key auto-unlock (the rising edge the
    // derive runs on) — never owed, never prompted.
    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(captured.isUnlocked).toBe(true));
    expect(screen.queryByText(/re-enter your password/i)).toBeNull();
    expect(generatePasswordSlot).not.toHaveBeenCalled();

    // Enroll a passkey for encryption.
    generatePrfSalt.mockReturnValue('prf-salt');
    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    startAuthentication.mockResolvedValue({
      id: 'cred-1',
      clientExtensionResults: { prf: { results: { first: 'x' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([9, 9, 9]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    const prfSlot = {
      slotType: 'passkey_prf',
      slotId: 'passkey_prf',
      credentialBinding: 'cred-1',
      prfSalt: 'prf-salt',
    };
    generatePasskeyPrfSlot.mockResolvedValue(prfSlot);
    getKeyEnvelopes.mockResolvedValue(notOwedEnvelopes); // re-fetch before the PUT
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    upsertKeyEnvelopeSlot.mockResolvedValue(undefined);

    await act(async () => {
      await captured.enrollPasskeyForEncryption('cred-1', 'my-pw');
    });
    expect(screen.queryByText(/re-enter your password/i)).toBeNull();

    // Sign out, then sign back in via the passkey just enrolled — the
    // isUnlocked rising edge from THIS unlock must not prompt either.
    await act(async () => {
      await captured.logout();
    });

    getKeyEnvelopes.mockResolvedValue({
      slots: [...notOwedEnvelopes.slots, prfSlot],
      envelopeSetVersion: 2,
      envelopeSetTag: 'new-tag',
      currentCredentialRevision: 'rev-1',
    });
    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    startAuthentication.mockResolvedValue({
      id: 'cred-1',
      clientExtensionResults: { prf: { results: { first: 'y' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([1, 2, 3]));
    unwrapPrfSlot.mockResolvedValue(fakeHdk);

    await act(async () => {
      await captured.loginWithPasskey();
    });

    await waitFor(() => expect(captured.isUnlocked).toBe(true));
    expect(screen.queryByText(/re-enter your password/i)).toBeNull();
    expect(generatePasswordSlot).not.toHaveBeenCalled();
  });
});

describe('AuthContext — unlockWithPasskey (user-initiated targeted PRF unlock)', () => {
  beforeEach(() => {
    apiRequest.mockReset();
    getKeyEnvelopes.mockReset();
    loadCachedHdk.mockReset();
    cacheHdk.mockReset();
    verifyEnvelopeSetTag.mockReset();
    unwrapPrfSlot.mockReset();
    startAuthentication.mockReset();
    addPrfEvalToOptions.mockReset();
    derivePrfWrapKey.mockReset();
    extractPrfResult.mockReset();
    generatePrfSalt.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Password login with NO cached HDK → authenticated but locked session. */
  async function loginLocked(): Promise<void> {
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      if (path === '/api/v1/auth/passkey/authenticate/start') {
        return { challenge: 'c', allowCredentials: [] };
      }
      throw new Error(`unexpected api call ${path}`);
    });
    loadCachedHdk.mockResolvedValue(null);
    getKeyEnvelopes.mockResolvedValue({
      slots: [{ slotType: 'passkey_prf', slotId: 'passkey_prf', credentialBinding: 'cred-1', prfSalt: 'salt' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(captured.unlockResolved).toBe(true));
    expect(captured.isUnlocked).toBe(false);
  }

  it('targeted assertion returns a PRF result → slot unwrapped, tag verified, unlocked, HDK cached', async () => {
    await renderAuth();
    await loginLocked();

    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    startAuthentication.mockResolvedValue({
      id: 'cred-1',
      clientExtensionResults: { prf: { results: { first: 'x' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([4, 5, 6]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    unwrapPrfSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);

    await act(async () => {
      await captured.unlockWithPasskey();
    });

    await waitFor(() => expect(captured.isUnlocked).toBe(true));
    expect(captured.getHdk()).toBe(fakeHdk);
    expect(cacheHdk).toHaveBeenCalledWith('hh-1', fakeHdk);
    // The targeted assertion overrode allowCredentials to the slot's bound credential.
    const overridden = addPrfEvalToOptions.mock.calls[0][0] as {
      allowCredentials: { id: string; type: string }[];
    };
    expect(overridden.allowCredentials).toEqual([{ id: 'cred-1', type: 'public-key' }]);
  });

  it('throws and stays locked when no passkey_prf slot exists', async () => {
    await renderAuth();
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/login') {
        return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });
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

    await expect(captured.unlockWithPasskey()).rejects.toThrow();
    expect(captured.isUnlocked).toBe(false);
    expect(captured.getHdk()).toBeNull();
  });

  it('throws and stays locked when the authenticator returns no PRF result', async () => {
    await renderAuth();
    await loginLocked();

    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    startAuthentication.mockResolvedValue({ id: 'cred-1', clientExtensionResults: {} });
    extractPrfResult.mockReturnValue(null);

    await expect(captured.unlockWithPasskey()).rejects.toBeInstanceOf(KeyWrappingError);
    expect(captured.isUnlocked).toBe(false);
    expect(captured.getHdk()).toBeNull();
    expect(unwrapPrfSlot).not.toHaveBeenCalled();
  });

  it('rejects and stays locked when the envelope-set tag fails to verify', async () => {
    await renderAuth();
    await loginLocked();

    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    startAuthentication.mockResolvedValue({
      id: 'cred-1',
      clientExtensionResults: { prf: { results: { first: 'x' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([4, 5, 6]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    // The PRF secret unwraps an HDK, but the live slot set fails the
    // HDK-keyed envelope-set tag (slot stripped/reordered/injected): the HDK
    // must never be trusted, set in memory, or cached.
    unwrapPrfSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockRejectedValue(new KeyWrappingError('envelope set tag mismatch'));

    await expect(captured.unlockWithPasskey()).rejects.toBeInstanceOf(KeyWrappingError);
    expect(captured.isUnlocked).toBe(false);
    expect(captured.getHdk()).toBeNull();
    // A tampered set is never blessed: no HDK is trusted in memory or cached.
    expect(cacheHdk).not.toHaveBeenCalled();
  });

  it('staleness guard: a logout mid-assertion does NOT trust the result (throws, stays locked)', async () => {
    await renderAuth();
    await loginLocked();

    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    startAuthentication.mockResolvedValue({
      id: 'cred-1',
      clientExtensionResults: { prf: { results: { first: 'x' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([4, 5, 6]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    unwrapPrfSlot.mockResolvedValue(fakeHdk);

    // Hold the envelope-set-tag verification open so we can log out underneath
    // the in-flight unlock. The staleness check runs AFTER this resolves; with
    // no cached HDK (loginLocked) this is the only verifyEnvelopeSetTag call, so
    // it can't be raced by initializeUnlockState.
    let releaseVerify!: () => void;
    verifyEnvelopeSetTag.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseVerify = resolve;
      }),
    );

    // Kick off the user-initiated unlock; capture its rejection.
    let unlockError: unknown;
    const unlockPromise = captured.unlockWithPasskey().catch((err: unknown) => {
      unlockError = err;
    });

    // Log out while the unlock is still mid-flight (blocked on tag verify): the
    // session is no longer the one the unlock captured.
    await act(async () => {
      await captured.logout();
    });

    // Now let the stale tag verify resolve: the staleness guard (checked right
    // after the tag verify) must throw "Session ended" without flipping
    // isUnlocked, trusting the HDK in memory, or caching it.
    await act(async () => {
      releaseVerify();
      await unlockPromise;
    });

    expect(unlockError).toBeInstanceOf(Error);
    expect((unlockError as Error).message).toMatch(/Session ended/);
    expect(captured.isUnlocked).toBe(false);
    expect(captured.getHdk()).toBeNull();
    expect(cacheHdk).not.toHaveBeenCalled();
  });
});

describe('AuthContext — tryUnlockWithPrf slot selection', () => {
  beforeEach(() => {
    apiRequest.mockReset();
    getKeyEnvelopes.mockReset();
    loadCachedHdk.mockReset();
    cacheHdk.mockReset();
    verifyEnvelopeSetTag.mockReset();
    unwrapPrfSlot.mockReset();
    startAuthentication.mockReset();
    addPrfEvalToOptions.mockReset();
    derivePrfWrapKey.mockReset();
    extractPrfResult.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Discoverable passkey login with a PRF salt in the start options. */
  function wirePasskeyLogin(token: string): void {
    apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') throw new Error('no session');
      if (path === '/api/v1/auth/passkey/authenticate/start') {
        return { extensions: { prf: { eval: { first: 'c2FsdA' } } } };
      }
      if (path === '/api/v1/auth/passkey/authenticate/finish') {
        return { accessToken: token, expiresIn: 3600 };
      }
      throw new Error(`unexpected api call ${path}`);
    });
  }

  it('selects the slot whose credentialBinding matches the asserted credential id', async () => {
    await renderAuth();
    wirePasskeyLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    const matching = { slotType: 'passkey_prf', slotId: 's-b', credentialBinding: 'cred-2' };
    getKeyEnvelopes.mockResolvedValue({
      slots: [
        { slotType: 'passkey_prf', slotId: 's-a', credentialBinding: 'cred-1' },
        matching,
      ],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    // The browser picks the second passkey: assertion id = cred-2.
    startAuthentication.mockResolvedValue({
      id: 'cred-2',
      clientExtensionResults: { prf: { results: { first: 'x' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([5]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    unwrapPrfSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);

    await act(async () => {
      await captured.loginWithPasskey();
    });

    await waitFor(() => expect(captured.isUnlocked).toBe(true));
    // Unwrapped the credential-2 slot, not the first one.
    expect(unwrapPrfSlot).toHaveBeenCalledWith(matching, expect.anything());
  });

  it('falls back to the first PRF slot when no credentialId is provided (backwards-compatible)', async () => {
    await renderAuth();
    wirePasskeyLogin(jwt({ userId: 'u1', householdId: 'hh-1' }));
    loadCachedHdk.mockResolvedValue(null);
    const firstSlot = { slotType: 'passkey_prf', slotId: 's-a' };
    getKeyEnvelopes.mockResolvedValue({
      slots: [firstSlot],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    addPrfEvalToOptions.mockReturnValue({ withPrf: true });
    // Assertion returns no id field → tryUnlockWithPrf receives undefined.
    startAuthentication.mockResolvedValue({
      clientExtensionResults: { prf: { results: { first: 'x' } } },
    });
    extractPrfResult.mockReturnValue(new Uint8Array([7]));
    derivePrfWrapKey.mockResolvedValue({} as CryptoKey);
    unwrapPrfSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockResolvedValue(undefined);
    cacheHdk.mockResolvedValue(undefined);

    await act(async () => {
      await captured.loginWithPasskey();
    });

    await waitFor(() => expect(captured.isUnlocked).toBe(true));
    expect(unwrapPrfSlot).toHaveBeenCalledWith(firstSlot, expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Moved from AuthContext.recacheHdk.test.tsx
// ---------------------------------------------------------------------------

/**
 * Focused tests for the `recacheHdk` best-effort re-cache,
 * threaded from `useZeroKnowledgeKey` through AuthContext. A snapshot restore
 * wipes the device `keyCache` while the in-memory HDK survives; `recacheHdk`
 * re-writes that surviving key so a subsequent page refresh doesn't miss the
 * cache and re-prompt for the password. Covers: (a) HDK in memory → writes to keyCache, (b)
 * locked session (no HDK) → no-op + no write, (c) a rejected `cacheHdk` IDB
 * write → resolves without throwing (the best-effort contract).
 *
 * A separate file from AuthContext.unlock.test.tsx, which is already over the
 * 800-line shape flag — adding these cases there would worsen it.
 *
 * The API, key-envelope client, HDK cache, and key-wrapping unwrap are mocked at
 * the module boundary so the test exercises only the hook's orchestration.
 */

let recacheCaptured: {
  login: (e: string, p: string) => Promise<void>;
  unlockWithPassword: (p: string) => Promise<void>;
  recacheHdk: () => Promise<void>;
  getHdk: () => CryptoKey | null;
  isAuthenticated: boolean;
};

function RecacheProbe(): React.ReactElement {
  const auth = useAuth();
  recacheCaptured = {
    login: auth.login,
    unlockWithPassword: auth.unlockWithPassword,
    recacheHdk: auth.recacheHdk,
    getHdk: auth.getHdk,
    isAuthenticated: auth.isAuthenticated,
  };
  return <span data-testid="auth">{String(auth.isAuthenticated)}</span>;
}

/** Route api calls: boot refresh fails (signed out), login returns the token. */
function wireLogin(token: string): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') return { accessToken: token, expiresIn: 3600 };
    if (path === '/api/v1/auth/verify-password') return undefined;
    throw new Error(`unexpected api call ${path}`);
  });
}

/** Render the provider and settle the boot effect to "signed out". */
async function recacheRenderAuth(): Promise<void> {
  render(
    <AuthProvider>
      <RecacheProbe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('auth').textContent).toBe('false'));
}

/** Sign in so claims are live (recacheHdk reads claimsRef.current.householdId). */
async function signIn(): Promise<void> {
  await act(async () => {
    await recacheCaptured.login('u@test.com', 'pw');
  });
}

/** Sign in AND unlock so the in-memory HDK is set (hdkRef.current = fakeHdk). */
async function signInAndUnlock(): Promise<void> {
  await signIn();
  getKeyEnvelopes.mockResolvedValue({
    slots: [{ slotType: 'password', slotId: 'pw' }],
    envelopeSetVersion: 1,
  });
  unwrapSlot.mockResolvedValue(fakeHdk);
  verifyEnvelopeSetTag.mockResolvedValue(undefined);
  await act(async () => {
    await recacheCaptured.unlockWithPassword('pw');
  });
  // The unlock itself caches once; clear so recacheHdk assertions start clean.
  cacheHdk.mockClear();
}

describe('AuthContext recacheHdk', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
  vi.clearAllMocks();
  });

  it('writes the in-memory HDK to the device cache for the live household', async () => {
    wireLogin(jwt({ userId: 'u1', householdId: 'h1' }));
    await recacheRenderAuth();
    await signInAndUnlock();
    expect(recacheCaptured.getHdk()).toBe(fakeHdk);
    cacheHdk.mockResolvedValue(undefined);

    await act(async () => {
      await recacheCaptured.recacheHdk();
    });

    expect(cacheHdk).toHaveBeenCalledTimes(1);
    expect(cacheHdk).toHaveBeenCalledWith('h1', fakeHdk);
  });

  it('no-ops without throwing when the session is locked (no in-memory HDK)', async () => {
    wireLogin(jwt({ userId: 'u1', householdId: 'h1' }));
    await recacheRenderAuth();
    // Signed in but never unlocked → hdkRef.current is null.
    await signIn();
    expect(recacheCaptured.getHdk()).toBeNull();

    await act(async () => {
      await expect(recacheCaptured.recacheHdk()).resolves.toBeUndefined();
    });

    expect(cacheHdk).not.toHaveBeenCalled();
  });

  it('resolves without throwing when the IDB cache write rejects (best-effort)', async () => {
    wireLogin(jwt({ userId: 'u1', householdId: 'h1' }));
    await recacheRenderAuth();
    await signInAndUnlock();
    cacheHdk.mockRejectedValue(new Error('idb write failed'));

    await act(async () => {
      await expect(recacheCaptured.recacheHdk()).resolves.toBeUndefined();
    });

    // The write was attempted (and swallowed), proving the failure is isolated.
    expect(cacheHdk).toHaveBeenCalledTimes(1);
  });
});
