// Security-page Recovery key & encryption card: the "Start over with this account" encrypted-workspace reset and the prepare-then-commit "Generate a new recovery key" rotation, rendered through SecurityPage.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderPage, securityMocks } from './security-page.test-harness';
import { DEVICE_ID_STORAGE_KEY } from '../auth/AuthContext';
import { expectNoA11yViolations } from '../test/a11y';
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

const { mockNavigate } = securityMocks;

describe('SecurityPage Recovery key & encryption — Start over with this account', () => {
  // The "Start over" path is gated on isAuthenticated && unlockResolved && !isUnlocked && !needsKeySetup.
  const lockedNoUnlock = {
    isAuthenticated: true,
    unlockResolved: true,
    isUnlocked: false,
    needsKeySetup: false,
  };

  let originalLocation: Location;
  let hrefSetter: import('vitest').Mock<(value: string) => void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetEncryptedWorkspace } = await import('../auth/key-envelope-client');
    (resetEncryptedWorkspace as any).mockReset();
    (resetEncryptedWorkspace as any).mockResolvedValue(undefined);
    const { clearAllLocalData } = await import('../lib/local-data');
    (clearAllLocalData as any).mockReset();
    (clearAllLocalData as any).mockResolvedValue(undefined);
    // The confirm hard-navigates (window.location.href = '/login'): the server revoked every session, so a full reload reinitialises AuthContext instead of a soft navigate bouncing back to /dashboard. jsdom forbids assigning href, so swap location for a stub with a spied href setter.
    originalLocation = window.location;
    hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, set href(v: string) { hrefSetter(v); } },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  async function openStartOverModal() {
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Delete unreadable encrypted data' }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete unreadable encrypted data' }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Type "DELETE" to confirm/i)).toBeInTheDocument(),
    );
  }

  it('does NOT render the Start over action when the workspace is unlocked', async () => {
    renderPage({}, { ...lockedNoUnlock, isUnlocked: true });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Recovery key & encryption' })).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Delete unreadable encrypted data' }),
    ).not.toBeInTheDocument();
  });

  it('renders the Start over action when authenticated but locked with no unwrapper', async () => {
    renderPage({}, lockedNoUnlock);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Delete unreadable encrypted data' }),
      ).toBeInTheDocument(),
    );
  });

  // The positive "try the key" path sits above the destructive button and navigates to `/login?mode=recovery`.
  it('renders the "Use recovery key to unlock your data" button when locked with no unwrapper', async () => {
    renderPage({}, lockedNoUnlock);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Use recovery key to unlock your data' }),
      ).toBeInTheDocument(),
    );
  });

  it('navigates to /login?mode=recovery when the recovery-key button is clicked', async () => {
    renderPage({}, lockedNoUnlock);
    const button = await screen.findByRole('button', {
      name: 'Use recovery key to unlock your data',
    });
    fireEvent.click(button);
    expect(mockNavigate).toHaveBeenCalledWith('/login?mode=recovery');
  });

  // Locked with no unwrapper, encryption is already set up and a recovery key exists, so the status must not claim "No recovery key yet" (reserved for pre-setup); it would contradict the "Use recovery key" button.
  it('does NOT show the "No recovery key yet" status when locked with no unwrapper', async () => {
    renderPage({}, lockedNoUnlock);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Use recovery key to unlock your data' }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/No recovery key yet/i)).not.toBeInTheDocument();
  });

  it('does NOT render the recovery-key button when the workspace is unlocked', async () => {
    renderPage({}, { ...lockedNoUnlock, isUnlocked: true });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Recovery key & encryption' })).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Use recovery key to unlock your data' }),
    ).not.toBeInTheDocument();
  });

  it('does NOT render the recovery-key button when key setup is still pending', async () => {
    renderPage({}, { ...lockedNoUnlock, needsKeySetup: true });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Recovery key & encryption' })).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Use recovery key to unlock your data' }),
    ).not.toBeInTheDocument();
  });

  it('confirm stays disabled until the exact phrase AND the password are provided', async () => {
    renderPage({}, lockedNoUnlock);
    await openStartOverModal();
    const confirmBtn = screen.getByRole('button', { name: 'Delete and start over' });
    expect(confirmBtn).toBeDisabled();
    const input = screen.getByLabelText(/Type "DELETE" to confirm/i);
    fireEvent.change(input, { target: { value: 'delete unreadable' } });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'secretpw' },
    });
    expect(confirmBtn).not.toBeDisabled();
  });

  // The re-auth surface must follow the password-manager interop rules: a real `<form>` with a `type="submit"` primary button, a `current-password` password field, a hidden username field, and the type-to-confirm phrase opted out of manager fill/save (`autocomplete="off"` + `PM_IGNORE_ATTRS`).
  it('renders the re-auth surface as a password-manager form (real form, submit button, autocomplete, hidden username, phrase opted out)', async () => {
    const { container } = renderPage({}, lockedNoUnlock);
    await openStartOverModal();

    const passwordInput = screen.getByLabelText('Current password');
    expect(passwordInput).toHaveAttribute('autocomplete', 'current-password');
    const form = passwordInput.closest('form');
    expect(form).not.toBeNull();

    // The confirm button submits the form natively (password-manager fill-and-submit relies on it), not via onClick.
    const confirmBtn = screen.getByRole('button', { name: 'Delete and start over' });
    expect(confirmBtn).toHaveAttribute('type', 'submit');
    expect(form!.contains(confirmBtn)).toBe(true);

    // The hidden username carries the account email so managers associate the password with the right credential.
    const hiddenUsername = container.querySelector('input[name="username"]');
    expect(hiddenUsername).toHaveAttribute('autocomplete', 'username');
    expect(hiddenUsername).toHaveValue('me@local.test');

    const phraseInput = screen.getByLabelText(/Type "DELETE" to confirm/i);
    expect(phraseInput).toHaveAttribute('autocomplete', 'off');
    expect(phraseInput).toHaveAttribute('data-1p-ignore');
  });

  it('Enter (native form submit) runs the reset once the phrase and password are provided', async () => {
    const { resetEncryptedWorkspace } = await import('../auth/key-envelope-client');
    renderPage({}, lockedNoUnlock);
    await openStartOverModal();
    const form = screen.getByLabelText('Current password').closest('form');
    expect(form).not.toBeNull();

    fireEvent.submit(form!);
    expect(resetEncryptedWorkspace).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Type "DELETE" to confirm/i), {
      target: { value: 'DELETE' },
    });
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'secretpw' },
    });
    fireEvent.submit(form!);
    await waitFor(() => expect(resetEncryptedWorkspace).toHaveBeenCalledWith('secretpw', undefined));
  });

  it('happy path: resetEncryptedWorkspace → clearAllLocalData (deviceId preserved) → hard nav to /login', async () => {
    const { resetEncryptedWorkspace } = await import('../auth/key-envelope-client');
    const { clearAllLocalData } = await import('../lib/local-data');
    const order: string[] = [];
    (resetEncryptedWorkspace as any).mockImplementation(async () => {
      order.push('reset');
    });
    (clearAllLocalData as any).mockImplementation(async () => {
      order.push('clear');
    });
    hrefSetter.mockImplementation(() => order.push('nav'));

    renderPage({}, lockedNoUnlock);
    await openStartOverModal();
    fireEvent.change(
      screen.getByLabelText(/Type "DELETE" to confirm/i),
      { target: { value: 'DELETE' } },
    );
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'secretpw' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete and start over' }));

    await waitFor(() => expect(hrefSetter).toHaveBeenCalledWith('/login'));
    expect(resetEncryptedWorkspace).toHaveBeenCalled();
    expect(clearAllLocalData).toHaveBeenCalledWith({
      preserveLocalKeys: [DEVICE_ID_STORAGE_KEY],
    });
    expect(order).toEqual(['reset', 'clear', 'nav']);
    // Soft navigation must not be used: the server revoked all sessions.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('local clear failing after a successful reset still hard-navigates to /login (no stuck authed state)', async () => {
    // Reset already revoked every session and wiped the server workspace, so a clearAllLocalData failure must not trap the user in a stale authenticated state: navigate regardless.
    const { resetEncryptedWorkspace } = await import('../auth/key-envelope-client');
    const { clearAllLocalData } = await import('../lib/local-data');
    (resetEncryptedWorkspace as any).mockResolvedValueOnce(undefined);
    (clearAllLocalData as any).mockRejectedValueOnce(new Error('nuke blew up'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderPage({}, lockedNoUnlock);
    await openStartOverModal();
    fireEvent.change(
      screen.getByLabelText(/Type "DELETE" to confirm/i),
      { target: { value: 'DELETE' } },
    );
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'secretpw' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete and start over' }));

    await waitFor(() => expect(hrefSetter).toHaveBeenCalledWith('/login'));
    expect(resetEncryptedWorkspace).toHaveBeenCalled();
    expect(clearAllLocalData).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    warnSpy.mockRestore();
  });

  // With AUTH_MFA_ENFORCED on, the reset needs the phrase, the password and a fresh step-up factor collected in the reusable modal before the destructive reset runs.
  it('shows the step-up modal before running the reset when a second factor is required', async () => {
    const getMfaStatus = vi.fn().mockResolvedValue({
      totpEnabled: true,
      stepUpRequired: true,
      methods: ['totp'],
      recoveryMethods: ['email_otp'],
    });
    const { resetEncryptedWorkspace } = await import('../auth/key-envelope-client');
    const { container } = renderPage({}, { ...lockedNoUnlock, getMfaStatus });
    await openStartOverModal();
    fireEvent.change(screen.getByLabelText(/Type "DELETE" to confirm/i), {
      target: { value: 'DELETE' },
    });
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'secretpw' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete and start over' }));

    await waitFor(() => expect(screen.getByText("Confirm it's you")).toBeInTheDocument());
    expect(resetEncryptedWorkspace).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);

    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(resetEncryptedWorkspace).toHaveBeenCalledWith('secretpw', {
        method: 'totp',
        code: '123456',
      }),
    );
  });

  it('on API error: shows the message and leaves the form enabled (no navigation)', async () => {
    class FakeApiError extends Error {
      error = { code: 'BAD_REQUEST', message: 'Could not start over right now.' };
    }
    const { ApiRequestError } = await import('../api/client');
    Object.setPrototypeOf(FakeApiError.prototype, ApiRequestError.prototype);
    const { resetEncryptedWorkspace } = await import('../auth/key-envelope-client');
    (resetEncryptedWorkspace as any).mockRejectedValueOnce(new FakeApiError('boom'));

    renderPage({}, lockedNoUnlock);
    await openStartOverModal();
    fireEvent.change(
      screen.getByLabelText(/Type "DELETE" to confirm/i),
      { target: { value: 'DELETE' } },
    );
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'secretpw' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete and start over' }));

    await waitFor(() => expect(resetEncryptedWorkspace).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/could not start over right now/i),
    );
    expect(hrefSetter).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete and start over' })).not.toBeDisabled();
  });
});

describe('SecurityPage Recovery key & encryption — Generate a new recovery key', () => {
  const unlocked = {
    isAuthenticated: true,
    unlockResolved: true,
    isUnlocked: true,
    needsKeySetup: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT offer regeneration while the workspace is locked', async () => {
    renderPage({}, {
      isAuthenticated: true,
      unlockResolved: true,
      isUnlocked: false,
      needsKeySetup: false,
      regenerateRecoveryKey: vi.fn(),
    });
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Recovery key & encryption' }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Generate a new recovery key' }),
    ).not.toBeInTheDocument();
  });

  it('happy path: password re-auth → prepared key shown (not yet active) → Activate commits', async () => {
    const user = userEvent.setup();
    // Prepare-then-commit: regenerateRecoveryKey returns the display key and an activate() thunk but persists nothing until activate() is called.
    const activate = vi.fn().mockResolvedValue(undefined);
    const regenerateRecoveryKey = vi
      .fn()
      .mockResolvedValue({ recoveryKey: 'NEWK-EY01-2345-6789', activate });
    renderPage({}, { ...unlocked, regenerateRecoveryKey });

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Generate a new recovery key' }),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Generate a new recovery key' }));

    await waitFor(() =>
      expect(screen.getByText('Generate a new recovery key?')).toBeInTheDocument(),
    );
    const pwInput = screen.getByLabelText('Current password');
    fireEvent.change(pwInput, { target: { value: 'account-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate new key' }));

    await waitFor(() => expect(regenerateRecoveryKey).toHaveBeenCalledWith('account-pw'));
    await waitFor(() =>
      expect(screen.getByTestId('recovery-key-display')).toHaveTextContent('NEWK-EY01-2345-6789'),
    );
    expect(screen.getByRole('heading', { name: 'Save your new recovery key' })).toBeInTheDocument();
    expect(screen.queryByText('Generate a new recovery key?')).not.toBeInTheDocument();
    expect(activate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: /i have saved my new recovery key/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Activate new key' }));

    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId('recovery-key-display')).not.toBeInTheDocument(),
    );
  });

  it('cancel: confirms the abort, discards the prepared key, and never activates', async () => {
    const user = userEvent.setup();
    const activate = vi.fn().mockResolvedValue(undefined);
    const regenerateRecoveryKey = vi
      .fn()
      .mockResolvedValue({ recoveryKey: 'NEWK-EY01-2345-6789', activate });
    renderPage({}, { ...unlocked, regenerateRecoveryKey });

    await user.click(
      await screen.findByRole('button', { name: 'Generate a new recovery key' }),
    );
    await waitFor(() =>
      expect(screen.getByText('Generate a new recovery key?')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'account-pw' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate new key' }));
    await waitFor(() =>
      expect(screen.getByTestId('recovery-key-display')).toBeInTheDocument(),
    );

    // The modal is locked: Esc and scrim click are no-ops, so a stray outside interaction can't discard the un-reshowable key.
    fireEvent.keyDown(screen.getByTestId('recovery-key-display'), {
      key: 'Escape',
      code: 'Escape',
    });
    expect(screen.queryByText('Cancel without activating?')).not.toBeInTheDocument();
    expect(screen.getByTestId('recovery-key-display')).toBeInTheDocument();

    // Cancel asks to confirm the abort, because discarding loses the freshly shown key, which can never be displayed again.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByText('Cancel without activating?')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('recovery-key-display')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));
    await waitFor(() =>
      expect(screen.queryByText('Cancel without activating?')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('recovery-key-display')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByText('Cancel without activating?')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }));

    await waitFor(() =>
      expect(screen.queryByTestId('recovery-key-display')).not.toBeInTheDocument(),
    );
    expect(activate).not.toHaveBeenCalled();
  });

  it('a wrong password surfaces inline and never opens the key modal', async () => {
    const user = userEvent.setup();
    const regenerateRecoveryKey = vi
      .fn()
      .mockRejectedValue(new Error('KeyWrappingError: wrong password'));
    renderPage({}, { ...unlocked, regenerateRecoveryKey });

    await user.click(
      await screen.findByRole('button', { name: 'Generate a new recovery key' }),
    );
    await waitFor(() =>
      expect(screen.getByText('Generate a new recovery key?')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate new key' }));

    await waitFor(() => expect(regenerateRecoveryKey).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText(/that password was incorrect/i)).toBeInTheDocument(),
    );
    expect(screen.getByText('Generate a new recovery key?')).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-key-display')).not.toBeInTheDocument();
  });
});
