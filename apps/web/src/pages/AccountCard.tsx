/** Security page Account card: the inline-editable account record (name, birthdate via PATCH /auth/me) and the verified email-change flow (password re-auth, a step-up factor when AUTH_MFA_ENFORCED is on, a pending state until the link is clicked).
* Separate from the household member records on the Household page. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useAuth, type AccountRecord } from '../auth/AuthContext';
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

// form collects the new email and password, stepUp a fresh MFA factor, pending confirms the link was sent.
type Stage = 'form' | 'stepUp' | 'pending';

interface Props {
  email: string;
  onError: (message: string | null) => void;
}

export const AccountCard: React.FC<Props> = ({ email, onError }) => {
  const {
    fetchAccountRecord,
    updateAccountRecord,
    changeEmail,
    sendEmailChangeOtp,
    verifyEmailChangeStepUp,
    stepUpPasskeyOptions,
  } = useAuth();

  const [record, setRecord] = useState<AccountRecord | null>(null);
  // Edit stays disabled until /auth/me settles, and on failure too, so the form never opens with blank seeds that look like genuinely unset fields.
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

  // Email-OTP send is change-email's own endpoint (bound by the pending intent); passkey uses the generic purpose-scoped options endpoint.
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

  // On failure leave record unset rather than seeding blanks, which look like genuinely unset fields; startEdit must never be reachable off a failed load.
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

  const isDirty = useMemo(
    () => showModal && stage === 'form' && (newEmail !== '' || password !== ''),
    [showModal, stage, newEmail, password],
  );

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
      setRecord(updated);
      setEditing(false);
    } catch (err) {
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
  const { pendingNavModal } = useUnsavedChangesGuard(isDirty || editIsDirty);

  const emailValid = EMAIL_REGEX.test(newEmail);

  const onSubmitRequest = async () => {
    onError(null);
    if (!emailValid || !password) return;
    setSubmitting(true);
    try {
      const res = await changeEmail(newEmail, password);
      setPendingEmail(newEmail);
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

  // The hook's initial factor is captured before methods populate.
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

      {/* PasswordManagerModal: the scrim swallows outside clicks (a manager popup renders outside the dialog and would fire the dirty-guard close) and the background stays interactive. Esc routes through guardedClose. */}
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
