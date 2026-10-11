/**
 * Security page: Account record card + verified email-change flow.
 *
 * Two responsibilities:
 *  - The account record (email / name / birthdate) loaded from `GET
 *    /auth/me`. Name + birthdate are editable inline (Edit/Save/Cancel) via
 *    `PATCH /auth/me` — session-only, no password re-entry or MFA step-up.
 *    This is the READABLE account record; the encrypted household
 *    member records the projections read are a separate record, edited
 *    separately on the Household page, and are untouched by this card. Email
 *    stays on the verified flow below.
 *  - The verified email-change flow: a modal that re-authenticates with the
 *    current password + the new address (`POST /auth/change-email/request`),
 *    completes a fresh MFA factor when `AUTH_MFA_ENFORCED` is on, then shows a
 *    pending state ("check your new inbox") until the user clicks the
 *    verification link (which lands on ChangeEmailConfirmPage). The current
 *    email keeps working until then.
 *
 * Password-manager interop ("Password managers" in docs/ui-conventions.md): the
 * password field lives in a real `<form>` with a `type="submit"` action, the
 * `current-password` autocomplete token, and a `HiddenUsernameField`. The
 * re-auth modal renders through `<PasswordManagerModal>` (its scrim swallows
 * outside clicks so a password-manager popup rendered outside the dialog can't
 * dismiss it, and the background is never inert so the popup stays clickable),
 * mirroring PasswordChangeCard.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useAuth, updateSignupProfile, type AccountRecord } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { PasswordManagerModal } from '../components/PasswordManagerModal';
import { StepUpModal } from '../components/StepUpModal';
import { useStepUp, type StepUpProof } from '../components/useStepUp';
import { Field } from '../components/Field';
import { TextInput } from '../components/TextInput';
import { DatePicker } from '../components/DatePicker';
import { Muted } from '../components/Muted';
import { HiddenUsernameField } from '../components/password-manager';
import { useDirtyModalClose, useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { formatDate } from '../lib/format-date';
import { birthdateBounds, validateBirthdate } from '../lib/birthdate-validation';
import {
  SettingsCard,
  btnPrimarySmClass,
  btnSecondaryClass,
  btnPrimaryClass,
  inputClass,
} from './profile-page-chrome';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Modal sub-state. `form` collects the new email + password; `stepUp`
 * collects a fresh MFA factor (via the reusable {@link StepUpModal}); `pending`
 * confirms the link was sent. */
type Stage = 'form' | 'stepUp' | 'pending';

interface Props {
  /** Fallback email (from the JWT claim) shown before /auth/me resolves. */
  email: string;
  /** Page-level error sink (single top-of-page Alert). */
  onError: (message: string | null) => void;
}

export const AccountCard: React.FC<Props> = ({ email, onError }) => {
  const {
    me,
    fetchAccountRecord,
    updateAccountRecord,
    changeEmail,
    sendEmailChangeOtp,
    verifyEmailChangeStepUp,
    stepUpPasskeyOptions,
  } = useAuth();

  const [record, setRecord] = useState<AccountRecord | null>(null);
  // Tracks the initial `GET /auth/me` fetch:
  // Edit stays disabled until it settles, and stays
  // disabled on failure too, so a person can never open the edit form with
  // blank seed values that are indistinguishable from a legitimately-unset
  // field.
  const [recordLoading, setRecordLoading] = useState(true);
  const [recordLoadFailed, setRecordLoadFailed] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [stage, setStage] = useState<Stage>('form');
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [methods, setMethods] = useState<string[]>([]);
  const [recoveryMethods, setRecoveryMethods] = useState<string[]>([]);
  const [pendingEmail, setPendingEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Account-record edit form: a
  // separate Edit/Save/Cancel surface for firstName/lastName/birthdate,
  // independent of the email-change modal above.
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [birthdateInput, setBirthdateInput] = useState('');
  const [firstNameError, setFirstNameError] = useState<string | null>(null);
  const [lastNameError, setLastNameError] = useState<string | null>(null);
  const [birthdateError, setBirthdateError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const birthdateRange = useMemo(() => birthdateBounds(), []);

  // Change-email step-up runs on the reusable modal/hook.
  // The Email-OTP send is change-email's OWN endpoint (legacy `<userId>` row,
  // bound by the pending intent); the passkey factor uses the generic
  // purpose-scoped options endpoint; verify is change-email's verify-step-up.
  const onStepUpVerify = useCallback(
    async (proof: StepUpProof): Promise<void> => {
      await verifyEmailChangeStepUp(proof.method, proof.code ?? '', proof.response);
    },
    [verifyEmailChangeStepUp],
  );
  const stepUp = useStepUp({
    purpose: 'change_email',
    methods,
    recoveryMethods,
    onSendEmailOtp: sendEmailChangeOtp,
    onPasskeyOptions: stepUpPasskeyOptions,
    onVerify: onStepUpVerify,
    onVerified: () => setStage('pending'),
  });
  const resetStepUp = stepUp.reset;

  // Load the read-only account record once. On failure, surface it via
  // `onError` and leave `record` unset rather than seeding it with blank
  // fields — a blank field is otherwise indistinguishable from a genuinely
  // unset one, and `startEdit` must never be reachable off a failed load.
  useEffect(() => {
    let cancelled = false;
    setRecordLoading(true);
    setRecordLoadFailed(false);
    fetchAccountRecord()
      .then((r) => {
        if (cancelled) return;
        setRecord(r);
        setRecordLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRecordLoadFailed(true);
        setRecordLoading(false);
        onError('Could not load your account details. Please try reloading the page.');
      });
    return () => {
      cancelled = true;
    };
  }, [fetchAccountRecord, email, onError]);

  const displayedEmail = record?.email ?? email;
  const fullName = [record?.firstName, record?.lastName].filter(Boolean).join(' ');

  // Dirty only on the credential-collecting `form` stage — any non-empty field
  // means the user typed something. The later stages are post-submit.
  const isDirty = useMemo(
    () => showModal && stage === 'form' && (newEmail !== '' || password !== ''),
    [showModal, stage, newEmail, password],
  );

  // Edit-form dirty: any typed field differs from the last-loaded record.
  const editIsDirty = useMemo(
    () =>
      editing &&
      (firstName !== (record?.firstName ?? '') ||
        lastName !== (record?.lastName ?? '') ||
        birthdateInput !== (record?.birthdate ?? '')),
    [editing, firstName, lastName, birthdateInput, record],
  );

  const startEdit = useCallback(() => {
    setFirstName(record?.firstName ?? '');
    setLastName(record?.lastName ?? '');
    setBirthdateInput(record?.birthdate ?? '');
    setFirstNameError(null);
    setLastNameError(null);
    setBirthdateError(null);
    setEditError(null);
    setEditing(true);
  }, [record]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setEditError(null);
  }, []);

  const onSubmitEdit = async () => {
    onError(null);
    setEditError(null);
    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();
    const nextFirstNameError = trimmedFirst ? null : 'Enter a first name.';
    const nextLastNameError = trimmedLast ? null : 'Enter a last name.';
    const nextBirthdateError = validateBirthdate(birthdateInput);
    setFirstNameError(nextFirstNameError);
    setLastNameError(nextLastNameError);
    setBirthdateError(nextBirthdateError);
    if (nextFirstNameError || nextLastNameError || nextBirthdateError) return;

    setEditSubmitting(true);
    try {
      const updated = await updateAccountRecord({
        firstName: trimmedFirst,
        lastName: trimmedLast,
        birthdate: birthdateInput,
      });
      // Render from the server's response, not the typed values.
      setRecord(updated);
      // Rewrite the signup-profile handoff if one is still pending —
      // a first-run seed that hasn't run yet must pick up the correction, not
      // the stale signup-time values. No-op when no handoff exists.
      if (me?.id) {
        updateSignupProfile(me.id, {
          firstName: trimmedFirst,
          lastName: trimmedLast,
          birthdate: birthdateInput,
        });
      }
      setEditing(false);
    } catch (err) {
      // Leave the form open with the entered values; the displayed record
      // stays the last-loaded one (we never called setRecord).
      setEditError(
        err instanceof ApiRequestError
          ? err.error.message
          : 'Could not save your account details. Please try again.',
      );
    } finally {
      setEditSubmitting(false);
    }
  };

  const resetModal = useCallback(() => {
    setStage('form');
    setNewEmail('');
    setPassword('');
    setMethods([]);
    setRecoveryMethods([]);
    setPendingEmail('');
    resetStepUp();
  }, [resetStepUp]);

  const closeModal = useCallback(() => {
    if (submitting) return;
    setShowModal(false);
    resetModal();
  }, [submitting, resetModal]);

  const { guardedClose, immediateClose, confirmModal } = useDirtyModalClose(isDirty, closeModal);
  // Combined page-level guard: either the email-change form or the edit form
  // being dirty blocks in-app navigation / tab close.
  const { pendingNavModal } = useUnsavedChangesGuard(isDirty || editIsDirty);

  const emailValid = EMAIL_REGEX.test(newEmail);

  const onSubmitRequest = async () => {
    onError(null);
    if (!emailValid || !password) return;
    setSubmitting(true);
    try {
      const res = await changeEmail(newEmail, password);
      setPendingEmail(newEmail);
      // Drop the password from memory once the request succeeds.
      setPassword('');
      if (res.stepUpRequired) {
        setMethods(res.methods ?? []);
        setRecoveryMethods(res.recoveryMethods ?? []);
        setStage('stepUp');
      } else {
        setStage('pending');
      }
    } catch (err) {
      onError(
        err instanceof ApiRequestError
          ? err.error.message
          : 'Could not start the email change. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Seed the step-up factor picker once the request returns the eligible
  // factors (the hook's initial factor is captured before `methods` populates).
  useEffect(() => {
    if (stage === 'stepUp') resetStepUp();
  }, [stage, resetStepUp]);

  return (
    <>
      <SettingsCard
        title="Account"
        subtitle="Your sign-in email and account record."
      >
        <dl className="mb-4 flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="font-medium text-ink">Email</dt>
            <dd className="text-muted">{displayedEmail}</dd>
          </div>
          {!editing && fullName ? (
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="font-medium text-ink">Name</dt>
              <dd className="text-muted">{fullName}</dd>
            </div>
          ) : null}
          {!editing && record?.birthdate ? (
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="font-medium text-ink">Birthdate</dt>
              <dd className="text-muted">{formatDate(record.birthdate)}</dd>
            </div>
          ) : null}
        </dl>

        {editing ? (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (editSubmitting) return;
              void onSubmitEdit();
            }}
          >
            <div className="flex flex-col gap-3">
              <Field
                htmlFor="account-first-name"
                label="First name"
                error={firstNameError ?? undefined}
              >
                <TextInput
                  id="account-first-name"
                  name="given-name"
                  autoComplete="given-name"
                  required
                  aria-required="true"
                  aria-invalid={firstNameError ? true : undefined}
                  aria-describedby={firstNameError ? 'account-first-name-error' : undefined}
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field
                htmlFor="account-last-name"
                label="Last name"
                error={lastNameError ?? undefined}
              >
                <TextInput
                  id="account-last-name"
                  name="family-name"
                  autoComplete="family-name"
                  required
                  aria-required="true"
                  aria-invalid={lastNameError ? true : undefined}
                  aria-describedby={lastNameError ? 'account-last-name-error' : undefined}
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field
                htmlFor="account-birthdate"
                label="Birthdate"
                error={birthdateError ?? undefined}
              >
                <DatePicker
                  id="account-birthdate"
                  value={birthdateInput}
                  onChange={setBirthdateInput}
                  min={birthdateRange.min}
                  max={birthdateRange.max}
                  required
                  isInvalid={!!birthdateError}
                  aria-describedby={birthdateError ? 'account-birthdate-error' : undefined}
                />
              </Field>
            </div>
            {editError && (
              <p role="alert" className="mt-1 mb-3 text-sm text-negative">
                {editError}
              </p>
            )}
            <Muted className="mb-4 block text-xs">
              These are your account details. The people in your plan are
              edited separately on the{' '}
              <Link to="/household" className="underline">
                Household page
              </Link>
              . Changing one does not change the other.
            </Muted>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                className={btnPrimaryClass}
                disabled={editSubmitting}
              >
                {editSubmitting ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className={btnSecondaryClass}
                onClick={cancelEdit}
                disabled={editSubmitting}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <Muted className="mb-4 block text-xs">
              These are your account details. The people in your plan are
              edited separately on the{' '}
              <Link to="/household" className="underline">
                Household page
              </Link>
              . Changing one does not change the other.
            </Muted>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={btnPrimarySmClass}
                onClick={startEdit}
                disabled={recordLoading || recordLoadFailed}
              >
                Edit
              </button>
              <button
                type="button"
                className={btnPrimarySmClass}
                onClick={() => {
                  resetModal();
                  setShowModal(true);
                }}
              >
                Change email
              </button>
            </div>
          </>
        )}
      </SettingsCard>

      {/* Render through PasswordManagerModal (the containment-free overlay):
          the scrim swallows outside clicks — a password-manager popup renders
          outside the dialog, so clicking it would otherwise fire the dirty-guard
          close mid-entry — and the background is never inert, so the popup stays
          interactive. Esc is left enabled (`keyboardDismissDisabled` unset) so it
          routes through `guardedClose` (the dirty guard); Cancel still closes
          immediately. Mirrors PasswordChangeCard. */}
      <PasswordManagerModal
        open={showModal && stage !== 'stepUp'}
        onClose={guardedClose}
        title="Change email"
        size="md"
      >
        {stage === 'form' ? (
          <form
            method="post"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (submitting || !emailValid || !password) return;
              void onSubmitRequest();
            }}
          >
            {/* Hidden username = the CURRENT email so a password manager
                associates the re-auth password with this account. */}
            <HiddenUsernameField email={displayedEmail} />
            <div className="flex flex-col gap-3">
              <Field
                htmlFor="ce-new-email"
                label="New email"
                hint="We'll send a confirmation link to this address. Your current email keeps working until you confirm."
                error={newEmail && !emailValid ? 'Enter a valid email address' : undefined}
              >
                <TextInput
                  id="ce-new-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field htmlFor="ce-password" label="Current password">
                <TextInput
                  id="ce-password"
                  name="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                />
              </Field>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                className={btnPrimaryClass}
                disabled={submitting || !emailValid || !password}
              >
                {submitting ? 'Sending…' : 'Continue'}
              </button>
              <button
                type="button"
                className={btnSecondaryClass}
                onClick={immediateClose}
                disabled={submitting}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {stage === 'pending' ? (
          <div>
            <p className="mb-3" role="status">
              Check your inbox at <strong>{pendingEmail}</strong> and click the
              confirmation link to finish changing your email. Your current email
              keeps working until you do.
            </p>
            <div className="mt-5">
              <button type="button" className={btnPrimaryClass} onClick={immediateClose}>
                Done
              </button>
            </div>
          </div>
        ) : null}
      </PasswordManagerModal>

      {/* Reusable step-up modal: confirm the change with a
          fresh second factor — authenticator / emailed code / passkey — before
          the confirmation link is sent to the new address. */}
      <StepUpModal
        open={showModal && stage === 'stepUp'}
        onClose={immediateClose}
        title="Confirm it's you"
        stepUp={stepUp}
        confirmLabel="Confirm and send link"
      >
        <Muted className="block text-sm">
          Confirm it's you with a second factor before we send the confirmation
          link to <strong>{pendingEmail}</strong>.
        </Muted>
      </StepUpModal>

      {confirmModal}
      {pendingNavModal}
    </>
  );
};
