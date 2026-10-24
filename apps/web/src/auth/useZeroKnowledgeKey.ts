// Zero-knowledge household-key hook: owns the in-memory HDK and the reactive unlock flags, and exposes the key
// lifecycle operations AuthContext threads through its context value. See docs/security.md "Unlocking".
import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { apiRequest, ApiRequestError } from '../api/client';
import { cacheHdk, clearCachedHdk, loadCachedHdk } from '../crypto/key-cache';
import {
  activateKeyEnvelopes,
  getKeyEnvelopes,
  upsertKeyEnvelopeSlot,
  type KeyEnvelopesResponse,
} from './key-envelope-client';
import {
  computeEnvelopeSetTag,
  generateHdk,
  generatePasskeyPrfSlot,
  generatePasswordSlot,
  generateRecoverySlot,
  isEnvelopeSetRollback,
  KeyWrappingError,
  raiseEnvelopeSetPinFloor,
  readEnvelopeSetPin,
  unwrapPrfSlot,
  unwrapSlot,
  verifyEnvelopeSetTag,
  writeEnvelopeSetPin,
} from '../crypto/key-wrapping';
import {
  addPrfEvalToOptions,
  derivePrfWrapKey,
  extractPrfResult,
  generatePrfSalt,
} from '../crypto/passkey-prf';
import type { KeyEnvelopeSlot } from '../crypto/encryption-types';
import { stepUpProofFields, type StepUpProof } from '../components/useStepUp';

// Best-effort pin write after first activation: the server already committed both slots, so a pin failure must never
// reject setup. Retries once, then raises the household-scoped fallback floor; if even that is unconfirmed it
// continues, since no earlier slot-bearing set exists to replay and the next verified unlock re-pins.
async function pinActivatedVersionBestEffort(
  version: number,
  deviceId: string | undefined,
  householdId: string,
): Promise<void> {
  try {
    await writeEnvelopeSetPin(version, deviceId);
    return;
  } catch {
    // Retried once below.
  }
  try {
    await writeEnvelopeSetPin(version, deviceId);
  } catch (retryErr) {
    if (!raiseEnvelopeSetPinFloor(version, householdId)) {
      console.warn('[setup] envelope-set pin could not be persisted after activation', retryErr);
    }
  }
}

const PASSKEY_PRF_SLOT_ID = 'passkey_prf';

// A served envelope-set version below the locally pinned one is a genuine rollback: the replayed older set carries its
// own valid tag, so the MAC cannot catch it. Subclasses KeyWrappingError so best-effort catches treat it as a
// verification failure.
class EnvelopeSetRollbackError extends KeyWrappingError {
  constructor(
    public readonly servedVersion: number,
    public readonly pinnedVersion: number,
  ) {
    super(
      `Envelope-set rollback detected: served version ${servedVersion} < pinned ${pinnedVersion}`,
    );
    this.name = 'EnvelopeSetRollbackError';
  }
}

// Both the `deviceMetadata` pin write and the localStorage floor failed for a just-committed password change, so this
// device holds no record that the version advanced. Callers must lock or clear the cached HDK and never resolve as
// though the floor were raised.
class EnvelopeSetPinFloorPersistenceError extends KeyWrappingError {
  constructor(
    public readonly version: number,
    public readonly originalError: unknown,
  ) {
    super(`Could not durably record the envelope-set pin floor at version ${version}`);
    this.name = 'EnvelopeSetPinFloorPersistenceError';
  }
}

/**
 * Thrown by `rotatePasswordSlot` when the server committed the re-wrapped `password` slot but this device's
 * rollback-pin bookkeeping needed a fallback: a known-committed outcome, never a refusal. `locked` is true only when
 * neither the durable pin nor the localStorage floor could be confirmed; the in-memory HDK is then already cleared,
 * since the device can no longer prove it is pinned above the retired set. When false the floor landed and the
 * workspace stays live.
 */
export class RewrapCommittedPinDegradedError extends Error {
  constructor(
    public readonly version: number,
    public readonly locked: boolean,
    public readonly originalError: unknown,
  ) {
    super(
      locked
        ? `Password slot committed at version ${version}, but no durable rollback record could be confirmed; this device was locked.`
        : `Password slot committed at version ${version}; the rollback pin fell back to the storage floor.`,
    );
    this.name = 'RewrapCommittedPinDegradedError';
  }
}

/**
 * Thrown by `setupEncryption`'s repair branch when the server refuses the missing-`recovery`-slot PUT with
 * `STEP_UP_PROOF_MISSING` and no proof was supplied: the repair is a `key_envelope_replace` write, so a stranded
 * household needs a fresh factor when `AUTH_MFA_ENFORCED` is on. `LoginPage` shows `StepUpModal` and retries with the
 * proof.
 */
export class SetupStepUpRequiredError extends Error {
  constructor() {
    super('A fresh factor is required to finish setting up encryption.');
    this.name = 'SetupStepUpRequiredError';
  }
}

/**
 * Thrown by `enrollPasskeyForEncryption` when the `passkey_prf` PUT failed without a server reply (dropped connection
 * or timeout): the server may have consumed the proof, so treat the outcome as ambiguous. Failures before that request
 * (no PRF result, locked session, cancelled prompt, tag/rollback mismatch) propagate untouched. `originalError` is the
 * cause.
 */
export class EnrollmentCommitAmbiguousError extends Error {
  constructor(public readonly originalError: unknown) {
    super(
      originalError instanceof Error
        ? originalError.message
        : 'The enrollment request did not complete.',
    );
    this.name = 'EnrollmentCommitAmbiguousError';
  }
}

// Types a transport failure as EnrollmentCommitAmbiguousError; a server reply (ApiRequestError) passes through, a clean
// 4xx being a definite rejection.
async function commitPasskeyPrfSlot(
  body: Parameters<typeof upsertKeyEnvelopeSlot>[1],
): Promise<void> {
  try {
    await upsertKeyEnvelopeSlot(PASSKEY_PRF_SLOT_ID, body);
  } catch (err) {
    if (err instanceof ApiRequestError) throw err;
    throw new EnrollmentCommitAmbiguousError(err);
  }
}

// Single chokepoint for every unlock and verification path, so the rollback guard cannot be forgotten on one: reject a
// served version below the pin (EnvelopeSetRollbackError), verify the set tag (KeyWrappingError), then advance the pin
// to max(pin, served). Both throws precede HDK adoption: fail closed.
async function verifyEnvelopeSetAndAdvancePin(
  envelopes: { slots: KeyEnvelopeSlot[]; envelopeSetVersion: number; envelopeSetTag: string },
  hdk: CryptoKey,
  householdId: string | undefined,
  deviceId?: string,
): Promise<void> {
  const pinned = await readEnvelopeSetPin(householdId);
  if (isEnvelopeSetRollback(envelopes.envelopeSetVersion, pinned)) {
    throw new EnvelopeSetRollbackError(envelopes.envelopeSetVersion, pinned);
  }
  await verifyEnvelopeSetTag(envelopes.slots, envelopes, hdk);
  // `deviceId` lets the pin persist when this is the first write, before any sync created the `deviceMetadata` row.
  await writeEnvelopeSetPin(envelopes.envelopeSetVersion, deviceId);
}

interface ZeroKnowledgeClaims {
  userId: string;
  householdId: string;
  // Seeds the pin row when setup or rotation precedes the first `deviceMetadata` sync write; without it a replay of an
  // old valid set passes the rollback check.
  deviceId?: string;
}

/** Dependencies the hook needs from AuthContext (no API client coupling). */
export interface ZeroKnowledgeKeyDeps {
  /** Live JWT claims, so a mid-flight logout / user switch can be detected. */
  claimsRef: MutableRefObject<ZeroKnowledgeClaims | null>;
  /**
   * Verifies the entered password server-side (POST /auth/verify-password); throws ApiRequestError(INVALID_CREDENTIALS)
   * on a mismatch. Injected to keep API wiring out of this hook.
   */
  verifyPassword(password: string): Promise<void>;
}

/** The key-management surface AuthContext threads into its context value. */
export interface ZeroKnowledgeKey {
  isUnlocked: boolean;
  needsKeySetup: boolean;
  unlockResolved: boolean;
  /**
   * True once {@link initializeUnlockState} saw a `passkey_prf` slot; shows the LoginPage "Unlock with passkey" button.
   * Reset on logout and new sign-in.
   */
  hasPasskeyPrfSlot: boolean;
  /**
   * True when {@link initializeUnlockState} was served an empty slot set on a device with evidence of a real key
   * (cached HDK or non-zero pin): why the device stops at the locked screen instead of starting fresh setup. An unkeyed
   * household resolves to {@link needsKeySetup}. Reset on logout and new sign-in.
   */
  lockedEnvelopeSetEmpty: boolean;
  getHdk(): CryptoKey | null;
  clearUnlockState(): void;
  initializeUnlockState(claims: ZeroKnowledgeClaims): Promise<void>;
  unlockWithPassword(password: string): Promise<void>;
  unlockWithRecovery(recoveryKey: string): Promise<void>;
  /**
   * User-initiated passkey-PRF unlock: a targeted second assertion against the `passkey_prf` slot's credential and
   * `prfSalt`, since the discoverable login assertion cannot carry the salt before the user is identified. Throws on no
   * PRF slot, no PRF result, or an unwrap/tag failure, so the button can surface it.
   */
  unlockWithPasskey(): Promise<void>;
  /**
   * First-time encryption setup, or on retry the repair of a household stranded with a `password` slot and no
   * `recovery` slot. `proof` rides on the repair write only (fresh activation is proofless); throws {@link
   * SetupStepUpRequiredError} when the repair needs a fresh factor and `proof` is omitted.
   */
  setupEncryption(password: string, proof?: StepUpProof): Promise<string>;
  /**
   * Re-wraps the `password` slot under `newPassword` (sole caller: `useDerivedRewrap.ts`). Returns silently only when
   * there is nothing to rotate (locked session, or no `password` slot); every other failure propagates (tag/rollback
   * mismatch, refused write, network fault) so the caller can tell "written" from "refused". A post-commit
   * pin-bookkeeping failure throws {@link RewrapCommittedPinDegradedError}, so the person is never told their password
   * was refused when it was not. The ordinary change-password flow uses {@link prepareRewrappedPasswordSlot}.
   */
  rotatePasswordSlot(newPassword: string, envelopesHint?: KeyEnvelopesResponse): Promise<void>;
  /**
   * Prepares the re-wrapped `password` slot for the atomic change-password commit (the re-wrap travels in the request
   * body). Throws when locked or signed out; first runs the fail-closed `verifyEnvelopeSetAndAdvancePin` on the live
   * slot set. Returns `null` for a recovery-only household. Call `confirmRewrap()` only after the server confirms the
   * commit: it advances the rollback pin to the prepared version, and never on a rejection.
   */
  prepareRewrappedPasswordSlot(newPassword: string): Promise<{
    slot: KeyEnvelopeSlot;
    envelopeSetVersion: number;
    expectedEnvelopeSetVersion: number;
    envelopeSetTag: string;
    confirmRewrap: () => Promise<void>;
  } | null>;
  /**
   * Prepares a recovery-key regeneration in two phases, so the rotation is invisible server-side until the user
   * confirms they saved the key. Unwrapping the `password` slot re-authenticates (a wrong password throws before
   * anything is minted); a fresh `recovery` slot over the same HDK is minted but not persisted, and the new display
   * string comes back with an `activate` thunk. Until `activate()` the old key keeps working; `activate()` PUTs the
   * slot and advances the pin, after which the old key stops. The raw bytes are never persisted. Prepare throws on a
   * wrong password, missing password slot or tampered set; `activate` throws on a tampered set, stale session or write
   * failure. `activate(proof)` takes a fresh factor proof, required only when `AUTH_MFA_ENFORCED` is on (replacing a
   * `recovery` slot is never step-up exempt). See docs/security.md "The three unlock slots".
   */
  regenerateRecoveryKey(
    password: string,
  ): Promise<{ recoveryKey: string; activate: (proof?: StepUpProof) => Promise<void> }>;
  /**
   * Re-caches the in-memory HDK in `keyCache` after an operation that wipes the cache but keeps the session (snapshot
   * restore, "Reload from server"), so a page refresh does not show the unlock prompt. Best-effort: no-ops when locked
   * or on an IDB write failure.
   */
  recacheHdk(): Promise<void>;
  /**
   * Enrolls a passkey as a PRF unlock method: a targeted WebAuthn assertion yields the PRF secret, the HDK is wrapped
   * into a `passkey_prf` slot bound to that credential, and the slot is PUT, replacing any existing one (one per
   * household). Needs an unlocked session; throws when locked, when no PRF result comes back, or on server rejection.
   * `currentPassword` is the password floor every enrollment carries in either `AUTH_MFA_ENFORCED` state. `proof` is a
   * fresh factor, required only when `AUTH_MFA_ENFORCED` is on (every write into a household that already holds a slot
   * needs one).
   */
  enrollPasskeyForEncryption(
    credentialId: string,
    currentPassword: string,
    proof?: StepUpProof,
  ): Promise<void>;
  /**
   * Best-effort passkey-PRF unlock. With `credentialId`, selects the `passkey_prf` slot bound to it; otherwise the
   * first one.
   */
  tryUnlockWithPrf(
    claims: ZeroKnowledgeClaims,
    prfResult: Uint8Array<ArrayBuffer>,
    credentialId?: string,
  ): Promise<void>;
  /**
   * Consumes (one-shot) the envelope-set response fetched during the unlock that just flipped `isUnlocked`, if it still
   * matches the live session, so `useDerivedRewrap` can skip a second `GET /auth/key-envelopes` against the 20/min
   * budget. Null when none is available; the caller then fetches fresh.
   */
  takeLastUnlockEnvelopes(): KeyEnvelopesResponse | null;
}

export function useZeroKnowledgeKey(deps: ZeroKnowledgeKeyDeps): ZeroKnowledgeKey {
  const { claimsRef, verifyPassword } = deps;

  // The HDK lives only in a ref: a CryptoKey is not serializable and must not leak into devtools-inspectable state.
  // `isUnlocked` is the reactive mirror.
  const hdkRef = useRef<CryptoKey | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [needsKeySetup, setNeedsKeySetup] = useState(false);
  const [unlockResolved, setUnlockResolved] = useState(false);
  const [hasPasskeyPrfSlot, setHasPasskeyPrfSlot] = useState(false);
  const [lockedEnvelopeSetEmpty, setLockedEnvelopeSetEmpty] = useState(false);
  const getHdk = useCallback((): CryptoKey | null => hdkRef.current, []);

  // The verified response from the unlock that just flipped `isUnlocked`, kept for `useDerivedRewrap`'s rising-edge
  // `runDerive()` to reuse instead of spending a second read of the shared 20/min budget. Tagged with its claims so a
  // session switch never reuses a stale household's response; `takeLastUnlockEnvelopes` checks that and clears it.
  const lastUnlockEnvelopesRef = useRef<{
    userId: string;
    householdId: string;
    envelopes: KeyEnvelopesResponse;
  } | null>(null);

  const takeLastUnlockEnvelopes = useCallback((): KeyEnvelopesResponse | null => {
    const entry = lastUnlockEnvelopesRef.current;
    lastUnlockEnvelopesRef.current = null;
    if (!entry) return null;
    const claims = claimsRef.current;
    if (!claims || claims.userId !== entry.userId || claims.householdId !== entry.householdId) {
      return null;
    }
    return entry.envelopes;
  }, [claimsRef]);

  // Session-staleness predicate over a captured claims snapshot. A logout, idle timeout or user switch can land
  // mid-flight, so every state write is guarded against the live claims. Fire-and-forget runs abandon silently;
  // user-initiated ones throw "Session ended" so the caller can surface it.
  const makeIsStale = useCallback(
    (claims: ZeroKnowledgeClaims): (() => boolean) => {
      const capturedUserId = claims.userId;
      const capturedHouseholdId = claims.householdId;
      return (): boolean =>
        claimsRef.current?.userId !== capturedUserId ||
        claimsRef.current?.householdId !== capturedHouseholdId;
    },
    [claimsRef],
  );

  const clearUnlockState = useCallback(() => {
    hdkRef.current = null;
    setIsUnlocked(false);
    setNeedsKeySetup(false);
    setUnlockResolved(false);
    setHasPasskeyPrfSlot(false);
    setLockedEnvelopeSetEmpty(false);
    // A session drop must never let the next session reuse a response fetched under the old one
    // (takeLastUnlockEnvelopes also checks claims).
    lastUnlockEnvelopesRef.current = null;
  }, []);

  // Verifies a cached HDK against a non-empty live slot set (an empty set is handled in initializeUnlockState, so the
  // cached key is never dropped just because the server claims no envelopes). Returns the key on a passing tag, else
  // drops it and returns null.
  const verifyAndAdoptCachedHdk = useCallback(
    async (cached: CryptoKey, envelopes: KeyEnvelopesResponse): Promise<CryptoKey | null> => {
      try {
        // A served set below the pin throws EnvelopeSetRollbackError, a tampered one KeyWrappingError; either way drop
        // the cached key rather than ride it.
        await verifyEnvelopeSetAndAdvancePin(
          envelopes,
          cached,
          claimsRef.current?.householdId,
          claimsRef.current?.deviceId,
        );
        return cached;
      } catch {
        // The user falls back to a fresh password unlock, which re-runs the same guard.
        await clearCachedHdk();
        return null;
      }
    },
    [claimsRef],
  );

  // After authentication settles: bring a cached HDK into memory and learn whether the household has key envelopes.
  // Best-effort and fire-and-forget: a failure never breaks login, the LoginPage shows the unlock prompt instead.
  const initializeUnlockState = useCallback(
    async (claims: ZeroKnowledgeClaims): Promise<void> => {
      const isStale = makeIsStale(claims);
      try {
        // Load the cached HDK but do not trust it: the envelope-set tag must be verified after every unlock, the
        // cached-key path included, so fetch the envelopes first and mark `isUnlocked` only once the cached key
        // verifies the live set.
        const cached = await loadCachedHdk(claims.householdId);
        if (isStale()) return;
        let envelopes: KeyEnvelopesResponse;
        try {
          envelopes = await getKeyEnvelopes();
        } catch {
          // The cached key cannot be verified, so do not trust it; still mark the lifecycle resolved (the prompt gate
          // keys off it) if this run owns the session.
          if (!isStale()) setUnlockResolved(true);
          return;
        }
        if (isStale()) return;
        // A missing or non-array `slots` reads as no envelopes, as a network omission would.
        const slots = Array.isArray(envelopes.slots) ? envelopes.slots : [];
        // Lets the LoginPage show "Unlock with passkey" only when there is a slot to target.
        setHasPasskeyPrfSlot(slots.some((slot: KeyEnvelopeSlot) => slot.slotType === 'passkey_prf'));
        if (slots.length === 0) {
          // Empty served set: either a genuinely unkeyed household (TOFU, needs setup) or a keyed device served an
          // empty set by a misbehaving server. Trust "needs setup" only when the device has no evidence of a real key
          // (no cached HDK, no rollback pin); otherwise stop at the locked screen rather than mint a new household key
          // over one that may still be real.
          const pin = await readEnvelopeSetPin(claims.householdId);
          if (isStale()) return;
          if (cached || pin > 0) {
            setLockedEnvelopeSetEmpty(true);
          } else {
            setNeedsKeySetup(true);
          }
          if (isStale()) return;
          setUnlockResolved(true);
          return;
        }
        if (cached) {
          // Verify the cached key against the live set first; the helper drops it on a tag mismatch, and a failure
          // leaves isUnlocked and needsKeySetup false so the LoginPage prompts for the password.
          const trusted = await verifyAndAdoptCachedHdk(cached, envelopes);
          if (isStale()) return;
          if (trusted) {
            hdkRef.current = trusted;
            setIsUnlocked(true);
            // The response useDerivedRewrap's rising-edge runDerive() needs; hand it over instead of forcing a second
            // GET.
            lastUnlockEnvelopesRef.current = {
              userId: claims.userId,
              householdId: claims.householdId,
              envelopes,
            };
          }
        }
        if (isStale()) return;
        setUnlockResolved(true);
      } catch {
        // Defensive: never let unlock initialization throw into the login path.
        if (!isStale()) setUnlockResolved(true);
      }
    },
    [makeIsStale, verifyAndAdoptCachedHdk],
  );

  // Recovers the HDK from a `passkey_prf` slot using the assertion's PRF result. Best-effort: any failure leaves
  // isUnlocked false so the LoginPage falls back to the password prompt; PRF never blocks login.
  const tryUnlockWithPrf = useCallback(
    async (
      claims: ZeroKnowledgeClaims,
      prfResult: Uint8Array<ArrayBuffer>,
      credentialId?: string,
    ): Promise<void> => {
      const isStale = makeIsStale(claims);
      try {
        const envelopes = await getKeyEnvelopes();
        const prfSlots = envelopes.slots.filter(
          (slot: KeyEnvelopeSlot) => slot.slotType === 'passkey_prf',
        );
        // Prefer the slot bound to the assertion credential, then an unbound legacy slot, then the first; the fallbacks
        // keep the single-slot path unlocking.
        const prfSlot =
          (credentialId &&
            prfSlots.find((slot) => slot.credentialBinding === credentialId)) ||
          prfSlots.find((slot) => slot.credentialBinding == null) ||
          prfSlots[0];
        if (!prfSlot) return;
        const wrapKey = await derivePrfWrapKey(prfResult);
        const hdk = await unwrapPrfSlot(prfSlot, wrapKey);
        await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
        if (isStale()) return;
        hdkRef.current = hdk;
        setIsUnlocked(true);
        lastUnlockEnvelopesRef.current = {
          userId: claims.userId,
          householdId: claims.householdId,
          envelopes,
        };
        if (isStale()) return;
        await cacheHdk(claims.householdId, hdk);
      } catch {
        // PRF unsupported / failed — password fallback handles it.
      }
    },
    [makeIsStale],
  );

  const unlockWithPassword = useCallback(
    async (password: string): Promise<void> => {
      const claims = claimsRef.current;
      if (!claims) throw new Error('Cannot unlock before signing in');
      const isStale = makeIsStale(claims);
      const envelopes = await getKeyEnvelopes();
      const passwordSlot = envelopes.slots.find(
        (slot: KeyEnvelopeSlot) => slot.slotType === 'password',
      );
      if (!passwordSlot) throw new Error('No password unlock slot for this account');
      // Throws KeyWrappingError on a wrong password or tampered slot metadata (the wrap AAD binds the KDF params, so a
      // downgrade fails closed).
      const hdk = await unwrapSlot(passwordSlot, password);
      // Rollback guard, tag verification and pin advance; throws before the HDK is adopted.
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      hdkRef.current = hdk;
      setIsUnlocked(true);
      setNeedsKeySetup(false);
      lastUnlockEnvelopesRef.current = {
        userId: claims.userId,
        householdId: claims.householdId,
        envelopes,
      };
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      await cacheHdk(claims.householdId, hdk);
    },
    [claimsRef, makeIsStale],
  );

  // Recovery-key unlock: mirrors unlockWithPassword (staleness guard, envelope-set-tag verification before trusting the
  // key, device caching) against the `recovery` slot.
  const unlockWithRecovery = useCallback(
    async (recoveryKey: string): Promise<void> => {
      const claims = claimsRef.current;
      if (!claims) throw new Error('Cannot unlock before signing in');
      const isStale = makeIsStale(claims);
      const envelopes = await getKeyEnvelopes();
      const recoverySlot = envelopes.slots.find(
        (slot: KeyEnvelopeSlot) => slot.slotType === 'recovery',
      );
      if (!recoverySlot) throw new Error('No recovery unlock slot for this account');
      // Throws KeyWrappingError on a wrong recovery key or tampered slot metadata.
      const hdk = await unwrapSlot(recoverySlot, recoveryKey);
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      hdkRef.current = hdk;
      setIsUnlocked(true);
      setNeedsKeySetup(false);
      lastUnlockEnvelopesRef.current = {
        userId: claims.userId,
        householdId: claims.householdId,
        envelopes,
      };
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      await cacheHdk(claims.householdId, hdk);
    },
    [claimsRef, makeIsStale],
  );

  // Repair for a household stranded with a `password` slot and no `recovery` slot (an interrupted two-PUT activation):
  // unwrap the password slot to recover the original HDK, then PUT only the recovery slot at the next version. The
  // write is `key_envelope_replace`, so it needs a fresh factor when `AUTH_MFA_ENFORCED` is on; without `proof`, a
  // `STEP_UP_PROOF_MISSING` refusal throws SetupStepUpRequiredError. A household holding both slots is refused:
  // re-minting `recovery` would silently invalidate a key another tab or device already showed (a reload takes the
  // unlock path).
  const completeFromExistingPasswordSlot = useCallback(
    async (
      householdId: string,
      password: string,
      existing: KeyEnvelopesResponse,
      existingPasswordSlot: KeyEnvelopeSlot,
      isStale: () => boolean,
      proof?: StepUpProof,
    ): Promise<{ hdk: CryptoKey; recoveryKey: string; finalVersion: number }> => {
      if (existing.slots.some((slot: KeyEnvelopeSlot) => slot.slotType === 'recovery')) {
        throw new Error(
          'Encryption is already set up for this account; unlock it with the password instead of re-running setup.',
        );
      }
      const hdk = await unwrapSlot(existingPasswordSlot, password);
      const generated = await generateRecoverySlot(householdId, 'recovery', hdk);
      const nextVersion = existing.envelopeSetVersion + 1;
      const tag = await computeEnvelopeSetTag(
        [existingPasswordSlot, generated.slot],
        nextVersion,
        hdk,
      );
      // A logout or user switch can land after the awaits above; the PUT uses the live bearer token and would write
      // into another session's envelope set.
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      try {
        await upsertKeyEnvelopeSlot('recovery', {
          slot: generated.slot,
          envelopeSetVersion: nextVersion,
          envelopeSetTag: tag,
          ...stepUpProofFields(proof),
        });
      } catch (err) {
        if (
          proof === undefined &&
          err instanceof ApiRequestError &&
          err.error.code === 'STEP_UP_PROOF_MISSING'
        ) {
          throw new SetupStepUpRequiredError();
        }
        throw err;
      }
      return { hdk, recoveryKey: generated.recoveryKey, finalVersion: nextVersion };
    },
    [],
  );

  // Fresh activation: one atomic call writes the whole initial slot set (password + recovery) at a single version bump,
  // so no half-committed state is observable. Proofless: the server refuses `activate` on a non-empty set.
  // `baseVersion` is the already-committed version (0 when clean); a meta-only residue from an earlier attempt would
  // otherwise 409 STALE_ENVELOPE_VERSION.
  const activateFreshSlots = useCallback(
    async (
      householdId: string,
      password: string,
      baseVersion: number,
      isStale: () => boolean,
    ): Promise<{ hdk: CryptoKey; recoveryKey: string; finalVersion: number }> => {
      const hdk = await generateHdk();
      const passwordSlot = await generatePasswordSlot(householdId, 'password', password, hdk);
      const generated = await generateRecoverySlot(householdId, 'recovery', hdk);
      const finalVersion = baseVersion + 1;
      const tag = await computeEnvelopeSetTag(
        [passwordSlot, generated.slot],
        finalVersion,
        hdk,
      );
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      await activateKeyEnvelopes({
        slots: [passwordSlot, generated.slot],
        envelopeSetVersion: finalVersion,
        envelopeSetTag: tag,
      });
      return { hdk, recoveryKey: generated.recoveryKey, finalVersion };
    },
    [],
  );

  const setupEncryption = useCallback(
    async (password: string, proof?: StepUpProof): Promise<string> => {
      const claims = claimsRef.current;
      if (!claims) throw new Error('Cannot set up encryption before signing in');
      const isStale = makeIsStale(claims);
      const householdId = claims.householdId;

      // Verify the entered password first: a typo would mint a `password` slot the account password can never unwrap,
      // silently locking the user out. A wrong one throws ApiRequestError(INVALID_CREDENTIALS) before any slot exists.
      await verifyPassword(password);

      // Fetch the current slot set so setup is idempotent across a partial failure: an existing password slot means a
      // prior call persisted it, so recover the original HDK and PUT only the missing recovery slot. An empty set takes
      // fresh activation from the committed version, so meta-only residue does not conflict.
      const existing = await getKeyEnvelopes();
      const existingPasswordSlot = existing.slots.find(
        (slot: KeyEnvelopeSlot) => slot.slotType === 'password',
      );
      const { hdk, recoveryKey, finalVersion } = existingPasswordSlot
        ? await completeFromExistingPasswordSlot(
            householdId,
            password,
            existing,
            existingPasswordSlot,
            isStale,
            proof,
          )
        : await activateFreshSlots(householdId, password, existing.envelopeSetVersion, isStale);

      // Everything from here is a local step after the server commit: a failure must not reject setup, or the caller
      // would never get the one-time recovery key and the only retry would be a proofless replace of the live
      // `recovery` slot that the step-up gate refuses. Best-effort, like `recacheHdk`. Setup writes the authoritative
      // set, so the pin advances directly to the written version (no tag to verify); `deviceId` lets it persist before
      // the first sync.
      await pinActivatedVersionBestEffort(finalVersion, claims.deviceId, householdId);

      if (isStale()) throw new Error('Session ended. Please sign in again.');
      hdkRef.current = hdk;
      setIsUnlocked(true);
      setNeedsKeySetup(false);
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      try {
        await cacheHdk(householdId, hdk);
      } catch (err) {
        // An IDB write failure only costs a password prompt on the next
        // reload; it must not swallow the one-time recovery key.
        console.warn('[setup] device key cache write failed after activation', err);
      }
      return recoveryKey;
    },
    [claimsRef, makeIsStale, verifyPassword, completeFromExistingPasswordSlot, activateFreshSlots],
  );

  // Fetches the slot set fresh so the version is monotonic, replaces only the password slot at `envelopeSetVersion +
  // 1`, and carries the recovery and PRF slots through the tag unchanged. The caller (`useDerivedRewrap.ts`) classifies
  // every propagated failure. `envelopesHint` is a verified-fresh response from the same transition, sparing the silent
  // repair a second rate-limited read; it is still verified against the in-memory HDK below. The prompted path omits
  // it: real time has passed.
  const rotatePasswordSlot = useCallback(
    async (newPassword: string, envelopesHint?: KeyEnvelopesResponse): Promise<void> => {
      const hdk = hdkRef.current;
      if (!hdk) return;
      const claims = claimsRef.current;
      if (!claims) return;
      const isStale = makeIsStale(claims);
      const envelopes = envelopesHint ?? (await getKeyEnvelopes());
      const existingPasswordSlot = envelopes.slots.find(
        (slot: KeyEnvelopeSlot) => slot.slotType === 'password',
      );
      // A recovery-only household has no password slot to rotate, and nothing is owed.
      if (!existingPasswordSlot) return;
      // Verify the fetched set against the in-memory HDK before re-wrapping: a stripped or injected set must not get a
      // new tag persisted as authoritative. Never attributable to a wrong password.
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      const newSlot = await generatePasswordSlot(
        claims.householdId,
        existingPasswordSlot.slotId,
        newPassword,
        hdk,
      );
      const nextVersion = envelopes.envelopeSetVersion + 1;
      const nextSlots = envelopes.slots.map((slot: KeyEnvelopeSlot) =>
        slot.slotType === 'password' ? newSlot : slot,
      );
      const tag = await computeEnvelopeSetTag(nextSlots, nextVersion, hdk);
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      // The server stamps the slot with the writing session's credential revision and refuses with `409
      // UPGRADE_REQUIRED` when that is stale or absent; the refusal propagates and the caller re-authenticates and
      // retries.
      await upsertKeyEnvelopeSlot(newSlot.slotId, {
        slot: newSlot,
        envelopeSetVersion: nextVersion,
        envelopeSetTag: tag,
      });
      // Re-check ownership after the PUT: a logout into a different household while it is in flight can drop and
      // recreate IndexedDB, so an unconditional pin write would land in the new household's unscoped `deviceMetadata`
      // and corrupt its rollback pin. The write is already committed for the captured household, so preserve a floor
      // for it via the household-scoped fallback and stop. A `false` from `raiseEnvelopeSetPinFloor` (storage
      // unavailable, quota boundary) means no durable record exists anywhere, so every stale-session branch escalates
      // identically.
      const escalateStaleFloor = (originalError?: unknown): never => {
        const persisted = raiseEnvelopeSetPinFloor(nextVersion, claims.householdId);
        if (!persisted) {
          // Runs after the PUT committed `nextVersion`, so this is a known-committed outcome, not a refusal: throw
          // RewrapCommittedPinDegradedError, which `useDerivedRewrap` classifies as committed (a
          // KeyWrappingError-derived error would read as a refusal although the password was accepted). `locked` is
          // false: the session is stale here, not locked.
          throw new RewrapCommittedPinDegradedError(nextVersion, false, originalError);
        }
        throw new Error('Session ended. Please sign in again.');
      };
      if (isStale()) escalateStaleFloor();
      // Advance the pin to the written version: the verify above pinned only the old version N, and a pin left at N
      // lets an adversarial server replay the old N set (valid tag, isEnvelopeSetRollback(N, N) is false) and undo the
      // rotation. This is a post-commit step (like `confirmRewrap`), so a pin-write failure is a known-committed
      // outcome: retry once, then raise the household-scoped floor, and if that is unconfirmed lock the live workspace
      // so the next unlock re-verifies from scratch. Both failure branches throw RewrapCommittedPinDegradedError rather
      // than an error that reads like a write that never landed. `isStale` goes into the write itself so a household
      // switch inside its internal awaits aborts before committing to the new household's recreated `deviceMetadata`
      // row; the checks below cover a switch outside those awaits.
      try {
        await writeEnvelopeSetPin(nextVersion, claims.deviceId, isStale);
      } catch (firstErr) {
        if (isStale()) escalateStaleFloor(firstErr);
        try {
          await writeEnvelopeSetPin(nextVersion, claims.deviceId, isStale);
        } catch (retryErr) {
          // The retry is itself an await: a household switch here must not reach the unscoped `clearCachedHdk()` below
          // and wipe the new household's freshly cached key.
          if (isStale()) escalateStaleFloor(retryErr);
          const persisted = raiseEnvelopeSetPinFloor(nextVersion, claims.householdId);
          if (!persisted) {
            // Neither the durable pin nor the floor is confirmed: lock the live workspace (not only the IDB cache),
            // since the in-memory HDK can no longer be proven pinned above the retired set.
            hdkRef.current = null;
            setIsUnlocked(false);
            await clearCachedHdk();
            throw new RewrapCommittedPinDegradedError(nextVersion, true, retryErr);
          }
          throw new RewrapCommittedPinDegradedError(nextVersion, false, retryErr);
        }
      }
      // A write that resolves is not proof it landed in the captured household's row: a switch inside its internal
      // awaits can land it on the new household's recreated `deviceMetadata`. Fall back to the scoped floor rather than
      // resolve quietly.
      if (isStale()) escalateStaleFloor();
    },
    [claimsRef, makeIsStale],
  );

  const prepareRewrappedPasswordSlot = useCallback(
    async (
      newPassword: string,
    ): Promise<{
      slot: KeyEnvelopeSlot;
      envelopeSetVersion: number;
      expectedEnvelopeSetVersion: number;
      envelopeSetTag: string;
      confirmRewrap: () => Promise<void>;
    } | null> => {
      const hdk = hdkRef.current;
      if (!hdk) throw new Error('Unlock your data before changing your password.');
      const claims = claimsRef.current;
      if (!claims) throw new Error('Cannot change the password before signing in.');
      const isStale = makeIsStale(claims);
      const envelopes = await getKeyEnvelopes();
      const existingPasswordSlot = envelopes.slots.find(
        (slot: KeyEnvelopeSlot) => slot.slotType === 'password',
      );
      // A recovery-only household has no password slot: the caller commits the credential alone.
      if (!existingPasswordSlot) return null;
      // Verify the fetched set before generating the new slot and tag, so a stripped or injected set is never blessed
      // during a change.
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      const newSlot = await generatePasswordSlot(
        claims.householdId,
        existingPasswordSlot.slotId,
        newPassword,
        hdk,
      );
      const nextVersion = envelopes.envelopeSetVersion + 1;
      // Replace exactly the canonical password slot by id, not `slotType`: a stray second password-typed row stays
      // unchanged in the tag, so the server's noncanonical-slot rejection remains the only way that state resolves.
      const nextSlots = envelopes.slots.map((slot: KeyEnvelopeSlot) =>
        slot.slotId === existingPasswordSlot.slotId ? newSlot : slot,
      );
      const tag = await computeEnvelopeSetTag(nextSlots, nextVersion, hdk);
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      return {
        slot: newSlot,
        envelopeSetVersion: nextVersion,
        expectedEnvelopeSetVersion: envelopes.envelopeSetVersion,
        envelopeSetTag: tag,
        confirmRewrap: async () => {
          // Advance the pin only after the server confirms the commit: the pre-flight verify pinned the old version,
          // and advancing off a bare served version would let a replayed old set undo the change.
          try {
            await writeEnvelopeSetPin(nextVersion, claims.deviceId);
          } catch (err) {
            // The durable pin write failed after the server committed: a pin left at the predecessor would accept a
            // replay of the old set, so raise the household-scoped localStorage floor (an unscoped key would survive an
            // account switch and block a different household). A `false` return means nothing durable recorded it:
            // surface EnvelopeSetPinFloorPersistenceError. Either branch throws so the caller's lock/retry handling
            // runs.
            const persisted = raiseEnvelopeSetPinFloor(nextVersion, claims.householdId);
            if (!persisted) {
              throw new EnvelopeSetPinFloorPersistenceError(nextVersion, err);
            }
            throw err;
          }
        },
      };
    },
    [claimsRef, makeIsStale],
  );

  const regenerateRecoveryKey = useCallback(
    async (
      password: string,
    ): Promise<{ recoveryKey: string; activate: () => Promise<void> }> => {
      const claims = claimsRef.current;
      if (!claims) throw new Error('Cannot regenerate a recovery key before signing in');
      const isStale = makeIsStale(claims);
      const envelopes = await getKeyEnvelopes();
      const passwordSlot = envelopes.slots.find(
        (slot: KeyEnvelopeSlot) => slot.slotType === 'password',
      );
      if (!passwordSlot) {
        throw new Error(
          'No password is set up for this account, so a recovery key cannot be regenerated.',
        );
      }
      // Unwrapping the password slot re-authenticates (a wrong password throws KeyWrappingError before any slot is
      // minted) and yields the canonical HDK.
      const hdk = await unwrapSlot(passwordSlot, password);
      // Rollback and tag checks first, so a key is never shown for a tampered or replayed set.
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      // Reuse the existing recovery slot's id so the PUT replaces it in place.
      const existingRecovery = envelopes.slots.find(
        (slot: KeyEnvelopeSlot) => slot.slotType === 'recovery',
      );
      const recoverySlotId = existingRecovery?.slotId ?? 'recovery';
      // Mint the slot and key but do not PUT yet; the HDK is immutable, so the slot stays valid for `activate()`.
      const generated = await generateRecoverySlot(claims.householdId, recoverySlotId, hdk);

      const activate = async (proof?: StepUpProof): Promise<void> => {
        // Re-fetch so the version is monotonic even if another device changed the set, and re-verify against the fresh
        // set and pin: fail closed.
        const current = await getKeyEnvelopes();
        await verifyEnvelopeSetAndAdvancePin(current, hdk, claims.householdId, claims.deviceId);
        const others = current.slots.filter(
          (slot: KeyEnvelopeSlot) => slot.slotType !== 'recovery',
        );
        const nextSlots = [...others, generated.slot];
        const nextVersion = current.envelopeSetVersion + 1;
        const tag = await computeEnvelopeSetTag(nextSlots, nextVersion, hdk);
        if (isStale()) throw new Error('Session ended. Please sign in again.');
        // Replacing a `recovery` slot is never step-up exempt, so the fresh factor proof rides along when
        // `AUTH_MFA_ENFORCED` is on.
        await upsertKeyEnvelopeSlot(recoverySlotId, {
          slot: generated.slot,
          envelopeSetVersion: nextVersion,
          envelopeSetTag: tag,
          ...stepUpProofFields(proof),
        });
        // Advance the pin to the written version (see rotatePasswordSlot); otherwise a replay of the old set restores
        // the previous recovery key.
        await writeEnvelopeSetPin(nextVersion, claims.deviceId);
      };

      return { recoveryKey: generated.recoveryKey, activate };
    },
    [claimsRef, makeIsStale],
  );

  // Deliberately skips the makeIsStale guard: the write is household-keyed and `loadCachedHdk` rejects another
  // household's entry, so a stale write self-corrects.
  const recacheHdk = useCallback(async (): Promise<void> => {
    const hdk = hdkRef.current;
    const householdId = claimsRef.current?.householdId;
    if (!hdk || !householdId) return;
    try {
      await cacheHdk(householdId, hdk);
    } catch {
      // Best-effort: a failed write only costs a password prompt on refresh.
    }
  }, [claimsRef]);

  // Targeted WebAuthn assertion for a chosen passkey's PRF secret: take a server challenge from `POST
  // /auth/passkey/authenticate/start`, override `allowCredentials` to the credential and add the PRF eval for
  // `prfSalt`. The assertion is not finished (the user is already authenticated; the challenge expires by TTL). Throws
  // if the authenticator returns no PRF output.
  const obtainPrfSecretForCredential = useCallback(
    async (credentialId: string, prfSalt: string): Promise<Uint8Array<ArrayBuffer>> => {
      const options = await apiRequest<PublicKeyCredentialRequestOptionsJSON>(
        '/api/v1/auth/passkey/authenticate/start',
        { method: 'POST', auth: false },
      );
      const targeted: PublicKeyCredentialRequestOptionsJSON = {
        ...options,
        allowCredentials: [{ id: credentialId, type: 'public-key' }],
      };
      const withPrf = addPrfEvalToOptions(targeted, prfSalt);
      const response = await startAuthentication({ optionsJSON: withPrf });
      const prfResult = extractPrfResult(response);
      if (!prfResult) {
        throw new KeyWrappingError('passkey did not return a PRF result (unsupported)');
      }
      return prfResult;
    },
    [],
  );

  const unlockWithPasskey = useCallback(
    async (): Promise<void> => {
      const claims = claimsRef.current;
      if (!claims) throw new Error('Cannot unlock before signing in');
      const isStale = makeIsStale(claims);
      const envelopes = await getKeyEnvelopes();
      const prfSlot = envelopes.slots.find(
        (slot: KeyEnvelopeSlot) => slot.slotType === 'passkey_prf',
      );
      if (!prfSlot || !prfSlot.credentialBinding || !prfSlot.prfSalt) {
        throw new Error('No passkey is set up to unlock your data on this device.');
      }
      // Throws KeyWrappingError when the authenticator returns no PRF result, so the UI shows the right message.
      const prfResult = await obtainPrfSecretForCredential(
        prfSlot.credentialBinding,
        prfSlot.prfSalt,
      );
      const wrapKey = await derivePrfWrapKey(prfResult);
      const hdk = await unwrapPrfSlot(prfSlot, wrapKey);
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      hdkRef.current = hdk;
      setIsUnlocked(true);
      setNeedsKeySetup(false);
      lastUnlockEnvelopesRef.current = {
        userId: claims.userId,
        householdId: claims.householdId,
        envelopes,
      };
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      await cacheHdk(claims.householdId, hdk);
    },
    [claimsRef, makeIsStale, obtainPrfSecretForCredential],
  );

  const enrollPasskeyForEncryption = useCallback(
    async (credentialId: string, currentPassword: string, proof?: StepUpProof): Promise<void> => {
      const hdk = hdkRef.current;
      if (!hdk) throw new Error('Unlock your data before enabling a passkey for encryption.');
      const claims = claimsRef.current;
      if (!claims) throw new Error('Cannot enroll a passkey before signing in');
      const isStale = makeIsStale(claims);
      const prfSalt = generatePrfSalt();
      const prfResult = await obtainPrfSecretForCredential(credentialId, prfSalt);
      const wrapKey = await derivePrfWrapKey(prfResult);
      const slot = await generatePasskeyPrfSlot(
        claims.householdId,
        PASSKEY_PRF_SLOT_ID,
        wrapKey,
        hdk,
        prfSalt,
        credentialId,
      );
      // One per household: replace any existing passkey_prf slot.
      const envelopes = await getKeyEnvelopes();
      // Verify the fetched set before re-tagging, as unlockWithPassword does. A user-initiated enrollment propagates
      // the error: no PUT is issued.
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      const others = envelopes.slots.filter(
        (s: KeyEnvelopeSlot) => s.slotType !== 'passkey_prf',
      );
      const nextSlots = [...others, slot];
      const nextVersion = envelopes.envelopeSetVersion + 1;
      const tag = await computeEnvelopeSetTag(nextSlots, nextVersion, hdk);
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      // A passkey_prf write is never step-up exempt, first enrollment included, and carries the password floor in
      // either `AUTH_MFA_ENFORCED` state. This is the one request carrying the proof; a transport failure is typed
      // EnrollmentCommitAmbiguousError so the caller can tell "outcome unknown" from the local failures above.
      await commitPasskeyPrfSlot({
        slot,
        envelopeSetVersion: nextVersion,
        envelopeSetTag: tag,
        currentPassword,
        ...stepUpProofFields(proof),
      });
      // Advance the pin to the written version (see rotatePasswordSlot).
      await writeEnvelopeSetPin(nextVersion, claims.deviceId);
    },
    [claimsRef, makeIsStale, obtainPrfSecretForCredential],
  );

  return {
    isUnlocked,
    needsKeySetup,
    unlockResolved,
    hasPasskeyPrfSlot,
    lockedEnvelopeSetEmpty,
    getHdk,
    clearUnlockState,
    initializeUnlockState,
    unlockWithPassword,
    unlockWithRecovery,
    unlockWithPasskey,
    setupEncryption,
    rotatePasswordSlot,
    prepareRewrappedPasswordSlot,
    regenerateRecoveryKey,
    recacheHdk,
    enrollPasskeyForEncryption,
    tryUnlockWithPrf,
    takeLastUnlockEnvelopes,
  };
}
