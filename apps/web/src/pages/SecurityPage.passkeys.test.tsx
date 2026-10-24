// Security-page Passkeys card: the per-passkey "Use for encryption" toggle and the just-registered "Use this passkey to unlock your data?" confirmation dialog, rendered through SecurityPage.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { SecurityPage } from '../pages/SecurityPage';
vi.mock('react-router', async () => (await import('./security-page.test-harness')).reactRouterMock());
vi.mock('../db/store', async () => (await import('./security-page.test-harness')).dbStoreMock());
vi.mock('../lib/local-data', async () => (await import('./security-page.test-harness')).localDataMock());
vi.mock('../db/monte-carlo-cache', async () => (await import('./security-page.test-harness')).monteCarloCacheMock());
vi.mock('../lib/demo-data-loader', async () => (await import('./security-page.test-harness')).demoDataLoaderMock());
vi.mock('../api/client', async () => (await import('./security-page.test-harness')).apiClientMock());
vi.mock('../auth/AuthContext', async () => (await import('./security-page.test-harness')).authContextMock());
vi.mock('../contexts/ThemeContext', async () => (await import('./security-page.test-harness')).themeContextMock());
vi.mock('../sync/SyncContext', async () => (await import('./security-page.test-harness')).syncContextMock());
vi.mock('../lib/data-export', async () => (await import('./security-page.test-harness')).dataExportMock());
vi.mock('../lib/data-import', async () => (await import('./security-page.test-harness')).dataImportMock());
vi.mock('../auth/key-envelope-client', async () => (await import('./security-page.test-harness')).keyEnvelopeClientMock());

import { useAuth } from '../auth/AuthContext';
import { securityAuthValue } from './security-page.test-harness';
import { expectNoA11yViolations } from '../test/a11y';

function renderPage(overrides: Record<string, unknown> = {}) {
  (useAuth as any).mockReturnValue(securityAuthValue({ confirmPasskeyRestriction: vi.fn() }, overrides));
  return render(<MemoryRouter><SecurityPage /></MemoryRouter>);
}

// Click "Add passkey" and submit the password gate (the flag-off floor by default in `mfaAuthDefaults`) so `registerPasskey` runs.
async function addPasskeyViaGate(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Add passkey' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Current password'), {
    target: { value: 'pw123456' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
}
describe('SecurityPage Passkeys — "Use for encryption" toggle', () => {
  const passkey = {
    id: 'pk-1',
    credentialId: 'cred-1',
    deviceType: 'multiDevice',
    backedUp: true,
    transports: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  it('renders a "Use for encryption" switch per passkey when unlocked', async () => {
    renderPage({
      isUnlocked: true,
      listPasskeys: vi.fn().mockResolvedValue([passkey]),
    });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Use for encryption' })).toBeInTheDocument(),
    );
  });

  it('enabling the switch opens the password prompt, then calls enrollPasskeyForEncryption with the credentialId + password', async () => {
    const user = userEvent.setup();
    const enrollPasskeyForEncryption = vi.fn().mockResolvedValue(undefined);
    renderPage({
      isUnlocked: true,
      listPasskeys: vi.fn().mockResolvedValue([passkey]),
      enrollPasskeyForEncryption,
    });
    const toggle = await screen.findByRole('switch', { name: 'Use for encryption' });
    await user.click(toggle);

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(enrollPasskeyForEncryption).toHaveBeenCalledWith('cred-1', 'pw123456', undefined),
    );
  });

  it('does not render the switch when the session is locked', async () => {
    renderPage({
      isUnlocked: false,
      listPasskeys: vi.fn().mockResolvedValue([passkey]),
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('switch', { name: 'Use for encryption' })).not.toBeInTheDocument();
  });
});

describe('SecurityPage Passkeys — removal step-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const passkey = {
    id: 'pk-1',
    credentialId: 'cred-1',
    deviceType: 'multiDevice',
    backedUp: true,
    transports: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  it('gates removal behind password + the reusable step-up modal when enforced', async () => {
    const removePasskey = vi.fn().mockResolvedValue({ noticeSent: true });
    const stepUpSendEmailOtp = vi.fn().mockResolvedValue(undefined);
    renderPage({
      listPasskeys: vi.fn().mockResolvedValue([passkey]),
      removePasskey,
      stepUpSendEmailOtp,
      getMfaStatus: vi.fn().mockResolvedValue({
        totpEnabled: false,
        stepUpRequired: true,
        methods: ['email_otp'],
        recoveryMethods: [],
      }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const confirmDialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Delete' }));

    const pwDialog = await screen.findByRole('dialog');
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByText("Confirm it's you")).toBeInTheDocument());
    expect(removePasskey).not.toHaveBeenCalled();

    const factorDialog = screen.getByRole('dialog');
    fireEvent.click(within(factorDialog).getByRole('button', { name: /Email me a code/i }));
    await waitFor(() => expect(stepUpSendEmailOtp).toHaveBeenCalledWith('passkey_remove'));
    fireEvent.change(within(factorDialog).getByLabelText('Email code'), {
      target: { value: '111222' },
    });
    fireEvent.click(within(factorDialog).getByRole('button', { name: 'Delete passkey' }));

    await waitFor(() =>
      expect(removePasskey).toHaveBeenCalledWith('pk-1', 'pw123456', {
        method: 'email_otp',
        code: '111222',
      }),
    );
  });
});

describe('SecurityPage Passkeys — registration encryption dialog', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // The PRF binding loads via getKeyEnvelopes; default to an empty slot set (no passkey holds the PRF slot) so the binding resolves positively.
    const { getKeyEnvelopes } = await import('../auth/key-envelope-client');
    (getKeyEnvelopes as any).mockReset();
    (getKeyEnvelopes as any).mockResolvedValue({
      slots: [],
      envelopeSetVersion: 0,
      envelopeSetTag: '',
    });
  });

  const newPasskey = {
    id: 'pk-new',
    credentialId: 'cred-new',
    deviceType: 'multiDevice',
    backedUp: true,
    transports: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  it('prompts on registration while unlocked, and confirming enrolls the new credential', async () => {
    const registerPasskey = vi.fn().mockResolvedValue({ ...newPasskey, noticeSent: true });
    const enrollPasskeyForEncryption = vi.fn().mockResolvedValue(undefined);
    renderPage({
      isUnlocked: true,
      listPasskeys: vi.fn().mockResolvedValue([]),
      registerPasskey,
      enrollPasskeyForEncryption,
    });
    await addPasskeyViaGate();
    await waitFor(() => expect(registerPasskey).toHaveBeenCalled());
    const confirm = await screen.findByRole('button', { name: 'Use for encryption' });
    expect(enrollPasskeyForEncryption).not.toHaveBeenCalled();
    fireEvent.click(confirm);

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'confirm-pw' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(enrollPasskeyForEncryption).toHaveBeenCalledWith('cred-new', 'confirm-pw', undefined),
    );
  });

  it('warns that confirming replaces the current passkey when another holds the slot', async () => {
    const { getKeyEnvelopes } = await import('../auth/key-envelope-client');
    (getKeyEnvelopes as any).mockResolvedValue({
      slots: [{ slotType: 'passkey_prf', credentialBinding: 'cred-existing' }],
      envelopeSetVersion: 1,
      envelopeSetTag: 'tag',
    });
    const registerPasskey = vi.fn().mockResolvedValue({ ...newPasskey, noticeSent: true });
    renderPage({
      isUnlocked: true,
      listPasskeys: vi.fn().mockResolvedValue([
        { ...newPasskey, id: 'pk-existing', credentialId: 'cred-existing' },
      ]),
      registerPasskey,
    });
    await addPasskeyViaGate();
    await waitFor(() => expect(registerPasskey).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Use for encryption' });
    expect(screen.getByText(/replace it/i)).toBeInTheDocument();
  });

  it('does NOT prompt when the session is locked', async () => {
    const registerPasskey = vi.fn().mockResolvedValue({ ...newPasskey, noticeSent: true });
    const enrollPasskeyForEncryption = vi.fn().mockResolvedValue(undefined);
    renderPage({
      isUnlocked: false,
      listPasskeys: vi.fn().mockResolvedValue([]),
      registerPasskey,
      enrollPasskeyForEncryption,
    });
    await addPasskeyViaGate();
    await waitFor(() => expect(registerPasskey).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Synced passkey/i)).toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: 'Use for encryption' }),
    ).not.toBeInTheDocument();
    expect(enrollPasskeyForEncryption).not.toHaveBeenCalled();
  });

  it('cancelling the dialog enrolls nothing', async () => {
    const registerPasskey = vi.fn().mockResolvedValue({ ...newPasskey, noticeSent: true });
    const enrollPasskeyForEncryption = vi.fn().mockResolvedValue(undefined);
    renderPage({
      isUnlocked: true,
      listPasskeys: vi.fn().mockResolvedValue([]),
      registerPasskey,
      enrollPasskeyForEncryption,
    });
    await addPasskeyViaGate();
    await waitFor(() => expect(registerPasskey).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Use for encryption' })).not.toBeInTheDocument(),
    );
    expect(enrollPasskeyForEncryption).not.toHaveBeenCalled();
  });

  it('keeps the registration and shows a clear error when the confirmed enroll throws (PRF unsupported)', async () => {
    const registerPasskey = vi.fn().mockResolvedValue({ ...newPasskey, noticeSent: true });
    const enrollPasskeyForEncryption = vi
      .fn()
      .mockRejectedValue(new Error('passkey did not return a PRF result (unsupported)'));
    renderPage({
      isUnlocked: true,
      listPasskeys: vi.fn().mockResolvedValue([]),
      registerPasskey,
      enrollPasskeyForEncryption,
    });
    await addPasskeyViaGate();
    await waitFor(() => expect(registerPasskey).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Use for encryption' }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'confirm-pw' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(enrollPasskeyForEncryption).toHaveBeenCalledWith('cred-new', 'confirm-pw', undefined),
    );
    await waitFor(() => expect(screen.getByText(/Synced passkey/i)).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/can't be used for encryption/i);
  });
});

describe('SecurityPage Passkeys — enrollment gate + post-reset restriction', () => {
  const newPasskey = {
    id: 'pk-new',
    credentialId: 'cred-new',
    deviceType: 'multiDevice',
    backedUp: true,
    transports: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  it('does not call registerPasskey until the password gate resolves', async () => {
    const registerPasskey = vi.fn().mockResolvedValue(newPasskey);
    renderPage({ listPasskeys: vi.fn().mockResolvedValue([]), registerPasskey });
    fireEvent.click(await screen.findByRole('button', { name: 'Add passkey' }));
    await screen.findByRole('dialog');
    expect(registerPasskey).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(registerPasskey).toHaveBeenCalledWith('pw123456', undefined));
  });

  it('gates adding a passkey behind the reusable step-up modal when enforced, then registers with the proof', async () => {
    const registerPasskey = vi.fn().mockResolvedValue(newPasskey);
    const stepUpSendEmailOtp = vi.fn().mockResolvedValue(undefined);
    renderPage({
      listPasskeys: vi.fn().mockResolvedValue([]),
      registerPasskey,
      stepUpSendEmailOtp,
      getMfaStatus: vi.fn().mockResolvedValue({
        totpEnabled: false,
        stepUpRequired: true,
        methods: ['email_otp'],
        recoveryMethods: [],
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add passkey' }));
    const pwDialog = await screen.findByRole('dialog');
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByText("Confirm it's you")).toBeInTheDocument());
    expect(registerPasskey).not.toHaveBeenCalled();

    const factorDialog = screen.getByRole('dialog');
    fireEvent.click(within(factorDialog).getByRole('button', { name: /Email me a code/i }));
    await waitFor(() => expect(stepUpSendEmailOtp).toHaveBeenCalledWith('passkey_enroll'));
    fireEvent.change(within(factorDialog).getByLabelText('Email code'), {
      target: { value: '654321' },
    });
    fireEvent.click(within(factorDialog).getByRole('button', { name: 'Add passkey' }));

    await waitFor(() =>
      expect(registerPasskey).toHaveBeenCalledWith('pw123456', {
        method: 'email_otp',
        code: '654321',
      }),
    );
  });

  it('does not offer the emailed code as the add-passkey step-up factor once an authenticator app is enrolled — the server refuses it', async () => {
    renderPage({
      listPasskeys: vi.fn().mockResolvedValue([]),
      getMfaStatus: vi.fn().mockResolvedValue({
        totpEnabled: true,
        stepUpRequired: true,
        methods: ['totp'],
        recoveryMethods: ['email_otp'],
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add passkey' }));
    const pwDialog = await screen.findByRole('dialog');
    fireEvent.change(within(pwDialog).getByLabelText('Current password'), {
      target: { value: 'pw123456' },
    });
    fireEvent.click(within(pwDialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByText("Confirm it's you")).toBeInTheDocument());

    // Only the enrolled authenticator is offered, with no factor picker or emailed-code path (the recovery list is dropped for enrollment; removal keeps it as the no-lockout floor).
    const factorDialog = screen.getByRole('dialog');
    expect(within(factorDialog).queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(
      within(factorDialog).queryByRole('button', { name: /Email me a code/i }),
    ).not.toBeInTheDocument();
    expect(within(factorDialog).getByLabelText('Authenticator code')).toBeInTheDocument();
  });

  it('renders a restricted passkey with a confirm action that lifts it, and passes a11y checks', async () => {
    const restricted = { ...newPasskey, restrictedPostReset: true };
    const confirmPasskeyRestriction = vi.fn().mockResolvedValue(undefined);
    const { container } = renderPage({
      isUnlocked: true,
      listPasskeys: vi.fn().mockResolvedValue([restricted]),
      confirmPasskeyRestriction,
      // A predating TOTP factor is a real proving method for a restricted passkey (email_otp can never vouch: no enrollment timestamp).
      getMfaStatus: vi.fn().mockResolvedValue({ totpEnabled: true, methods: ['totp'] }),
    });
    expect(await screen.findByText('Needs confirmation')).toBeInTheDocument();
    expect(
      screen.getByText(/added right after a password reset/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Use for encryption' })).not.toBeInTheDocument();
    await expectNoA11yViolations(container);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm this passkey' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Authenticator code'), {
      target: { value: '111222' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(confirmPasskeyRestriction).toHaveBeenCalledWith('pk-new', {
        method: 'totp',
        code: '111222',
      }),
    );
  });

  it('offers no dead-end confirm modal when nothing predates the reset — points at removal instead', async () => {
    const restricted = { ...newPasskey, restrictedPostReset: true };
    // Default `mfaAuthDefaults()` status has no `methods`, so the card falls back to `['email_otp']`, filtered to no eligible confirm method.
    renderPage({ listPasskeys: vi.fn().mockResolvedValue([restricted]) });
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm this passkey' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/don't have an older sign-in method/i),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete passkey' }));
    const confirmDeleteDialog = await screen.findByRole('alertdialog');
    expect(within(confirmDeleteDialog).getByText('Delete passkey')).toBeInTheDocument();
  });
});
