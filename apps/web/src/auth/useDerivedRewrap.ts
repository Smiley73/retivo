// Derived post-reset password-slot re-wrap: owed iff the `password` slot's `credentialRevision` differs from
// `currentCredentialRevision`, re-derived at every unlock (docs/security.md "Password change, password reset").
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '../api/client';
import { getKeyEnvelopes, type KeyEnvelopesResponse } from './key-envelope-client';
import { KeyWrappingError } from '../crypto/key-wrapping';
import { RewrapCommittedPinDegradedError } from './useZeroKnowledgeKey';

const MAX_PROMPT_ATTEMPTS = 3;

/** Reactive prompt state AuthContext renders via a Modal-based component. */
export interface RewrapPromptState {
  /**
   * Wrong-password attempts left before the prompt closes for this unlock (still owed; the next transition asks again).
   * `0` also marks a terminal state (exhausted, login-backoff wait, post-verify write refusal): dismiss, see `error`.
   */
  attemptsRemaining: number;
  /** Inline error from the last submit, or null. */
  error: string | null;
  /** True while a `verify-password` / rewrap round-trip is in flight. */
  submitting: boolean;
}

export interface DerivedRewrap {
  /**
   * Stashes the plaintext this session's sign-in accepted (never an unlock-prompt value: post-reset those open under
   * the old password). Overwrites any prior value.
   */
  retainPassword(password: string): void;
  /**
   * Ends the unlock window: drops the retained plaintext, closes the prompt, and bumps the session generation so an
   * in-flight derive/answer bails instead of acting on the next session's prompt, HDK or claims. Idempotent;
   * AuthContext calls it on every session-drop path (logout, refresh failure, account deletion) and on unmount.
   */
  clearRetainedPassword(): void;
  /**
   * Derive-and-complete step; safe on every unlock transition (a fresh server read each time, a no-op when nothing is
   * owed), guarded against overlapping runs, and a no-op while locked.
   */
  runDerive(): void;
  /** Non-null while the re-wrap prompt should be shown. */
  prompt: RewrapPromptState | null;
  /**
   * Verifies the password via `verify-password` (`purpose: 'password_slot_rewrap'`, which also repairs the session's
   * write authority), then re-wraps under it.
   */
  answerPrompt(password: string): Promise<void>;
  /** Dismisses without answering; writes nothing, the next transition asks again. */
  dismissPrompt(): void;
}

export interface DerivedRewrapDeps {
  /** The in-memory HDK accessor (useZeroKnowledgeKey.getHdk); null while locked, so the derive no-ops. */
  getHdk(): CryptoKey | null;
  /**
   * Re-wraps the `password` slot under an authenticated plaintext (useZeroKnowledgeKey.rotatePasswordSlot); propagates
   * every failure for this hook to classify. `envelopesHint` spares the silent path a second rate-limited read.
   */
  rotatePasswordSlot(newPassword: string, envelopesHint?: KeyEnvelopesResponse): Promise<void>;
  /**
   * Verifies against the account credential (AuthContext.verifyPassword); throws
   * `ApiRequestError('INVALID_CREDENTIALS')`, or `429 LOGIN_BACKOFF` under the shared login backoff.
   */
  verifyPassword(
    password: string,
    opts?: { purpose?: 'password_slot_rewrap' },
  ): Promise<void>;
  /**
   * Consumes the envelope-set response the unlock already fetched and verified
   * (useZeroKnowledgeKey.takeLastUnlockEnvelopes) if it still matches the live session, sparing a second rate-limited
   * read. Optional; null or omitted means the derive fetches fresh.
   */
  takeLastUnlockEnvelopes?(): KeyEnvelopesResponse | null;
}

// The one refusal answered by re-authenticating the plaintext: `409 UPGRADE_REQUIRED`, the session's recorded write
// authority is stale or absent.
function isStaleWriteAuthorityError(err: unknown): boolean {
  return err instanceof ApiRequestError && err.error.code === 'UPGRADE_REQUIRED';
}

function isBackoffError(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 429;
}

function isInvalidCredentialsError(err: unknown): boolean {
  return err instanceof ApiRequestError && err.error.code === 'INVALID_CREDENTIALS';
}

// `refused-integrity`: tag/rollback mismatch on the fresh slot set, permanent for this plaintext/device pair.
// `refused-transient`: anything else, may resolve at a later transition. `written-degraded` and `locked` are committed
// outcomes, never refusals: only this device's rollback-pin bookkeeping needed a fallback. `locked` means neither the
// durable pin nor the fallback floor could be confirmed, so the HDK was cleared and the caller must say so.
type RewrapOutcome =
  | 'written'
  | 'written-degraded'
  | 'locked'
  | 'refused-integrity'
  | 'refused-transient';

function classifyRefusal(err: unknown): 'refused-integrity' | 'refused-transient' {
  return err instanceof KeyWrappingError ? 'refused-integrity' : 'refused-transient';
}

// A RewrapCommittedPinDegradedError means the write committed server-side, so it is never described as refused or left
// owed. Any other failure stays owed and is logged. `when` names the failed attempt in the log line.
function reportRewrapFailure(err: unknown, when: string): RewrapOutcome {
  if (err instanceof RewrapCommittedPinDegradedError) {
    console.warn(
      `[useDerivedRewrap] re-wrap committed server-side ${when}, but this device's local rollback-pin bookkeeping needed a fallback`,
      err,
    );
    return err.locked ? 'locked' : 'written-degraded';
  }
  console.warn(
    `[useDerivedRewrap] re-wrap refused ${when}; left owed for the next unlock (never attributed to a wrong password)`,
    err,
  );
  return classifyRefusal(err);
}

export function useDerivedRewrap(deps: DerivedRewrapDeps): DerivedRewrap {
  const { getHdk, rotatePasswordSlot, verifyPassword, takeLastUnlockEnvelopes } = deps;

  // Plaintext lives in a ref, never React state (devtools-inspectable), like the in-memory HDK. Cleared on session
  // drop, unmount, or as soon as a derive run settles: it is scoped to the unlock window, not to one attempt.
  const retainedRef = useRef<string | null>(null);
  const [prompt, setPrompt] = useState<RewrapPromptState | null>(null);
  // Bumped by `clearRetainedPassword`. A run captures its generation and bails after an await if it moved, so a dead
  // session's outcome never surfaces over the next screen or acts on the next user's session.
  const generationRef = useRef(0);
  // Generation of the in-flight derive (null if none): a stale run from a dropped session must not block the next
  // session's runDerive().
  const inFlightGenerationRef = useRef<number | null>(null);

  const retainPassword = useCallback((password: string): void => {
    retainedRef.current = password;
  }, []);

  const clearRetainedPassword = useCallback((): void => {
    retainedRef.current = null;
    generationRef.current += 1;
    setPrompt(null);
  }, []);

  /**
   * Re-wraps under an already-authenticated plaintext. On `409 UPGRADE_REQUIRED` with `retryOnStaleAuthority`,
   * re-verifies (repairing the authority) and retries once; any other failure is left owed, never retried invisibly nor
   * shown as a wrong password. Never throws. `generation` is checked before every network await: a logout or new
   * sign-in between awaits must not let the retry run against the next session's claims/HDK with this plaintext, so a
   * stale generation returns `'refused-transient'` without touching the API.
   */
  const attemptRewrap = useCallback(
    async (
      password: string,
      retryOnStaleAuthority: boolean,
      generation: number,
      envelopesHint?: KeyEnvelopesResponse,
    ): Promise<RewrapOutcome> => {
      if (generation !== generationRef.current) return 'refused-transient';
      try {
        await rotatePasswordSlot(password, envelopesHint);
        if (generation !== generationRef.current) return 'refused-transient';
        return 'written';
      } catch (err) {
        if (generation !== generationRef.current) return 'refused-transient';
        if (retryOnStaleAuthority && isStaleWriteAuthorityError(err)) {
          try {
            await verifyPassword(password, { purpose: 'password_slot_rewrap' });
            if (generation !== generationRef.current) return 'refused-transient';
            await rotatePasswordSlot(password, envelopesHint);
            if (generation !== generationRef.current) return 'refused-transient';
            return 'written';
          } catch (retryErr) {
            if (generation !== generationRef.current) return 'refused-transient';
            return reportRewrapFailure(retryErr, 'after session-authority repair');
          }
        }
        return reportRewrapFailure(err, 'on first attempt');
      }
    },
    [rotatePasswordSlot, verifyPassword],
  );

  const runDerive = useCallback((): void => {
    if (inFlightGenerationRef.current === generationRef.current) return; // already running this transition
    if (getHdk() === null) return; // locked: nothing to verify a tag against yet
    if (prompt !== null) return; // already asking for this unlock
    const generation = generationRef.current;
    inFlightGenerationRef.current = generation;
    void (async () => {
      try {
        // Reuse the response the unlock already fetched and verified for this transition.
        const reused = takeLastUnlockEnvelopes ? takeLastUnlockEnvelopes() : null;
        let envelopes: KeyEnvelopesResponse;
        if (reused) {
          envelopes = reused;
        } else {
          try {
            envelopes = await getKeyEnvelopes();
          } catch {
            // Transient read failure: retry at the next transition rather than guess at owed-ness; this unlock's window
            // ends here.
            if (generation === generationRef.current) retainedRef.current = null;
            return;
          }
        }
        // The session may have dropped or switched during the read: bail before prompting or rotating against the next
        // session.
        if (generation !== generationRef.current) return;
        const passwordSlot = envelopes.slots.find((slot) => slot.slotType === 'password');
        // No password slot (e.g. recovery-only): nothing owed, never prompted; the window ends here.
        if (!passwordSlot) {
          retainedRef.current = null;
          return;
        }
        // Owed means not equal, including a slot with no recorded revision.
        const owed = passwordSlot.credentialRevision !== envelopes.currentCredentialRevision;
        if (!owed) {
          // Not owed: the plaintext must not survive a settled derive.
          retainedRef.current = null;
          return;
        }
        const retained = retainedRef.current;
        if (retained !== null) {
          // The window ends regardless of outcome: a non-credential failure stays owed for the next transition (which
          // prompts) rather than retrying a stale plaintext.
          retainedRef.current = null;
          const outcome = await attemptRewrap(retained, true, generation, envelopes);
          if (generation !== generationRef.current) return;
          if (outcome === 'locked') {
            // The silent path must surface this: the cached key and in-memory HDK are already gone, so show the
            // terminal prompt rather than an unexplained session expiry.
            setPrompt({
              attemptsRemaining: 0,
              error:
                "Your password was updated, but this device needed to be locked again as a safety check. Dismiss this and sign in again to unlock it.",
              submitting: false,
            });
          }
          return;
        }
        setPrompt({ attemptsRemaining: MAX_PROMPT_ATTEMPTS, error: null, submitting: false });
      } finally {
        if (inFlightGenerationRef.current === generation) inFlightGenerationRef.current = null;
      }
    })();
  }, [getHdk, prompt, attemptRewrap, takeLastUnlockEnvelopes]);

  const dismissPrompt = useCallback((): void => {
    setPrompt(null);
  }, []);

  const answerPrompt = useCallback(
    async (password: string): Promise<void> => {
      const generation = generationRef.current;
      setPrompt((prev) => (prev ? { ...prev, submitting: true, error: null } : prev));
      try {
        await verifyPassword(password, { purpose: 'password_slot_rewrap' });
      } catch (err) {
        // The session ended during the verify: leave the cleared state alone.
        if (generation !== generationRef.current) return;
        if (isBackoffError(err)) {
          // A 429 reads as a wait, not a wrong guess, so it does not count against `attemptsRemaining`. The person
          // dismisses; the next transition asks again.
          setPrompt((prev) =>
            prev
              ? {
                  attemptsRemaining: 0,
                  error: 'Too many attempts. Please try again in a few minutes.',
                  submitting: false,
                }
              : prev,
          );
          return;
        }
        if (isInvalidCredentialsError(err)) {
          setPrompt((prev) => {
            if (!prev) return prev;
            const attemptsRemaining = prev.attemptsRemaining - 1;
            if (attemptsRemaining <= 0) {
              // The last wrong guess must still say so; the bound ends the asking for this unlock, still owed.
              return {
                attemptsRemaining: 0,
                error: 'Incorrect password. This will be asked again at your next sign-in.',
                submitting: false,
              };
            }
            return {
              attemptsRemaining,
              error: 'Incorrect password. Please try again.',
              submitting: false,
            };
          });
          return;
        }
        // Network or server fault, not a wrong guess: keep the prompt open and the attempt bound intact.
        setPrompt((prev) =>
          prev ? { ...prev, submitting: false, error: 'Something went wrong. Please try again.' } : prev,
        );
        return;
      }
      if (generation !== generationRef.current) return;
      // The prompt may sit open long enough for another tab or device to finish the re-wrap: re-fetch and repeat
      // runDerive's owed-ness compare before writing. A fetch failure falls back to `rotatePasswordSlot`'s own fetch.
      let freshEnvelopes: KeyEnvelopesResponse | undefined;
      try {
        freshEnvelopes = await getKeyEnvelopes();
      } catch {
        freshEnvelopes = undefined;
      }
      if (generation !== generationRef.current) return;
      if (freshEnvelopes) {
        const freshPasswordSlot = freshEnvelopes.slots.find((slot) => slot.slotType === 'password');
        if (
          !freshPasswordSlot ||
          freshPasswordSlot.credentialRevision === freshEnvelopes.currentCredentialRevision
        ) {
          // Another device already completed the re-wrap (or the slot is gone): close without writing.
          setPrompt(null);
          return;
        }
      }
      // Just verified, which also repaired a stale write authority in place, so one attempt suffices.
      const outcome = await attemptRewrap(password, false, generation, freshEnvelopes);
      if (generation !== generationRef.current) return;
      if (outcome === 'written') {
        setPrompt(null);
        return;
      }
      if (outcome === 'written-degraded') {
        // Committed server-side and the fallback floor confirmed it: not a refusal, and already logged as a diagnostic.
        setPrompt(null);
        return;
      }
      if (outcome === 'locked') {
        // Committed, but neither the durable pin nor the fallback floor was confirmed and the device is already
        // locked: say so, not the refusal copy.
        setPrompt((prev) =>
          prev
            ? {
                attemptsRemaining: 0,
                error:
                  "Your password was updated, but this device needed to be locked again as a safety check. Dismiss this and sign in again to unlock it.",
                submitting: false,
              }
            : prev,
        );
        return;
      }
      // A correct-password refusal must not read as success: distinguish a permanent integrity problem from a
      // transient one. The slot stays untouched and owed.
      setPrompt((prev) =>
        prev
          ? {
              attemptsRemaining: 0,
              error:
                outcome === 'refused-integrity'
                  ? "Your password was correct, but this device's encryption key could not be verified. This needs attention beyond a retry."
                  : "Your password was correct, but we couldn't finish updating this device. It will try again automatically at your next sign-in.",
              submitting: false,
            }
          : prev,
      );
    },
    [verifyPassword, attemptRewrap],
  );

  // Unmount / navigation away ends the unlock window.
  useEffect(() => {
    return () => {
      retainedRef.current = null;
      generationRef.current += 1;
    };
  }, []);

  return { retainPassword, clearRetainedPassword, runDerive, prompt, answerPrompt, dismissPrompt };
}
