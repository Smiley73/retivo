/**
 * Derived post-reset password-slot re-wrap, extracted from AuthContext so
 * that file stays under the shape limit.
 *
 * The problem it solves: a password reset rotates only the *login*
 * credential — it cannot unwrap the pre-existing `password` key-envelope slot
 * (the server holds no key material). Whether THIS device's slot is
 * still wrapped under a superseded credential is now DERIVED, at every
 * unlock-state transition, from two server-authored fields on the same
 * `GET /auth/key-envelopes` read the unlock path already makes: the
 * `password` slot's own `credentialRevision` and the response's
 * `currentCredentialRevision`. Not equal — including a slot carrying
 * no revision at all (a slot written before revisions were recorded) — means a
 * re-wrap is owed. This is a pure compare: no clock, no stored marker, no
 * unwrap failure is ever the trigger (a reset never touches the slot, so the
 * pre-reset password still opens it).
 *
 * Where it is owed:
 *   - a plaintext this session's own sign-in accepted is retained in memory
 *     (never persisted) for the unlock window; when present, the re-wrap
 *     fires silently under it;
 *   - otherwise the person is prompted once, with a plain-English reason, and
 *     asked again at every later unlock-state transition until an accepted
 *     envelope write lands. The prompt answer is verified through the
 *     existing `POST /auth/verify-password` route (shares the per-account
 *     login backoff) and, on success, becomes the wrap plaintext.
 *
 * A write refused because the session's recorded write authority is stale or
 * absent (a session that predates recorded write authority carries none) is answered
 * by a FRESH verification of the plaintext — silently when a plaintext is in
 * hand, by the prompt otherwise — rather than by reusing the session's own
 * (already-stale) authority; `verify-password` updates that authority in
 * place, so the retry that follows lands. A failure for any other reason
 * (a tag/rollback mismatch, a network fault) never overwrites the slot and is
 * never presented as a wrong password; it is recorded as a diagnostic and
 * left owed for the next unlock-state transition rather than retried
 * invisibly forever.
 *
 * Nothing here is wired to any specific unlock method — AuthContext calls
 * {@link DerivedRewrap.runDerive} once on every rising edge of `isUnlocked`,
 * which already covers the cached-key auto-unlock, the PRF unlock, and all
 * three explicit unlock branches (password / recovery / passkey) uniformly,
 * so no branch can be forgotten and none is asked more than the derive says
 * it should be.
 *
 * A session-generation token bounds every retained plaintext, the prompt, and any
 * derive/answer async continuation to the unlock window it started in:
 * `clearRetainedPassword` — called by AuthContext on every session-drop path
 * (logout / refresh failure / account deletion) and on unmount — bumps it, so
 * a run still in flight when the session ends bails out instead of showing a
 * prompt after logout or acting against the NEXT session's HDK/claims.
 *
 * See "Unlocking" and "Password change, password reset" in docs/security.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '../api/client';
import { getKeyEnvelopes, type KeyEnvelopesResponse } from './key-envelope-client';
import { KeyWrappingError } from '../crypto/key-wrapping';
import { RewrapCommittedPinDegradedError } from './useZeroKnowledgeKey';

/** Bound on wrong-password attempts inside one prompt. */
const MAX_PROMPT_ATTEMPTS = 3;

/** Reactive prompt state AuthContext renders via a Modal-based component. */
export interface RewrapPromptState {
  /** Wrong-password attempts left before the prompt closes for this unlock
   * (still owed — the next unlock-state transition asks again). `0` also
   * marks a TERMINAL state (attempts exhausted, a login-backoff wait, or a
   * post-verify write refusal) — the person must dismiss rather than retry;
   * see `error` for why. */
  attemptsRemaining: number;
  /** Inline error from the last submit, or null. */
  error: string | null;
  /** True while a `verify-password` / rewrap round-trip is in flight. */
  submitting: boolean;
}

export interface DerivedRewrap {
  /** Stash the plaintext THIS session's sign-in just accepted (never a value
   * typed into an unlock prompt — those unwrap under whatever secret already
   * opens the slot, which post-reset is the OLD password). Overwrites any
   * prior retained value. */
  retainPassword(password: string): void;
  /**
   * Ends the unlock window for good: drops any retained plaintext, closes
   * an open prompt (its typed value goes with it — `PasswordRewrapPrompt` is
   * a thin view over `prompt` and clears its own field once `prompt` goes
   * null), and bumps the session generation so a derive/answer already in
   * flight for the ending session bails out instead of acting on the NEXT
   * session (its own prompt, its own HDK, its own claims). Idempotent.
   * Called by AuthContext on every session-drop path (logout / refresh
   * failure / account deletion) and on unmount — none of the plaintext, the
   * prompt, or an in-flight derive/answer may outlive the unlock window they
   * were entered in.
   */
  clearRetainedPassword(): void;
  /**
   * Run the derive-and-complete step. Safe to call on every unlock-state
   * transition (cached-key auto-unlock, PRF, or any explicit unlock
   * success) — it is a pure re-derivation from a fresh server read each
   * time, so calling it when nothing is owed, or when a prior call already
   * completed the re-wrap, is a harmless no-op (one extra read). Internally
   * guarded against concurrent overlapping runs. No-ops when the session is
   * locked (nothing to verify a tag against yet).
   */
  runDerive(): void;
  /** Non-null while the re-wrap prompt should be shown. */
  prompt: RewrapPromptState | null;
  /** Submit the prompt's password. Verifies it via `verify-password`
   * (`purpose: 'password_slot_rewrap'`), which also repairs this session's
   * recorded write authority in place, then re-wraps under it. */
  answerPrompt(password: string): Promise<void>;
  /** Dismiss the prompt without answering. Writes nothing; the next
   * unlock-state transition asks again. */
  dismissPrompt(): void;
}

export interface DerivedRewrapDeps {
  /** The in-memory HDK accessor (useZeroKnowledgeKey.getHdk) — null when
   * locked, in which case the derive has nothing to verify a tag against yet
   * and no-ops. */
  getHdk(): CryptoKey | null;
  /** Re-wrap the `password` slot under a plaintext already authenticated
   * (useZeroKnowledgeKey.rotatePasswordSlot). Propagates every failure — this hook classifies the throw. Accepts an optional
   * already-fetched envelope-set response so the silent (retained-password)
   * path does not spend a second rate-limited read on the same unlock. */
  rotatePasswordSlot(newPassword: string, envelopesHint?: KeyEnvelopesResponse): Promise<void>;
  /** Verify a password against the account credential
   * (AuthContext.verifyPassword). Throws `ApiRequestError('INVALID_CREDENTIALS')`
   * on a mismatch, or a `429 LOGIN_BACKOFF` under the shared login backoff. */
  verifyPassword(
    password: string,
    opts?: { purpose?: 'password_slot_rewrap' },
  ): Promise<void>;
  /**
   * Consume (and clear) the envelope-set response already fetched + verified
   * during the unlock that just flipped `isUnlocked`, if it still matches
   * the live session (useZeroKnowledgeKey.takeLastUnlockEnvelopes) — avoids
   * spending a second rate-limited `GET /auth/key-envelopes` on the same
   * unlock. Optional: omitted by tests and any future
   * caller that has no such response to offer, in which case the derive
   * always fetches fresh. Returns null when none is available.
   */
  takeLastUnlockEnvelopes?(): KeyEnvelopesResponse | null;
}

/** `true` when `err` is the server's "this session's recorded write authority
 * is stale or absent" refusal (`409 UPGRADE_REQUIRED` on the
 * key-envelope write path) — the one refusal class this hook answers by
 * re-authenticating the plaintext rather than surfacing it. */
function isStaleWriteAuthorityError(err: unknown): boolean {
  return err instanceof ApiRequestError && err.error.code === 'UPGRADE_REQUIRED';
}

function isBackoffError(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 429;
}

function isInvalidCredentialsError(err: unknown): boolean {
  return err instanceof ApiRequestError && err.error.code === 'INVALID_CREDENTIALS';
}

/** The rewrap-write outcome, classified for the caller:
 * `refused-integrity` is a tag/rollback mismatch on the freshly-fetched slot
 * set — permanent for this plaintext/device pair, retrying will not help;
 * `refused-transient` is everything else (network fault, unexpected server
 * error) — expected to resolve itself on a later unlock-state transition.
 * `written-degraded` and `locked` are BOTH known-committed outcomes, never refusals: the server
 * already accepted the new password slot, and only this device's local
 * rollback-pin bookkeeping needed a fallback. `written-degraded` means the
 * fallback floor landed — the workspace stays live. `locked` means neither
 * the durable pin nor the fallback floor could be confirmed anywhere on
 * this device, so `rotatePasswordSlot` has already cleared the in-memory
 * HDK and `isUnlocked` as a precaution — the caller must say so rather than
 * let the next unlock prompt read as an ordinary, unexplained session
 * expiry. */
type RewrapOutcome =
  | 'written'
  | 'written-degraded'
  | 'locked'
  | 'refused-integrity'
  | 'refused-transient';

function classifyRefusal(err: unknown): 'refused-integrity' | 'refused-transient' {
  return err instanceof KeyWrappingError ? 'refused-integrity' : 'refused-transient';
}

/** Classify + log a `rotatePasswordSlot` failure: a {@link RewrapCommittedPinDegradedError} means
 * the write already committed server-side — it is never described as
 * "refused" or "left owed", which would tell the person nothing happened
 * when their password WAS re-wrapped. Every other failure is left owed and
 * logged as a diagnostic. `when` is a
 * short phrase describing which attempt failed, folded into the log line. */
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

  // Plaintext lives only in a ref (never React state — must not leak into
  // devtools-inspectable state, same posture as the in-memory HDK). Cleared
  // by an explicit session-drop / unmount, or the instant a derive run
  // settles (owed or not) — the sign-in plaintext is scoped to the unlock
  // WINDOW, not to any single unlock attempt inside it (a failed unlock
  // attempt — e.g. the ordinary post-reset case of trying the new password
  // before the old one — never calls this hook at all, since {@link
  // runDerive} only runs on an unlock SUCCESS).
  const retainedRef = useRef<string | null>(null);
  const [prompt, setPrompt] = useState<RewrapPromptState | null>(null);
  // Bumped by `clearRetainedPassword` on every session-drop path / unmount.
  // A derive/answer run captures the
  // generation it started under; if it moves on while an await is pending,
  // the continuation bails without touching `retainedRef`/`prompt` — a dead
  // session's outcome must never surface over the next screen or act against
  // the next user's session.
  const generationRef = useRef(0);
  // The generation the CURRENTLY in-flight derive belongs to (null when none
  // is running). Scoped to generation rather than a bare boolean so a stale
  // run from a session that has since dropped never blocks the NEXT
  // session's own runDerive() call — only an
  // in-flight run for the CURRENT generation guards against a concurrent
  // duplicate for the SAME unlock-state transition.
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
   * Attempt the re-wrap under an already-authenticated plaintext. On a
   * `409 UPGRADE_REQUIRED` refusal (this session's recorded write authority
   * is stale/absent) and `retryOnStaleAuthority`, re-verify the plaintext
   * (which repairs the authority in place) and retry exactly once.
   * Every other failure is left owed and logged as a diagnostic — never
   * retried invisibly, never presented as a wrong password. Never throws.
   *
   * `generation` is the session generation this run started under: checked before EVERY await that reaches the network, not just
   * before this function is entered — a session-drop (logout) or a new
   * sign-in landing between two of this function's own awaits (e.g. after a
   * `rotatePasswordSlot` that returns `UPGRADE_REQUIRED`) must not let the
   * retry's `verifyPassword` / `rotatePasswordSlot` calls run against the
   * NEXT session's live claims/HDK using A's retained plaintext. A stale
   * generation bails with `'refused-transient'` (nothing was written; left
   * owed, exactly as any other transient refusal) without touching the API
   * again. `envelopesHint`, when supplied, is threaded straight through to
   * `rotatePasswordSlot` for every attempt.
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
        // Reuse the envelope-set response the unlock itself
        // already fetched + verified for THIS transition, rather than
        // spending a second rate-limited read on the same unlock.
        const reused = takeLastUnlockEnvelopes ? takeLastUnlockEnvelopes() : null;
        let envelopes: KeyEnvelopesResponse;
        if (reused) {
          envelopes = reused;
        } else {
          try {
            envelopes = await getKeyEnvelopes();
          } catch {
            // Transient read failure: try again at the next unlock-state
            // transition rather than guessing at owed-ness. This unlock's
            // window still ends here — a re-derive on the
            // NEXT transition re-fetches and re-decides from scratch.
            if (generation === generationRef.current) retainedRef.current = null;
            return;
          }
        }
        // The session may have dropped or
        // switched while the read above was in flight. Bail before acting on
        // the result — never show a prompt post-logout, never rotate against
        // the NEXT session's live HDK/claims under this stale derive's plan.
        if (generation !== generationRef.current) return;
        const passwordSlot = envelopes.slots.find((slot) => slot.slotType === 'password');
        // No password slot at all (e.g. recovery-only household): owes
        // nothing by rule, never prompted. This unlock's window ends here.
        if (!passwordSlot) {
          retainedRef.current = null;
          return;
        }
        // Owed means NOT EQUAL — including a slot with no recorded revision
        // at all (a slot written before revisions were recorded).
        const owed = passwordSlot.credentialRevision !== envelopes.currentCredentialRevision;
        if (!owed) {
          // Not owed: this unlock's window ends here too —
          // the plaintext must not survive past a settled derive.
          retainedRef.current = null;
          return;
        }
        const retained = retainedRef.current;
        if (retained !== null) {
          // The unlock window ends here regardless of the write's outcome —
          // a non-credential failure is left owed for the NEXT unlock-state
          // transition (which, with no plaintext retained, prompts) rather
          // than retried against a stale plaintext.
          retainedRef.current = null;
          const outcome = await attemptRewrap(retained, true, generation, envelopes);
          if (generation !== generationRef.current) return;
          if (outcome === 'locked') {
            // The silent path must not discard this
            // outcome — the on-disk cached key (and
            // the in-memory HDK / isUnlocked) are already gone by
            // the time this runs, but nothing told the person why. Surface
            // it through the same terminal prompt state the asking path
            // uses, so the next unlock doesn't read as an ordinary,
            // unexplained session expiry.
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
    // Writes nothing; the next unlock-state transition derives owed again
    // and asks again.
    setPrompt(null);
  }, []);

  const answerPrompt = useCallback(
    async (password: string): Promise<void> => {
      const generation = generationRef.current;
      setPrompt((prev) => (prev ? { ...prev, submitting: true, error: null } : prev));
      try {
        await verifyPassword(password, { purpose: 'password_slot_rewrap' });
      } catch (err) {
        // The session ended while this verify was in
        // flight — leave the (already-cleared) state alone.
        if (generation !== generationRef.current) return;
        if (isBackoffError(err)) {
          // A 429 reads as a wait, not a wrong-password attempt: it does not
          // count against `attemptsRemaining`. Surface why the
          // dialog is ending instead of vanishing — the person dismisses it
          // themselves; the next unlock-state transition re-derives and asks
          // again.
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
              // The LAST wrong guess must still say so, not
              // just vanish. The bound ends the asking for THIS unlock —
              // still owed; the next unlock-state transition asks again.
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
        // Any other failure (network, server fault): leave the prompt open
        // with a generic error so the person can retry without losing the
        // attempt bound above (this branch is not a wrong-password guess).
        setPrompt((prev) =>
          prev ? { ...prev, submitting: false, error: 'Something went wrong. Please try again.' } : prev,
        );
        return;
      }
      if (generation !== generationRef.current) return;
      // This prompt can sit open for real time — long
      // enough for another tab/device to complete the re-wrap (or for the
      // password slot to vanish) before this submit lands. Re-fetch and
      // repeat the SAME owed-ness compare `runDerive` used to open it,
      // right before writing anything, rather than trusting the snapshot
      // that opened it. A fetch failure here falls back to letting
      // `rotatePasswordSlot`'s own fresh fetch decide (unchanged behaviour)
      // rather than surfacing a second failure mode.
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
          // Another device already completed the re-wrap (or the slot is
          // gone) while this prompt was open — nothing is owed anymore.
          // Close without writing, exactly as `runDerive` would decide had
          // it re-run this instant.
          setPrompt(null);
          return;
        }
      }
      // The password just verified — no further re-authentication needed on
      // a stale-authority refusal (verify-password already repaired it in
      // place); one attempt is all that is needed.
      const outcome = await attemptRewrap(password, false, generation, freshEnvelopes);
      if (generation !== generationRef.current) return;
      if (outcome === 'written') {
        setPrompt(null);
        return;
      }
      if (outcome === 'written-degraded') {
        // Committed server-side,
        // and this device's fallback floor confirmed it — never presented
        // as a refusal. `reportRewrapFailure` already logged the fallback
        // as a diagnostic; nothing more is owed here.
        setPrompt(null);
        return;
      }
      if (outcome === 'locked') {
        // Committed server-side, but neither the durable pin nor the
        // fallback floor could be confirmed — `rotatePasswordSlot` has
        // already locked this device (cleared the in-memory HDK /
        // isUnlocked) as a precaution. Say so, rather than the refusal
        // copy below, which would describe a refusal that never happened.
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
      // A correct-password refusal must not read as
      // success — distinguish a permanent integrity problem (retrying will
      // not help) from a transient one (expected to resolve on its own),
      // and surface it rather than silently closing. Either way the slot is
      // left untouched and still owed; the next unlock-state transition
      // tries again.
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
