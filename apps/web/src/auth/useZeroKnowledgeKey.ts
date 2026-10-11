/**
 * Zero-knowledge household-key management hook, extracted from
 * AuthContext to keep that file under the shape limit. Owns the in-memory
 * household data key (HDK) plus the reactive unlock flags, and exposes the
 * key lifecycle operations the AuthContext threads through its context value:
 *
 *   - `initializeUnlockState` — post-login cached-HDK + envelope-set resolution
 *   - `unlockWithPassword`    — recover the HDK from the password slot
 *   - `unlockWithRecovery`    — recover the HDK from the recovery slot
 *   - `setupEncryption`       — first-time activation (idempotent on retry)
 *   - `rotatePasswordSlot`    — re-wrap the password slot under a new password
 *   - `enrollPasskeyForEncryption` — add a passkey as a PRF unlock method
 *   - `tryUnlockWithPrf`      — best-effort passkey-PRF unlock
 *   - `clearUnlockState`      — drop the in-memory HDK + flags (logout/switch)
 *
 * The HDK is held only in a ref (never React state — a CryptoKey isn't
 * serializable and must not leak into devtools-inspectable state); `isUnlocked`
 * is the reactive mirror the UI subscribes to. See "Unlocking" in
 * docs/security.md.
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why it cannot be split: the
 * rollback-pin wiring must thread the served version + device id through all
 * 9 verification/unlock/rotate paths AND the post-PUT pin advance for
 * setup/rotate/enroll/recovery-regen, all of which already live in this hook;
 * the wrap/unwrap + pin primitives are in `key-wrapping.ts`, so moving the
 * orchestration out would create an import cycle (the hook re-exports
 * `EnvelopeSetRollbackError extends KeyWrappingError`). The unlock/rotate
 * paths are tightly coupled to the in-memory `hdkRef` + the reactive unlock
 * flags + the per-session staleness predicate; a separate `useEnvelopeSetPin`
 * hook would have to re-export that internal state, trading one over-cap file
 * for two coupled ones with a worse boundary. The same holds for the pieces
 * that look separable: `regenerateRecoveryKey` is the recovery-slot sibling of
 * `rotatePasswordSlot`, sharing the same primitives, staleness predicate, and
 * `verifyEnvelopeSetAndAdvancePin` chokepoint; the empty-served-slot-set
 * handling ("trust needs-setup only with no cached key AND no pin") reuses the
 * same staleness predicate, `readEnvelopeSetPin`, and reactive-flag chokepoint
 * `initializeUnlockState` already threads through; and the optional step-up
 * proof threaded into `regenerateRecoveryKey`'s `activate`,
 * `completeFromExistingPasswordSlot` and `enrollPasskeyForEncryption` is a
 * parameter on write paths that already exist, not a new subsystem.
 * Extracting any of them alone would recreate that coupling across a new
 * file. Trigger: a change adding 5 or more lines here must either refactor
 * the file back under the limit or re-justify this exception in this note.
 */
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

/**
 * Best-effort rollback-pin write after FIRST activation. The server has already committed both setup slots by the
 * time this runs, so a pin-write failure must never reject setup (see
 * `setupEncryption`). Retry once; if the durable pin still cannot be written,
 * raise the household-scoped fallback floor instead (mirrors
 * `rotatePasswordSlot`'s post-commit handling); if even that cannot be
 * confirmed, continue anyway — this is first activation, so no earlier
 * slot-bearing set exists for a replay to restore, and the next verified
 * unlock re-pins.
 */
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

/** Server-issued slot id for the single per-household passkey-PRF slot. */
const PASSKEY_PRF_SLOT_ID = 'passkey_prf';

/**
 * Thrown when a served key-envelope set's version is strictly below this
 * device's locally pinned version. A genuine rollback: the
 * server/operator/stale backend replayed an older valid slot set (which carries
 * its own valid `envelopeSetTag`, so the MAC alone cannot catch it). Surfaced
 * so the unlock path refuses the cached/unwrapped HDK rather than adopting a
 * rolled-back set. Subclass of {@link KeyWrappingError} so the existing
 * best-effort catches (e.g. `rotatePasswordSlot`) treat it as a verification
 * failure and never bless a rolled-back set.
 */
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

/**
 * Thrown by `confirmRewrap` when BOTH the durable
 * `deviceMetadata` pin write and the localStorage-floor fallback failed to
 * persist the version a just-committed password change advanced to. Unlike
 * an ordinary pin-write failure — where the localStorage floor still lands
 * and durably blocks a replay of the retired version — this device now holds
 * NO record anywhere that the version advanced. The caller must treat this
 * at least as strictly as the ordinary failure (lock / clear the cached HDK)
 * and never resolve as though the floor were raised.
 */
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
 * Thrown by `rotatePasswordSlot`'s post-commit pin bookkeeping
 * when the server already committed the re-wrapped `password` slot but this
 * device's local rollback-pin bookkeeping needed a fallback afterwards. This
 * is a KNOWN-COMMITTED outcome, never an ordinary refusal: the new password DID take effect server-side, so
 * `useDerivedRewrap` must classify it as a completed re-wrap, not a refusal
 * to be retried.
 *
 * `locked` is `true` only when NEITHER the durable `deviceMetadata` pin
 * write NOR the localStorage fallback floor could be confirmed anywhere on
 * this device — in that case `rotatePasswordSlot` has already cleared the
 * in-memory HDK and flipped `isUnlocked` false, same
 * as clearing the IDB cache: this device can no longer prove it is pinned
 * above the retired set, so the whole live workspace locks, not only the
 * on-disk cache. `locked` is `false` when the fallback floor DID land: the
 * commit is fully protected against replay and the workspace stays live —
 * only the caller-facing copy needs to note that a fallback was used.
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
 * Thrown by `setupEncryption`'s repair branch (`completeFromExistingPasswordSlot`)
 * when the server refuses the missing-
 * `recovery`-slot PUT with `STEP_UP_PROOF_MISSING` and the caller supplied no
 * proof. The repair write is `key_envelope_replace` like every other
 * post-first-activation write, so a stranded household (a `password` slot,
 * no `recovery` slot — an interrupted pre-cutover activation) now needs a
 * fresh factor when `AUTH_MFA_ENFORCED` is on, where the old two-PUT
 * activation shape never did. `LoginPage` catches this, shows the reusable
 * `StepUpModal`, and retries `setupEncryption(password, proof)` with the
 * collected proof — no new step-up purpose, no persisted setup record.
 */
export class SetupStepUpRequiredError extends Error {
  constructor() {
    super('A fresh factor is required to finish setting up encryption.');
    this.name = 'SetupStepUpRequiredError';
  }
}

/**
 * Thrown by `enrollPasskeyForEncryption` when the factor-carrying
 * `passkey_prf` PUT failed WITHOUT a server reply — a dropped connection or
 * the client timeout, the only failures `apiRequest` leaves unwrapped. The
 * server may already have consumed the proof, so the caller must treat this
 * as AMBIGUOUS, never as a clean local
 * failure. Every failure BEFORE that request — no PRF result, a locked or
 * ended session, a cancelled WebAuthn prompt, a tag/rollback mismatch —
 * propagates untouched: no proof was sent, so the caller can name the real
 * cause. The original message is kept so existing
 * message-based handling reads the same text; `originalError` is the cause.
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

/**
 * Send the factor-carrying `passkey_prf` PUT for `enrollPasskeyForEncryption`,
 * typing a transport failure as {@link EnrollmentCommitAmbiguousError}. A
 * server reply (`ApiRequestError`) passes through unchanged — a clean 4xx is
 * a definite rejection the caller may retry with a fresh factor.
 */
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

/**
 * Verify a served key-envelope set against BOTH the rollback pin and the
 * HDK-keyed set tag, then advance the pin. Single chokepoint
 * for every unlock/verification path (cached-HDK adoption, password/recovery/
 * PRF unlock, password-change + PRF-enrollment re-tag, setup/recovery
 * completion) so the rollback guard cannot be forgotten on one path:
 *
 *  1. reject when `servedVersion < pinnedVersion` (replay of an older set);
 *  2. verify the envelope-set tag (slot stripping/reorder/injection);
 *  3. advance the device pin to `max(pin, servedVersion)` so a later replay of
 *     this-or-older is refused.
 *
 * Throws {@link EnvelopeSetRollbackError} on (1) and {@link KeyWrappingError}
 * on (2), both before the caller adopts the HDK — fail closed.
 */
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
  // Pass `deviceId` so the pin still persists when this is the first write
  // before any sync created the `deviceMetadata` row.
  await writeEnvelopeSetPin(envelopes.envelopeSetVersion, deviceId);
}

/** JWT claims subset the key hook needs to scope unlock state to a session. */
interface ZeroKnowledgeClaims {
  userId: string;
  householdId: string;
  /**
   * This session's device id. Threaded into the rollback-pin
   * writes so a setup/rotation that happens before the first sync write of
   * `deviceMetadata` can still seed the pin row — without it a later replay of
   * an old valid set passes the rollback check. Optional so legacy callers that
   * only carry user/household still type-check.
   */
  deviceId?: string;
}

/** Dependencies the hook needs from AuthContext (no API client coupling). */
export interface ZeroKnowledgeKeyDeps {
  /** Live JWT claims, so a mid-flight logout / user switch can be detected. */
  claimsRef: MutableRefObject<ZeroKnowledgeClaims | null>;
  /**
   * Verify the entered password against the account credential server-side
   * (POST /auth/verify-password). Throws ApiRequestError(INVALID_CREDENTIALS)
   * on a wrong password. Injected so this hook stays free of API-client wiring.
   */
  verifyPassword(password: string): Promise<void>;
}

/** The key-management surface AuthContext threads into its context value. */
export interface ZeroKnowledgeKey {
  isUnlocked: boolean;
  needsKeySetup: boolean;
  unlockResolved: boolean;
  /**
   * `true` once {@link initializeUnlockState} has fetched a slot set that
   * contains a `passkey_prf` slot (one per household). Drives the LoginPage
   * "Unlock with passkey" button: only shown when the household actually has an
   * enrolled PRF slot to target. Reset on every logout / new sign-in.
   */
  hasPasskeyPrfSlot: boolean;
  /**
   * `true` when {@link initializeUnlockState} was served an EMPTY key-envelope
   * slot set on a device that already has evidence of a real key here — a
   * cached HDK, or a non-zero rollback pin. A genuinely
   * unkeyed household never sets this (TOFU first contact still resolves to
   * {@link needsKeySetup}); this flag is read-only context for WHY the device
   * stopped at the locked screen rather than starting fresh setup on its own.
   * Reset on every logout / new sign-in.
   */
  lockedEnvelopeSetEmpty: boolean;
  getHdk(): CryptoKey | null;
  clearUnlockState(): void;
  initializeUnlockState(claims: ZeroKnowledgeClaims): Promise<void>;
  unlockWithPassword(password: string): Promise<void>;
  unlockWithRecovery(recoveryKey: string): Promise<void>;
  /**
   * User-initiated passkey-PRF unlock from the post-login unlock prompt.
   * Unlike the best-effort discoverable-login PRF attempt
   * ({@link tryUnlockWithPrf}), this runs a *targeted* second assertion against
   * the enrolled `passkey_prf` slot's bound credential + `prfSalt` — the
   * discoverable login assertion can't carry the PRF salt before the user is
   * identified, so this explicit path supersedes that limitation. Throws on no
   * PRF slot, an authenticator that returns no PRF result, or an unwrap/tag
   * failure, so the button can surface the error (it never silently swallows).
   */
  unlockWithPasskey(): Promise<void>;
  /**
   * First-time encryption setup, or — on a retry — the repair completion of a
   * household stranded with a `password` slot and no `recovery` slot.
   * `proof`, when supplied, rides along on
   * the repair branch's `recovery`-slot write only (fresh activation is
   * always proofless). Throws {@link SetupStepUpRequiredError} when the repair
   * branch needs a fresh factor and `proof` was omitted — the caller collects
   * one (`StepUpModal`/`useStepUp`) and retries with it.
   */
  setupEncryption(password: string, proof?: StepUpProof): Promise<string>;
  /**
   * Re-wrap the `password` slot under `newPassword` (sole caller:
   * `useDerivedRewrap.ts`). No-ops silently ONLY when
   * there is nothing to rotate: a locked session (`getHdk()` null) or a
   * household with no `password` slot at all. Every other failure — a tag/
   * rollback mismatch on the freshly-fetched slot set, a stale/refused write
   * (`ApiRequestError`), a network fault — now PROPAGATES rather than being
   * swallowed, so the caller can distinguish "written" from "refused" from
   * "refused for a non-credential reason" and act on it (retry, prompt, or
   * record a diagnostic) instead of the change silently never landing.
   * The ordinary change-password flow
   * uses {@link prepareRewrappedPasswordSlot} instead, which already threw on
   * every failure. A post-commit pin-bookkeeping failure — the server-side
   * write already succeeded, only this device's local rollback record needs
   * attention — throws {@link RewrapCommittedPinDegradedError} distinctly
   * from an ordinary refusal, so the caller
   * never tells the person their password was refused when it was not.
   */
  rotatePasswordSlot(newPassword: string, envelopesHint?: KeyEnvelopesResponse): Promise<void>;
  /**
   * Prepare the re-wrapped `password` slot for the ATOMIC change-password
   * commit — the re-wrap travels IN the
   * change-password request body rather than as a separate best-effort PUT.
   * Throws when the session is locked (no HDK) or before sign-in: the change
   * is offered only on an unlocked workspace. Fetches the live slot set and,
   * before generating anything, runs the same fail-closed
   * `verifyEnvelopeSetAndAdvancePin` check every unlock/rotate path runs
   * — a stripped or injected slot set is refused rather than blessed.
   * Returns `null` when the household holds no `password` slot at all (a
   * recovery-only household) — the caller commits the credential alone. On a
   * non-null return, `confirmRewrap()` must be called ONLY after the server
   * confirms the commit — it advances the device rollback pin to the version
   * this prepared, never on a rejection and never off a bare server-served
   * version: the pre-flight verify above only pins the OLD version.
   */
  prepareRewrappedPasswordSlot(newPassword: string): Promise<{
    slot: KeyEnvelopeSlot;
    envelopeSetVersion: number;
    expectedEnvelopeSetVersion: number;
    envelopeSetTag: string;
    confirmRewrap: () => Promise<void>;
  } | null>;
  /**
   * Prepare a recovery-key regeneration, two-phase so the
   * rotation isn't visible server-side until the user confirms they saved the new
   * key. Re-authenticates by unwrapping the `password` slot with the entered
   * account password (a wrong password throws before anything is minted), mints a
   * FRESH `recovery` slot wrapping the same HDK but does NOT persist it, and
   * returns the new grouped recovery-key display string plus an `activate` thunk.
   * Until `activate()` is called nothing changes — the existing recovery key keeps
   * working; only `activate()` PUTs the prepared slot and advances the rollback
   * pin, at which point the old key stops working. The raw recovery bytes are
   * never persisted, so re-displaying the original is impossible — rotating
   * is the only way back from a lost key. Prepare throws on a wrong password /
   * missing password slot / tampered set; `activate()` throws on a tampered set,
   * stale session, or write failure. See "The three unlock slots" in docs/security.md.
   *
   * `activate(proof)`: replacing an existing
   * `recovery` slot is a write the server's step-up gate never exempts, so
   * `activate` carries an OPTIONAL fresh factor proof — required only when
   * `AUTH_MFA_ENFORCED` is on (the caller collects it via `StepUpModal` /
   * `useStepUp`, mirroring every other gated op).
   */
  regenerateRecoveryKey(
    password: string,
  ): Promise<{ recoveryKey: string; activate: (proof?: StepUpProof) => Promise<void> }>;
  /**
   * Re-cache the in-memory HDK in the device `keyCache` store after an operation
   * that wipes the cache but leaves the unlocked session intact — snapshot
   * restore and Settings → Workspace → Reload from server both run `clearAllStores()`, which
   * drops `keyCache` while the in-memory HDK survives, so a subsequent page
   * refresh would otherwise miss the cache and show the unlock prompt.
   * Best-effort:
   * no-ops silently when the session is locked (no HDK in memory) or when the
   * IDB write fails, so it never gates the restore success path.
   */
  recacheHdk(): Promise<void>;
  /**
   * Enroll a passkey as a zero-knowledge unlock method:
   * obtain a PRF secret from the named credential via a targeted WebAuthn
   * assertion, wrap the HDK into a `passkey_prf` slot bound to that
   * credential, and PUT it — replacing any existing PRF slot (one per
   * household). Requires an unlocked session (HDK in memory); throws on a
   * locked session, an authenticator that does not return a PRF result, or a
   * server rejection (e.g. the credential is not enrolled for this account).
   *
   * `currentPassword` is the password floor
   * this write ALWAYS carries — the first-ever enrollment as much as a
   * replace — in EITHER `AUTH_MFA_ENFORCED` state; the server refuses the
   * write without a correct password. `proof` is the OPTIONAL fresh factor,
   * required only when `AUTH_MFA_ENFORCED` is on (every write into a
   * household that already holds a slot now requires one — the old
   * first-ever/brand-new-slot-id exemption is gone).
   */
  enrollPasskeyForEncryption(
    credentialId: string,
    currentPassword: string,
    proof?: StepUpProof,
  ): Promise<void>;
  /**
   * Best-effort passkey-PRF unlock. When `credentialId` is provided, selects the
   * `passkey_prf` slot whose `credentialBinding` matches it; otherwise falls back
   * to the first `passkey_prf` slot (backwards-compatible).
   */
  tryUnlockWithPrf(
    claims: ZeroKnowledgeClaims,
    prfResult: Uint8Array<ArrayBuffer>,
    credentialId?: string,
  ): Promise<void>;
  /**
   * Consume (and clear) the envelope-set response fetched + verified during
   * the unlock that just flipped `isUnlocked`, if it still matches the live
   * session — lets `useDerivedRewrap`'s rising-edge `runDerive()` reuse it
   * instead of spending a second `GET /auth/key-envelopes` on the same 20/min
   * budget the unlock itself may still need. Returns null
   * when none is available (a stale/mismatched session, or a later on-demand
   * `runDerive()` call after the unlock has already settled), in which case
   * the caller falls back to its own fresh fetch.
   */
  takeLastUnlockEnvelopes(): KeyEnvelopesResponse | null;
}

export function useZeroKnowledgeKey(deps: ZeroKnowledgeKeyDeps): ZeroKnowledgeKey {
  const { claimsRef, verifyPassword } = deps;

  // The HDK is held only in memory (never in React state — a CryptoKey isn't
  // serializable and must not leak into devtools-inspectable state);
  // `isUnlocked` is the reactive mirror the UI subscribes to.
  const hdkRef = useRef<CryptoKey | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [needsKeySetup, setNeedsKeySetup] = useState(false);
  const [unlockResolved, setUnlockResolved] = useState(false);
  const [hasPasskeyPrfSlot, setHasPasskeyPrfSlot] = useState(false);
  const [lockedEnvelopeSetEmpty, setLockedEnvelopeSetEmpty] = useState(false);
  const getHdk = useCallback((): CryptoKey | null => hdkRef.current, []);

  /**
   * The verified envelope-set response from the unlock that just flipped
   * `isUnlocked`, kept only long enough for `useDerivedRewrap`'s rising-edge
   * `runDerive()` to reuse it — every unlock branch already
   * spends one of the shared 20/min `GET /auth/key-envelopes` reads verifying
   * the envelope-set tag; re-fetching immediately after, for the SAME unlock,
   * would burn a second read off the same budget the unlock itself may still
   * need. Tagged with the claims it was fetched for so a consumer can never
   * reuse a stale household's response after a session switch;
   * `takeLastUnlockEnvelopes` both checks that match and clears the ref
   * (one-shot — any LATER on-demand `runDerive()` call always fetches fresh).
   */
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

  /** Build a session-staleness predicate from a captured claims snapshot. */
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

  /** Drop the in-memory HDK + reactive unlock flags (not the IDB cache). */
  const clearUnlockState = useCallback(() => {
    hdkRef.current = null;
    setIsUnlocked(false);
    setNeedsKeySetup(false);
    setUnlockResolved(false);
    setHasPasskeyPrfSlot(false);
    setLockedEnvelopeSetEmpty(false);
    // A session drop must never let the next session's
    // runDerive() reuse an envelope response fetched under the OLD session
    // (takeLastUnlockEnvelopes already guards on claims match, but dropping it
    // here too is the belt-and-suspenders version — nothing to lose by it).
    lastUnlockEnvelopesRef.current = null;
  }, []);

  /**
   * Verify a cached HDK against the live slot set before trusting it.
   * Returns the cached key on a passing tag, or null (and drops the cached
   * key) when the tag fails (slot stripping/reorder/injection). Callers only
   * reach this with a NON-EMPTY slot set — an empty set is handled centrally
   * in {@link initializeUnlockState} before this runs, so
   * the cached key is never blindly dropped just because the server claims no
   * envelopes exist. Extracted from {@link initializeUnlockState} to keep that
   * function's nesting ≤ 3.
   */
  const verifyAndAdoptCachedHdk = useCallback(
    async (cached: CryptoKey, envelopes: KeyEnvelopesResponse): Promise<CryptoKey | null> => {
      try {
        // Rollback guard + tag verification + pin advance. A served set
        // below this device's pin (replay of an older valid set) throws
        // EnvelopeSetRollbackError; a tampered set throws KeyWrappingError —
        // either way drop the cached key rather than ride a rolled-back/tampered
        // set.
        await verifyEnvelopeSetAndAdvancePin(
          envelopes,
          cached,
          claimsRef.current?.householdId,
          claimsRef.current?.deviceId,
        );
        return cached;
      } catch {
        // Tag mismatch or rollback: drop the cached key; the user falls back to
        // a fresh password unlock (which re-runs the same guard).
        await clearCachedHdk();
        return null;
      }
    },
    [claimsRef],
  );

  /**
   * After authentication settles, bring the household data key into memory if
   * the device already has it cached, and learn whether the household has any
   * key envelopes. Best-effort + fire-and-forget: a failure here must never
   * break login — the LoginPage shows the password unlock prompt instead.
   *
   * For a household with no envelope yet, the cached-HDK lookup
   * misses and the envelope fetch returns an empty set → `needsKeySetup` true
   * and `isUnlocked` false.
   */
  const initializeUnlockState = useCallback(
    async (claims: ZeroKnowledgeClaims): Promise<void> => {
      // Capture the session this run is for. A logout or user switch can land
      // mid-flight (this is fire-and-forget); guard every state write against the
      // live claims so a stale household's result never overwrites a newer
      // session. Once stale, abandon the run entirely.
      const isStale = makeIsStale(claims);
      try {
        // Load the cached HDK (if any) but do NOT trust it yet: the
        // envelope-set tag must be verified after every unlock —
        // including the cached-key path — to detect slot stripping/reorder/
        // injection. We therefore fetch the envelopes first and only mark
        // `isUnlocked` once the cached key has verified the live slot set.
        const cached = await loadCachedHdk(claims.householdId);
        if (isStale()) return;
        let envelopes: KeyEnvelopesResponse;
        try {
          envelopes = await getKeyEnvelopes();
        } catch {
          // Network/endpoint failure — we cannot verify the cached key against
          // the slot set, so we must NOT trust it (no `isUnlocked`). The unlock
          // prompt (or a later retry) handles recovery. Still mark the lifecycle
          // resolved (the prompt gate keys off this), but only if this run owns
          // the session.
          if (!isStale()) setUnlockResolved(true);
          return;
        }
        if (isStale()) return;
        // Treat a missing / non-array `slots` field as empty rather than
        // throwing — a malformed server response reads as
        // "no envelopes", the same posture a network omission would produce.
        const slots = Array.isArray(envelopes.slots) ? envelopes.slots : [];
        // Surface whether the household has an enrolled passkey_prf slot (one per
        // household) so the LoginPage can show the "Unlock with passkey"
        // button only when there is actually a slot to target.
        setHasPasskeyPrfSlot(slots.some((slot: KeyEnvelopeSlot) => slot.slotType === 'passkey_prf'));
        if (slots.length === 0) {
          // Empty served slot set: ambiguous between a
          // genuinely unkeyed household (TOFU first contact — needs setup)
          // and a device that has already keyed this household, now served
          // an empty set by a misbehaving/compromised server. Trust "needs
          // setup" ONLY when this device carries NO evidence of a real key
          // here — no cached HDK and no rollback pin. Otherwise the cached
          // key is doubted, never dropped: stop at the locked screen instead
          // of walking the user into minting a brand-new household key over
          // one that may still be real.
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
          // Cached key path: verify it against the live slot set before
          // trusting it. The helper returns the key only on a passing tag,
          // and drops the cached key on a tag mismatch. Never silently ride a
          // key past a failed tag. (A non-empty set that fails the tag leaves
          // isUnlocked=false and needsKeySetup=false so the LoginPage prompts
          // for the password — unchanged.)
          const trusted = await verifyAndAdoptCachedHdk(cached, envelopes);
          if (isStale()) return;
          if (trusted) {
            hdkRef.current = trusted;
            setIsUnlocked(true);
            // This is the exact response useDerivedRewrap's
            // rising-edge runDerive() needs for its owed-ness compare — hand
            // it over instead of forcing a second GET.
            lastUnlockEnvelopesRef.current = {
              userId: claims.userId,
              householdId: claims.householdId,
              envelopes,
            };
          }
        }
        // A non-empty set with no cached key leaves `isUnlocked` false so the
        // LoginPage surfaces the password unlock prompt.
        if (isStale()) return;
        setUnlockResolved(true);
      } catch {
        // Defensive: never let unlock initialization throw into the login path.
        if (!isStale()) setUnlockResolved(true);
      }
    },
    [makeIsStale, verifyAndAdoptCachedHdk],
  );

  /**
   * Try to recover the HDK from a `passkey_prf` slot using a PRF result the
   * authenticator returned during the assertion. Best-effort:
   * any failure (no PRF slot, derivation/unwrap/tag failure) silently leaves
   * `isUnlocked` false so the LoginPage falls back to the password prompt — PRF
   * must never block login.
   * The PRF wrap-key derivation lives in passkey-prf.ts so this hook delegates
   * the WebCrypto step rather than reimplementing it.
   */
  const tryUnlockWithPrf = useCallback(
    async (
      claims: ZeroKnowledgeClaims,
      prfResult: Uint8Array<ArrayBuffer>,
      credentialId?: string,
    ): Promise<void> => {
      // Capture the session this run is for. A logout or user switch can land
      // mid-flight (this is fire-and-forget after a passkey assertion); guard
      // every state write against the live claims so a stale household's PRF
      // result never overwrites a newer session. Background
      // unlock → a stale run abandons silently.
      const isStale = makeIsStale(claims);
      try {
        const envelopes = await getKeyEnvelopes();
        const prfSlots = envelopes.slots.filter(
          (slot: KeyEnvelopeSlot) => slot.slotType === 'passkey_prf',
        );
        // When the assertion credential is known, prefer the slot bound to it so
        // the right PRF secret is matched to the right slot. Fall back to a
        // PRF slot with no binding (a slot enrolled before credentialBinding
        // shipped) and finally to the first PRF slot — both keep the legacy
        // single-slot path unlocking. Absent a credentialId, use the first slot.
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
        // Hand the just-verified response to useDerivedRewrap
        // instead of forcing a second GET for the same unlock.
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
      // Capture the session this unlock is for. The user types the password
      // while the session is live, but a logout / idle-timeout / user switch can
      // land between the async awaits below; guard every state write against the
      // live claims so a stale household's HDK never overwrites a newer session.
      // This is user-initiated, so a stale run throws so the
      // caller's unlock handler surfaces a clear "session ended" outcome rather
      // than silently writing into the wrong session.
      const isStale = makeIsStale(claims);
      const envelopes = await getKeyEnvelopes();
      const passwordSlot = envelopes.slots.find(
        (slot: KeyEnvelopeSlot) => slot.slotType === 'password',
      );
      if (!passwordSlot) throw new Error('No password unlock slot for this account');
      // unwrapSlot throws KeyWrappingError on a wrong password or tampered slot
      // metadata (the wrap AAD binds the KDF params, so a downgrade fails closed).
      const hdk = await unwrapSlot(passwordSlot, password);
      // Reject a rolled-back set, verify the whole slot set against the
      // HDK-keyed tag (slot stripping/reorder/injection), then advance the pin.
      // Throws EnvelopeSetRollbackError / KeyWrappingError before adoption.
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      hdkRef.current = hdk;
      setIsUnlocked(true);
      setNeedsKeySetup(false);
      // Hand the just-verified response to useDerivedRewrap
      // instead of forcing a second GET for the same unlock.
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

  /**
   * Recovery-key unlock path: recover the HDK from the `recovery` slot using the
   * grouped recovery-key display string the user saved at setup. Mirrors
   * {@link unlockWithPassword} (same staleness guard, same envelope-set-tag
   * verification before trusting the key, same device caching) but unwraps the
   * recovery slot instead of the password slot. `unwrapSlot` throws
   * KeyWrappingError on a wrong/malformed recovery key. User-initiated, so a
   * stale run throws so the caller surfaces a clear "session ended" outcome.
   */
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
      // unwrapSlot throws KeyWrappingError on a wrong recovery key or tampered
      // slot metadata (the wrap AAD binds the slot fields, so a downgrade fails
      // closed).
      const hdk = await unwrapSlot(recoverySlot, recoveryKey);
      // Reject a rolled-back set, verify the HDK-keyed tag (slot stripping/
      // reorder/injection), then advance the pin. Throws before adoption.
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      hdkRef.current = hdk;
      setIsUnlocked(true);
      setNeedsKeySetup(false);
      // Hand the just-verified response to useDerivedRewrap
      // instead of forcing a second GET for the same unlock.
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

  /**
   * Recovery-completion path: a password
   * slot already exists but NO recovery slot does — a household stranded by
   * an interrupted PRE-CUTOVER two-PUT activation (this repair proof-carrying
   * PUT, not a first-time activation, is what finishes it now; a genuinely
   * fresh household never reaches this branch — see {@link activateFreshSlots}).
   * Recover the ORIGINAL HDK by unwrapping the password slot so the recovery
   * slot wraps the same key, then PUT only the recovery slot at the next
   * monotonic version. This write is `key_envelope_replace` like every other
   * write into a household that already holds a slot, so it now REQUIRES a
   * fresh factor when `AUTH_MFA_ENFORCED` is on — `proof`, when supplied,
   * rides along; when the server refuses `STEP_UP_PROOF_MISSING` with no
   * proof supplied, this throws {@link SetupStepUpRequiredError} so
   * `LoginPage` can show the reusable `StepUpModal` and retry with a proof.
   *
   * A household that already holds BOTH slots is fully set up, and this path
   * REFUSES it: re-minting the `recovery` slot would
   * replace live key material, silently invalidating a recovery key another
   * tab or device already showed and had saved. The "completed setup whose
   * final local step failed" retry this branch used to serve no longer
   * arises: {@link setupEncryption} treats every post-commit local step as
   * best-effort and always returns the key. Reaching this state anyway
   * (another tab finished setup first) surfaces as a setup error; a reload
   * takes the unlock path, since the slots exist.
   * Extracted to keep {@link setupEncryption} ≤ 60 lines.
   */
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
      // A logout / user switch can land after getKeyEnvelopes / unwrapSlot
      // returned. The PUT uses the live bearer token, so writing now would land
      // this setup material in a different session's envelope set. Bail
      // before the write if the session is no longer ours.
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

  /**
   * Fresh-activation path: no slot exists
   * yet. One atomic call writes the WHOLE initial slot set (password +
   * recovery) at a single version bump — replacing the old two-PUT sequence
   * whose intermediate "password committed, recovery not yet" state the
   * retired step-up exemption used to serve. Proofless: the server's
   * `activate` route refuses outright when the set is not genuinely empty, so
   * there is nothing to prove a factor against here.
   *
   * `baseVersion` is the already-committed envelope-set version (0 for a
   * truly clean household). This handles the "meta-only residue" case:
   * a prior attempt can leave `{ slots: [], envelopeSetVersion: N }`
   * with `N > 0`; starting from `baseVersion` (not a hard-coded 0) keeps the
   * activation monotonic past the already-committed version instead of
   * conflicting → `409 STALE_ENVELOPE_VERSION`. Extracted to keep
   * {@link setupEncryption} ≤ 60 lines.
   */
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
      // A logout / user switch can land after getKeyEnvelopes returned. The
      // write uses the live bearer token, so writing now would land this setup
      // material in a different session's envelope set.
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
      // Same staleness guard as unlockWithPassword: the user types the password
      // while the session is live, but a logout / idle-timeout / user switch can
      // land between awaits. Guard every state write so a stale household's HDK
      // never overwrites a newer session. User-initiated → a
      // stale run throws so LoginPage surfaces a clear "session ended" outcome.
      const isStale = makeIsStale(claims);
      const householdId = claims.householdId;

      // Verify the entered password is the current account password BEFORE we
      // wrap the HDK with it. Without this, a typo or a different
      // password would mint a `password` slot the account password can never
      // unwrap — silently locking the user out of their own data. A wrong
      // password throws ApiRequestError(INVALID_CREDENTIALS) here, so no
      // envelope slot is ever created against an unverified password.
      await verifyPassword(password);

      // Fetch the current slot set so setup is idempotent across a partial
      // failure. An existing password slot means a prior call persisted
      // it; recover the ORIGINAL HDK and PUT only the missing recovery slot. An
      // empty slot set takes the fresh-activation path, starting from the
      // already-committed envelope-set version so a meta-only residue (meta
      // bumped, slot PUT failed) doesn't conflict with the stored version.
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

      // Everything from here on is a LOCAL step after the server commit: both slots are live, so a failure here must NOT
      // reject setup — the caller would never receive the recovery key (which
      // can never be shown again), `needsKeySetup` would stay true, and the
      // only retry would be a proofless replace of the live `recovery` slot
      // that the step-up gate refuses. Best-effort, like `recacheHdk`.
      //
      // Pin the version this device just activated so a later replay of an
      // older set is refused. Setup writes the authoritative set, so there is no
      // tag to verify here — advance the pin directly to the written version.
      // Pass deviceId so the pin persists even when setup runs before the first
      // sync wrote `deviceMetadata`.
      await pinActivatedVersionBestEffort(finalVersion, claims.deviceId, householdId);

      // Hold + cache the HDK and flip the reactive unlock flags. Guard against a
      // session that ended mid-setup before writing any in-memory state.
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

  /**
   * Re-wrap the `password` slot under `newPassword`.
   * Fetches the current slot set fresh so the new version is
   * monotonically correct, replaces ONLY the password slot at
   * `envelopeSetVersion + 1`, and preserves the recovery + PRF slots unchanged
   * in the tag computation.
   *
   * No-ops silently ONLY when there is nothing to rotate — a locked session
   * (`getHdk()` null, `claimsRef` empty) or a household with no `password`
   * slot at all. Every other failure PROPAGATES (no swallow): a tag/rollback
   * mismatch on the freshly-fetched set (`KeyWrappingError` /
   * `EnvelopeSetRollbackError` — never overwrite a slot that fails to verify),
   * a refused write (`ApiRequestError`, e.g. `409 UPGRADE_REQUIRED` when the
   * writing session's recorded credential revision has gone stale, or a
   * network fault). The caller (`useDerivedRewrap.ts`) is responsible for
   * classifying the throw and deciding whether to retry, prompt, or record a
   * diagnostic — this hook only owns the crypto + the write.
   *
   * `envelopesHint`, when supplied, is used instead of a fresh
   * `getKeyEnvelopes()` read: the caller already holds a
   * verified-fresh response from the same unlock-state transition (the
   * unlock's own read, or the derive's), and re-fetching here would spend a
   * SECOND rate-limited round trip on the same silent repair. Still verified
   * against the in-memory HDK below before anything is trusted, so a
   * stale/tampered hint can never be blessed. Omitted (fresh fetch) for the
   * prompted path, where real time has passed since any prior read.
   */
  const rotatePasswordSlot = useCallback(
    async (newPassword: string, envelopesHint?: KeyEnvelopesResponse): Promise<void> => {
      const hdk = hdkRef.current;
      // Locked session: no HDK in memory to re-wrap.
      if (!hdk) return;
      const claims = claimsRef.current;
      if (!claims) return;
      const isStale = makeIsStale(claims);
      const envelopes = envelopesHint ?? (await getKeyEnvelopes());
      const existingPasswordSlot = envelopes.slots.find(
        (slot: KeyEnvelopeSlot) => slot.slotType === 'password',
      );
      // No password slot to rotate (e.g. a recovery-only household): nothing to
      // do — the new password has no slot to re-wrap, and nothing is owed.
      if (!existingPasswordSlot) return;
      // Verify the freshly-fetched slot set against the in-memory HDK before
      // re-wrapping anything, matching unlockWithPassword /
      // unlockWithRecovery. Without this a stripped/injected slot set could be
      // blessed — the new tag would be computed over a tampered set and
      // persisted as authoritative. Throws on mismatch/rollback; the slot is
      // never overwritten for this reason (never attributable to a wrong
      // password).
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      const newSlot = await generatePasswordSlot(
        claims.householdId,
        existingPasswordSlot.slotId,
        newPassword,
        hdk,
      );
      const nextVersion = envelopes.envelopeSetVersion + 1;
      // Tag over the full slot set with the new password slot in place of the
      // old one — recovery + PRF slots are carried through unchanged so the set
      // tag still verifies after the rotation.
      const nextSlots = envelopes.slots.map((slot: KeyEnvelopeSlot) =>
        slot.slotType === 'password' ? newSlot : slot,
      );
      const tag = await computeEnvelopeSetTag(nextSlots, nextVersion, hdk);
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      // The server stamps the slot with the WRITING SESSION's recorded
      // credential revision and conditions the write on it still matching the
      // credential's current revision — refused with
      // `409 UPGRADE_REQUIRED` when the session's recorded authority is stale
      // or absent. That refusal propagates here; the caller re-authenticates
      // the plaintext and retries.
      await upsertKeyEnvelopeSlot(newSlot.slotId, {
        slot: newSlot,
        envelopeSetVersion: nextVersion,
        envelopeSetTag: tag,
      });
      // Re-check ownership AFTER the PUT resolves: the
      // pre-PUT `isStale()` check above only guards the request itself. A
      // logout from THIS household into a different one while the PUT is in
      // flight can drop and recreate IndexedDB in between, so an unconditional
      // pin write below would land in the NEW household's live (unscoped)
      // `deviceMetadata` — corrupting its rollback pin if its real version is
      // lower. The write already committed server-side for the CAPTURED
      // household, so preserve a floor for it through the household-scoped
      // fallback (never the live IndexedDB pin) and stop without touching IDB.
      //
      // `raiseEnvelopeSetPinFloor`'s return is checked:
      // a silent `false` (storage
      // unavailable / a write landing on a quota boundary, per its own
      // docstring) would otherwise leave this device with NO durable record
      // anywhere that the version advanced, behind a "Session ended" message
      // that reads like an ordinary, harmless staleness case. Every stale-
      // session branch below escalates identically on `false`.
      const escalateStaleFloor = (originalError?: unknown): never => {
        const persisted = raiseEnvelopeSetPinFloor(nextVersion, claims.householdId);
        if (!persisted) {
          // Every call site of `escalateStaleFloor` runs strictly after
          // `upsertKeyEnvelopeSlot` has already committed `nextVersion`
          // server-side — this is a known-committed outcome, semantically
          // identical to the post-commit pin-write failure below, never a
          // plain refusal. Throwing the
          // KeyWrappingError-derived `EnvelopeSetPinFloorPersistenceError`
          // here left it indistinguishable from an ordinary integrity
          // refusal to `useDerivedRewrap`'s classifier, which only
          // recognizes `RewrapCommittedPinDegradedError` as "committed, not
          // refused" — so it read as a permanent wrong-password-adjacent
          // rejection even though the password WAS accepted and re-wrapped.
          // `locked` is `false`: unlike the retry-exhausted branch below,
          // this path never clears `hdkRef`/`isUnlocked` (the session is
          // simply stale here, not locked), matching the class's own
          // `locked` contract.
          throw new RewrapCommittedPinDegradedError(nextVersion, false, originalError);
        }
        throw new Error('Session ended. Please sign in again.');
      };
      if (isStale()) escalateStaleFloor();
      // Advance the device rollback pin to the just-written set version. The
      // verify above only pinned the OLD version (N); leaving the pin at N
      // while the server set is N+1 lets an adversarial server replay the old
      // N set (valid tag, isEnvelopeSetRollback(N, N) === false) and silently
      // undo the rotation. Matches setupEncryption.
      //
      // This is a POST-COMMIT step (mirrors
      // `prepareRewrappedPasswordSlot.confirmRewrap` + `AuthContext.changePassword`):
      // the server has already committed `nextVersion`, so a pin-write failure
      // here is a known-committed outcome, never an ordinary transient
      // refusal. Retry once; if the pin still cannot be durably written,
      // durably raise the household-scoped fallback floor so a replay of the
      // old (still individually-valid) set is still rejected; if that floor
      // cannot be confirmed either, lock this LIVE workspace (not only the
      // IDB cache) so the next unlock re-verifies from
      // scratch rather than riding a key this device can no longer prove is
      // pinned above the retired set. Neither failure branch below is an
      // ordinary refusal: `nextVersion` is
      // already committed server-side by the time either one runs, so
      // `RewrapCommittedPinDegradedError` signals that distinctly rather
      // than folding it into a plain "session ended" / raw retry error that
      // reads exactly like a write that never landed.
      // `isStale` is threaded into the write itself:
      // `writeEnvelopeSetPin` internally awaits its own existence probe and
      // `updateDeviceMetadata`'s read before committing, and a cross-
      // household session switch landing inside either await would otherwise
      // let this write land on the NEW household's freshly-recreated
      // `deviceMetadata` row. Passing `isStale` makes the write abort BEFORE
      // it commits when that happens, instead of only being noticed after
      // (the checks below remain as belt-and-suspenders for a switch landing
      // strictly outside `writeEnvelopeSetPin`'s own awaits).
      try {
        await writeEnvelopeSetPin(nextVersion, claims.deviceId, isStale);
      } catch (firstErr) {
        if (isStale()) escalateStaleFloor(firstErr);
        try {
          await writeEnvelopeSetPin(nextVersion, claims.deviceId, isStale);
        } catch (retryErr) {
          // The RETRY is itself an await the session can go stale during:
          // a household switch landing here
          // must never fall through to the unconditional, household-
          // unscoped `clearCachedHdk()` below — that would wipe the NEWLY
          // active household's freshly-cached key over a failure that
          // belongs entirely to the CAPTURED (retiring) household.
          if (isStale()) escalateStaleFloor(retryErr);
          const persisted = raiseEnvelopeSetPinFloor(nextVersion, claims.householdId);
          if (!persisted) {
            // Neither the durable pin nor the fallback floor could be
            // confirmed anywhere on this device: lock
            // the LIVE workspace, not only the IndexedDB cache — the
            // in-memory HDK and `isUnlocked` must not keep riding a key this
            // device can no longer prove is pinned above the retired set.
            hdkRef.current = null;
            setIsUnlocked(false);
            await clearCachedHdk();
            throw new RewrapCommittedPinDegradedError(nextVersion, true, retryErr);
          }
          throw new RewrapCommittedPinDegradedError(nextVersion, false, retryErr);
        }
      }
      // A "successful" write above is not proof it landed in the CAPTURED
      // household's row: `writeEnvelopeSetPin`
      // performs its own separate `readDeviceMetadata` / `updateDeviceMetadata`
      // awaits internally, and a household switch landing strictly inside
      // either one can let it resolve without throwing against the NEW
      // household's freshly-recreated `deviceMetadata`. Never trust a
      // success once the session has moved on; fall back to the same
      // household-scoped floor the failure branches use instead of
      // resolving quietly.
      if (isStale()) escalateStaleFloor();
    },
    [claimsRef, makeIsStale],
  );

  /**
   * See {@link ZeroKnowledgeKey.prepareRewrappedPasswordSlot}.
   */
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
      // No password slot to rotate (a recovery-only household): the caller
      // commits the credential alone — the server-confirmed no-slot exception.
      if (!existingPasswordSlot) return null;
      // Verify the freshly-fetched slot set against the in-memory HDK BEFORE
      // generating the new slot and tag — the fail-closed step
      // `rotatePasswordSlot` performs today, which must survive moving the
      // write server-side: a stripped or injected slot set must never be
      // blessed during a change and persisted under a valid tag.
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      const newSlot = await generatePasswordSlot(
        claims.householdId,
        existingPasswordSlot.slotId,
        newPassword,
        hdk,
      );
      const nextVersion = envelopes.envelopeSetVersion + 1;
      // Replace exactly the canonical password slot the change targeted — by
      // id, not by `slotType`:
      // a stray second password-typed row at a non-canonical id must
      // stay wrapped under the old set and computed into the tag unchanged,
      // never silently substituted, so the server's own noncanonical-slot
      // rejection stays the only way that state resolves.
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
          // Advance the pin to the version this commit just wrote — ONLY
          // after the server confirms the commit: the pre-flight verify
          // above pinned the OLD version, and advancing off a bare
          // server-served version (rather than a confirmed commit) would let
          // a replayed old set silently undo the change.
          try {
            await writeEnvelopeSetPin(nextVersion, claims.deviceId);
          } catch (err) {
            // The durable `deviceMetadata` pin write itself failed:
            // the server already committed this version, so a pin
            // left at the predecessor would accept a later replay of the
            // still-valid old envelope set. Durably raise the independent
            // localStorage floor — scoped to THIS household (an
            // unscoped key would let a floor raised here
            // survive an account switch and incorrectly block a different
            // household with a genuinely lower version) — so
            // `readEnvelopeSetPin` rejects that replay regardless of the IDB
            // failure. `raiseEnvelopeSetPinFloor` re-reads what it wrote to
            // confirm the value actually landed
            // (`setItem` can return without throwing yet not persist); a
            // `false` return means NOTHING durable recorded the new floor —
            // surface that as its own error rather than an ordinary
            // pin-write failure, so it is never mistaken for "the floor is
            // durably in place". Either branch still throws so the caller's
            // own lock/retry handling runs.
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

  /**
   * Prepare a recovery-key regeneration after the user proves the current
   * account password. Re-authenticates by unwrapping the
   * `password` slot with the entered password: a wrong password throws
   * KeyWrappingError before any new slot is minted, and a correct one yields the
   * canonical HDK to re-wrap — no server round-trip and no reliance on the
   * in-memory session (the password is the proof). Mints a FRESH `recovery` slot
   * wrapping that same HDK but does **not** persist it; instead it returns the
   * new grouped recovery-key display string plus an {@link activate} thunk.
   *
   * This is a two-phase **prepare → commit** so the rotation is never visible
   * server-side until the user confirms they saved the new key: nothing is
   * written here, so the previous recovery key keeps working. Only `activate()`
   * PUTs the prepared slot at the next monotonic version and advances the
   * rollback pin; the OLD key stops working the instant that lands. If the user
   * abandons the flow (cancel / navigate away), no `activate()` call happens and
   * the existing key is untouched. Re-displaying the original key is impossible
   * (raw recovery bytes are never persisted), so rotating is the only path
   * back from a lost key.
   *
   * Throws synchronously (during prepare) on a wrong password, a missing password
   * slot, or a tampered/rolled-back set — so a key is never even shown for an
   * unverifiable set. `activate()` re-fetches + re-verifies before the PUT and
   * throws on a tampered/rolled-back set, a stale session, or a write failure, so
   * the UI can surface it and the user never believes a stale key is valid.
   */
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
      // Re-authenticate by unwrapping the password slot with the entered password.
      // unwrapSlot throws KeyWrappingError on a wrong password or tampered slot
      // metadata (the wrap AAD binds the KDF params), so no recovery slot is ever
      // minted against an unverified password — and the unwrap yields the canonical
      // HDK to re-wrap into the fresh recovery slot.
      const hdk = await unwrapSlot(passwordSlot, password);
      // Reject a rolled-back set, verify the HDK-keyed tag (slot stripping/
      // reorder/injection), then advance the pin — all before minting anything, so
      // we never even show a key for a tampered or replayed set.
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      // Reuse the existing recovery slot's id so the eventual PUT replaces it in
      // place; fall back to 'recovery' for the (rare) no-recovery-slot-yet case.
      const existingRecovery = envelopes.slots.find(
        (slot: KeyEnvelopeSlot) => slot.slotType === 'recovery',
      );
      const recoverySlotId = existingRecovery?.slotId ?? 'recovery';
      // Mint the fresh recovery slot + key, but DO NOT PUT yet. The HDK is
      // immutable, so this wrapped slot stays valid to persist later in
      // `activate()`; until then nothing has changed server-side.
      const generated = await generateRecoverySlot(claims.householdId, recoverySlotId, hdk);

      const activate = async (proof?: StepUpProof): Promise<void> => {
        // Commit the prepared recovery slot. Re-fetch the set so the version is
        // monotonically correct even if another device changed it since prepare,
        // and re-verify the (immutable) HDK against the fresh set + rollback pin
        // before re-tagging — fail closed on tamper/rollback, exactly like the
        // other write paths.
        const current = await getKeyEnvelopes();
        await verifyEnvelopeSetAndAdvancePin(current, hdk, claims.householdId, claims.deviceId);
        // Replace any existing recovery slot with the prepared one; every other
        // slot (password + any passkey_prf) carries through unchanged so the set
        // tag still verifies after the rotation.
        const others = current.slots.filter(
          (slot: KeyEnvelopeSlot) => slot.slotType !== 'recovery',
        );
        const nextSlots = [...others, generated.slot];
        const nextVersion = current.envelopeSetVersion + 1;
        const tag = await computeEnvelopeSetTag(nextSlots, nextVersion, hdk);
        if (isStale()) throw new Error('Session ended. Please sign in again.');
        // This PUT replaces an existing `recovery` slot — the server's
        // exemption matrix never exempts it, so
        // the caller's fresh factor proof (when `AUTH_MFA_ENFORCED` is on)
        // rides along as the wire fields `stepUpProofFields` builds.
        await upsertKeyEnvelopeSlot(recoverySlotId, {
          slot: generated.slot,
          envelopeSetVersion: nextVersion,
          envelopeSetTag: tag,
          ...stepUpProofFields(proof),
        });
        // Advance the device rollback pin to the just-written version. The verify
        // above only pinned the OLD version (N); leaving the pin at N while the
        // server set is N+1 lets an adversarial server replay the old N set (valid
        // tag, isEnvelopeSetRollback(N, N) === false) and silently restore the
        // previous recovery key. Matches rotatePasswordSlot.
        await writeEnvelopeSetPin(nextVersion, claims.deviceId);
      };

      return { recoveryKey: generated.recoveryKey, activate };
    },
    [claimsRef, makeIsStale],
  );

  /**
   * Re-cache the in-memory HDK after an operation that wiped the device
   * `keyCache` but left the session unlocked (a snapshot restore runs
   * `clearAllStores()`, which drops `keyCache` while the in-memory `hdkRef`
   * survives — so without this a refresh misses the cache and prompts for the
   * password). Best-effort: no-ops when the session is locked (no HDK or no
   * household) and swallows an IDB write failure, so it never gates the
   * reseed success path.
   *
   * Unlike the other `cacheHdk` call sites, this deliberately skips the
   * `makeIsStale(claims)` mid-flight-switch guard: the write is household-keyed
   * (`cacheHdk(householdId, hdk)`) and `loadCachedHdk` rejects an entry whose
   * `householdId` doesn't match the live session on read, so a stale-session
   * write is self-correcting — the next session never trusts another
   * household's cached key. Reading `claimsRef.current?.householdId` here pairs
   * the household with the HDK that is actually in memory at call time.
   */
  const recacheHdk = useCallback(async (): Promise<void> => {
    const hdk = hdkRef.current;
    const householdId = claimsRef.current?.householdId;
    // Locked session (no HDK) or no live household: nothing to cache.
    if (!hdk || !householdId) return;
    try {
      await cacheHdk(householdId, hdk);
    } catch {
      // Best-effort: an IDB write failure leaves the device locked on the
      // next refresh (recoverable via the password prompt) rather than turning
      // a successful restore into a hard error.
    }
  }, [claimsRef]);

  /**
   * Obtain a PRF secret from a specific passkey via a targeted WebAuthn
   * assertion. Fetches a server-issued challenge from
   * `POST /auth/passkey/authenticate/start` (discoverable: `allowCredentials:
   * []`), then OVERRIDES `allowCredentials` client-side to the chosen credential
   * and adds the PRF eval for `prfSalt`. The assertion is NOT finished — the
   * user is already authenticated; the server challenge expires via its TTL.
   * Returns the raw PRF output, or throws if the authenticator returns none
   * (PRF unsupported). Extracted to keep {@link enrollPasskeyForEncryption}
   * ≤ 60 lines and free of WebAuthn-extension wiring.
   */
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

  /**
   * User-initiated passkey-PRF unlock from the post-login unlock prompt.
   * The discoverable login assertion can't carry the PRF salt
   * before the user is identified, so the explicit unlock runs a *targeted*
   * second assertion against the enrolled slot's bound credential + `prfSalt`
   * (the same mechanism as {@link obtainPrfSecretForCredential}), then unwraps
   * the slot and verifies the envelope-set tag before trusting the HDK. Guards
   * every state write with the staleness predicate like {@link unlockWithPassword}.
   * User-initiated → throws on any failure so the button surfaces the error.
   */
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
      // Targeted assertion against the slot's bound credential + salt,
      // reusing obtainPrfSecretForCredential (throws KeyWrappingError when the
      // authenticator returns no PRF result, so the UI shows the right message).
      const prfResult = await obtainPrfSecretForCredential(
        prfSlot.credentialBinding,
        prfSlot.prfSalt,
      );
      const wrapKey = await derivePrfWrapKey(prfResult);
      const hdk = await unwrapPrfSlot(prfSlot, wrapKey);
      // Reject a rolled-back set, verify the HDK-keyed tag (slot stripping/
      // reorder/injection), then advance the pin. Throws before adoption.
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      hdkRef.current = hdk;
      setIsUnlocked(true);
      setNeedsKeySetup(false);
      // Hand the just-verified response to useDerivedRewrap
      // instead of forcing a second GET for the same unlock.
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
      // Replace any existing passkey_prf slot (one per household); other
      // slots carry through unchanged in the tag computation.
      const envelopes = await getKeyEnvelopes();
      // Verify the freshly-fetched slot set against the in-memory HDK before
      // re-tagging anything, matching unlockWithPassword /
      // rotatePasswordSlot. Without this a stripped/injected slot set could be
      // blessed during enrollment — the new tag would be computed over a
      // tampered/rolled-back set and persisted as authoritative. Throws on
      // mismatch or rollback; unlike the best-effort rotatePasswordSlot
      // this is a user-initiated enrollment, so the error propagates:
      // enrollment fails and no PUT is issued.
      await verifyEnvelopeSetAndAdvancePin(envelopes, hdk, claims.householdId, claims.deviceId);
      const others = envelopes.slots.filter(
        (s: KeyEnvelopeSlot) => s.slotType !== 'passkey_prf',
      );
      const nextSlots = [...others, slot];
      const nextVersion = envelopes.envelopeSetVersion + 1;
      const tag = await computeEnvelopeSetTag(nextSlots, nextVersion, hdk);
      if (isStale()) throw new Error('Session ended. Please sign in again.');
      // A passkey_prf write is never exempt on a household that already
      // holds a slot — the first-ever
      // enrollment (`others.length === envelopes.slots.length`, no prior PRF
      // slot) requires a proof exactly like a replace does now, plus the
      // password floor below, in EITHER `AUTH_MFA_ENFORCED` state. This is
      // the ONE request that carries the proof: a transport failure here is
      // typed {@link EnrollmentCommitAmbiguousError} so the caller can tell
      // "outcome unknown" apart from every local failure above.
      await commitPasskeyPrfSlot({
        slot,
        envelopeSetVersion: nextVersion,
        envelopeSetTag: tag,
        currentPassword,
        ...stepUpProofFields(proof),
      });
      // Advance the device rollback pin to the just-written set version. The
      // verify above only pinned the OLD version (N); leaving the pin at N while
      // the server set is N+1 lets an adversarial server replay the old N set
      // (valid tag, isEnvelopeSetRollback(N, N) === false) and silently undo the
      // enrollment. Matches setupEncryption.
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
