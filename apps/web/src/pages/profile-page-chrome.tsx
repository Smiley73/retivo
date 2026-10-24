/** Shared chrome for the settings pages: settings card, re-auth password modal, success notice and member-details form. */
import React from 'react';
import { PasswordManagerModal } from '../components/PasswordManagerModal';
import { Card } from '../components/Card';
import { Alert } from '../components/Alert';
import { Field } from '../components/Field';
import { DatePicker } from '../components/DatePicker';
import { TextInput } from '../components/TextInput';
import { Muted } from '../components/Muted';
import { HiddenUsernameField } from '../components/password-manager';
import { birthdateBounds } from '../lib/birthdate-validation';

export {
  btnPrimaryClass,
  btnSecondaryClass,
  btnDangerClass,
  btnPrimarySmClass,
  btnSecondarySmClass,
  btnDangerSmClass,
  inputClass,
  tableClass,
  thClass,
  thStickyClass,
  tdClass,
} from './accounts-page-chrome';

import {
  btnSecondaryClass,
  btnPrimarySmClass,
  btnSecondarySmClass,
  btnDangerClass,
  inputClass,
} from './accounts-page-chrome';

export {
  DownloadIcon,
  UploadIcon,
  HistoryIcon,
  SparklesIcon,
  RefreshIcon,
  TrashIcon,
  KeyIcon,
  FingerprintIcon,
  LockOpenIcon,
} from '../components/icons';

const settingsHeadingClass =
  'm-0 mb-2 text-lg font-semibold text-ink';

const settingsSubtitleClass =
  'm-0 mb-4 text-xs text-muted';

export const CardPair: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div className="mb-6 grid gap-6 md:grid-cols-2 [&>*]:mb-0">{children}</div>
);

interface SettingsCardProps {
  title: React.ReactNode;
  subtitle: React.ReactNode;
  /** `danger` surfaces the destructive-zone wash (legacy `.card--danger`). */
  tone?: 'default' | 'danger';
  children: React.ReactNode;
}

export const SettingsCard: React.FC<SettingsCardProps> = ({
  title,
  subtitle,
  tone = 'default',
  children,
}) => (
  <Card tone={tone}>
    <h2 className={settingsHeadingClass}>{title}</h2>
    <p className={settingsSubtitleClass}>{subtitle}</p>
    {children}
  </Card>
);

/** Inline success notice, a polite `role="status"` live region. */
export const SuccessNotice: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <div
    role="status"
    className={
      'mb-3 inline-flex items-center rounded-full border border-positive/40 ' +
      'bg-surface-sunken px-3 py-2 text-xs font-medium text-positive' +
      (className ? ` ${className}` : '')
    }
  >
    {children}
  </div>
);

interface PasswordPromptModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Muted intro sentence above the password field. */
  intro: React.ReactNode;
  /** Inline error (rendered as a centered assertive alert), or null. */
  error: string | null;
  /** Field id — also the label `htmlFor`. Unique per concurrent modal. */
  inputId: string;
  value: string;
  onValueChange: (next: string) => void;
  /** Rendered as a hidden `autocomplete="username"` field so password managers associate the prompt with the credential; `''` omits it. */
  email: string;
  /** Also the form's submit handler: Enter continues natively whenever `continueDisabled` is false, which password managers' fill-and-submit relies on. */
  onContinue: () => void;
  /** Primary button label; pass the in-flight label while verifying. */
  continueLabel: string;
  /** Disables the primary button (empty value / in-flight). */
  continueDisabled: boolean;
  /** Disables the secondary Cancel (in-flight). */
  cancelDisabled?: boolean;
  /** Field(s) collected in the same submit as the password, e.g. the live authenticator code on the last TOTP-enrollment gate step. */
  children?: React.ReactNode;
}

/**
* Re-auth password prompt shared by Profile's password modals; the caller owns the dirty-guard close.
* A real form with a submit button and hidden username (see "Password managers" in docs/ui-conventions.md), rendered through PasswordManagerModal so a manager popup outside the dialog stays clickable.
*/
export const PasswordPromptModal: React.FC<PasswordPromptModalProps> = ({
  open,
  onClose,
  title,
  intro,
  error,
  inputId,
  value,
  onValueChange,
  email,
  onContinue,
  continueLabel,
  continueDisabled,
  cancelDisabled,
  children,
}) => (
  // PasswordManagerModal: the scrim swallows outside clicks (a manager popup renders outside the dialog and would discard the typed password) and the background is never inert. Esc is disabled only while a verify is in flight.
  <PasswordManagerModal
    open={open}
    onClose={onClose}
    title={title}
    size="md"
    keyboardDismissDisabled={cancelDisabled ?? false}
  >
    <Muted as="p" className="mt-0">
      {intro}
    </Muted>
    {error && (
      <Alert tone="error" className="mt-0 mb-3 text-center">
        {error}
      </Alert>
    )}
    <form
      method="post"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        // Same gate as the Continue button: a stray Enter or fill-and-submit can't bypass it or double-fire.
        if (continueDisabled) return;
        onContinue();
      }}
    >
      <HiddenUsernameField email={email} />
      <Field htmlFor={inputId} label="Current password">
        <TextInput
          id={inputId}
          name="current-password"
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className={inputClass}
        />
      </Field>
      {children}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className={btnDangerClass}
          disabled={continueDisabled}
        >
          {continueLabel}
        </button>
        <button
          type="button"
          className={btnSecondaryClass}
          onClick={onClose}
          disabled={cancelDisabled}
        >
          Cancel
        </button>
      </div>
    </form>
  </PasswordManagerModal>
);

interface MemberDetailsFormProps {
  /** Stable id prefix for the four field ids (unique per form instance). */
  idPrefix: string;
  values: { firstName: string; lastName: string; email: string; birthdate: string };
  onChange: (next: {
    firstName: string;
    lastName: string;
    email: string;
    birthdate: string;
  }) => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  submitting: boolean;
  submitLabel: string;
  submittingLabel: string;
  /** Optional leading glyph on the submit button (Plus for add, Check for save). */
  submitIcon?: React.ReactNode;
  /** Optional secondary Cancel (the edit-in-place form). */
  onCancel?: () => void;
}

const memberInputClass = inputClass;

/** Name/email/birthdate form shared by the HouseholdPage add and edit forms; `onChange` returns the whole next form object. */
export const MemberDetailsForm: React.FC<MemberDetailsFormProps> = ({
  idPrefix,
  values,
  onChange,
  onSubmit,
  submitting,
  submitLabel,
  submittingLabel,
  submitIcon,
  onCancel,
}) => {
  const { min: minBirthdate, max: maxBirthdate } = birthdateBounds();
  return (
    <form onSubmit={onSubmit} noValidate>
    <div className="flex flex-wrap items-start gap-3">
      <Field htmlFor={`${idPrefix}-fn`} label="First name" className="flex-1">
        <TextInput
          id={`${idPrefix}-fn`}
          required
          value={values.firstName}
          onChange={(e) => onChange({ ...values, firstName: e.target.value })}
          className={memberInputClass}
        />
      </Field>
      <Field htmlFor={`${idPrefix}-ln`} label="Last name" className="flex-1">
        <TextInput
          id={`${idPrefix}-ln`}
          required
          value={values.lastName}
          onChange={(e) => onChange({ ...values, lastName: e.target.value })}
          className={memberInputClass}
        />
      </Field>
    </div>
    <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
      <Field htmlFor={`${idPrefix}-email`} label="Email" className="sm:col-span-2">
        <TextInput
          id={`${idPrefix}-email`}
          type="email"
          required
          value={values.email}
          onChange={(e) => onChange({ ...values, email: e.target.value })}
          className={memberInputClass}
        />
      </Field>
      <Field htmlFor={`${idPrefix}-bd`} label="Birthdate" className="sm:col-span-1">
        <DatePicker
          id={`${idPrefix}-bd`}
          ariaLabel="Birthdate"
          required
          min={minBirthdate}
          max={maxBirthdate}
          value={values.birthdate}
          onChange={(v) => onChange({ ...values, birthdate: v })}
        />
      </Field>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <button type="submit" className={`${btnPrimarySmClass} gap-1.5`} disabled={submitting}>
        {submitIcon}
        {submitting ? submittingLabel : submitLabel}
      </button>
      {onCancel && (
        <button type="button" className={btnSecondarySmClass} onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
    </form>
  );
};
