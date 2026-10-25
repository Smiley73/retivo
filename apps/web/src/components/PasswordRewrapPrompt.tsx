/**
 * Post-reset re-wrap prompt rendered app-level from `AuthContext.tsx`; copy says this device's key needs re-wrapping,
 * not that a reset happened. Built on `PasswordManagerModal`, so an outside click cannot discard the password.
 */
import React, { useState } from 'react';
import { PasswordManagerModal } from './PasswordManagerModal';
import { Field } from './Field';
import { TextInput } from './TextInput';
import { Muted } from './Muted';
import { Alert } from './Alert';
import { HiddenUsernameField } from './password-manager';
import { btnPrimaryClass, btnSecondaryClass, inputClass } from './dialog-chrome';
import type { RewrapPromptState } from '../auth/useDerivedRewrap';

interface PasswordRewrapPromptProps {
  state: RewrapPromptState | null;
  /** The account email for the hidden username field; `''` when unknown. */
  email: string;
  onSubmit: (password: string) => Promise<void>;
  onDismiss: () => void;
}

const INPUT_ID = 'rewrap-prompt-password';

export const PasswordRewrapPrompt: React.FC<PasswordRewrapPromptProps> = ({
  state,
  email,
  onSubmit,
  onDismiss,
}) => {
  const [value, setValue] = useState('');

  // Reset the typed value on close so a re-open starts blank.
  const open = state !== null;
  React.useEffect(() => {
    if (!open) setValue('');
  }, [open]);

  if (!state) return null;

  // `attemptsRemaining <= 0` also marks a terminal state (exhausted attempts, login backoff,
  // post-verify write refusal): dismiss, do not retry in place.
  const terminal = state.attemptsRemaining <= 0 && state.error !== null;
  const disabled = state.submitting || value.length === 0 || terminal;

  const handleContinue = (): void => {
    if (disabled) return;
    void onSubmit(value);
  };

  return (
    <PasswordManagerModal
      open
      onClose={onDismiss}
      title="Re-enter your password"
      size="md"
      keyboardDismissDisabled={state.submitting}
    >
      <Muted as="p" className="mt-0">
        This device&rsquo;s encryption key needs to be re-wrapped under your
        current password. This can happen after a password change on another
        device. Enter your password to finish it here.
      </Muted>
      {state.error && (
        <Alert tone="error" className="mt-0 mb-3 text-center">
          {state.error}
        </Alert>
      )}
      <form
        method="post"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          handleContinue();
        }}
      >
        <HiddenUsernameField email={email} />
        <Field htmlFor={INPUT_ID} label="Current password">
          <TextInput
            id={INPUT_ID}
            name="current-password"
            type="password"
            autoComplete="current-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={state.submitting}
            autoFocus
            className={inputClass}
          />
        </Field>
        <div className="flex justify-start gap-3">
          <button
            type="submit"
            className={btnPrimaryClass}
            disabled={disabled}
          >
            {state.submitting ? 'Verifying…' : 'Continue'}
          </button>
          <button
            type="button"
            className={btnSecondaryClass}
            onClick={onDismiss}
            disabled={state.submitting}
          >
            Not now
          </button>
        </div>
      </form>
    </PasswordManagerModal>
  );
};
