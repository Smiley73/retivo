// Security-page Delete account card: the three-step flow (password, export offer, confirm), including the within-delete export that silently reuses the step-1 password via the shared `useProfileExport`. Rendered through SecurityPage, which hosts the card.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderPage, securityMocks } from './security-page.test-harness';
import { DELETED_NOTICE_KEY } from '../pages/profile-page-shared';
import { DEVICE_ID_STORAGE_KEY } from '../auth/AuthContext';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('react-router', async () => (await import('./security-page.test-harness')).reactRouterMock());
vi.mock('../db/store', async () => (await import('./security-page.test-harness')).dbStoreMock());
vi.mock('../lib/local-data', async () => (await import('./security-page.test-harness')).localDataMock());
vi.mock('../db/monte-carlo-cache', async () => (await import('./security-page.test-harness')).monteCarloCacheMock());
vi.mock('../lib/demo-data-loader', async () => (await import('./security-page.test-harness')).demoDataLoaderMock());
vi.mock('../api/client', async () => (await import('./security-page.test-harness')).apiClientMock({ getCurrentAccessToken: vi.fn(() => 'access-tok') }));
vi.mock('../auth/AuthContext', async () => (await import('./security-page.test-harness')).authContextMock());
vi.mock('../contexts/ThemeContext', async () => (await import('./security-page.test-harness')).themeContextMock());
vi.mock('../sync/SyncContext', async () => (await import('./security-page.test-harness')).syncContextMock());
// The within-delete export runs the server-authoritative export through `useProfileExport`; mock its single entry point.
vi.mock('../lib/server-data-export', () => ({
  exportServerData: vi.fn().mockResolvedValue({ unresolvedCount: 0 }),
}));
vi.mock('../lib/data-import', async () => (await import('./security-page.test-harness')).dataImportMock());
vi.mock('../auth/key-envelope-client', async () => (await import('./security-page.test-harness')).keyEnvelopeClientMock());

const { mockNavigate } = securityMocks;

const authExtra = { getHdk: () => null, refreshAccessToken: vi.fn().mockResolvedValue(null) };

describe('SecurityPage Danger zone — account deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  async function openDeleteModal() {
    await waitFor(() => expect(screen.getByRole('button', { name: /delete my account/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /delete my account/i }));
    await waitFor(() => expect(screen.getByLabelText('Current password')).toBeInTheDocument());
  }

  // The wording is the owner's to edit, so these assert key facts rather than whole sentences.
  function expectDeletionFacts(text: string) {
    expect(text).toMatch(/security logs.*expire.*one year/i);
    expect(text).toMatch(/backups.*expire.*90 days/i);
    expect(text).not.toMatch(/seven years|legal|privacy notice/i);
  }

  it('says the data is deleted and that security logs and backups expire on their own', async () => {
    renderPage(authExtra);
    const note = screen.getByText(/security logs.*one year/i);
    expect(note).toHaveTextContent(/deleted/i);
    expectDeletionFacts(note.textContent ?? '');

    await openDeleteModal();
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'secretpw' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument(),
    );
    expect(screen.getByText(/removes your live account and workspace/i)).toBeInTheDocument();
    expect(screen.queryByText(/erases everything/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Skip, delete anyway' }));
    await waitFor(() =>
      expect(screen.getByText('Delete account and live data?')).toBeInTheDocument(),
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/permanently deletes/i);
    expectDeletionFacts(dialog.textContent ?? '');
    expect(screen.queryByText(/every backup we have/i)).not.toBeInTheDocument();
  });

  it('Continue is disabled until a password is typed', async () => {
    renderPage(authExtra);
    await openDeleteModal();
    const continueBtn = screen.getByRole('button', { name: 'Continue' });
    expect(continueBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'pw' } });
    expect(continueBtn).not.toBeDisabled();
  });

  it('Enter submits the prompt form once a password is typed, and is a no-op while empty', async () => {
    // Native form submission (password-manager fill-and-submit relies on it) shares the Continue button's gate. jsdom doesn't run implicit submission from a keydown, so drive Enter as the submit event a real browser produces.
    renderPage(authExtra);
    await openDeleteModal();
    const input = screen.getByLabelText('Current password');
    const form = input.closest('form');
    expect(form).not.toBeNull();

    fireEvent.submit(form!);
    expect(screen.queryByText('Save a copy of your data first?')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'secretpw' } });
    fireEvent.submit(form!);
    await waitFor(() =>
      expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument(),
    );
  });

  it('happy path: password → confirm → deleteAccount + clearAllLocalData (deviceId + toast preserved) + redirect to /login', async () => {
    const deleteAccount = vi.fn().mockResolvedValue(undefined);
    const { clearAllLocalData } = await import('../lib/local-data');
    renderPage(authExtra, { deleteAccount });
    await openDeleteModal();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'secretpw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Skip, delete anyway' }));

    await waitFor(() => expect(screen.getByText('Delete account and live data?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /yes, delete account/i }));

    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith('secretpw'));
    // Deletion preserves the deviceId (no reload) and the toast across the wipe.
    expect(clearAllLocalData).toHaveBeenCalledWith({
      preserveLocalKeys: [DEVICE_ID_STORAGE_KEY],
      preserveSessionKeys: [DELETED_NOTICE_KEY],
    });
    expect(sessionStorage.getItem(DELETED_NOTICE_KEY)).toMatch(/deleted/i);
    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  // Regression: deleteAccount calls setMe(null) internally, so RequireAuth redirects to /login mid-await; the notice must already be in sessionStorage when that redirect's LoginPage effect runs, or it surfaces on a later /login visit.
  it('writes the toast flag to sessionStorage BEFORE invoking deleteAccount', async () => {
    let storedAtCallTime: string | null | undefined;
    const deleteAccount = vi.fn().mockImplementation(async () => {
      storedAtCallTime = sessionStorage.getItem(DELETED_NOTICE_KEY);
    });
    renderPage(authExtra, { deleteAccount });
    await openDeleteModal();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'secretpw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Skip, delete anyway' }));
    await waitFor(() => expect(screen.getByText('Delete account and live data?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /yes, delete account/i }));

    await waitFor(() => expect(deleteAccount).toHaveBeenCalled());
    expect(storedAtCallTime).toMatch(/deleted/i);
  });

  it('wrong-password error: surfaces the server message and does not delete or redirect', async () => {
    class FakeApiError extends Error {
      error = { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' };
    }
    const { ApiRequestError } = await import('../api/client');
    Object.setPrototypeOf(FakeApiError.prototype, ApiRequestError.prototype);
    const deleteAccount = vi.fn().mockRejectedValue(new FakeApiError('boom'));

    renderPage(authExtra, { deleteAccount });
    await openDeleteModal();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Skip, delete anyway' }));
    await waitFor(() => expect(screen.getByText('Delete account and live data?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /yes, delete account/i }));

    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith('wrong'));
    // The failure drops both the confirm and the export-offer interstitial so the password modal, the only step with a field to fix the wrong password, reopens with the server error inline.
    await waitFor(() =>
      expect(screen.getByLabelText('Current password')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Save a copy of your data first?')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete account and live data?')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/current password is incorrect/i);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(DELETED_NOTICE_KEY)).toBeNull();
  });

  it('Cancel on the confirm dialog returns to the export-offer modal without deleting', async () => {
    const deleteAccount = vi.fn();
    renderPage(authExtra, { deleteAccount });
    await openDeleteModal();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'secretpw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Skip, delete anyway' }));
    await waitFor(() => expect(screen.getByText('Delete account and live data?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Delete account and live data?')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument());
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('export path: enter password → Export my data → verify+export → final confirm (no second password modal)', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    const { exportServerData } = await import('../lib/server-data-export');
    renderPage(authExtra, { verifyPassword });
    await openDeleteModal();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'secretpw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }));

    // The step-1 password is reused silently: the export verifies with `data_export` and runs with no second password prompt.
    await waitFor(() =>
      expect(verifyPassword).toHaveBeenCalledWith('secretpw', { purpose: 'data_export' }),
    );
    await waitFor(() =>
      expect(exportServerData).toHaveBeenCalledWith(
        expect.objectContaining({ householdId: 'hh-1' }),
        'gzip',
      ),
    );
    await waitFor(() => expect(screen.getByText('Delete account and live data?')).toBeInTheDocument());
    expect(screen.queryByText('Export your data?')).not.toBeInTheDocument();
  });

  it('skip path: Skip, delete anyway opens the final confirm without verifying or exporting', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    const { exportServerData } = await import('../lib/server-data-export');
    renderPage(authExtra, { verifyPassword });
    await openDeleteModal();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'secretpw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Skip, delete anyway' }));

    await waitFor(() => expect(screen.getByText('Delete account and live data?')).toBeInTheDocument());
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(exportServerData).not.toHaveBeenCalled();
  });

  it('export failure: keeps the offer step open with an inline error and does not advance', async () => {
    class FakeApiError extends Error {
      error = { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' };
    }
    const { ApiRequestError } = await import('../api/client');
    Object.setPrototypeOf(FakeApiError.prototype, ApiRequestError.prototype);
    const verifyPassword = vi.fn().mockRejectedValue(new FakeApiError('boom'));
    const { exportServerData } = await import('../lib/server-data-export');
    renderPage(authExtra, { verifyPassword });
    await openDeleteModal();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'secretpw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/current password is incorrect/i),
    );
    expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument();
    expect(screen.queryByText('Delete account and live data?')).not.toBeInTheDocument();
    expect(exportServerData).not.toHaveBeenCalled();
  });

  it('Cancel on the export-offer modal resets the whole delete flow', async () => {
    const verifyPassword = vi.fn();
    const { exportServerData } = await import('../lib/server-data-export');
    renderPage(authExtra, { verifyPassword });
    await openDeleteModal();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'secretpw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByText('Save a copy of your data first?')).not.toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(exportServerData).not.toHaveBeenCalled();
  });

  // With AUTH_MFA_ENFORCED on, GET /auth/mfa/status returns stepUpRequired and the card inserts a fresh-factor step-up between the export offer and the final confirm.
  const enforcedStatus = {
    totpEnabled: true,
    stepUpRequired: true,
    methods: ['totp'],
    recoveryMethods: ['email_otp'],
  };

  it('shows the step-up modal on the confirm path when a second factor is required, and carries the proof to deleteAccount', async () => {
    const deleteAccount = vi.fn().mockResolvedValue(undefined);
    const getMfaStatus = vi.fn().mockResolvedValue(enforcedStatus);
    const { container } = renderPage(authExtra, { deleteAccount, getMfaStatus });
    await openDeleteModal();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'secretpw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Skip, delete anyway' }));

    await waitFor(() => expect(screen.getByText("Confirm it's you")).toBeInTheDocument());
    expect(screen.queryByText('Delete account and live data?')).not.toBeInTheDocument();
    await expectNoA11yViolations(container);

    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByText('Delete account and live data?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /yes, delete account/i }));

    await waitFor(() =>
      expect(deleteAccount).toHaveBeenCalledWith('secretpw', {
        method: 'totp',
        code: '123456',
      }),
    );
  });

  it('Skip clears a stale export error so it does not carry into the offer modal after a confirm-Cancel round trip', async () => {
    class FakeApiError extends Error {
      error = { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' };
    }
    const { ApiRequestError } = await import('../api/client');
    Object.setPrototypeOf(FakeApiError.prototype, ApiRequestError.prototype);
    const verifyPassword = vi.fn().mockRejectedValue(new FakeApiError('boom'));
    renderPage(authExtra, { verifyPassword });
    await openDeleteModal();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'secretpw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/current password is incorrect/i),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Skip, delete anyway' }));
    await waitFor(() => expect(screen.getByText('Delete account and live data?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByText('Save a copy of your data first?')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
