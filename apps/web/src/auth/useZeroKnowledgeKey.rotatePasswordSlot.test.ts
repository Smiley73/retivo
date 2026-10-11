/**
 * Tests for `rotatePasswordSlot`'s post-commit pin bookkeeping: the post-PUT `isStale()` re-check, the
 * `writeEnvelopeSetPin` retry-once, the `raiseEnvelopeSetPinFloor` fallback,
 * and the lock-on-failure path. None of these branches ran in any test
 * before this round — `AuthContext.unlock.test.tsx` stubs `writeEnvelopeSetPin`
 * to never fail, and `useDerivedRewrap.test.ts` mocks `rotatePasswordSlot`
 * itself rather than exercising the real implementation.
 *
 * `useZeroKnowledgeKey` is exercised directly via `renderHook` (rather than
 * through `AuthContext`) so each test can flip `claimsRef.current` at the
 * exact moment a given await is in flight — the precise race window each
 * finding names. The API, the key-envelope client, the HDK cache, and the
 * key-wrapping primitives are mocked at the module boundary, matching the
 * pattern in `AuthContext.unlock.test.tsx` / `AuthContext.changePassword.test.tsx`.
 */
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
  // Defined inside the factory so it isn't in the TDZ when the hoisted mock
  // runs (a top-level `class` reference here throws "before initialization").
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

/** The version rotatePasswordSlot commits to in every test below: the
 * fetched envelope-set version (5) + 1. */
const NEXT_VERSION = 6;

/** Render the hook already unlocked for `HOUSEHOLD_A`, with an HDK in
 * memory, so `rotatePasswordSlot` has something to rotate. Returns the live
 * `claimsRef` so a test can flip households mid-flight. */
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

/** Wire the fresh-fetch + rewrap plumbing rotatePasswordSlot needs after
 * `renderUnlocked` (a fresh, distinct call from the unlock's own fetch). */
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
      // A household switch lands exactly between the PUT resolving and the
      // isStale() re-check.
      claimsRef.current = HOUSEHOLD_B;
    });
    raiseEnvelopeSetPinFloor.mockReturnValue(true);

    await expect(result.current.rotatePasswordSlot('NewPassw0rd!')).rejects.toMatchObject({
      message: 'Session ended. Please sign in again.',
    });

    expect(raiseEnvelopeSetPinFloor).toHaveBeenCalledWith(NEXT_VERSION, 'hh-a');
    // Never even attempts the durable pin write for the version the PUT
    // committed — the household-scoped floor is the only fallback used.
    expect(writeEnvelopeSetPin.mock.calls.filter((c) => c[0] === NEXT_VERSION)).toHaveLength(0);
  });

  it('(a) the same post-PUT stale branch escalates to RewrapCommittedPinDegradedError(locked: false) when the fallback floor ALSO fails to persist', async () => {
    const { result, claimsRef } = await renderUnlocked();
    wireRotate();
    upsertKeyEnvelopeSlot.mockImplementation(async () => {
      claimsRef.current = HOUSEHOLD_B;
    });
    raiseEnvelopeSetPinFloor.mockReturnValue(false);

    // This is a known-committed outcome (the PUT
    // above already landed server-side), so it must throw the SAME error
    // class useDerivedRewrap's classifier recognizes as "committed, not
    // refused" — not the unexported EnvelopeSetPinFloorPersistenceError,
    // which fell through to a permanent-refusal classification.
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
    // The in-memory HDK and isUnlocked are cleared too
    // — not only the on-disk cache.
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
      // The switch lands strictly inside the RETRY's own await.
      claimsRef.current = HOUSEHOLD_B;
      throw new Error('retry fails too');
    });
    raiseEnvelopeSetPinFloor.mockReturnValue(true);

    await expect(result.current.rotatePasswordSlot('NewPassw0rd!')).rejects.toMatchObject({
      message: 'Session ended. Please sign in again.',
    });

    expect(raiseEnvelopeSetPinFloor).toHaveBeenCalledWith(NEXT_VERSION, 'hh-a');
    // The household-UNSCOPED clearCachedHdk() must never run here — that
    // would wipe household B's freshly-cached key over a failure that
    // belongs entirely to the retiring household A.
    expect(clearCachedHdk).not.toHaveBeenCalled();
  });

  it('a household switch landing strictly inside a "successful" writeEnvelopeSetPin never resolves quietly — it still raises the floor for the CAPTURED household', async () => {
    const { result, claimsRef } = await renderUnlocked();
    wireRotate();
    writeEnvelopeSetPin.mockImplementation(async (version: number) => {
      if (version !== NEXT_VERSION) return;
      // The write "succeeds" (no throw) but the switch landed inside its
      // own internal awaits before it resolved.
      claimsRef.current = HOUSEHOLD_B;
    });
    raiseEnvelopeSetPinFloor.mockReturnValue(true);

    await expect(result.current.rotatePasswordSlot('NewPassw0rd!')).rejects.toMatchObject({
      message: 'Session ended. Please sign in again.',
    });

    expect(raiseEnvelopeSetPinFloor).toHaveBeenCalledWith(NEXT_VERSION, 'hh-a');
  });
});
