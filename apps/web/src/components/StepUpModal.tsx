/**
 * Reusable step-up re-auth modal.
 *
 * Presentational shell for "prove it's really you with a fresh second factor"
 * before a sensitive operation. State + API orchestration live in `useStepUp`
 * (kept out of `AuthContext`); this renders the factor picker, the code
 * field, and the passkey button from a `UseStepUpResult`.
 *
 * Password-manager interop (see "Password managers" in docs/ui-conventions.md): the
 * OTP / code fields carry `autocomplete="one-time-code"`; the modal renders
 * through `<PasswordManagerModal>` (its scrim swallows outside clicks so a
 * password-manager popup cannot dismiss it; the background is never inert).
 * React Aria primitives only.
 */
import React from 'react';
import { RadioGroup } from 'react-aria-components';
import { PasswordManagerModal } from './PasswordManagerModal';
import { RadioOption } from './RadioOption';
import { Field } from './Field';
import { TextInput } from './TextInput';
import { Muted } from './Muted';
import { Alert } from './Alert';
import { btnPrimaryClass, btnSecondaryClass, inputClass } from './dialog-chrome';
import type { StepUpFactor, UseStepUpResult } from './useStepUp';

const FACTOR_LABEL: Record<StepUpFactor, string> = {
  passkey: 'Passkey (fingerprint or security key)',
  totp: 'Authenticator app code',
  email_otp: 'Emailed code',
};

interface StepUpModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** The orchestration state + actions from {@link useStepUp}. */
  stepUp: UseStepUpResult;
  /** Optional intro copy above the factor picker. */
  children?: React.ReactNode;
  /** Label for the confirm button (defaults to "Confirm"). */
  confirmLabel?: string;
  /**
   * Field(s) the operation needs in the SAME submit as the factor proof,
   * rendered after the factor field so they are the last thing typed before
   * Confirm — e.g. the live authenticator code during TOTP enrollment,
   * valid for only ~a minute and so collected
   * right before it is spent rather than frozen earlier in the flow.
   */
  extraFields?: React.ReactNode;
  /** Owner-side confirm gate (e.g. an empty `extraFields` value), OR'd with
   * the modal's own code/passkey readiness. */
  confirmDisabled?: boolean;
}

export const StepUpModal: React.FC<StepUpModalProps> = ({
  open,
  onClose,
  title,
  stepUp,
  children,
  confirmLabel = 'Confirm',
  extraFields,
  confirmDisabled = false,
}) => {
  const {
    availableFactors,
    factor,
    selectFactor,
    code,
    setCode,
    otpSent,
    submitting,
    error,
    nonRetryable,
    sendOtp,
    submit,
  } = stepUp;

  const codeReady = factor === 'passkey' || code.trim().length > 0;

  return (
    <PasswordManagerModal
      open={open}
      onClose={onClose}
      title={title}
      size="md"
      keyboardDismissDisabled={submitting}
    >
      {children ? <div className="mb-3">{children}</div> : null}

      {error ? (
        <Alert tone={nonRetryable ? 'warning' : 'error'}>{error}</Alert>
      ) : null}

      {availableFactors.length > 1 ? (
        <RadioGroup
          aria-label="Choose a factor"
          value={factor}
          onChange={(v) => selectFactor(v as StepUpFactor)}
          isDisabled={submitting}
          className="mb-4 flex flex-col gap-1"
        >
          {availableFactors.map((f) => (
            <RadioOption key={f} value={f}>
              {FACTOR_LABEL[f]}
            </RadioOption>
          ))}
        </RadioGroup>
      ) : null}

      {factor === 'passkey' ? (
        <Muted className="mb-3 block text-sm">
          Your browser will ask for your passkey (fingerprint, face, or security
          key) when you confirm.
        </Muted>
      ) : null}

      {factor === 'email_otp' ? (
        <p className="mb-3">
          <button
            type="button"
            className={btnSecondaryClass}
            onClick={() => void sendOtp()}
            disabled={submitting}
          >
            {otpSent ? 'Resend code' : 'Email me a code'}
          </button>
        </p>
      ) : null}

      {factor !== 'passkey' ? (
        <Field
          htmlFor="step-up-code"
          label={factor === 'totp' ? 'Authenticator code' : 'Email code'}
        >
          <TextInput
            id="step-up-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={inputClass}
            disabled={submitting}
            inputMode="numeric"
            autoComplete="one-time-code"
          />
        </Field>
      ) : null}

      {extraFields ?? null}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={btnPrimaryClass}
          onClick={() => void submit()}
          disabled={submitting || !codeReady || confirmDisabled}
        >
          {submitting ? 'Confirming…' : confirmLabel}
        </button>
        <button
          type="button"
          className={btnSecondaryClass}
          onClick={onClose}
          disabled={submitting}
        >
          Cancel
        </button>
      </div>
    </PasswordManagerModal>
  );
};
