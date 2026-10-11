/**
 * RecoveryKeyEncryptionCard — the step-up gate on "Activate new key".
 * Activating a
 * regenerated recovery key always REPLACES the live `recovery` slot, which the
 * server refuses without a fresh second factor when `AUTH_MFA_ENFORCED` is on
 * (the posture on both deployed stacks). These cases render the card with
 * `stepUpRequired: true` — the ungated flow lives in
 * SecurityPage.recovery.test.tsx — and pin the client half of that contract:
 * the modal gates the commit, the collected proof reaches `activate`, a
 * consumed proof is never resent, and cancelling the factor step leaves the
 * prepared key on screen with nothing committed.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryKeyEncryptionCard } from './RecoveryKeyEncryptionCard';
import { useAuth } from '../auth/AuthContext';

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: vi.fn(),
  DEVICE_ID_STORAGE_KEY: 'retivo.auth.deviceId',
}));


vi.mock('../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {},
}));

vi.mock('../auth/key-envelope-client', () => ({
  ENCRYPTED_WORKSPACE_RESET_PHRASE: 'DELETE',
  resetEncryptedWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/local-data', () => ({
  clearAllLocalData: vi.fn().mockResolvedValue(undefined),
}));

type Activate = ReturnType<typeof vi.fn>;

function mount(activate: Activate) {
  const regenerateRecoveryKey = vi
    .fn()
    .mockResolvedValue({ recoveryKey: 'NEWK-EY01-2345-6789', activate });
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    regenerateRecoveryKey,
    getMfaStatus: vi.fn().mockResolvedValue({
      totpEnabled: true,
      stepUpRequired: true,
      methods: ['totp'],
      recoveryMethods: ['email_otp'],
    }),
    stepUpPasskeyOptions: vi.fn().mockResolvedValue({ challenge: 'c', allowCredentials: [] }),
    stepUpSendEmailOtp: vi.fn().mockResolvedValue(undefined),
  });
  return render(
    <RecoveryKeyEncryptionCard email="me@local.test" isUnlocked isLockedNoUnlock={false} />,
  );
}

/** Password re-auth → prepared key shown → saved-key checkbox ticked. */
async function prepareKey(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Generate a new recovery key' }));
  fireEvent.change(await screen.findByLabelText('Current password'), {
    target: { value: 'account-pw' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Generate new key' }));
  await screen.findByTestId('recovery-key-display');
  fireEvent.click(screen.getByRole('checkbox', { name: /i have saved my new recovery key/i }));
}

async function confirmWithCode(code: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Authenticator code'), {
    target: { value: code },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
}

describe('RecoveryKeyEncryptionCard — "Activate new key" step-up gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gates the commit behind the step-up modal and activates with the collected proof', async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    mount(activate);
    await prepareKey();

    fireEvent.click(screen.getByRole('button', { name: 'Activate new key' }));

    // The factor prompt takes over the prepared-key modal; nothing committed.
    await screen.findByText("Confirm it's you");
    expect(screen.getByText(/before activating your new recovery key/i)).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-key-display')).not.toBeInTheDocument();
    expect(activate).not.toHaveBeenCalled();

    await confirmWithCode('123456');

    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    expect(activate).toHaveBeenCalledWith({ method: 'totp', code: '123456' });
    await screen.findByText(/Your new recovery key is now active/i);
    expect(screen.queryByTestId('recovery-key-display')).not.toBeInTheDocument();
  });

  it('cancelling the factor step returns to the prepared key without activating', async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    mount(activate);
    await prepareKey();

    fireEvent.click(screen.getByRole('button', { name: 'Activate new key' }));
    await screen.findByText("Confirm it's you");
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Back on the (un-reshowable) key with the old key still in force.
    expect(await screen.findByTestId('recovery-key-display')).toHaveTextContent(
      'NEWK-EY01-2345-6789',
    );
    expect(screen.queryByText("Confirm it's you")).not.toBeInTheDocument();
    expect(activate).not.toHaveBeenCalled();
  });

  it('a failed activation drops the consumed proof so the retry collects a fresh factor', async () => {
    const activate = vi
      .fn()
      .mockRejectedValueOnce(new Error('server 500'))
      .mockResolvedValueOnce(undefined);
    mount(activate);
    await prepareKey();

    fireEvent.click(screen.getByRole('button', { name: 'Activate new key' }));
    await screen.findByText("Confirm it's you");
    await confirmWithCode('111111');
    await waitFor(() => expect(activate).toHaveBeenCalledWith({ method: 'totp', code: '111111' }));

    // The key modal is back with the inline error; the old key still works.
    await screen.findByText(/Could not activate your new recovery key/i);
    expect(await screen.findByTestId('recovery-key-display')).toBeInTheDocument();

    // Step-up proofs are single-use: the retry must NOT resend '111111' — it
    // re-opens the factor prompt and commits with the freshly entered code.
    // (The key modal re-mounted after the factor step, so its saved-key
    // checkbox is unticked again.)
    fireEvent.click(screen.getByRole('checkbox', { name: /i have saved my new recovery key/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Activate new key' }));
    await screen.findByText("Confirm it's you");
    expect(activate).toHaveBeenCalledTimes(1);
    await confirmWithCode('222222');

    await waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
    expect(activate).toHaveBeenLastCalledWith({ method: 'totp', code: '222222' });
    await screen.findByText(/Your new recovery key is now active/i);
  });
});
