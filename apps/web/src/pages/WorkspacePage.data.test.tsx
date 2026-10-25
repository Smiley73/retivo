// Workspace page Data card: the standalone export re-auth gate, the five-modal import pipeline and the Data · Workspace tools card order, rendered through WorkspacePage.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WorkspacePage } from '../pages/WorkspacePage';
import { ISSUES_URL } from '../lib/brand';

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../db/store', () => ({
  dropLocalDatabase: vi.fn().mockResolvedValue(undefined),
  listPendingMutations: vi.fn().mockResolvedValue([]),
  clearAllStores: vi.fn().mockResolvedValue(undefined),
  clearSelectedScenario: vi.fn().mockResolvedValue(undefined),
  listAggregates: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/local-data', () => ({
  clearAllLocalData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../db/monte-carlo-cache', () => ({
  clearMonteCarloCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/demo-data-loader', () => ({
  loadDemoData: vi.fn().mockResolvedValue({}),
  wipeWorkspaceForDemoReload: vi.fn().mockResolvedValue({
    deletedAccounts: 0,
    deletedBalances: 0,
    deletedSocialSecurity: 0,
    deletedMembers: 0,
  }),
  DemoDataExistsError: class DemoDataExistsError extends Error {
    constructor() {
      super(
        'Workspace already has household or account data. Demo data can only be loaded into an empty workspace.',
      );
      this.name = 'DemoDataExistsError';
    }
  },
}));

vi.mock('../api/client', () => ({
  apiRequest: vi.fn(),
  ApiRequestError: class ApiRequestError extends Error {},
  configureApi: vi.fn(),
  getCurrentAccessToken: vi.fn(() => 'access-tok'),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: vi.fn(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  DEVICE_ID_STORAGE_KEY: 'retivo.auth.deviceId',
}));

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));

const notifyPendingMock = vi.fn();
const syncRoundTripMock = vi.fn().mockResolvedValue({ ok: true });
const forceRefreshMock = vi.fn().mockResolvedValue({ ok: true, wiped: true });
const recacheHdkMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../sync/SyncContext', () => ({
  useSync: () => ({
    notifyPending: notifyPendingMock,
    syncRoundTrip: syncRoundTripMock,
    forceRefresh: forceRefreshMock,
    // Pass-through fence stub: runs the destructive `fn` so the demo-overwrite handler body executes (the real provider adds the poll fence and mutex).
    runDestructive: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  }),
}));

// The "Export my data" download is the server-authoritative path; mock its single entry point so tests cover the gate and completion UI without a real bootstrap/pull (the merge logic is in server-data-export.test.ts).
vi.mock('../lib/server-data-export', () => ({
  exportServerData: vi.fn().mockResolvedValue({ unresolvedCount: 0 }),
}));

vi.mock('../lib/data-import', async () => {
  const actual = await vi.importActual<typeof import('../lib/data-import')>('../lib/data-import');
  return {
    ...actual,
    parseImportFile: vi.fn(),
    validateBundle: vi.fn(),
    applyImport: vi.fn(),
  };
});

vi.mock('../auth/key-envelope-client', () => ({
  resetEncryptedWorkspace: vi.fn().mockResolvedValue(undefined),
  getKeyEnvelopes: vi.fn().mockResolvedValue({
    slots: [],
    envelopeSetVersion: 0,
    envelopeSetTag: '',
  }),
}));

import { useAuth } from '../auth/AuthContext';
import { mfaAuthDefaults } from './profile-test-mfa';

function renderPage(overrides: Record<string, unknown> = {}) {
  (useAuth as any).mockReturnValue({
    me: { id: 'u-1', email: 'me@local.test', displayName: 'Me', roles: ['member'] },
    householdId: 'hh-1',
    isAuthenticated: true,
    isBooting: false,
    login: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn().mockResolvedValue(undefined),
    verifyPassword: vi.fn().mockResolvedValue(undefined),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    registerPasskey: vi.fn(),
    listPasskeys: vi.fn().mockResolvedValue([]),
    removePasskey: vi.fn(),
    enrollPasskeyForEncryption: vi.fn().mockResolvedValue(undefined),
    recacheHdk: recacheHdkMock,
    getHdk: () => null,
    refreshAccessToken: vi.fn().mockResolvedValue(null),
    hasRole: () => true,
    ...mfaAuthDefaults(),
    ...overrides,
  });
  return render(<MemoryRouter><WorkspacePage /></MemoryRouter>);
}

describe('WorkspacePage Data card — export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Data card before the Workspace tools card (Workspace page layout)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export my data' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Import from file' })).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).not.toContain('Appearance');
    expect(headings).not.toContain('Passkeys');
    expect(headings).not.toContain('Recovery key & encryption');
    expect(headings).not.toContain('Delete account');
    const dataIdx = headings.indexOf('Data');
    const workspaceIdx = headings.indexOf('Workspace tools');
    expect(dataIdx).toBeGreaterThan(-1);
    expect(workspaceIdx).toBeGreaterThan(dataIdx);
  });

  it('clicking Export my data opens the password gate and does not export until re-auth succeeds', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    const { exportServerData } = await import('../lib/server-data-export');
    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export my data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }));
    await waitFor(() => expect(screen.getByText('Export your data?')).toBeInTheDocument());
    expect(exportServerData).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'correct-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() =>
      expect(verifyPassword).toHaveBeenCalledWith('correct-pw', { purpose: 'data_export' }),
    );
    await waitFor(() =>
      expect(exportServerData).toHaveBeenCalledWith(
        expect.objectContaining({ householdId: 'hh-1' }),
        'gzip',
      ),
    );
    await waitFor(() => expect(screen.getByText(/Export ready/i)).toBeInTheDocument());
  });

  // The Data card once offered a plain-JSON download beside Export; gzip is the only format now, so the row carries one affordance and the gate copy never promises an uncompressed file. The lib keeps its `format` parameter (server-data-export.test.ts).
  it('offers a single export affordance — no plain-JSON alternative', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export my data' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /plain JSON/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'JSON' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }));
    await waitFor(() => expect(screen.getByText('Export your data?')).toBeInTheDocument());
    expect(screen.getByText(/compressed file/i)).toBeInTheDocument();
    expect(screen.queryByText(/uncompressed JSON file/i)).not.toBeInTheDocument();
  });

  it('reports the count of unresolved local-change records in the completion notice', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    const { exportServerData } = await import('../lib/server-data-export');
    (exportServerData as any).mockResolvedValueOnce({ unresolvedCount: 2 });
    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export my data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }));
    await waitFor(() => expect(screen.getByText('Export your data?')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'correct-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() =>
      expect(screen.getByText(/2 changes from this device that hadn't finished syncing/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/keep this file even after you import it/i)).toBeInTheDocument();
  });

  it('rapid Enter presses while verify is in flight run verify+export only once', async () => {
    // Hold verifyPassword in flight so the modal stays open: a second Enter (a native form submission) during that window must be dropped by the form's onSubmit guard and the handler's re-entrancy guard.
    let resolveVerify!: () => void;
    const verifyPassword = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveVerify = resolve; }),
    );
    const { exportServerData } = await import('../lib/server-data-export');
    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export my data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }));
    await waitFor(() => expect(screen.getByText('Export your data?')).toBeInTheDocument());

    const input = screen.getByLabelText('Current password');
    const form = input.closest('form');
    expect(form).not.toBeNull();
    fireEvent.change(input, { target: { value: 'correct-pw' } });
    fireEvent.submit(form!);
    await waitFor(() => expect(verifyPassword).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Exporting…' })).toBeInTheDocument(),
    );
    fireEvent.submit(form!);
    expect(verifyPassword).toHaveBeenCalledTimes(1);

    resolveVerify();
    await waitFor(() => expect(exportServerData).toHaveBeenCalledTimes(1));
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  it('the re-auth prompt is a native form with a hidden username for password managers', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export my data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }));
    await waitFor(() => expect(screen.getByText('Export your data?')).toBeInTheDocument());

    const input = screen.getByLabelText('Current password');
    // A real `<form>` with autocomplete tokens is what password managers key autofill, save prompts and fill-and-submit on.
    const form = input.closest('form');
    expect(form).not.toBeNull();
    expect(input).toHaveAttribute('name', 'current-password');
    expect(input).toHaveAttribute('autocomplete', 'current-password');
    const username = form!.querySelector('input[name="username"]');
    expect(username).not.toBeNull();
    expect(username).toHaveAttribute('autocomplete', 'username');
    expect(username).toHaveValue('me@local.test');
  });

  it('wrong password keeps the gate open with an inline error and does not export', async () => {
    class FakeApiError extends Error {
      error = { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' };
    }
    const { ApiRequestError } = await import('../api/client');
    Object.setPrototypeOf(FakeApiError.prototype, ApiRequestError.prototype);
    const verifyPassword = vi.fn().mockRejectedValue(new FakeApiError('boom'));
    const { exportServerData } = await import('../lib/server-data-export');
    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export my data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }));
    await waitFor(() => expect(screen.getByText('Export your data?')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() =>
      expect(verifyPassword).toHaveBeenCalledWith('wrong-pw', { purpose: 'data_export' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/current password is incorrect/i),
    );
    expect(screen.getByText('Export your data?')).toBeInTheDocument();
    expect(exportServerData).not.toHaveBeenCalled();
  });

  it('cancelling the export gate does not verify or export', async () => {
    const verifyPassword = vi.fn();
    const { exportServerData } = await import('../lib/server-data-export');
    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export my data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }));
    await waitFor(() => expect(screen.getByText('Export your data?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Export your data?')).not.toBeInTheDocument());
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(exportServerData).not.toHaveBeenCalled();
  });

  it('Export my data prompts the gate even on an empty workspace', async () => {
    // listAggregates resolves to [] in the db/store mock, so the workspace is empty; the gate must still prompt.
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export my data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }));
    await waitFor(() => expect(screen.getByText('Export your data?')).toBeInTheDocument());
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });

  it('surfaces an error when the export throws after a successful re-auth', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    const { exportServerData } = await import('../lib/server-data-export');
    (exportServerData as any).mockRejectedValueOnce(new Error('disk full'));
    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export my data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }));
    await waitFor(() => expect(screen.getByText('Export your data?')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'correct-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Failed to export data/i),
    );
  });
});

describe('WorkspacePage Data card — import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears call counts but leaves queued `mockResolvedValueOnce` values, so `mockReset` drains them; the `mockResolvedValue` below restores the success default.
    syncRoundTripMock.mockReset();
    syncRoundTripMock.mockResolvedValue({ ok: true });
  });

  function makeFile(name = 'export.json.gz') {
    return new File([new Uint8Array([0])], name, { type: 'application/gzip' });
  }

  async function fireFileSelect(file: File) {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    fireEvent.change(input);
  }

  function makeBundle(overrides: Record<string, unknown> = {}) {
    return {
      format: 'retivo-export',
      version: 1,
      exportedAt: '2026-05-05T00:00:00Z',
      exportedByBuildId: 'test',
      householdId: 'hh-1',
      deviceId: 'dev-x',
      aggregates: {
        household: [], householdMember: [], account: [], accountBalance: [], socialSecurityBenefit: [], scenario: [],
      },
      ...mfaAuthDefaults(),
      ...overrides,
    };
  }

  async function enterPasswordModalAndContinue(password: string) {
    await waitFor(() =>
      expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: password } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  }

  it('happy path: validates → password → confirms → applies → shows success badge with count', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    const { parseImportFile, validateBundle, applyImport } = await import('../lib/data-import');
    (parseImportFile as any).mockResolvedValueOnce({});
    (validateBundle as any).mockReturnValueOnce({ bundle: makeBundle(), unknownTypes: [] });
    (applyImport as any).mockResolvedValueOnce({
      countsByType: { household: 0, householdMember: 0, account: 0, accountBalance: 0, socialSecurityBenefit: 0 },
      total: 7,
    });

    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import from file' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Import from file' }));
    await fireFileSelect(makeFile());
    await enterPasswordModalAndContinue('correct-pw');

    await waitFor(() => expect(verifyPassword).toHaveBeenCalledWith('correct-pw'));
    await waitFor(() =>
      expect(screen.getByText(/Replace workspace with file contents\?/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Replace and import/i }));
    await waitFor(() => expect(applyImport).toHaveBeenCalled());
    expect(notifyPendingMock).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/Imported 7 records/i)).toBeInTheDocument());
  });

  it('wrong password keeps the password modal open with an inline error and does not apply', async () => {
    class FakeApiError extends Error {
      error = { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' };
    }
    const { ApiRequestError } = await import('../api/client');
    Object.setPrototypeOf(FakeApiError.prototype, ApiRequestError.prototype);
    const verifyPassword = vi.fn().mockRejectedValue(new FakeApiError('boom'));
    const { parseImportFile, validateBundle, applyImport } = await import('../lib/data-import');
    (parseImportFile as any).mockResolvedValueOnce({});
    (validateBundle as any).mockReturnValueOnce({ bundle: makeBundle(), unknownTypes: [] });

    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import from file' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Import from file' }));
    await fireFileSelect(makeFile());
    await enterPasswordModalAndContinue('wrong-pw');

    await waitFor(() => expect(verifyPassword).toHaveBeenCalledWith('wrong-pw'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/current password is incorrect/i),
    );
    expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument();
    expect(screen.queryByText(/Replace workspace with file contents\?/i)).not.toBeInTheDocument();
    expect(applyImport).not.toHaveBeenCalled();
  });

  it('Cancel on the password modal aborts without verifying or applying', async () => {
    const verifyPassword = vi.fn();
    const { parseImportFile, validateBundle, applyImport } = await import('../lib/data-import');
    (parseImportFile as any).mockResolvedValueOnce({});
    (validateBundle as any).mockReturnValueOnce({ bundle: makeBundle(), unknownTypes: [] });

    renderPage({ verifyPassword });
    fireEvent.click(await screen.findByRole('button', { name: 'Import from file' }));
    await fireFileSelect(makeFile());
    await waitFor(() => expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/Confirm with your password/i)).not.toBeInTheDocument());
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(applyImport).not.toHaveBeenCalled();
    expect(screen.queryByText(/Replace workspace with file contents\?/i)).not.toBeInTheDocument();
  });

  it('shows an error message when validateBundle throws DataImportError', async () => {
    const { parseImportFile, validateBundle } = await import('../lib/data-import');
    const { DataImportError } = await import('../lib/data-import');
    (parseImportFile as any).mockResolvedValueOnce({});
    (validateBundle as any).mockImplementationOnce(() => {
      throw new DataImportError('BUNDLE_VERSION_UNSUPPORTED', 'too new');
    });

    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import from file' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Import from file' }));
    await fireFileSelect(makeFile());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/newer version of the app/i),
    );
  });

  it('a too-large file shows the Report an issue on GitHub link and no support wording', async () => {
    const { parseImportFile, validateBundle } = await import('../lib/data-import');
    const { DataImportError } = await import('../lib/data-import');
    (parseImportFile as any).mockResolvedValueOnce({});
    (validateBundle as any).mockImplementationOnce(() => {
      throw new DataImportError('BUNDLE_TOO_LARGE', 'too big');
    });

    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import from file' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Import from file' }));
    await fireFileSelect(makeFile());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/exceeds the import size limit/i);
    expect(alert).not.toHaveTextContent(/support/i);
    const link = within(alert).getByRole('link', { name: 'Report an issue on GitHub' });
    expect(link).toHaveAttribute('href', ISSUES_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('warns about unsynced edits in the confirm body when listPendingMutations > 0', async () => {
    const { listPendingMutations } = await import('../db/store');
    (listPendingMutations as any).mockResolvedValueOnce([{ id: 'm1' }, { id: 'm2' }]);
    const { parseImportFile, validateBundle } = await import('../lib/data-import');
    (parseImportFile as any).mockResolvedValueOnce({});
    (validateBundle as any).mockReturnValueOnce({ bundle: makeBundle(), unknownTypes: [] });

    renderPage({ verifyPassword: vi.fn().mockResolvedValue(undefined) });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import from file' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Import from file' }));
    await fireFileSelect(makeFile());
    await enterPasswordModalAndContinue('pw');

    await waitFor(() =>
      expect(
        screen.getByText(/You have 2 unsynced edits that will be discarded/i),
      ).toBeInTheDocument(),
    );
  });

  it('shows the unknown-types modal when validation reports unknown types, then proceeds to the password modal on Skip', async () => {
    const { parseImportFile, validateBundle } = await import('../lib/data-import');
    (parseImportFile as any).mockResolvedValueOnce({});
    (validateBundle as any).mockReturnValueOnce({
      bundle: makeBundle(),
      unknownTypes: [{ type: 'zorblax', count: 3 }],
    });

    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import from file' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Import from file' }));
    await fireFileSelect(makeFile());

    await waitFor(() =>
      expect(screen.getByText(/Unknown data types in file/i)).toBeInTheDocument(),
    );
    expect(screen.getByText('zorblax')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip and continue' }));

    await waitFor(() =>
      expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument(),
    );
  });

  it('Cancel on the unknown-types modal aborts without showing the confirm dialog', async () => {
    const { parseImportFile, validateBundle } = await import('../lib/data-import');
    (parseImportFile as any).mockResolvedValueOnce({});
    (validateBundle as any).mockReturnValueOnce({
      bundle: makeBundle(),
      unknownTypes: [{ type: 'zorblax', count: 1 }],
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Import from file' }));
    await fireFileSelect(makeFile());

    await waitFor(() => expect(screen.getByText(/Unknown data types in file/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByText(/Unknown data types in file/i)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/Replace workspace with file contents\?/i)).not.toBeInTheDocument();
  });

  it('shows the cross-household warning when the bundle householdId differs from the signed-in user, then proceeds to the password modal on Continue', async () => {
    const { parseImportFile, validateBundle } = await import('../lib/data-import');
    (parseImportFile as any).mockResolvedValueOnce({});
    (validateBundle as any).mockReturnValueOnce({
      bundle: makeBundle({ householdId: 'hh-other' }),
      unknownTypes: [],
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Import from file' }));
    await fireFileSelect(makeFile());

    await waitFor(() =>
      expect(screen.getByText(/File is from a different account/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Confirm with your password/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reassign and continue/i }));

    await waitFor(() =>
      expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument(),
    );
  });

  it('Cancel on the cross-household warning aborts without verifying or applying', async () => {
    const verifyPassword = vi.fn();
    const { parseImportFile, validateBundle, applyImport } = await import('../lib/data-import');
    (parseImportFile as any).mockResolvedValueOnce({});
    (validateBundle as any).mockReturnValueOnce({
      bundle: makeBundle({ householdId: 'hh-other' }),
      unknownTypes: [],
    });

    renderPage({ verifyPassword });
    fireEvent.click(await screen.findByRole('button', { name: 'Import from file' }));
    await fireFileSelect(makeFile());

    await waitFor(() =>
      expect(screen.getByText(/File is from a different account/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByText(/File is from a different account/i)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/Confirm with your password/i)).not.toBeInTheDocument();
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(applyImport).not.toHaveBeenCalled();
  });

  it('chains unknown-types → cross-household → password when the bundle has both', async () => {
    const { parseImportFile, validateBundle } = await import('../lib/data-import');
    (parseImportFile as any).mockResolvedValueOnce({});
    (validateBundle as any).mockReturnValueOnce({
      bundle: makeBundle({ householdId: 'hh-other' }),
      unknownTypes: [{ type: 'zorblax', count: 1 }],
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Import from file' }));
    await fireFileSelect(makeFile());

    await waitFor(() =>
      expect(screen.getByText(/Unknown data types in file/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Skip and continue' }));

    await waitFor(() =>
      expect(screen.getByText(/File is from a different account/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Reassign and continue/i }));

    await waitFor(() =>
      expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument(),
    );
  });

  it('aborts the import when the sync round-trip fails (offline)', async () => {
    syncRoundTripMock.mockResolvedValueOnce({ ok: false, reason: 'You appear to be offline.' });
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    const { parseImportFile, validateBundle, applyImport } = await import('../lib/data-import');
    (parseImportFile as any).mockResolvedValueOnce({});
    (validateBundle as any).mockReturnValueOnce({ bundle: makeBundle(), unknownTypes: [] });

    renderPage({ verifyPassword });
    fireEvent.click(await screen.findByRole('button', { name: 'Import from file' }));
    await fireFileSelect(makeFile());

    await enterPasswordModalAndContinue('correct-pw');
    await waitFor(() => expect(verifyPassword).toHaveBeenCalledWith('correct-pw'));

    await waitFor(() =>
      expect(screen.getByText(/Replace workspace with file contents/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Replace and import' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/offline/i),
    );
    expect(applyImport).not.toHaveBeenCalled();
  });
});
