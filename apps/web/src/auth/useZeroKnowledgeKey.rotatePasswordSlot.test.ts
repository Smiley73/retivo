// `rotatePasswordSlot`'s post-commit pin bookkeeping: the post-PUT `isStale()` re-check, the `writeEnvelopeSetPin` retry-once,
// the `raiseEnvelopeSetPinFloor` fallback and the lock-on-failure path, driven through `renderHook` so each test flips `claimsRef` mid-await.
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiRequest = vi.fn();
vi.mock('../api/client', () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  ApiRequestError: class ApiRequestError extends Error {},
}));

const getKeyEnvelopes = vi.fn();
const upsertKeyEnvelopeSlot = vi.fn();
vi.mock('./key-envelope-client', () => ({
  getKeyEnvelopes: () => getKeyEnvelopes(),
  upsertKeyEnvelopeSlot: (...a: unknown[]) => upsertKeyEnvelopeSlot(...a),
}));

const loadCachedHdk = vi.fn();
const cacheHdk = vi.fn();
const clearCachedHdk = vi.fn();
vi.mock('../crypto/key-cache', () => ({
  loadCachedHdk: (...a: unknown[]) => loadCachedHdk(...a),
  cacheHdk: (...a: unknown[]) => cacheHdk(...a),
  clearCachedHdk: (...a: unknown[]) => clearCachedHdk(...a),
}));

const unwrapSlot = vi.fn();
const verifyEnvelopeSetTag = vi.fn();
const generatePasswordSlot = vi.fn();
const computeEnvelopeSetTag = vi.fn();
const writeEnvelopeSetPin = vi.fn();
const raiseEnvelopeSetPinFloor = vi.fn();
vi.mock('../crypto/key-wrapping', () => {
  // Defined inside the factory so it is not in the TDZ when the hoisted mock runs.
  class KeyWrappingError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'KeyWrappingError';
    }
  }
  return {
    unwrapSlot: (...a: unknown[]) => unwrapSlot(...a),
    verifyEnvelopeSetTag: (...a: unknown[]) => verifyEnvelopeSetTag(...a),
    unwrapPrfSlot: vi.fn(),
    generateHdk: vi.fn(),
    generatePasswordSlot: (...a: unknown[]) => generatePasswordSlot(...a),
    generateRecoverySlot: vi.fn(),
    computeEnvelopeSetTag: (...a: unknown[]) => computeEnvelopeSetTag(...a),
    isEnvelopeSetRollback: (servedVersion: number, pinnedVersion: number) => servedVersion < pinnedVersion,
    readEnvelopeSetPin: async () => 0,
    writeEnvelopeSetPin: (...a: unknown[]) => writeEnvelopeSetPin(...a),
    raiseEnvelopeSetPinFloor: (...a: unknown[]) => raiseEnvelopeSetPinFloor(...a),
    KeyWrappingError,
  };
});

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));

const addPrfEvalToOptions = vi.fn();
const derivePrfWrapKey = vi.fn();
const extractPrfResult = vi.fn();
const generatePrfSalt = vi.fn();
vi.mock('../crypto/passkey-prf', () => ({
  addPrfEvalToOptions: (...a: unknown[]) => addPrfEvalToOptions(...a),
  derivePrfWrapKey: (...a: unknown[]) => derivePrfWrapKey(...a),
  extractPrfResult: (...a: unknown[]) => extractPrfResult(...a),
  generatePrfSalt: (...a: unknown[]) => generatePrfSalt(...a),
}));

import { useZeroKnowledgeKey, RewrapCommittedPinDegradedError } from './useZeroKnowledgeKey';

const fakeHdk = { algorithm: { name: 'AES-GCM' } } as unknown as CryptoKey;

type Claims = { userId: string; householdId: string; deviceId?: string };

const HOUSEHOLD_A: Claims = { userId: 'u1', householdId: 'hh-a', deviceId: 'dev-1' };
const HOUSEHOLD_B: Claims = { userId: 'u1', householdId: 'hh-b', deviceId: 'dev-1' };

const NEXT_VERSION = 6;

// Renders the hook unlocked for HOUSEHOLD_A and returns the live `claimsRef` so a test can flip households mid-flight.
async function renderUnlocked() {
  const claimsRef: { current: Claims | null } = { current: HOUSEHOLD_A };
  unwrapSlot.mockResolvedValue(fakeHdk);
  verifyEnvelopeSetTag.mockResolvedValue(undefined);
  cacheHdk.mockResolvedValue(undefined);
  writeEnvelopeSetPin.mockResolvedValue(undefined);
  getKeyEnvelopes.mockResolvedValueOnce({
    slots: [{ slotType: 'password', slotId: 'password' }],
    envelopeSetVersion: 1,
    envelopeSetTag: 'tag',
    currentCredentialRevision: 'rev',
  });
  const { result } = renderHook(() =>
    useZeroKnowledgeKey({ claimsRef, verifyPassword: vi.fn() }),
  );
  await act(async () => {
    await result.current.unlockWithPassword('OldPassw0rd!');
  });
  expect(result.current.getHdk()).not.toBeNull();
  return { result, claimsRef };
}

function wireRotate(): void {
  getKeyEnvelopes.mockResolvedValueOnce({
    slots: [{ slotType: 'password', slotId: 'password' }],
    envelopeSetVersion: NEXT_VERSION - 1,
    envelopeSetTag: 'tag',
    currentCredentialRevision: 'rev',
  });
  generatePasswordSlot.mockResolvedValue({ slotType: 'password', slotId: 'password' });
  computeEnvelopeSetTag.mockResolvedValue('new-tag');
  upsertKeyEnvelopeSlot.mockResolvedValue(undefined);
}

describe('rotatePasswordSlot post-commit pin bookkeeping', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('(a) isStale() true right after the PUT resolves: raises the floor for the CAPTURED household and throws without touching the durable pin write', async () => {
    const { result, claimsRef } = await renderUnlocked();
    wireRotate();
    upsertKeyEnvelopeSlot.mockImplementation(async () => {
      claimsRef.current = HOUSEHOLD_B;
    });
    raiseEnvelopeSetPinFloor.mockReturnValue(true);

    await expect(result.current.rotatePasswordSlot('NewPassw0rd!')).rejects.toMatchObject({
      message: 'Session ended. Please sign in again.',
    });

    expect(raiseEnvelopeSetPinFloor).toHaveBeenCalledWith(NEXT_VERSION, 'hh-a');
    expect(writeEnvelopeSetPin.mock.calls.filter((c) => c[0] === NEXT_VERSION)).toHaveLength(0);
  });

  it('(a) the same post-PUT stale branch escalates to RewrapCommittedPinDegradedError(locked: false) when the fallback floor ALSO fails to persist', async () => {
    const { result, claimsRef } = await renderUnlocked();
    wireRotate();
    upsertKeyEnvelopeSlot.mockImplementation(async () => {
      claimsRef.current = HOUSEHOLD_B;
    });
    raiseEnvelopeSetPinFloor.mockReturnValue(false);

    // A known-committed outcome must throw the error class useDerivedRewrap classifies as "committed, not refused"; the unexported floor error would read as a permanent refusal.
    let caught: unknown;
    try {
      await result.current.rotatePasswordSlot('NewPassw0rd!');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RewrapCommittedPinDegradedError);
    expect(caught).toMatchObject({ locked: false });
    expect(raiseEnvelopeSetPinFloor).toHaveBeenCalledWith(NEXT_VERSION, 'hh-a');
  });

  it('(b) writeEnvelopeSetPin failing once then succeeding retries once and never raises the floor or locks', async () => {
    const { result } = await renderUnlocked();
    wireRotate();
    let attempt = 0;
    writeEnvelopeSetPin.mockImplementation(async (version: number) => {
      if (version !== NEXT_VERSION) return;
      attempt += 1;
      if (attempt === 1) throw new Error('transient IDB failure');
    });

    await expect(result.current.rotatePasswordSlot('NewPassw0rd!')).resolves.toBeUndefined();

    expect(writeEnvelopeSetPin.mock.calls.filter((c) => c[0] === NEXT_VERSION)).toHaveLength(2);
    expect(raiseEnvelopeSetPinFloor).not.toHaveBeenCalled();
    expect(clearCachedHdk).not.toHaveBeenCalled();
  });

  it('(c) writeEnvelopeSetPin failing twice with the floor persisting: throws RewrapCommittedPinDegradedError(locked: false), never locks the device', async () => {
    const { result } = await renderUnlocked();
    wireRotate();
    writeEnvelopeSetPin.mockImplementation(async (version: number) => {
      if (version === NEXT_VERSION) throw new Error('idb broken');
    });
    raiseEnvelopeSetPinFloor.mockReturnValue(true);

    let caught: unknown;
    try {
      await result.current.rotatePasswordSlot('NewPassw0rd!');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RewrapCommittedPinDegradedError);
    expect(caught).toMatchObject({ locked: false });

    expect(clearCachedHdk).not.toHaveBeenCalled();
    expect(result.current.getHdk()).not.toBeNull();
    expect(result.current.isUnlocked).toBe(true);
  });

  it('(d) writeEnvelopeSetPin failing twice with the floor ALSO failing to persist: locks the LIVE workspace (HDK + isUnlocked), not only the IDB cache', async () => {
    const { result } = await renderUnlocked();
    wireRotate();
    writeEnvelopeSetPin.mockImplementation(async (version: number) => {
      if (version === NEXT_VERSION) throw new Error('idb broken');
    });
    raiseEnvelopeSetPinFloor.mockReturnValue(false);

    await act(async () => {
      await expect(result.current.rotatePasswordSlot('NewPassw0rd!')).rejects.toMatchObject({
        name: 'RewrapCommittedPinDegradedError',
        locked: true,
      });
    });

    expect(clearCachedHdk).toHaveBeenCalled();
    expect(result.current.getHdk()).toBeNull();
    expect(result.current.isUnlocked).toBe(false);
  });

  it('a household switch landing during the RETRY itself never falls through to the unscoped clearCachedHdk(); it raises the floor for the CAPTURED household instead', async () => {
    const { result, claimsRef } = await renderUnlocked();
    wireRotate();
    let call = 0;
    writeEnvelopeSetPin.mockImplementation(async (version: number) => {
      if (version !== NEXT_VERSION) return;
      call += 1;
      if (call === 1) throw new Error('first attempt fails');
      claimsRef.current = HOUSEHOLD_B;
      throw new Error('retry fails too');
    });
    raiseEnvelopeSetPinFloor.mockReturnValue(true);

    await expect(result.current.rotatePasswordSlot('NewPassw0rd!')).rejects.toMatchObject({
      message: 'Session ended. Please sign in again.',
    });

    expect(raiseEnvelopeSetPinFloor).toHaveBeenCalledWith(NEXT_VERSION, 'hh-a');
    // The household-unscoped clearCachedHdk() must never run here: it would wipe household B's freshly cached key.
    expect(clearCachedHdk).not.toHaveBeenCalled();
  });

  it('a household switch landing strictly inside a "successful" writeEnvelopeSetPin never resolves quietly — it still raises the floor for the CAPTURED household', async () => {
    const { result, claimsRef } = await renderUnlocked();
    wireRotate();
    writeEnvelopeSetPin.mockImplementation(async (version: number) => {
      if (version !== NEXT_VERSION) return;
      claimsRef.current = HOUSEHOLD_B;
    });
    raiseEnvelopeSetPinFloor.mockReturnValue(true);

    await expect(result.current.rotatePasswordSlot('NewPassw0rd!')).rejects.toMatchObject({
      message: 'Session ended. Please sign in again.',
    });

    expect(raiseEnvelopeSetPinFloor).toHaveBeenCalledWith(NEXT_VERSION, 'hh-a');
  });
});
