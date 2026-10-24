// The shared re-auth `PasswordPromptModal` (profile-page-chrome.tsx), rendered through the containment-free `PasswordManagerModal` and driven by a small harness that owns the value and verify state: native form tokens and hidden username, outside DOM (a Keeper-like popup) not inert, the scrim swallowing outside clicks, Esc suppressed while verifying, and submit gating.
// Esc is driven via `userEvent.keyboard('{Escape}')` with focus inside the panel, never a synthetic keydown.
import React, { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PasswordPromptModal } from './profile-page-chrome';
import { expectNoA11yViolations } from '../test/a11y';

interface HarnessProps {
  onClose?: () => void;
  onContinue?: () => void;
  verifying?: boolean;
  error?: string | null;
  children?: React.ReactNode;
}

// Minimal stand-in for the owning page: holds the password locally and wires the disabled/verifying expressions as the real callers do (Continue disabled while empty or verifying; Cancel and Esc disabled while verifying).
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
    // The `HiddenUsernameField` (tabIndex -1, aria-hidden) is the first input in the DOM; autofocus must skip it and land on the password.
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

    form.requestSubmit?.();
    expect(onContinue).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Current password'), 'correct-pw');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('a wrong password keeps the inline error and does not advance or double-submit', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    // While verifying, Continue and the form gate are disabled, so a second submit during the in-flight window is dropped.
    render(<Harness onContinue={onContinue} verifying error="Current password is incorrect." />);

    expect(screen.getByRole('alert')).toHaveTextContent(/current password is incorrect/i);
    const form = screen.getByLabelText('Current password').closest('form')!;
    form.requestSubmit?.();
    await user.click(screen.getByRole('button', { name: 'Verifying…' }));
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('has no a11y violations when open', async () => {
    const { baseElement } = render(<Harness />);
    await expectNoA11yViolations(baseElement);
  });
});
