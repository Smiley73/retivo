/**
 * Security page: Change-password card (trigger + modal). The modal is a real
 * `<form>` with current-/new-password autocomplete tokens + a hidden username
 * and locked outside-click dismissal (see "Password managers" in
 * docs/ui-conventions.md).
 *
 * Owns the change-password modal state and its dirty-modal-close +
 * unsaved-changes navigation guards. The success notice is hoisted to the page
 * (it renders at the very top, above the card rows) via `onSuccess`, so the DOM
 * order is identical to the pre-split page. The page-level navigation-guard
 * modal is rendered here too (`pwPendingNavModal`) — its placement does not
 * affect behavior since it portals.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { PasswordChangeCommittedError, PasswordChangeNotSentError } from '../auth/types';
import { ApiRequestError } from '../api/client';
import { PasswordManagerModal } from '../components/PasswordManagerModal';
import { Field } from '../components/Field';
import { Tooltip } from '../components/Tooltip';
import { InfoIcon } from '../components/icons';
import { TextInput } from '../components/TextInput';
import { Muted } from '../components/Muted';
import { RepoLink } from '../components/RepoLink';
import { HiddenUsernameField } from '../components/password-manager';
import { StepUpModal } from '../components/StepUpModal';
import { useStepUp, type StepUpProof } from '../components/useStepUp';
import { useDirtyModalClose, useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import {
  SettingsCard,
  btnPrimarySmClass,
  btnSecondaryClass,
  btnDangerClass,
  inputClass,
  KeyIcon,
} from './profile-page-chrome';

// Mirrors the server-side COMPLEXITY_REGEX (password-validator.service.ts): at
// least one lower, upper, digit, and one special character from the exact
// 32-character POSIX [:punct:] ASCII set (hex-range class), so client and
// server accept the same character set.
const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/;

/** Rolling-deployment / superseded-session answer: never a validation
 * error on the form — a reload prompt instead. */
const RELOAD_MESSAGE = 'A newer version of this page is available. Reload the page and try again.';

/** Lost-response wording: the
 * request left the client and there is no authenticated read that can prove
 * an outcome, so neither password can be assumed correct. */
const SIGN_IN_AGAIN_MESSAGE =
  'We could not confirm whether your password changed. Sign in again — try your new password first, and your old one if that fails.';

/**
 * Error codes the server only ever throws BEFORE any commit — session
 * revocation, denylisting, or re-issue — happens (`ChangePasswordService.
 * commitChangeTransaction`, apps/api/src/auth/change-password.service.ts).
 * A response carrying one of these is a definite rejection, not a lost
 * response: the credential row and the slot are provably unchanged, the same
 * as the 409 `STALE_ENVELOPE_VERSION` / `UPGRADE_REQUIRED` cases already
 * classified `rejected`. Currently only `CHANGE_PASSWORD_CONFLICT` (503, a
 * transient DynamoDB failure caught inside `runTransactWrite`'s
 * `TransientTransactionError` handler) falls outside the ordinary 4xx range
 * this guarantee would otherwise cover.
 */
const PRE_COMMIT_GUARANTEED_REJECTION_CODES = new Set(['CHANGE_PASSWORD_CONFLICT']);

/**
 * The observable outcome of a `changePassword` attempt:
 *  - `not-sent` — a preparation failure ({@link PasswordChangeNotSentError}):
 *    nothing was ever sent to the server. Definitely unchanged, safe to retry
 *    from this form with the SAME old password.
 *  - `upgrade-required` — the rolling-deployment / superseded-session answer:
 *    reload, never a validation error.
 *  - `rejected` — a known pre-commit validation/conflict code from the server
 *    (4xx, not the client's own synthesized `UNKNOWN_ERROR` /
 *    `INVALID_RESPONSE` codes, plus any code in
 *    {@link PRE_COMMIT_GUARANTEED_REJECTION_CODES}): the commit was refused
 *    server-side before anything that could make the outcome ambiguous.
 *    Definitely unchanged, safe to retry from this form.
 *  - `committed` — the server CONFIRMED the commit (a 200) but this device
 *    could not durably advance its rollback pin afterwards
 *    ({@link PasswordChangeCommittedError}): the password definitely changed
 *    and the workspace is now locked on this device. Never the sign-in-again
 *    wording (that claims ignorance of a verdict the client has), and never
 *    a route back to the form (the OLD password is definitely wrong now).
 *  - `indeterminate` — a network failure, an unparseable response, or any
 *    other 5xx: the request may have committed and there is no authenticated
 *    read that can tell. Never claim a verdict — sign in again instead of
 *    replaying the old password against the shared per-account login backoff.
 */
type ChangeOutcome = 'not-sent' | 'upgrade-required' | 'rejected' | 'committed' | 'indeterminate';

function classifyChangePasswordOutcome(err: unknown): ChangeOutcome {
  if (err instanceof PasswordChangeNotSentError) return 'not-sent';
  if (err instanceof PasswordChangeCommittedError) return 'committed';
  if (err instanceof ApiRequestError) {
    if (err.error.code === 'UPGRADE_REQUIRED') return 'upgrade-required';
    if (PRE_COMMIT_GUARANTEED_REJECTION_CODES.has(err.error.code)) return 'rejected';
    if (err.status >= 400 && err.status < 500 && err.error.code !== 'UNKNOWN_ERROR' && err.error.code !== 'INVALID_RESPONSE') {
      return 'rejected';
    }
    return 'indeterminate';
  }
  // A network failure / timeout thrown mid-request (not wrapped as
  // ApiRequestError) after the POST left the client.
  return 'indeterminate';
}

/** The message for a `not-sent` or `rejected` outcome — nothing changed, so
 * surface the specific reason and keep the form open for a retry. */
function retryableMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.error.message;
  if (err instanceof Error) return err.message;
  return 'Could not change your password. Try again.';
}

/** What a `rejected` / `not-sent` outcome shows: the server's message, except
 * for `PASSWORD_SLOT_NOT_CANONICAL`, whose reporting link only the web can
 * build — keyed on the error code, never on the message text. */
function rejectionNotice(err: unknown): React.ReactNode {
  if (err instanceof ApiRequestError && err.error.code === 'PASSWORD_SLOT_NOT_CANONICAL') {
    return (
      <>
        This account cannot change its password right now. Re-run key setup, or{' '}
        <RepoLink kind="issue" />.
      </>
    );
  }
  return retryableMessage(err);
}

interface Props {
  /** Account email for the hidden username field. */
  email: string;
  /** Page-level error sink (single top-of-page Alert). A node, not only a
   * string, so a message can carry a link. */
  onError: (message: React.ReactNode) => void;
  /** Fired after a successful change so the page can show the top-of-page notice. */
  onSuccess: () => void;
}

export const PasswordChangeCard: React.FC<Props> = ({ email, onError, onSuccess }) => {
  const {
    changePassword,
    getMfaStatus,
    stepUpPasskeyOptions,
    stepUpSendEmailOtp,
    isUnlocked,
    needsKeySetup,
  } = useAuth();
  const [showPwModal, setShowPwModal] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwSubmitting, setPwSubmitting] = useState(false);
  // A terminal outcome: set on a lost response (`indeterminate` — sign
  // in again, whichever password signs in is now theirs) or a confirmed
  // commit whose device-side confirmation failed (`committed` — the workspace
  // is locked on this device). Once set, the card renders this notice IN
  // PLACE of the "Change password" trigger, so there is no route back to the
  // change form that would replay the old password against the shared
  // per-account login backoff — merely closing the modal would leave the
  // trigger a click away.
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null);

  // Step-up eligibility: when `AUTH_MFA_ENFORCED`
  // is on, changing the password requires a fresh second factor on top of the
  // current password. Loaded on mount from GET /auth/mfa/status; when off the
  // flow is unchanged (no step-up step).
  const [stepUpRequired, setStepUpRequired] = useState(false);
  const [stepUpMethods, setStepUpMethods] = useState<string[]>(['email_otp']);
  const [stepUpRecoveryMethods, setStepUpRecoveryMethods] = useState<string[]>([]);
  const [showStepUp, setShowStepUp] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMfaStatus()
      .then((s) => {
        if (cancelled) return;
        setStepUpRequired(!!s.stepUpRequired);
        if (s.methods?.length) setStepUpMethods(s.methods);
        if (s.recoveryMethods) setStepUpRecoveryMethods(s.recoveryMethods);
      })
      // A status-read failure leaves the default (no step-up shown); the server
      // still enforces the factor, surfacing as an error on the change call.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [getMfaStatus]);

  // The password fields all start empty when the modal opens, so any non-empty
  // value means the user has typed something — baseline is implicit, no ref
  // needed. See "Form controls" in docs/ui-conventions.md.
  const isPwDirty = useMemo(
    () => showPwModal && (pwCurrent !== '' || pwNew !== '' || pwConfirm !== ''),
    [showPwModal, pwCurrent, pwNew, pwConfirm],
  );

  const closePwModal = useCallback(() => {
    if (pwSubmitting) return;
    setShowPwModal(false);
    setShowStepUp(false);
    setPwCurrent('');
    setPwNew('');
    setPwConfirm('');
  }, [pwSubmitting]);

  const { guardedClose: pwGuardedClose, immediateClose: pwImmediateClose, confirmModal: pwCloseConfirmModal } =
    useDirtyModalClose(isPwDirty, closePwModal);
  const { pendingNavModal: pwPendingNavModal } = useUnsavedChangesGuard(isPwDirty);

  const pwValid = pwNew.length >= 16 && PASSWORD_REGEX.test(pwNew);

  // Run the actual change, carrying a collected step-up factor when one was
  // required (the flag-off floor is password-only, so `proof` stays undefined).
  const performChange = useCallback(
    async (proof?: StepUpProof) => {
      setPwSubmitting(true);
      try {
        await changePassword(pwCurrent, pwNew, proof);
        // Clear the fields BEFORE flipping the modal closed so the dirty memo
        // sees a clean state on the next render and doesn't briefly think we're
        // navigating away with unsaved edits.
        setPwCurrent('');
        setPwNew('');
        setPwConfirm('');
        setShowStepUp(false);
        setShowPwModal(false);
        onSuccess();
      } finally {
        setPwSubmitting(false);
      }
    },
    [changePassword, pwCurrent, pwNew, onSuccess],
  );

  // Step-up factor collection: on a verified factor, run the change inline (so an
  // ambiguous confirm failure surfaces the modal's non-retryable error).
  //
  // `onVerify` runs the WHOLE change-password request (the factor proof rides
  // in the same body as the passwords) — a failure here is a
  // password-change outcome, not a bare step-up-factor rejection, so it is
  // routed through the SAME classifier `onChangePassword` uses
  // rather than left to `useStepUp`'s generic ambiguous-factor
  // handling, which would show "couldn't confirm it's you" after a change
  // that may have already committed, leave the step-up flow open, and still
  // enable Confirm. The error is swallowed here (never rethrown) so
  // `useStepUp`'s own catch never runs; `onVerified()` still fires afterward
  // via the normal resolve path, which is harmless — `onError` already holds
  // the right message.
  const stepUp = useStepUp({
    purpose: 'change_password',
    methods: stepUpMethods,
    recoveryMethods: stepUpRecoveryMethods,
    onSendEmailOtp: stepUpSendEmailOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: async (proof) => {
      try {
        await performChange(proof);
      } catch (err) {
        const outcome = classifyChangePasswordOutcome(err);
        if (outcome === 'indeterminate' || outcome === 'committed') {
          // Terminal either way: close BOTH modals, never leave Confirm
          // enabled to invite a replay, and replace the card's trigger with
          // the outcome notice so the form cannot be reopened. For a lost
          // response that is the new-password-first sign-in instruction; for
          // a confirmed-but-unpinned commit it is the specific
          // change-succeeded / unlock-again message (never the "may or may
          // not" wording for a verdict the client does have).
          const notice =
            outcome === 'indeterminate' ? SIGN_IN_AGAIN_MESSAGE : retryableMessage(err);
          setTerminalNotice(notice);
          setShowStepUp(false);
          closePwModal();
          onError(notice);
          return;
        }
        // 'upgrade-required' | 'rejected' | 'not-sent': the commit definitely
        // did not happen server-side. Return to the password form — the
        // factor was never the problem — rather than leaving the step-up
        // modal open on it.
        setShowStepUp(false);
        onError(outcome === 'upgrade-required' ? RELOAD_MESSAGE : rejectionNotice(err));
      }
    },
    onVerified: () => setShowStepUp(false),
  });
  const resetStepUp = stepUp.reset;

  // Seed the factor picker once the modal opens (the hook's initial factor was
  // captured before `methods` loaded from mfa/status — mirrors DeleteAccountCard).
  useEffect(() => {
    if (showStepUp) resetStepUp();
  }, [showStepUp, resetStepUp]);

  const onChangePassword = async () => {
    onError(null);
    if (pwNew !== pwConfirm) {
      onError('Passwords do not match');
      return;
    }
    if (!PASSWORD_REGEX.test(pwNew)) {
      onError('Password must contain at least one uppercase letter, one lowercase letter, one digit, and one special character');
      return;
    }
    // When step-up is required, gate the change behind a fresh factor: open the
    // reusable modal, which runs the change on a verified factor. Otherwise
    // (flag off) change straight away with the password only.
    if (stepUpRequired) {
      setShowStepUp(true);
      return;
    }
    try {
      await performChange();
    } catch (err) {
      const outcome = classifyChangePasswordOutcome(err);
      if (outcome === 'indeterminate' || outcome === 'committed') {
        // Lost response: the request may or may not have completed
        // server-side, and there is no authenticated read that can tell —
        // never claim a verdict. Or a CONFIRMED commit whose device-side pin
        // confirmation failed: the change definitely happened and the
        // workspace is locked here. Both are terminal for this card: close
        // the form AND replace the trigger with the outcome notice, so
        // nothing routes back to a form that would replay the old password
        // against the shared login backoff.
        const notice =
          outcome === 'indeterminate' ? SIGN_IN_AGAIN_MESSAGE : retryableMessage(err);
        setTerminalNotice(notice);
        closePwModal();
        onError(notice);
        return;
      }
      if (outcome === 'upgrade-required') {
        // Rolling-deployment / superseded-session answer: never shown
        // as a validation error on the form — a reload prompt instead.
        onError(RELOAD_MESSAGE);
        return;
      }
      // 'rejected' | 'not-sent': nothing changed — the old password still
      // signs in and still unlocks. Safe to retry from this form.
      onError(rejectionNotice(err));
    }
  };

  return (
    <>
      <SettingsCard
        title="Password"
        subtitle="Change the password you use to sign in."
      >
        {terminalNotice ? (
          // A terminal outcome replaced the trigger: reopening the form
          // to replay the old password is exactly what the lost-response
          // handling exists to prevent, so the way forward (sign in again /
          // unlock again) is stated instead until a fresh session renders
          // this card anew.
          <Muted className="block text-sm">{terminalNotice}</Muted>
        ) : needsKeySetup ? (
          <Muted className="block text-sm">
            Finish setting up encryption for this account before changing your password.
          </Muted>
        ) : !isUnlocked ? (
          <Muted className="block text-sm">
            Unlock your data on this device before changing your password.
          </Muted>
        ) : (
          <button
            type="button"
            className={`${btnPrimarySmClass} gap-1.5`}
            onClick={() => setShowPwModal(true)}
          >
            <KeyIcon />
            Change password
          </button>
        )}
      </SettingsCard>

      {/* Render through PasswordManagerModal (the containment-free overlay):
          the scrim swallows outside clicks — a password-manager popup renders
          outside the dialog, so clicking it would otherwise fire the
          dirty-guard close mid-entry — and the background is never inert, so
          the popup stays interactive. Esc is left enabled
          (`keyboardDismissDisabled` unset) so it routes through
          `pwGuardedClose` (the dirty guard); Cancel still closes immediately. */}
      <PasswordManagerModal
        open={showPwModal && !showStepUp}
        onClose={pwGuardedClose}
        title="Change password"
        size="md"
      >
        {/* Real form (password-manager interop): managers detect the
            change-password shape from the
            current-/new-password autocomplete tokens + the hidden username,
            offer "update password?" on submit, and can fill-and-submit. */}
        <form
          method="post"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            // Same gate as the submit button: Enter (or a manager's
            // fill-and-submit) can't bypass validation or double-fire.
            if (pwSubmitting || !pwCurrent || !pwValid || pwNew !== pwConfirm) return;
            void onChangePassword();
          }}
        >
          <HiddenUsernameField email={email} />
          <div className="flex flex-col gap-3">
            <Field htmlFor="pw-current" label="Current password">
              <TextInput
                id="pw-current"
                name="current-password"
                type="password"
                autoComplete="current-password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field
              htmlFor="pw-new"
              label={
                <span className="inline-flex items-center gap-1">
                  New password
                  <Tooltip
                    multiline
                    content="Min 16 characters, must include uppercase, lowercase, a digit, and a special character. Common passwords are rejected."
                  >
                    <span
                      role="img"
                      aria-label="Password requirements"
                      className="inline-flex cursor-help text-muted"
                    >
                      <InfoIcon />
                    </span>
                  </Tooltip>
                </span>
              }
            >
              <TextInput
                id="pw-new"
                name="new-password"
                type="password"
                autoComplete="new-password"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field
              htmlFor="pw-confirm"
              label="Confirm new password"
              error={
                pwConfirm && pwNew !== pwConfirm ? 'Passwords do not match' : undefined
              }
            >
              <TextInput
                id="pw-confirm"
                name="confirm-new-password"
                type="password"
                autoComplete="new-password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
          {/* Left-aligned, primary first — AGENTS modal rule. */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className={btnDangerClass}
              disabled={pwSubmitting || !pwCurrent || !pwValid || pwNew !== pwConfirm}
            >
              {pwSubmitting ? 'Changing…' : 'Change password'}
            </button>
            <button
              type="button"
              className={btnSecondaryClass}
              onClick={pwImmediateClose}
              disabled={pwSubmitting}
            >
              Cancel
            </button>
          </div>
        </form>
      </PasswordManagerModal>

      {/* Fresh second-factor step-up: shown only
          when `AUTH_MFA_ENFORCED` is on, after the password form. Verifying a
          factor runs the change inline; an ambiguous failure surfaces the
          modal's non-retryable error. */}
      <StepUpModal
        open={showStepUp}
        onClose={() => {
          if (stepUp.submitting) return;
          setShowStepUp(false);
        }}
        title="Confirm it's you"
        stepUp={stepUp}
        confirmLabel="Change password"
      >
        <Muted className="block text-sm">
          Confirm it&apos;s you with a second factor to change your password.
        </Muted>
      </StepUpModal>

      {pwCloseConfirmModal}
      {pwPendingNavModal}
    </>
  );
};
