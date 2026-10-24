// Passkey-PRF key-envelope flows: `enrollPasskeyForEncryption` (a targeted assertion's PRF secret becomes a `passkey_prf` slot
// bound to the credential) and `tryUnlockWithPrf`'s slot selection by credentialBinding.
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', async () => (await import('./auth-context.test-harness')).apiClientMock());
vi.mock('./key-envelope-client', async () => (await import('./auth-context.test-harness')).keyEnvelopeClientMock());
vi.mock('../crypto/key-cache', async () => (await import('./auth-context.test-harness')).keyCacheMock());
vi.mock('../crypto/key-wrapping', async () => (await import('./auth-context.test-harness')).keyWrappingMock());
vi.mock('./user-transition', async () => (await import('./auth-context.test-harness')).userTransitionMock());
vi.mock('@simplewebauthn/browser', async () => (await import('./auth-context.test-harness')).webauthnBrowserMock());
vi.mock('../crypto/passkey-prf', async () => (await import('./auth-context.test-harness')).passkeyPrfMock());

import { authMocks, captured, fakeHdk, jwt, renderAuth } from './auth-context.test-harness';
// The mocked KeyWrappingError, so assertions use the class the SUT throws.
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

    const assertOpts = startAuthentication.mock.calls[0][0] as { optionsJSON: unknown };
    expect(addPrfEvalToOptions).toHaveBeenCalled();
    const overriddenOptions = addPrfEvalToOptions.mock.calls[0][0] as {
      allowCredentials: { id: string; type: string }[];
    };
    expect(overriddenOptions.allowCredentials).toEqual([{ id: 'cred-1', type: 'public-key' }]);
    expect(assertOpts.optionsJSON).toEqual({ withPrf: true });

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
    // The pin advances to the written version, with the session's deviceId so it persists before the first sync writes deviceMetadata; left at 1, a replayed old set would undo the enrollment.
    expect(writeEnvelopeSetPin).toHaveBeenCalledWith(2, 'dev-1');
    expect(writeEnvelopeSetPin.mock.calls.at(-1)).toEqual([2, 'dev-1']);
  });

  // Re-enrolling replaces a live `passkey_prf` slot, which the server refuses without a fresh second factor when `AUTH_MFA_ENFORCED` is on; with no proof the body carries no step-up fields.
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

    // A passkey factor rides as `response` with no `code` key (server DTO XOR).
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
    expect(computeEnvelopeSetTag).not.toHaveBeenCalled();
    expect(upsertKeyEnvelopeSlot).not.toHaveBeenCalled();
  });

  // First-time setup, enrolling a passkey and unlocking by it must never prompt for a re-wrap: the password slot's credentialRevision already matches.

  it('setup → enroll a passkey → sign back in via that passkey is never prompted for a re-wrap', async () => {
    await renderAuth();

    // The password slot's recorded credentialRevision matches the account's current one, so nothing is owed.
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

    await act(async () => {
      await captured.login('u@test.com', 'pw');
    });
    await waitFor(() => expect(captured.isUnlocked).toBe(true));
    expect(screen.queryByText(/re-enter your password/i)).toBeNull();
    expect(generatePasswordSlot).not.toHaveBeenCalled();

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
    getKeyEnvelopes.mockResolvedValue(notOwedEnvelopes);
    computeEnvelopeSetTag.mockResolvedValue('new-tag');
    upsertKeyEnvelopeSlot.mockResolvedValue(undefined);

    await act(async () => {
      await captured.enrollPasskeyForEncryption('cred-1', 'my-pw');
    });
    expect(screen.queryByText(/re-enter your password/i)).toBeNull();

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
    // The PRF secret unwraps an HDK but the live set fails the HDK-keyed tag, so the HDK must never be trusted, set in memory or cached.
    unwrapPrfSlot.mockResolvedValue(fakeHdk);
    verifyEnvelopeSetTag.mockRejectedValue(new KeyWrappingError('envelope set tag mismatch'));

    await expect(captured.unlockWithPasskey()).rejects.toBeInstanceOf(KeyWrappingError);
    expect(captured.isUnlocked).toBe(false);
    expect(captured.getHdk()).toBeNull();
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

    // Hold the tag verification open to log out underneath the in-flight unlock; with no cached HDK this is the only verifyEnvelopeSetTag call, so initializeUnlockState cannot race it.
    let releaseVerify!: () => void;
    verifyEnvelopeSetTag.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseVerify = resolve;
      }),
    );

    let unlockError: unknown;
    const unlockPromise = captured.unlockWithPasskey().catch((err: unknown) => {
      unlockError = err;
    });

    await act(async () => {
      await captured.logout();
    });

    // The staleness guard, checked right after the tag verify, must throw "Session ended" without flipping isUnlocked or caching.
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


// `recacheHdk` is a best-effort re-write of the in-memory HDK to the device keyCache after a snapshot restore wipes it, so a
// page refresh does not re-prompt for the password; a locked session is a no-op and a rejected write resolves.

function wireLogin(token: string): void {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') return { accessToken: token, expiresIn: 3600 };
    if (path === '/api/v1/auth/verify-password') return undefined;
    throw new Error(`unexpected api call ${path}`);
  });
}

async function signIn(): Promise<void> {
  await act(async () => {
    await captured.login('u@test.com', 'pw');
  });
}

async function signInAndUnlock(): Promise<void> {
  await signIn();
  getKeyEnvelopes.mockResolvedValue({
    slots: [{ slotType: 'password', slotId: 'pw' }],
    envelopeSetVersion: 1,
  });
  unwrapSlot.mockResolvedValue(fakeHdk);
  verifyEnvelopeSetTag.mockResolvedValue(undefined);
  await act(async () => {
    await captured.unlockWithPassword('pw');
  });
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
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'h1' }));
    await signInAndUnlock();
    expect(captured.getHdk()).toBe(fakeHdk);
    cacheHdk.mockResolvedValue(undefined);

    await act(async () => {
      await captured.recacheHdk();
    });

    expect(cacheHdk).toHaveBeenCalledTimes(1);
    expect(cacheHdk).toHaveBeenCalledWith('h1', fakeHdk);
  });

  it('no-ops without throwing when the session is locked (no in-memory HDK)', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'h1' }));
    await signIn();
    expect(captured.getHdk()).toBeNull();

    await act(async () => {
      await expect(captured.recacheHdk()).resolves.toBeUndefined();
    });

    expect(cacheHdk).not.toHaveBeenCalled();
  });

  it('resolves without throwing when the IDB cache write rejects (best-effort)', async () => {
    await renderAuth();
    wireLogin(jwt({ userId: 'u1', householdId: 'h1' }));
    await signInAndUnlock();
    cacheHdk.mockRejectedValue(new Error('idb write failed'));

    await act(async () => {
      await expect(captured.recacheHdk()).resolves.toBeUndefined();
    });

    expect(cacheHdk).toHaveBeenCalledTimes(1);
  });
});
