/**
 * MfaChallengeForm tests (enforced MFA). Covers method selection,
 * verify submission, the conditional trust-device checkbox, stale-factor
 * filtering, the email-send button, cancel, and the mandatory
 * shared-component a11y smoke (AGENTS.md → Testing setup).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MfaChallengeForm } from './MfaChallengeForm';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      public status: number,
      public error: { code: string; message: string },
      public retryAfterMs?: number | null,
    ) {
      super(error.message);
    }
  },
}));

// WebAuthn-support detection — defaults to supported; individual tests flip it.
const browserSupportsWebAuthn = vi.fn(() => true);
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => browserSupportsWebAuthn(),
}));

afterEach(() => {
  browserSupportsWebAuthn.mockReturnValue(true);
});

function renderForm(
  props: Partial<React.ComponentProps<typeof MfaChallengeForm>> = {},
): ReturnType<typeof render> {
  return render(
    <MfaChallengeForm
      methods={['totp']}
      recoveryMethods={['email_otp']}
      onVerify={vi.fn().mockResolvedValue(undefined)}
      onSendEmail={vi.fn().mockResolvedValue(undefined)}
      onCancel={vi.fn()}
      {...props}
    />,
  );
}

describe('MfaChallengeForm', () => {
  it('renders the heading and a code field', () => {
    renderForm();
    expect(
      screen.getByRole('heading', { name: 'Two-factor authentication' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Verification code')).toBeInTheDocument();
  });

  it('renders a method tab for each supported offered factor', () => {
    renderForm();
    const group = screen.getByRole('radiogroup', { name: 'Verification method' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Authenticator app' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Email code' })).toBeInTheDocument();
  });

  it('submits the active method + code to onVerify', async () => {
    const onVerify = vi.fn().mockResolvedValue(undefined);
    renderForm({ onVerify });
    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(onVerify).toHaveBeenCalledWith('totp', '123456', false);
    });
  });

  it('shows the trust-device checkbox for a routine factor (totp)', () => {
    renderForm({ methods: ['totp'] });
    expect(
      screen.getByRole('checkbox', { name: /trust this device/i }),
    ).toBeInTheDocument();
  });

  it('passes rememberDevice=true when the trust checkbox is ticked', async () => {
    const onVerify = vi.fn().mockResolvedValue(undefined);
    renderForm({ onVerify, methods: ['totp'], recoveryMethods: [] });
    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '654321' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /trust this device/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(onVerify).toHaveBeenCalledWith('totp', '654321', true);
    });
  });

  it('ignores a retired backup-code method advertised by an older server', () => {
    renderForm({
      methods: ['totp'],
      recoveryMethods: ['email_otp', 'backup_code'],
    });
    expect(screen.queryByRole('radio', { name: 'Backup code' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Backup code')).not.toBeInTheDocument();
  });

  it('shows the email-send button only on the email_otp method and calls onSendEmail', async () => {
    const onSendEmail = vi.fn().mockResolvedValue(undefined);
    renderForm({ methods: ['email_otp'], recoveryMethods: [], onSendEmail });
    const sendBtn = screen.getByRole('button', { name: 'Send code by email' });
    fireEvent.click(sendBtn);
    await waitFor(() => expect(onSendEmail).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/we sent a code to your email/i)).toBeInTheDocument();
  });

  it('does not show the email-send button on the totp method', () => {
    renderForm({ methods: ['totp'], recoveryMethods: ['email_otp'] });
    expect(
      screen.queryByRole('button', { name: 'Send code by email' }),
    ).not.toBeInTheDocument();
  });

  it('invokes onCancel from the back-to-sign-in link', () => {
    const onCancel = vi.fn();
    renderForm({ onCancel });
    fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('surfaces a verify failure inline without unmounting', async () => {
    const { ApiRequestError } = await import('../api/client');
    const onVerify = vi
      .fn()
      .mockRejectedValue(new (ApiRequestError as any)(401, {
        code: 'MFA_CODE_INVALID',
        message: 'The code is incorrect or no longer valid.',
      }));
    renderForm({ onVerify, methods: ['totp'], recoveryMethods: [] });
    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText('The code is incorrect or no longer valid.'),
    ).toBeInTheDocument();
  });

  // Inline "service is busy" copy: a gateway-level throttle/timeout with no error envelope shows
  // the shared busy sentence instead of raw upstream status text, in the
  // same aria-live="polite" error region a wrong code already uses.
  describe('busy-response handling', () => {
    const BUSY_MESSAGE = 'The service is busy right now. Please try again in a moment.';

    it('shows the busy sentence for a no-envelope 5xx on the code-submit path', async () => {
      const { ApiRequestError } = await import('../api/client');
      const onVerify = vi
        .fn()
        .mockRejectedValue(new (ApiRequestError as any)(503, { code: 'UNKNOWN_ERROR', message: 'Service Unavailable' }));
      renderForm({ onVerify, methods: ['totp'], recoveryMethods: [] });
      fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '000000' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(await screen.findByText(BUSY_MESSAGE)).toBeInTheDocument();
    });

    it('a genuine enveloped error on the code-submit path keeps its own message', async () => {
      const { ApiRequestError } = await import('../api/client');
      const onVerify = vi
        .fn()
        .mockRejectedValue(new (ApiRequestError as any)(500, { code: 'INTERNAL_ERROR', message: 'Something broke.' }));
      renderForm({ onVerify, methods: ['totp'], recoveryMethods: [] });
      fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '000000' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(await screen.findByText('Something broke.')).toBeInTheDocument();
      expect(screen.queryByText(BUSY_MESSAGE)).not.toBeInTheDocument();
    });

    it('shows the busy sentence for a no-envelope 429 with no Retry-After on the passkey path', async () => {
      const { ApiRequestError } = await import('../api/client');
      const onVerifyPasskey = vi
        .fn()
        .mockRejectedValue(new (ApiRequestError as any)(429, { code: 'INVALID_RESPONSE', message: 'Too Many Requests' }));
      renderForm({ methods: ['passkey'], recoveryMethods: [], onVerifyPasskey });
      fireEvent.click(screen.getByRole('button', { name: 'Use a passkey' }));
      expect(await screen.findByText(BUSY_MESSAGE)).toBeInTheDocument();
    });

    it('a 429 carrying a parsed retryAfterMs on the passkey path keeps its own message', async () => {
      const { ApiRequestError } = await import('../api/client');
      const onVerifyPasskey = vi
        .fn()
        .mockRejectedValue(
          new (ApiRequestError as any)(429, { code: 'INVALID_RESPONSE', message: 'Too Many Requests' }, 5_000),
        );
      renderForm({ methods: ['passkey'], recoveryMethods: [], onVerifyPasskey });
      fireEvent.click(screen.getByRole('button', { name: 'Use a passkey' }));
      expect(await screen.findByText('Too Many Requests')).toBeInTheDocument();
      expect(screen.queryByText(BUSY_MESSAGE)).not.toBeInTheDocument();
    });

    it('renders the busy sentence inside the form\'s aria-live="polite" error region with no a11y violations', async () => {
      const { ApiRequestError } = await import('../api/client');
      const onVerify = vi
        .fn()
        .mockRejectedValue(new (ApiRequestError as any)(503, { code: 'UNKNOWN_ERROR', message: 'Service Unavailable' }));
      const { container } = renderForm({ onVerify, methods: ['totp'], recoveryMethods: [] });
      fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '000000' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      const alert = await screen.findByText(BUSY_MESSAGE);
      expect(alert.closest('[aria-live="polite"]')).not.toBeNull();
      await expectNoA11yViolations(container);
    });
  });

  it('auto-selects passkey and renders an assert button (not a code field) when supported', () => {
    renderForm({
      methods: ['passkey', 'totp'],
      recoveryMethods: ['email_otp'],
      onVerifyPasskey: vi.fn().mockResolvedValue(undefined),
    });
    // Passkey leads → assert button, no code field.
    expect(screen.getByRole('button', { name: 'Use a passkey' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
    // The trust-device checkbox is available for the passkey routine factor.
    expect(screen.getByRole('checkbox', { name: /trust this device/i })).toBeInTheDocument();
    // The recovery factors are still reachable.
    expect(screen.getByRole('radio', { name: 'Authenticator app' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Email code' })).toBeInTheDocument();
  });

  it('runs onVerifyPasskey with the trust flag when the assert button is pressed', async () => {
    const onVerifyPasskey = vi.fn().mockResolvedValue(undefined);
    renderForm({ methods: ['passkey'], recoveryMethods: [], onVerifyPasskey });
    fireEvent.click(screen.getByRole('checkbox', { name: /trust this device/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Use a passkey' }));
    await waitFor(() => expect(onVerifyPasskey).toHaveBeenCalledWith(true));
  });

  it('hides the passkey factor and falls through when the browser does not support WebAuthn', () => {
    browserSupportsWebAuthn.mockReturnValue(false);
    renderForm({
      methods: ['passkey'],
      recoveryMethods: ['email_otp'],
      onVerifyPasskey: vi.fn().mockResolvedValue(undefined),
    });
    // No passkey tab/button; selection falls through to a usable recovery factor.
    expect(screen.queryByRole('button', { name: 'Use a passkey' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Passkey' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Verification code')).toBeInTheDocument();
  });

  it('shows non-alarming retry copy when a passkey assertion is cancelled and keeps the form mounted', async () => {
    const onVerifyPasskey = vi
      .fn()
      .mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'));
    renderForm({
      methods: ['passkey'],
      recoveryMethods: ['email_otp'],
      onVerifyPasskey,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use a passkey' }));
    expect(
      await screen.findByText("We couldn't verify your passkey. Try again, or use another option."),
    ).toBeInTheDocument();
    // The form stays mounted: a recovery factor is still reachable.
    expect(screen.getByRole('radio', { name: 'Email code' })).toBeInTheDocument();
  });

  it('switches from passkey to email-OTP and back to a code field', () => {
    renderForm({
      methods: ['passkey'],
      recoveryMethods: ['email_otp'],
      onVerifyPasskey: vi.fn().mockResolvedValue(undefined),
    });
    expect(screen.getByRole('button', { name: 'Use a passkey' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Email code' }));
    // The code field returns; the assert button is gone.
    expect(screen.getByLabelText('Verification code')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use a passkey' })).not.toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = renderForm();
    await expectNoA11yViolations(container);
  });

  it('has no a11y violations with the passkey factor active', async () => {
    const { container } = renderForm({
      methods: ['passkey', 'totp'],
      recoveryMethods: ['email_otp'],
      onVerifyPasskey: vi.fn().mockResolvedValue(undefined),
    });
    await expectNoA11yViolations(container);
  });
});
