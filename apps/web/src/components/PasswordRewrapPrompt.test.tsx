/** PasswordRewrapPrompt: the terminal locked outcome's copy must not instruct an action the disabled Continue button cannot perform. */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PasswordRewrapPrompt } from './PasswordRewrapPrompt';

const LOCKED_ERROR =
  'Your password was updated, but this device needed to be locked again as a safety check. Dismiss this and sign in again to unlock it.';

describe('PasswordRewrapPrompt', () => {
  it('renders nothing when state is null', () => {
    render(
      <PasswordRewrapPrompt
        state={null}
        email=""
        onSubmit={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the terminal "locked" state disables Continue AND its copy does not instruct entering a password here', () => {
    render(
      <PasswordRewrapPrompt
        state={{ attemptsRemaining: 0, error: LOCKED_ERROR, submitting: false }}
        email=""
        onSubmit={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    expect(screen.getByText(LOCKED_ERROR)).toBeInTheDocument();
    expect(screen.queryByText(/enter your password to unlock it/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeEnabled();
  });

  it('a non-terminal state (attempts remaining) leaves Continue enabled once a password is typed, unlike the locked state', async () => {
    const user = userEvent.setup();
    render(
      <PasswordRewrapPrompt
        state={{ attemptsRemaining: 3, error: null, submitting: false }}
        email=""
        onSubmit={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    await user.type(screen.getByLabelText('Current password'), 'S0mePassw0rd!');
    expect(continueButton).toBeEnabled();
  });
});
