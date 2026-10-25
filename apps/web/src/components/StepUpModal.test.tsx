/** StepUpModal and useStepUp: factor picker, code path, verify interaction and the non-retryable ambiguous failure. */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepUpModal } from './StepUpModal';
import { useStepUp, type StepUpProof, type UseStepUpOptions } from './useStepUp';
import { ApiRequestError } from '../api/client';
import { expectNoA11yViolations } from '../test/a11y';

// WebAuthn browser boundary: the passkey factor prompts `startAuthentication`.
const startAuthentication = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...a: unknown[]) => startAuthentication(...a),
}));

afterEach(() => {
  startAuthentication.mockReset();
});

interface HarnessProps {
  methods?: string[];
  recoveryMethods?: string[];
  onSendEmailOtp?: () => Promise<void>;
  onPasskeyOptions?: UseStepUpOptions['onPasskeyOptions'];
  onVerify?: (proof: StepUpProof) => Promise<void>;
  onVerified?: () => void;
  extraFields?: React.ReactNode;
  confirmDisabled?: boolean;
}

const Harness: React.FC<HarnessProps> = ({
  methods = ['email_otp'],
  recoveryMethods = [],
  onSendEmailOtp = vi.fn().mockResolvedValue(undefined),
  onPasskeyOptions = vi.fn().mockResolvedValue({ challenge: 'c', allowCredentials: [] }),
  onVerify = vi.fn().mockResolvedValue(undefined),
  onVerified = vi.fn(),
  extraFields,
  confirmDisabled,
}) => {
  const stepUp = useStepUp({
    purpose: 'change_email',
    methods,
    recoveryMethods,
    onSendEmailOtp,
    onPasskeyOptions,
    onVerify,
    onVerified,
  });
  return (
    <StepUpModal
      open
      onClose={vi.fn()}
      title="Confirm it's you"
      stepUp={stepUp}
      extraFields={extraFields}
      confirmDisabled={confirmDisabled}
    />
  );
};

describe('StepUpModal', () => {
  it('renders the emailed-code factor with a send button and a code field', () => {
    render(<Harness methods={['email_otp']} />);
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email code')).toBeInTheDocument();
  });

  it('offers a factor picker when more than one factor is eligible', () => {
    render(<Harness methods={['totp']} recoveryMethods={['email_otp']} />);
    expect(screen.getByRole('radiogroup', { name: 'Choose a factor' })).toBeInTheDocument();
    expect(screen.getByLabelText('Authenticator code')).toBeInTheDocument();
  });

  it('ignores a retired backup-code factor advertised by an older server', () => {
    render(
      <Harness
        methods={['totp']}
        recoveryMethods={['email_otp', 'backup_code']}
      />,
    );
    expect(screen.queryByText('Backup code')).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('verifies with the entered code and reports success', async () => {
    const onVerify = vi.fn().mockResolvedValue(undefined);
    const onVerified = vi.fn();
    render(<Harness methods={['totp']} onVerify={onVerify} onVerified={onVerified} />);
    fireEvent.change(screen.getByLabelText('Authenticator code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(onVerify).toHaveBeenCalledWith({ method: 'totp', code: '123456' }),
    );
    await waitFor(() => expect(onVerified).toHaveBeenCalled());
  });

  it('shows a NON-retryable warning on an ambiguous confirm failure and does not report success', async () => {
    const onVerify = vi.fn().mockRejectedValue(new Error('network down'));
    const onVerified = vi.fn();
    render(<Harness methods={['totp']} onVerify={onVerify} onVerified={onVerified} />);
    fireEvent.change(screen.getByLabelText('Authenticator code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(screen.getByText(/recheck before/i)).toBeInTheDocument(),
    );
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('shows the server message (retryable) on a clean factor rejection', async () => {
    const onVerify = vi
      .fn()
      .mockRejectedValue(
        new ApiRequestError(401, {
          code: 'MFA_CODE_INVALID',
          message: 'The code is incorrect or no longer valid.',
        }),
      );
    render(<Harness methods={['totp']} onVerify={onVerify} />);
    fireEvent.change(screen.getByLabelText('Authenticator code'), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(screen.getByText('The code is incorrect or no longer valid.')).toBeInTheDocument(),
    );
  });

  it('runs the passkey factor: prompts WebAuthn and reports the assertion to onVerify', async () => {
    const assertionResponse = {
      id: 'cred-1',
      rawId: 'cred-1',
      response: {},
      clientExtensionResults: {},
      type: 'public-key',
    };
    startAuthentication.mockResolvedValue(assertionResponse);
    const onPasskeyOptions = vi
      .fn()
      .mockResolvedValue({ challenge: 'chal', allowCredentials: [] });
    const onVerify = vi.fn().mockResolvedValue(undefined);
    const onVerified = vi.fn();
    render(
      <Harness
        methods={['passkey']}
        onPasskeyOptions={onPasskeyOptions}
        onVerify={onVerify}
        onVerified={onVerified}
      />,
    );

    expect(screen.queryByLabelText(/code/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(onPasskeyOptions).toHaveBeenCalledWith('change_email'));
    await waitFor(() =>
      expect(startAuthentication).toHaveBeenCalledWith({
        optionsJSON: { challenge: 'chal', allowCredentials: [] },
      }),
    );
    await waitFor(() =>
      expect(onVerify).toHaveBeenCalledWith({
        method: 'passkey',
        response: assertionResponse,
      }),
    );
    await waitFor(() => expect(onVerified).toHaveBeenCalled());
  });

  it('renders owner-supplied extra fields after the factor field and honours confirmDisabled', () => {
    const extra = (
      <label>
        Extra field
        <input />
      </label>
    );
    const { rerender } = render(
      <Harness methods={['email_otp']} extraFields={extra} confirmDisabled />,
    );
    const emailCode = screen.getByLabelText('Email code');
    const extraField = screen.getByLabelText('Extra field');
    expect(
      emailCode.compareDocumentPosition(extraField) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.change(emailCode, { target: { value: '123456' } });
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    rerender(<Harness methods={['email_otp']} extraFields={extra} confirmDisabled={false} />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <Harness methods={['totp']} recoveryMethods={['email_otp']} />,
    );
    await expectNoA11yViolations(container);
  });
});
