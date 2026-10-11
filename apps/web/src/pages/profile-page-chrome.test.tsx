/**
 * Focused contract tests for the shared re-auth `PasswordPromptModal`
 * (profile-page-chrome.tsx), which now renders through the containment-free
 * `PasswordManagerModal`. These assert the password-surface contract directly
 * on the component — driven by a small harness that owns the value + verify
 * state — rather than through a whole settings page:
 *
 *  - native form tokens + hidden username survive the overlay swap;
 *  - DOM injected outside the panel (a Keeper-like popup) is not inert /
 *    aria-hidden, so the autofill popup stays clickable;
 *  - the scrim swallows outside clicks (no dismiss);
 *  - Esc closes when not verifying and is suppressed while verifying;
 *  - submit calls `onContinue` only when enabled, a wrong password keeps the
 *    inline error with no advance and no double-submit;
 *  - axe smoke passes.
 *
 * Esc is driven via `userEvent.keyboard('{Escape}')` with focus inside the
 * panel, never a synthetic `fireEvent` keydown.
 */
import React, { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PasswordPromptModal } from './profile-page-chrome';
import { expectNoA11yViolations } from '../test/a11y';

interface HarnessProps {
  onClose?: () => void;
  onContinue?: () => void;
  /** Simulates the in-flight verify state (disables Continue + Esc). */
  verifying?: boolean;
  /** Inline error to surface (wrong password). */
  error?: string | null;
  /** Owner-supplied field(s) rendered after the password field. */
  children?: React.ReactNode;
}

/**
 * Minimal stand-in for the page that owns the prompt: holds the password value
 * locally and wires the disabled/verifying expressions exactly as the real
 * callers do (Continue disabled while empty or verifying; Cancel + Esc disabled
 * while verifying).
 */
const Harness: React.FC<HarnessProps> = ({
  onClose = () => {},
  onContinue = () => {},
  verifying = false,
  error = null,
  children,
}) => {
  const [value, setValue] = useState('');
  return (
    <PasswordPromptModal
      open
      onClose={onClose}
      title="Confirm with your password"
      intro="Re-enter your password to continue."
      error={error}
      inputId="reauth-pw"
      value={value}
      onValueChange={setValue}
      email="me@local.test"
      onContinue={onContinue}
      continueLabel={verifying ? 'Verifying…' : 'Continue'}
      continueDisabled={verifying || value === ''}
      cancelDisabled={verifying}
    >
      {children}
    </PasswordPromptModal>
  );
};

describe('PasswordPromptModal (through PasswordManagerModal)', () => {
  it('renders owner-supplied fields inside the same form, after the password field', () => {
    render(
      <Harness>
        <label>
          Extra field
          <input />
        </label>
      </Harness>,
    );
    const password = screen.getByLabelText('Current password');
    const extra = screen.getByLabelText('Extra field');
    // Same form → one submit carries both; after the password → typed last.
    expect(extra.closest('form')).toBe(password.closest('form'));
    expect(
      password.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('is a native form with current-password tokens + a hidden username', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Current password');
    const form = input.closest('form');
    expect(form).not.toBeNull();
    expect(input).toHaveAttribute('name', 'current-password');
    expect(input).toHaveAttribute('autocomplete', 'current-password');
    const username = form!.querySelector('input[name="username"]');
    expect(username).not.toBeNull();
    expect(username).toHaveAttribute('autocomplete', 'username');
    expect(username).toHaveValue('me@local.test');
  });

  it('autofocuses the visible password field on open, not the hidden username', async () => {
    render(<Harness />);
    const password = screen.getByLabelText('Current password');
    // The `HiddenUsernameField` (tabIndex={-1}, aria-hidden) is the first
    // `<input>` in the DOM; autofocus must skip it and land on the password.
    await waitFor(() => expect(password).toHaveFocus());
    const username = password.closest('form')!.querySelector('input[name="username"]');
    expect(document.activeElement).not.toBe(username);
  });

  it('does not mark a Keeper-like outside node as inert or aria-hidden', async () => {
    const popup = document.createElement('div');
    popup.setAttribute('data-testid', 'keeper-popup');
    document.body.appendChild(popup);
    render(<Harness />);
    await screen.findByRole('dialog');
    // Survive any MutationObserver tick a containment overlay would use.
    await waitFor(() => expect(screen.getByLabelText('Current password')).toBeInTheDocument());
    expect(popup.hasAttribute('inert')).toBe(false);
    expect(popup.getAttribute('aria-hidden')).toBeNull();
    popup.remove();
  });

  it('does not close on a scrim/outside click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const scrim = screen.getByRole('dialog').closest('.fixed')!;
    await user.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Esc when not verifying', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByLabelText('Current password'));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('suppresses Esc while verifying', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} verifying />);
    await user.click(screen.getByLabelText('Current password'));
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('submits only when enabled: empty password is a no-op, then a filled one continues', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    render(<Harness onContinue={onContinue} />);
    const form = screen.getByLabelText('Current password').closest('form')!;

    // Empty → submit is gated off.
    form.requestSubmit?.();
    expect(onContinue).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Current password'), 'correct-pw');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('a wrong password keeps the inline error and does not advance or double-submit', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    // Mirrors the page wiring: while verifying, Continue + the form gate are
    // disabled, so a second submit during the in-flight window is dropped.
    render(<Harness onContinue={onContinue} verifying error="Current password is incorrect." />);

    expect(screen.getByRole('alert')).toHaveTextContent(/current password is incorrect/i);
    // The disabled (Verifying…) action cannot re-fire.
    const form = screen.getByLabelText('Current password').closest('form')!;
    form.requestSubmit?.();
    await user.click(screen.getByRole('button', { name: 'Verifying…' }));
    expect(onContinue).not.toHaveBeenCalled();
    // The prompt stays open (no destructive/import/export advance).
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('has no a11y violations when open', async () => {
    const { baseElement } = render(<Harness />);
    await expectNoA11yViolations(baseElement);
  });
});
