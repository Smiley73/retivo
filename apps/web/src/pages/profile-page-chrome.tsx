/**
 * Shared chrome for the settings area — Preferences / Security / Workspace /
 * Household / Social Security / Dashboard (Graphite Spectrum
 * semantic tokens). The semantic-token replacement
 * for the legacy `.card-pair` / `.card` / `.field` / `.muted` /
 * `.badge--success` markup these pages hand-rolled, plus the repeated
 * structural pieces (a settings card, a re-auth password modal, a
 * success notice, a member-details form).
 *
 * Why a chrome module (not inline strings everywhere): these pages share
 * one settings vocabulary — a titled card with a muted subtitle, a
 * paired-card grid, an inline success badge, and (Security) the
 * structurally-identical password re-auth modals. Centralising keeps the
 * code DRY and — critically — keeps the settings pages and
 * `HouseholdPage` from growing as
 * legacy classes become longer utility strings.
 * Mirrors
 * the established `accounts-page-chrome.tsx` / `auth-page-chrome.tsx` /
 * `scenarios-page-chrome.tsx` pattern; the control classes (buttons,
 * inputs, selects) are re-exported from `accounts-page-chrome.tsx` so
 * there is one source of truth for the shared form vocabulary.
 *
 * Visual style only — no behavioral contract beyond what the embedded
 * components preserve verbatim (the password modal threads the caller's
 * dirty-guard close exactly as before; Enter submits its native form).
 * Every fg/bg pair is an AA-safe Graphite Spectrum pair from
 * apps/web/src/lib/contrast.ts.
 */
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

// Single source of truth for the shared form-control vocabulary.
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

// Settings-card action glyphs — re-exported from the shared icon module
// (apps/web/src/components/icons.tsx) so Profile uses the one source of truth.
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

/** Section heading inside a settings card (legacy `<h2 font-size-lg>`). */
const settingsHeadingClass =
  'm-0 mb-2 text-lg font-semibold text-ink';

/** Muted subtitle under a settings-card heading (legacy `.muted` xs). */
const settingsSubtitleClass =
  'm-0 mb-4 text-xs text-muted';

/**
 * Two-up card grid (legacy `.card-pair`: a `1fr 1fr` grid that stacks
 * to one column on narrow viewports; child cards drop their bottom
 * margin). Re-expressed with the Tailwind default `md` breakpoint.
 */
export const CardPair: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div className="mb-6 grid gap-6 md:grid-cols-2 [&>*]:mb-0">{children}</div>
);

interface SettingsCardProps {
  title: string;
  subtitle: React.ReactNode;
  /** `danger` surfaces the destructive-zone wash (legacy `.card--danger`). */
  tone?: 'default' | 'danger';
  children: React.ReactNode;
}

/**
 * A titled settings card: an `<h2>` + a muted subtitle + the body. The
 * `<h2>` carries the section heading; pages keep their own `<section>`
 * + heading-id wiring for the page-level `aria-labelledby`.
 */
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

/**
 * Inline success notice (legacy `role="status" .badge.badge--success`).
 * Polite live region — matches the prior `role="status"` exactly.
 */
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
  /**
   * The account email, rendered as a hidden `autocomplete="username"`
   * field so password managers associate the prompt with the right
   * credential. Pass `''` when unknown (the field is omitted).
   */
  email: string;
  /** Primary (Continue) handler — also the form's submit handler, so
   *  Enter in the password field continues whenever `continueDisabled`
   *  is false (native implicit submission; password managers'
   *  fill-and-submit relies on it). */
  onContinue: () => void;
  /** Primary button label; pass the in-flight label while verifying. */
  continueLabel: string;
  /** Disables the primary button (empty value / in-flight). */
  continueDisabled: boolean;
  /** Disables the secondary Cancel (in-flight). */
  cancelDisabled?: boolean;
  /**
   * Field(s) collected in the SAME submit as the password, rendered after the
   * password field inside the form — e.g. the live authenticator code when
   * this prompt is the last gate step of TOTP enrollment (flag-off floor), so
   * it is typed seconds before it is spent.
   */
  children?: React.ReactNode;
}

/**
 * The re-auth password prompt shared by Profile's structurally identical
 * password modals (Export, Recovery-key regen, Delete account, Import
 * re-auth, Demo-load re-auth, Workspace reset). The caller still owns
 * the dirty-guard close (passed as `onClose`); left-aligned,
 * primary-first button row (AGENTS modal rule); width 420 (one input +
 * a note, AGENTS width scale).
 *
 * Password-manager interop (see "Password managers" in docs/ui-conventions.md): a
 * real `<form>` with a `type="submit"` primary button and a hidden
 * username field, so manager extensions autofill, offer to save, and
 * fill-and-submit. Enter therefore submits natively whenever
 * `continueDisabled` is false. Renders through `PasswordManagerModal`
 * (the containment-free overlay) so the popup the manager injects outside
 * the dialog stays clickable.
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
  // Render through PasswordManagerModal: the scrim swallows outside clicks (a
  // password-manager popup like Keeper / 1Password renders outside this dialog,
  // so clicking it would otherwise discard the typed password) and the
  // background is never made inert, so the popup stays interactive. Esc is
  // disabled only while a verify is in flight (`cancelDisabled`); otherwise Esc
  // and the Cancel button remain the exits.
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
        // Same gate as the Continue button: a stray Enter (or a manager's
        // fill-and-submit) can't bypass a disabled action or double-fire
        // while a verify is in flight.
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
      {/* Left-aligned, primary (Continue) first — AGENTS modal rule. */}
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

// The canonical shared `inputClass` (border-input-line + sunken surface
// + lime focus ring) — AA-safe in both themes; contrast.ts.
const memberInputClass = inputClass;

/**
 * The household member name/email/birthdate form, shared by the three
 * structurally-identical HouseholdPage forms (add-primary, add-secondary,
 * edit-in-place). Extracted so the already-oversized `HouseholdPage`
 * shrinks rather than grows. The
 * `onChange` returns the whole next form object (the page owns the
 * add-vs-edit state); `noValidate` + `required` inputs unchanged.
 */
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
