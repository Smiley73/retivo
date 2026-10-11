/**
 * Derived post-reset re-wrap prompt.
 * Rendered app-level from `AuthContext.tsx`, beside `LocalResetRequiredModal`
 * (`useDerivedRewrap.ts` owns the state this component is a thin view over).
 *
 * Shown when the derive finds a re-wrap owed and no plaintext already in
 * hand (a passkey unlock, a recovery-key unlock, or a returning device's
 * cached-key auto-unlock — never after a password unlock, which already
 * supplied a plaintext). The copy is written to be true for someone who has
 * never reset their password — at rollout this reaches every pre-ship
 * household that unlocks without a password, almost none of whom ever did:
 * it says THIS DEVICE's key needs re-wrapping under the current password, not
 * that a reset happened, and it never promises the next unlock finishes it.
 *
 * Built on the containment-free `PasswordManagerModal` (a password-manager
 * popup renders outside the dialog, so an outside click must not discard the
 * typed password) — the same primitive `PasswordPromptModal` uses for the
 * structurally identical re-auth prompts. Dismissing writes nothing; the
 * derive asks again at the next unlock-state transition.
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
  /** Non-null while the prompt should be shown. */
  state: RewrapPromptState | null;
  /** The account email, for the hidden username field (password-manager
   * interop) — `''` when unknown. */
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

  // Reset the typed value once the prompt closes, so a later re-open (a
  // fresh unlock-state transition) starts blank rather than replaying a
  // stale/wrong entry.
  const open = state !== null;
  React.useEffect(() => {
    if (!open) setValue('');
  }, [open]);

  if (!state) return null;

  // `attemptsRemaining <= 0` also marks a TERMINAL state —
  // attempts exhausted, a login-backoff wait, or a post-verify
  // write refusal all surface a final `error` and must be dismissed rather
  // than retried in place.
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
