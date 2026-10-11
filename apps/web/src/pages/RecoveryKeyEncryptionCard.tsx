/**
 * Security page: Recovery key & encryption card — status, the "Generate a new
 * recovery key" prepare-then-commit rotation, and the locked-no-unwrapper
 * "Use recovery key to unlock your data" + "Start over" reset (see "Start over
 * (resetting encryption)" in docs/security.md).
 *
 * Owns the recovery-key regeneration flow (password re-auth → RecoveryKeyModal
 * prepare-then-commit → activation + SuccessNotice), the start-over flow, and
 * the locked-state recovery actions. Self-sources auth from `useAuth`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth, DEVICE_ID_STORAGE_KEY } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { PasswordManagerModal } from '../components/PasswordManagerModal';
import { Alert } from '../components/Alert';
import { Field } from '../components/Field';
import { Muted } from '../components/Muted';
import { TextInput } from '../components/TextInput';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { RecoveryKeyModal } from '../components/RecoveryKeyModal';
import { StepUpModal } from '../components/StepUpModal';
import { useStepUp, type StepUpProof } from '../components/useStepUp';
import { HiddenUsernameField, PM_IGNORE_ATTRS } from '../components/password-manager';
import { clearAllLocalData } from '../lib/local-data';
import {
  ENCRYPTED_WORKSPACE_RESET_PHRASE,
  resetEncryptedWorkspace,
} from '../auth/key-envelope-client';
import {
  SettingsCard,
  SuccessNotice,
  PasswordPromptModal,
  btnPrimarySmClass,
  btnSecondarySmClass,
  btnDangerSmClass,
  btnSecondaryClass,
  btnDangerClass,
  inputClass,
  KeyIcon,
  TrashIcon,
  LockOpenIcon,
} from './profile-page-chrome';

interface Props {
  /** Account email for the password re-auth prompt's hidden username. */
  email: string;
  /** Whether the household data key is unlocked in memory. */
  isUnlocked: boolean;
  /** Authenticated but locked out with no unwrapper. */
  isLockedNoUnlock: boolean;
}

export const RecoveryKeyEncryptionCard: React.FC<Props> = ({
  email,
  isUnlocked,
  isLockedNoUnlock,
}) => {
  const {
    regenerateRecoveryKey,
    getMfaStatus,
    stepUpPasskeyOptions,
    stepUpSendEmailOtp,
  } = useAuth();
  const navigate = useNavigate();

  // Encrypted-workspace "Start over" flow. The gate is phrase + password
  // (always) + a fresh step-up
  // factor when `AUTH_MFA_ENFORCED` is on.
  const [showStartOverModal, setShowStartOverModal] = useState(false);
  const [startOverPhrase, setStartOverPhrase] = useState('');
  const [startOverPassword, setStartOverPassword] = useState('');
  const [startOverError, setStartOverError] = useState<string | null>(null);
  const [startOverSubmitting, setStartOverSubmitting] = useState(false);
  const startOverPhraseMatches = startOverPhrase === ENCRYPTED_WORKSPACE_RESET_PHRASE;

  // Step-up eligibility, loaded on mount from GET /auth/mfa/status. When the
  // flag is off the flow is phrase + password only (no step-up step). The
  // collected factor lives in a ref so `runReset` reads it synchronously right
  // after `onVerified` fires (avoiding a stale-state race).
  const [stepUpRequired, setStepUpRequired] = useState(false);
  const [stepUpMethods, setStepUpMethods] = useState<string[]>(['email_otp']);
  const [stepUpRecoveryMethods, setStepUpRecoveryMethods] = useState<string[]>([]);
  const [showStepUp, setShowStepUp] = useState(false);
  const stepUpProofRef = useRef<StepUpProof | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMfaStatus()
      .then((s) => {
        if (cancelled) return;
        setStepUpRequired(!!s.stepUpRequired);
        if (s.methods?.length) setStepUpMethods(s.methods);
        if (s.recoveryMethods) setStepUpRecoveryMethods(s.recoveryMethods);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [getMfaStatus]);

  // Recovery-key regeneration. A signed-in user who lost
  // their saved recovery key can mint a fresh one: the original key's raw bytes
  // are never persisted, so re-displaying it is impossible — rotating is
  // the only path. Two-phase prepare → commit so NOTHING changes server-side
  // until the user confirms they saved the new key:
  //   1. password re-auth (password only, no passkey) → `regenerateRecoveryKey`
  //      mints + returns the new key + an `activate` thunk (no write yet);
  //   2. the new key shows in RecoveryKeyModal; "Activate new key" calls
  //      `activate()` (the only moment the old key is replaced);
  //   3. Cancel opens a confirm; confirming aborts with the old key untouched.
  // `regenPending` holds { recoveryKey, activate } while the save-modal is open.
  const [regenPasswordOpen, setRegenPasswordOpen] = useState(false);
  const [regenPasswordValue, setRegenPasswordValue] = useState('');
  const [regenPasswordError, setRegenPasswordError] = useState<string | null>(null);
  const [regenSubmitting, setRegenSubmitting] = useState(false);
  const [regenPending, setRegenPending] = useState<{
    recoveryKey: string;
    activate: (proof?: StepUpProof) => Promise<void>;
  } | null>(null);
  const [regenActivating, setRegenActivating] = useState(false);
  const [regenActivateError, setRegenActivateError] = useState<string | null>(null);
  const [regenAbortConfirm, setRegenAbortConfirm] = useState(false);
  // Fresh second-factor step-up: activation
  // always REPLACES an existing `recovery` slot — the exemption matrix never
  // exempts that — so `AUTH_MFA_ENFORCED` demands a proof right before the
  // commit. Same ref-stash pattern as the Start-over flow below.
  const [showRegenStepUp, setShowRegenStepUp] = useState(false);
  const regenStepUpProofRef = useRef<StepUpProof | null>(null);
  // Success confirmation after a recovery key is activated. The flow otherwise
  // goes silent (the modal just closes), leaving an anxious user unsure it
  // worked; SuccessNotice carries role="status" so it's announced too. Cleared
  // when a fresh regeneration starts so stale "now active" copy can't linger.
  const [regenActivated, setRegenActivated] = useState(false);

  const closeRegenPasswordModal = useCallback(() => {
    // Don't tear down mid-regeneration: a fresh recovery slot may be landing.
    if (regenSubmitting) return;
    setRegenPasswordOpen(false);
    setRegenPasswordValue('');
    setRegenPasswordError(null);
  }, [regenSubmitting]);

  const onRegeneratePasswordContinue = useCallback(async () => {
    // Re-entrancy guard: onEnter can fire while a prepare is already in flight
    // (rapid Enter presses).
    if (regenSubmitting) return;
    if (!regenPasswordValue) return;
    setRegenPasswordError(null);
    setRegenSubmitting(true);
    try {
      // PREPARE only: regenerateRecoveryKey re-auths by unwrapping the password
      // slot with this password (a wrong password throws KeyWrappingError) and
      // mints the new key + an `activate` thunk WITHOUT writing anything — the
      // existing recovery key keeps working until the user confirms. Tear down the
      // password modal and hand the pending key to the save-key modal to show once.
      const pending = await regenerateRecoveryKey(regenPasswordValue);
      setRegenPasswordOpen(false);
      setRegenPasswordValue('');
      setRegenActivateError(null);
      regenStepUpProofRef.current = null;
      setRegenPending(pending);
    } catch (err) {
      // Wrong password (KeyWrappingError) or a tampered set: nothing was minted or
      // written, so surface inline in the password modal for a retry.
      if (err instanceof ApiRequestError) {
        setRegenPasswordError(err.error.message);
      } else {
        setRegenPasswordError(
          'That password was incorrect, or your data could not be verified. Please try again.',
        );
      }
    } finally {
      setRegenSubmitting(false);
    }
  }, [regenSubmitting, regenPasswordValue, regenerateRecoveryKey]);

  // Commit the prepared activate() thunk with whatever proof was collected
  // (undefined on the flag-off floor). Shared by the direct path and the
  // step-up-gated path below.
  const doActivateRegeneratedKey = useCallback(
    async (proof?: StepUpProof) => {
      if (!regenPending) return;
      setRegenActivateError(null);
      setRegenActivating(true);
      try {
        await regenPending.activate(proof);
        setRegenPending(null);
        setRegenActivated(true);
      } catch {
        setRegenActivateError(
          'Could not activate your new recovery key. Your previous key still works. Please try again.',
        );
      } finally {
        // Step-up proofs are single-use: whatever
        // proof this call carried is now consumed server-side regardless of
        // outcome, so a failed attempt must not leave it stashed — the retry
        // this error message invites would otherwise resend the same
        // already-consumed proof and fail identically forever. Clearing here
        // (not only on success) forces `onActivateRegeneratedKey` to
        // re-collect a fresh factor on the next click.
        regenStepUpProofRef.current = null;
        setRegenActivating(false);
      }
    },
    [regenPending],
  );

  const regenStepUp = useStepUp({
    purpose: 'key_envelope_replace',
    methods: stepUpMethods,
    recoveryMethods: stepUpRecoveryMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: async (proof: StepUpProof) => {
      regenStepUpProofRef.current = proof;
    },
    onVerified: () => {
      setShowRegenStepUp(false);
      void doActivateRegeneratedKey(regenStepUpProofRef.current ?? undefined);
    },
  });
  const resetRegenStepUp = regenStepUp.reset;
  useEffect(() => {
    if (showRegenStepUp) resetRegenStepUp();
  }, [showRegenStepUp, resetRegenStepUp]);

  // "Activate new key": the ONLY moment the rotation is committed server-side.
  // Gate behind a fresh factor first when `AUTH_MFA_ENFORCED` is on —
  // this always replaces an existing `recovery` slot. Calls the prepared
  // `activate` thunk (PUT + pin advance); the old key stops working once it
  // lands. A failure keeps the modal open with an inline error so the user
  // can retry without losing the shown key.
  const onActivateRegeneratedKey = useCallback(() => {
    if (!regenPending || regenActivating) return;
    if (stepUpRequired && !regenStepUpProofRef.current) {
      setShowRegenStepUp(true);
      return;
    }
    void doActivateRegeneratedKey(regenStepUpProofRef.current ?? undefined);
  }, [regenPending, regenActivating, stepUpRequired, doActivateRegeneratedKey]);

  // Cancel on the new-key modal asks for confirmation first (the key isn't shown
  // again). Confirming aborts the whole flow: no `activate()` call, so nothing was
  // ever written and the existing recovery key is untouched.
  const onAbortRegeneration = useCallback(() => {
    setRegenAbortConfirm(false);
    setRegenActivateError(null);
    setRegenPending(null);
    regenStepUpProofRef.current = null;
    resetRegenStepUp();
  }, [resetRegenStepUp]);

  // Step-up wiring: the destructive reset is inline (no separate verify
  // endpoint), so `onVerify` stashes the collected proof in a ref and
  // `onVerified` runs the reset carrying it. `runReset` is defined below and
  // reached through a ref so the hook doesn't forward-reference it.
  const runResetRef = useRef<() => Promise<void>>(async () => {});
  const stepUp = useStepUp({
    purpose: 'encrypted_workspace_reset',
    methods: stepUpMethods,
    recoveryMethods: stepUpRecoveryMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: async (proof: StepUpProof) => {
      stepUpProofRef.current = proof;
    },
    onVerified: () => {
      setShowStepUp(false);
      void runResetRef.current();
    },
  });
  const resetStepUp = stepUp.reset;

  // Seed the factor picker once the modal opens (the hook's initial factor was
  // captured before `methods` loaded from mfa/status).
  useEffect(() => {
    if (showStepUp) resetStepUp();
  }, [showStepUp, resetStepUp]);

  const closeStartOverModal = useCallback(() => {
    if (startOverSubmitting) return;
    setShowStartOverModal(false);
    setStartOverPhrase('');
    setStartOverPassword('');
    setStartOverError(null);
    setShowStepUp(false);
    stepUpProofRef.current = null;
    resetStepUp();
  }, [startOverSubmitting, resetStepUp]);

  const runReset = useCallback(async () => {
    setStartOverSubmitting(true);
    setStartOverError(null);
    // Server re-verifies the password + fresh factor, then wipes the unreadable
    // household sync state + snapshots + key envelopes and revokes every session
    // — the account survives. Only the server reset is recoverable-on-failure: if
    // it throws nothing has happened yet, so re-enable the form + surface the
    // error and bail. A failed reset may have consumed the factor, so drop it and
    // require a fresh one on retry.
    try {
      await resetEncryptedWorkspace(
        startOverPassword,
        stepUpProofRef.current ?? undefined,
      );
    } catch (err) {
      setStartOverSubmitting(false);
      stepUpProofRef.current = null;
      resetStepUp();
      if (err instanceof ApiRequestError) {
        setStartOverError(err.error.message);
      } else {
        setStartOverError('Could not start over. Please try again.');
      }
      return;
    }
    // Past this point the server already revoked every session and wiped
    // the workspace — there is no safe "stay here" state. The local nuke
    // is best-effort cleanup (the now-empty household can no longer decrypt
    // this device's copy anyway); a failure must NOT trap the user in stale
    // authenticated state, so swallow it and navigate regardless. Preserve
    // the deviceId across the nuke (same rationale as account deletion): no
    // reload happens here, so AuthProvider stays mounted holding the
    // in-memory deviceId.
    try {
      await clearAllLocalData({ preserveLocalKeys: [DEVICE_ID_STORAGE_KEY] });
    } catch (err) {
      console.warn('[profile] Start over: local data clear failed', err);
    }
    // Hard navigation (not React Router): the server revoked every
    // session, but AuthContext still holds isAuthenticated=true + stale
    // in-memory JWT claims. A soft navigate('/login') would let
    // LoginPage bounce straight back to /dashboard (still "authed"),
    // 401 the next call, and cascade through a doomed token-refresh
    // before logging out. A full reload reinitialises React +
    // AuthContext from scratch; the startup refresh-cookie attempt 401s
    // (all tokens revoked) so it lands on isAuthenticated=false cleanly.
    // No logout() call first — the server already revoked everything, so
    // POST /auth/logout would just 401.
    window.location.href = '/login';
  }, [startOverPassword, resetStepUp]);
  runResetRef.current = runReset;

  // "Delete and start over": gate on a fresh factor when required (and not yet
  // collected), else run the reset straight away (flag-off floor = phrase +
  // password).
  const onStartOverSubmit = useCallback(() => {
    if (!startOverPhraseMatches || !startOverPassword) return;
    if (stepUpRequired && !stepUpProofRef.current) {
      setStartOverError(null);
      setShowStepUp(true);
      return;
    }
    void runReset();
  }, [startOverPhraseMatches, startOverPassword, stepUpRequired, runReset]);

  return (
    <>
      <SettingsCard
        title="Recovery key & encryption"
        subtitle="Your saved data is encrypted before it leaves this device. A recovery key lets you unlock it if you forget your password."
      >
        {/* Recovery-key status. */}
        <p className="m-0 text-sm text-ink">
          {isUnlocked || isLockedNoUnlock
            ? 'Recovery key set.'
            : 'No recovery key yet. You can set one up once encryption is enabled.'}
        </p>

        {/* Activation succeeded — the flow otherwise closes silently, so
            confirm it landed (and that the old key is now retired).
            role="status" on SuccessNotice announces it to screen readers. */}
        {regenActivated && (
          <SuccessNotice className="mt-3">
            Your new recovery key is now active. Your previous recovery key no
            longer works.
          </SuccessNotice>
        )}

        {isUnlocked && (
          <div className="mt-4 flex flex-col items-start gap-3 border-t border-line pt-4">
            <p className="m-0 text-sm text-muted">
              Lost your recovery key? You can generate a new one. We
              can&apos;t show your existing key again, but your current key
              keeps working until you activate the new one.
            </p>
            <button
              type="button"
              className={`${btnSecondarySmClass} gap-1.5`}
              onClick={() => {
                setRegenActivated(false);
                setRegenPasswordError(null);
                setRegenPasswordValue('');
                setRegenPasswordOpen(true);
              }}
            >
              <KeyIcon />
              Generate a new recovery key
            </button>
          </div>
        )}

        {/* "Start over with this account": the recovery path when the user
            is authenticated but locked out of their encrypted data with no
            way to unlock it. Keeps the account, wipes the
            unreadable data. Hidden in every other state. */}
        {isLockedNoUnlock && (
          <div className="mt-4 border-t border-line pt-4">
            <p className="m-0 mb-3 text-sm text-ink">
              We couldn&apos;t unlock your encrypted data on this device. If you
              can&apos;t recover it with your password or recovery key, you can
              start over: your account stays, but the unreadable data is
              permanently deleted.
            </p>
            {/* Positive recovery path first (try the key), then the destructive
                last resort below. The "Use recovery key" button navigates
                to the unlock prompt with recovery mode pre-selected via
                `?mode=recovery`. Stacked (flex-col) so the destructive action
                reads as the second, separate option. */}
            <div className="flex flex-col items-start gap-3">
              <button
                type="button"
                className={`${btnPrimarySmClass} gap-1.5`}
                onClick={() => navigate('/login?mode=recovery')}
              >
                <LockOpenIcon />
                Use recovery key to unlock your data
              </button>
              <button
                type="button"
                className={`${btnDangerSmClass} gap-1.5`}
                onClick={() => {
                  setStartOverError(null);
                  setStartOverPhrase('');
                  setShowStartOverModal(true);
                }}
              >
                <TrashIcon />
                Delete unreadable encrypted data
              </button>
            </div>
          </div>
        )}
      </SettingsCard>

      {/* Recovery-key regeneration re-auth. Password only — no
          passkey step. On a correct password, regenerateRecoveryKey mints a fresh
          recovery slot and the new key is shown once in RecoveryKeyModal below. */}
      <PasswordPromptModal
        open={regenPasswordOpen}
        onClose={closeRegenPasswordModal}
        title="Generate a new recovery key?"
        intro="This prepares a new recovery key to replace your current one. Your current key keeps working until you activate the new one on the next screen, and only stops working once you do. Enter your password to continue."
        error={regenPasswordError}
        inputId="regen-recovery-pw"
        value={regenPasswordValue}
        onValueChange={setRegenPasswordValue}
        email={email}
        onContinue={onRegeneratePasswordContinue}
        continueLabel={regenSubmitting ? 'Generating…' : 'Generate new key'}
        continueDisabled={!regenPasswordValue || regenSubmitting}
        cancelDisabled={regenSubmitting}
      />

      {/* The freshly-minted recovery key, shown once — but NOT yet active. Nothing
          changed server-side at prepare, so the existing key still works. "Activate
          new key" (onConfirmed) calls the prepared activate() thunk: the only point
          the old key is replaced. Cancel (onDismiss) opens a confirm; aborting never
          calls activate(), leaving the old key untouched. The raw key lives only in
          `regenPending` until activated or discarded — never persisted. */}
      {regenPending && !showRegenStepUp && (
        <RecoveryKeyModal
          recoveryKey={regenPending.recoveryKey}
          title="Save your new recovery key"
          intro="This is your new recovery key. It replaces your current one only when you confirm below; until then, your existing recovery key keeps working. Store it somewhere safe, separate from your password; a password manager is ideal."
          warning="We can't show this key again. If you cancel, your current recovery key stays in use and this new one is discarded."
          savedLabel="I have saved my new recovery key"
          confirmLabel={regenActivating ? 'Activating…' : 'Activate new key'}
          confirmDisabled={regenActivating}
          error={regenActivateError}
          // Lock the modal: scrim click / Esc do nothing, so a stray outside
          // interaction can't silently discard the un-reshowable new key. The
          // only way out is the explicit Cancel button (→ abort confirm) or
          // "Activate new key". This also removes the stacked-overlay pointer
          // race where a scrim-triggered confirm could be dismissed by the same
          // click that opened it.
          dismissable={false}
          onConfirmed={onActivateRegeneratedKey}
          onDismiss={() => {
            // Reached only via the explicit Cancel button now (scrim/Esc are
            // disabled). Don't interrupt an in-flight activation; otherwise ask
            // to confirm before discarding the (un-reshowable) new key.
            if (regenActivating) return;
            setRegenAbortConfirm(true);
          }}
        />
      )}

      {/* Confirm before aborting a regeneration: the new key won't be shown again,
          so a stray Cancel/Esc/scrim shouldn't silently discard it. Aborting is
          safe (nothing was written), so this is a benign (non-destructive) confirm. */}
      <ConfirmDialog
        open={regenAbortConfirm}
        size="lg"
        destructive={false}
        title="Cancel without activating?"
        message="Your new recovery key won't be activated, and your current recovery key stays in use. You can generate a new one again later."
        confirmLabel="Yes, cancel"
        cancelLabel="Keep going"
        onConfirm={onAbortRegeneration}
        onCancel={() => setRegenAbortConfirm(false)}
      />

      {/* Password re-auth surface — renders through PasswordManagerModal (real
          `<form>` + `type="submit"` + `current-password` autocomplete +
          `HiddenUsernameField`) so browser password managers autofill /
          fill-and-submit and the scrim swallows outside clicks (a manager popup
          rendered outside the dialog can't discard the typed password). Esc is
          gated off `startOverSubmitting` only. */}
      <PasswordManagerModal
        open={showStartOverModal && !showStepUp}
        onClose={closeStartOverModal}
        title="Start over with this account"
        size="md"
        keyboardDismissDisabled={startOverSubmitting}
      >
        <p className="mt-0 text-sm text-ink">
          This permanently deletes the encrypted data we can&apos;t unlock
          (on this device and on our servers) and signs you out of every
          device. <strong>This can&apos;t be undone.</strong> Your account,
          sign-in details, and security history stay. After this you can sign
          in again and start fresh.
        </p>
        {startOverError && (
          <Alert tone="error" className="mt-3">
            {startOverError}
          </Alert>
        )}
        <form
          method="post"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            // Same gate as the submit button: a stray Enter (or a manager's
            // fill-and-submit) can't bypass the disabled action or double-fire
            // while a reset is in flight.
            if (!startOverPhraseMatches || !startOverPassword || startOverSubmitting) {
              return;
            }
            onStartOverSubmit();
          }}
        >
          {/* Hidden username = the account email so a password manager associates
              the re-auth password with this account. */}
          <HiddenUsernameField email={email} />
          <Field
            htmlFor="start-over-password"
            label="Current password"
            className="mt-4"
          >
            <TextInput
              id="start-over-password"
              name="current-password"
              type="password"
              autoComplete="current-password"
              value={startOverPassword}
              onChange={(e) => setStartOverPassword(e.target.value)}
              className={inputClass}
              disabled={startOverSubmitting}
            />
          </Field>
          <Field
            htmlFor="start-over-phrase"
            label={`Type "${ENCRYPTED_WORKSPACE_RESET_PHRASE}" to confirm`}
            className="mt-4"
          >
            <TextInput
              id="start-over-phrase"
              value={startOverPhrase}
              onChange={(e) => setStartOverPhrase(e.target.value)}
              className={inputClass}
              autoComplete="off"
              // A type-to-confirm phrase, not a credential — keep password
              // managers from overlaying fill/save UI on it.
              {...PM_IGNORE_ATTRS}
              disabled={startOverSubmitting}
            />
          </Field>
          {/* Left-aligned, primary (destructive) first — AGENTS modal rule. */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className={btnDangerClass}
              disabled={!startOverPhraseMatches || !startOverPassword || startOverSubmitting}
            >
              {startOverSubmitting ? 'Starting over…' : 'Delete and start over'}
            </button>
            <button
              type="button"
              className={btnSecondaryClass}
              onClick={closeStartOverModal}
              disabled={startOverSubmitting}
            >
              Cancel
            </button>
          </div>
        </form>
      </PasswordManagerModal>

      {/* Fresh second-factor step-up: shown only
          when `AUTH_MFA_ENFORCED` is on, after the phrase + password gate and
          before the destructive reset actually runs. */}
      <StepUpModal
        open={showStepUp}
        onClose={() => {
          if (stepUp.submitting) return;
          setShowStepUp(false);
        }}
        title="Confirm it's you"
        stepUp={stepUp}
        confirmLabel="Confirm"
      >
        <Muted className="block text-sm">
          Confirm it&apos;s you with a second factor before permanently deleting
          your unreadable encrypted data.
        </Muted>
      </StepUpModal>

      {/* Fresh second-factor step-up: shown only
          when `AUTH_MFA_ENFORCED` is on, right before "Activate new key"
          commits — activation always replaces the existing recovery slot. */}
      <StepUpModal
        open={showRegenStepUp}
        onClose={() => {
          if (regenStepUp.submitting) return;
          setShowRegenStepUp(false);
        }}
        title="Confirm it's you"
        stepUp={regenStepUp}
        confirmLabel="Confirm"
      >
        <Muted className="block text-sm">
          Confirm it&apos;s you with a second factor before activating your new
          recovery key.
        </Muted>
      </StepUpModal>
    </>
  );
};
