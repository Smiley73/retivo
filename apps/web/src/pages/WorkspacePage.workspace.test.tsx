// Workspace page Workspace tools card: Load demo data (three-gate overwrite flow), Delete workspace data, Clear data on this device and Reload from server, rendered through WorkspacePage.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WorkspacePage } from '../pages/WorkspacePage';
import {
  WORKSPACE_HISTORY_NOT_ERASED_KEY,
  WORKSPACE_NOTICE_KEY,
} from '../pages/profile-page-shared';
import { expectNoA11yViolations } from '../test/a11y';

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../db/store', () => ({
  dropLocalDatabase: vi.fn().mockResolvedValue(undefined),
  listPendingMutations: vi.fn().mockResolvedValue([]),
  clearAllStores: vi.fn().mockResolvedValue(undefined),
  clearMutationQueue: vi.fn().mockResolvedValue(undefined),
  clearSelectedScenario: vi.fn().mockResolvedValue(undefined),
  listAggregates: vi.fn().mockResolvedValue([]),
  readKeyCacheEntry: vi.fn().mockResolvedValue(null),
  writeKeyCacheEntry: vi.fn().mockResolvedValue(undefined),
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
// `runDestructive` fences the demo-overwrite wipe→load window in the real provider; here it just runs `fn`.
const runDestructiveMock = vi.fn(async (fn: () => Promise<unknown>) => fn());
// `clearWorkspace` is the server-authoritative Delete-workspace-data call. Default: a 2xx that did not erase backup history (`historyErased:false`, what the real server returns when erase wasn't requested); that is a success, not a failure.
const clearWorkspaceMock = vi
  .fn()
  .mockResolvedValue({ ok: true, historyErased: false });
// Configurable un-synced mutation lists for the sync inspector and the Reload-from-server warn-before-discard; default empty, a test reassigns them before rendering.
let pendingMutationsMock: unknown[] = [];
let conflictMutationsMock: unknown[] = [];
let failedErrorMutationsMock: unknown[] = [];
// The card `instanceof`-checks this typed error to tell a post-commit local cleanup failure (server did sweep) from a pre-commit rejection; hoisted so the mocked SyncContext re-exports the same class the card imports.
const { WorkspaceClearCleanupError } = vi.hoisted(() => {
  class WorkspaceClearCleanupError extends Error {
    result: { ok: boolean; historyErased: boolean };
    constructor(result: { ok: boolean; historyErased: boolean }) {
      super(
        'Workspace cleared on the server, but the local sync-state cleanup could not be completed.',
      );
      this.name = 'WorkspaceClearCleanupError';
      this.result = result;
    }
  }
  return { WorkspaceClearCleanupError };
});
vi.mock('../sync/SyncContext', () => ({
  useSync: () => ({
    notifyPending: notifyPendingMock,
    syncRoundTrip: syncRoundTripMock,
    forceRefresh: forceRefreshMock,
    runDestructive: runDestructiveMock,
    clearWorkspace: clearWorkspaceMock,
    pendingMutations: pendingMutationsMock,
    conflictMutations: conflictMutationsMock,
    failedErrorMutations: failedErrorMutationsMock,
    resolveConflict: vi.fn(),
    checkAndRepair: vi.fn(),
  }),
  WorkspaceClearCleanupError,
}));

vi.mock('../lib/data-export', async () => {
  const actual = await vi.importActual<typeof import('../lib/data-export')>('../lib/data-export');
  return {
    ...actual,
    exportData: vi.fn().mockResolvedValue(undefined),
  };
});

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
  ENCRYPTED_WORKSPACE_RESET_PHRASE: 'DELETE',
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
    signOutForDeviceClear: vi.fn().mockResolvedValue({ proven: true }),
    changePassword: vi.fn().mockResolvedValue(undefined),
    verifyPassword: vi.fn().mockResolvedValue(undefined),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    registerPasskey: vi.fn(),
    listPasskeys: vi.fn().mockResolvedValue([]),
    removePasskey: vi.fn(),
    enrollPasskeyForEncryption: vi.fn().mockResolvedValue(undefined),
    recacheHdk: recacheHdkMock,
    hasRole: () => true,
    ...mfaAuthDefaults(),
    ...overrides,
  });
  return render(<MemoryRouter><WorkspacePage /></MemoryRouter>);
}
describe('WorkspacePage Workspace tools — Load demo data', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // `clearAllMocks` clears call counts but leaves queued `mockResolvedValueOnce` values, so `mockReset` drains them; the `mockResolvedValue` below restores the success default.
    syncRoundTripMock.mockReset();
    syncRoundTripMock.mockResolvedValue({ ok: true });
    // mockImplementation persists across tests; reset to default before each.
    const { listAggregates, dropLocalDatabase } = await import('../db/store');
    (listAggregates as any).mockReset();
    (listAggregates as any).mockResolvedValue([]);
    (dropLocalDatabase as any).mockReset();
    (dropLocalDatabase as any).mockResolvedValue(undefined);
    const { loadDemoData, wipeWorkspaceForDemoReload } = await import(
      '../lib/demo-data-loader'
    );
    (loadDemoData as any).mockReset();
    (loadDemoData as any).mockResolvedValue({});
    (wipeWorkspaceForDemoReload as any).mockReset();
    (wipeWorkspaceForDemoReload as any).mockResolvedValue({
      deletedAccounts: 0,
      deletedBalances: 0,
      deletedSocialSecurity: 0,
      deletedMembers: 0,
    });
  });

  it('renders the Workspace tools card after the Data card with both row actions', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Workspace' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Clear data on this device' })).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    const dataIdx = headings.indexOf('Data');
    const workspaceIdx = headings.indexOf('Workspace tools');
    expect(dataIdx).toBeGreaterThan(-1);
    expect(workspaceIdx).toBeGreaterThan(dataIdx);
    expect(headings).not.toContain('Delete account');
  });

  it('clicking Load demo data on an empty workspace opens the simple confirm', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Load demo data' }));
    await waitFor(() =>
      expect(screen.getByRole('alertdialog')).toHaveTextContent(/Load demo data\?/i),
    );
    expect(screen.queryByText(/Replace all your data with demo data/i)).not.toBeInTheDocument();
  });

  it('opens the overwrite warning when the workspace already has accounts', async () => {
    const { listAggregates } = await import('../db/store');
    (listAggregates as any).mockImplementation(async (type: string) =>
      type === 'account'
        ? [{ id: 'acc-1', householdId: 'hh-1', aggregateType: 'account', payload: {} }]
        : [],
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Load demo data' }));
    await waitFor(() =>
      expect(screen.getByText(/Replace all your data with demo data\?/i)).toBeInTheDocument(),
    );
  });

  it('confirming Load demo data calls loadDemoData and stashes a notice that survives the reload', async () => {
    const { loadDemoData } = await import('../lib/demo-data-loader');
    const { unmount } = renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Load demo data' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirmBtn = await waitFor(() => {
      const buttons = dialog.querySelectorAll('button');
      const match = Array.from(buttons).find((b) => b.textContent?.trim() === 'Load demo data');
      if (!match) throw new Error('dialog confirm button not found');
      return match;
    });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(loadDemoData).toHaveBeenCalled());
    expect(notifyPendingMock).toHaveBeenCalled();
    // The flow hard-reloads (a jsdom no-op), so the notice is stashed in sessionStorage rather than shown inline.
    await waitFor(() =>
      expect(sessionStorage.getItem(WORKSPACE_NOTICE_KEY)).toBe('Demo data loaded.'),
    );
    // On the next mount (post-reload) the notice surfaces once, then the key is consumed.
    unmount();
    renderPage();
    await waitFor(() => expect(screen.getByText(/Demo data loaded/i)).toBeInTheDocument());
    expect(sessionStorage.getItem(WORKSPACE_NOTICE_KEY)).toBeNull();
  });

  it('overwrite path requires password verification + final confirmation before queueing delete mutations', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    const { listAggregates } = await import('../db/store');
    const { loadDemoData, wipeWorkspaceForDemoReload } = await import(
      '../lib/demo-data-loader'
    );
    (listAggregates as any).mockImplementation(async (type: string) =>
      type === 'account'
        ? [{ id: 'acc-1', householdId: 'hh-1', aggregateType: 'account', payload: {} }]
        : [],
    );
    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Load demo data' }));

    await waitFor(() =>
      expect(screen.getByText(/Replace all your data with demo data\?/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Yes, replace everything/i }));

    await waitFor(() =>
      expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument(),
    );
    expect(wipeWorkspaceForDemoReload).not.toHaveBeenCalled();
    expect(loadDemoData).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'correct-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(verifyPassword).toHaveBeenCalledWith('correct-pw'));

    await waitFor(() =>
      expect(screen.getByText(/Final check: really replace everything\?/i)).toBeInTheDocument(),
    );
    expect(wipeWorkspaceForDemoReload).not.toHaveBeenCalled();
    expect(loadDemoData).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Delete and load demo/i }));
    await waitFor(() =>
      expect(wipeWorkspaceForDemoReload).toHaveBeenCalledWith('hh-1'),
    );
    expect(loadDemoData).toHaveBeenCalled();
    // Wipe must precede load, or the loader's precondition would refuse on the existing account.
    const wipeOrder = (wipeWorkspaceForDemoReload as any).mock.invocationCallOrder[0];
    const loadOrder = (loadDemoData as any).mock.invocationCallOrder[0];
    expect(wipeOrder).toBeLessThan(loadOrder);
  });

  it('wrong password keeps the demo password modal open and never reaches the final check', async () => {
    class FakeApiError extends Error {
      error = { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' };
    }
    const { ApiRequestError } = await import('../api/client');
    Object.setPrototypeOf(FakeApiError.prototype, ApiRequestError.prototype);
    const verifyPassword = vi.fn().mockRejectedValue(new FakeApiError('boom'));
    const { listAggregates } = await import('../db/store');
    const { loadDemoData, wipeWorkspaceForDemoReload } = await import(
      '../lib/demo-data-loader'
    );
    (listAggregates as any).mockImplementation(async (type: string) =>
      type === 'account'
        ? [{ id: 'acc-1', householdId: 'hh-1', aggregateType: 'account', payload: {} }]
        : [],
    );
    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Load demo data' }));
    await waitFor(() =>
      expect(screen.getByText(/Replace all your data with demo data\?/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Yes, replace everything/i }));
    await waitFor(() =>
      expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(verifyPassword).toHaveBeenCalledWith('wrong-pw'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/current password is incorrect/i),
    );
    expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument();
    expect(screen.queryByText(/Final check: really replace everything\?/i)).not.toBeInTheDocument();
    expect(wipeWorkspaceForDemoReload).not.toHaveBeenCalled();
    expect(loadDemoData).not.toHaveBeenCalled();
  });

  it('cancelling on the demo password modal aborts without verifying or loading', async () => {
    const verifyPassword = vi.fn();
    const { listAggregates } = await import('../db/store');
    const { loadDemoData, wipeWorkspaceForDemoReload } = await import(
      '../lib/demo-data-loader'
    );
    (listAggregates as any).mockImplementation(async (type: string) =>
      type === 'account'
        ? [{ id: 'acc-1', householdId: 'hh-1', aggregateType: 'account', payload: {} }]
        : [],
    );
    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Load demo data' }));
    await waitFor(() =>
      expect(screen.getByText(/Replace all your data with demo data\?/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Yes, replace everything/i }));
    await waitFor(() =>
      expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByText(/Confirm with your password/i)).not.toBeInTheDocument(),
    );
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(wipeWorkspaceForDemoReload).not.toHaveBeenCalled();
    expect(loadDemoData).not.toHaveBeenCalled();
  });

  it('cancelling at the final-check dialog leaves the workspace untouched', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    const { listAggregates } = await import('../db/store');
    const { loadDemoData, wipeWorkspaceForDemoReload } = await import(
      '../lib/demo-data-loader'
    );
    (listAggregates as any).mockImplementation(async (type: string) =>
      type === 'account'
        ? [{ id: 'acc-1', householdId: 'hh-1', aggregateType: 'account', payload: {} }]
        : [],
    );
    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Load demo data' }));
    await waitFor(() =>
      expect(screen.getByText(/Replace all your data with demo data\?/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Yes, replace everything/i }));
    await waitFor(() =>
      expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'correct-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(screen.getByText(/Final check: really replace everything\?/i)).toBeInTheDocument(),
    );

    const dialog = screen.getByRole('alertdialog');
    const cancelBtn = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Cancel',
    );
    if (!cancelBtn) throw new Error('Cancel button not found in final-check dialog');
    fireEvent.click(cancelBtn);

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(wipeWorkspaceForDemoReload).not.toHaveBeenCalled();
    expect(loadDemoData).not.toHaveBeenCalled();
  });

  it('empty-workspace path loads demo data without a second confirmation', async () => {
    const { loadDemoData, wipeWorkspaceForDemoReload } = await import(
      '../lib/demo-data-loader'
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Load demo data' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/Load demo data\?/i);
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Load demo data',
    );
    if (!confirm) throw new Error('confirm button not found');
    fireEvent.click(confirm);
    await waitFor(() => expect(loadDemoData).toHaveBeenCalled());
    expect(wipeWorkspaceForDemoReload).not.toHaveBeenCalled();
  });

  it('surfaces DemoDataExistsError as an inline workspace error', async () => {
    const { loadDemoData, DemoDataExistsError } = await import('../lib/demo-data-loader');
    (loadDemoData as any).mockRejectedValueOnce(new DemoDataExistsError());
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Load demo data' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirmBtn = await waitFor(() => {
      const buttons = dialog.querySelectorAll('button');
      const match = Array.from(buttons).find((b) => b.textContent?.trim() === 'Load demo data');
      if (!match) throw new Error('dialog confirm button not found');
      return match;
    });
    fireEvent.click(confirmBtn);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Workspace already has/i),
    );
  });

  it('overwrite path aborts when the sync round-trip fails (offline)', async () => {
    syncRoundTripMock.mockResolvedValueOnce({ ok: false, reason: 'You appear to be offline.' });
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    const { listAggregates } = await import('../db/store');
    const { loadDemoData, wipeWorkspaceForDemoReload } = await import(
      '../lib/demo-data-loader'
    );
    (listAggregates as any).mockImplementation(async (type: string) =>
      type === 'account'
        ? [{ id: 'acc-1', householdId: 'hh-1', aggregateType: 'account', payload: {} }]
        : [],
    );
    renderPage({ verifyPassword });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Load demo data' }));
    await waitFor(() =>
      expect(screen.getByText(/Replace all your data with demo data\?/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Yes, replace everything/i }));
    await waitFor(() =>
      expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'correct-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(screen.getByText(/Final check: really replace everything\?/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Delete and load demo/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/offline/i),
    );
    expect(wipeWorkspaceForDemoReload).not.toHaveBeenCalled();
    expect(loadDemoData).not.toHaveBeenCalled();
  });
});

describe('WorkspacePage Workspace tools — Delete workspace data', () => {
  // listAggregates feeds the confirm dialog's local record count; the row is visible regardless of demo data.
  const demoMembers = [
    {
      id: 'demo-member-primary',
      householdId: 'hh-1',
      aggregateType: 'householdMember',
      payload: { isPrimary: true },
    },
  ];

  let originalLocation: Location;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { listAggregates, clearAllStores } = await import('../db/store');
    (listAggregates as any).mockReset();
    (listAggregates as any).mockResolvedValue([]);
    // `clearAllMocks` clears call counts but leaves queued `mockRejectedValue(Once)`, which the retry-path tests drive, so reset the local-wipe mock each test.
    (clearAllStores as any).mockReset();
    (clearAllStores as any).mockResolvedValue(undefined);
    clearWorkspaceMock.mockReset();
    // Default: a 2xx non-erase clear returns historyErased:false (the real server's response when erase wasn't requested), a success not a latch.
    clearWorkspaceMock.mockResolvedValue({ ok: true, historyErased: false });
    sessionStorage.clear();
    // jsdom no-ops reload() without a spy; mock it so the 2xx-gated hard reload is assertable.
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: vi.fn() },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
    sessionStorage.clear();
  });

  // Drive the flow to the open counts-confirm dialog: Delete, password, Continue. Returns the verifyPassword spy.
  async function openConfirmDialog(
    verifyPassword: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
  ) {
    renderPage({ verifyPassword });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Delete workspace data/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Delete workspace data/i }));
    await waitFor(() =>
      expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'correct-pw' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(screen.getByText(/Delete all workspace data\?/i)).toBeInTheDocument(),
    );
    return verifyPassword;
  }

  it('always shows the Delete workspace data row, even on an empty workspace', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: /Delete workspace data/i }),
    ).toBeInTheDocument();
  });

  it('shows the Delete workspace data row when demo data is on file', async () => {
    const { listAggregates } = await import('../db/store');
    (listAggregates as any).mockImplementation(async (type: string) =>
      type === 'householdMember' ? demoMembers : [],
    );
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Delete workspace data/i }),
      ).toBeInTheDocument(),
    );
  });

  it('requires password verification, then shows a counts confirmation naming un-synced data — no pre-clear sync round-trip', async () => {
    const { listAggregates } = await import('../db/store');
    (listAggregates as any).mockImplementation(async (type: string) => {
      if (type === 'householdMember') return demoMembers;
      if (type === 'account')
        return [
          { id: 'a-1', payload: {} },
          { id: 'a-2', payload: {} },
        ];
      return [];
    });
    const verifyPassword = await openConfirmDialog();
    expect(verifyPassword).toHaveBeenCalledWith('correct-pw');
    expect(syncRoundTripMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/3 records/i);
    expect(dialog).toHaveTextContent(/anything not yet synced to this device/i);
    expect(clearWorkspaceMock).not.toHaveBeenCalled();
  });

  it('confirming calls clearWorkspace (2xx), wipes local residue, suppresses the demo modal, stashes a notice, and reloads', async () => {
    const { clearAllStores, clearMutationQueue } = await import('../db/store');
    // The per-browser first-run seeded flag must survive "Delete workspace data": that makes the wipe stick on this browser (first-run then shows the prompt instead of re-seeding).
    const seededKey = 'retivo:primary-member-seeded:hh-1';
    localStorage.setItem(seededKey, '1');
    await openConfirmDialog();
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    await waitFor(() =>
      expect(clearWorkspaceMock).toHaveBeenCalledWith({
        currentPassword: 'correct-pw',
        eraseHistory: false,
      }),
    );
    await waitFor(() => expect(clearAllStores).toHaveBeenCalled());
    // The mutation-queue clear moved into SyncContext.clearWorkspace's destructive fence (mocked here), so the card no longer clears it; the atomic clear is covered in SyncContext.test.tsx.
    expect(clearMutationQueue).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(sessionStorage.getItem('suppressDemoModal')).toBe('1'),
    );
    expect(localStorage.getItem(seededKey)).toBe('1');
    localStorage.removeItem(seededKey);
    expect(sessionStorage.getItem(WORKSPACE_NOTICE_KEY)).toBe('Workspace data deleted.');
    // Erase-history was not requested (checkbox unticked), so historyErased:false is the normal success case and the "couldn't erase backups" banner must not latch.
    expect(sessionStorage.getItem(WORKSPACE_HISTORY_NOT_ERASED_KEY)).toBeNull();
    expect(window.location.reload).toHaveBeenCalled();
  });

  it('ticking "Also erase backup history" sends eraseHistory: true', async () => {
    await openConfirmDialog();
    fireEvent.click(
      screen.getByRole('checkbox', { name: /erase backup history/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    await waitFor(() =>
      expect(clearWorkspaceMock).toHaveBeenCalledWith({
        currentPassword: 'correct-pw',
        eraseHistory: true,
      }),
    );
  });

  it('a 2xx historyErased:false when erase-history WAS requested latches the "couldn\'t erase backups" banner for after the reload', async () => {
    clearWorkspaceMock.mockResolvedValue({ ok: true, historyErased: false });
    const { clearAllStores } = await import('../db/store');
    await openConfirmDialog();
    // Tick "Also erase backup history" so the purge is requested; only then does historyErased:false mean the purge failed.
    fireEvent.click(
      screen.getByRole('checkbox', { name: /erase backup history/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    await waitFor(() => expect(clearAllStores).toHaveBeenCalled());
    expect(window.location.reload).toHaveBeenCalled();
    await waitFor(() =>
      expect(sessionStorage.getItem(WORKSPACE_HISTORY_NOT_ERASED_KEY)).toBe('1'),
    );
    expect(sessionStorage.getItem(WORKSPACE_NOTICE_KEY)).toBeNull();
  });

  it('a 2xx historyErased:false when erase-history was NOT requested is a plain success — normal notice, no failure latch', async () => {
    clearWorkspaceMock.mockResolvedValue({ ok: true, historyErased: false });
    const { clearAllStores } = await import('../db/store');
    await openConfirmDialog();
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    await waitFor(() =>
      expect(clearWorkspaceMock).toHaveBeenCalledWith({
        currentPassword: 'correct-pw',
        eraseHistory: false,
      }),
    );
    await waitFor(() => expect(clearAllStores).toHaveBeenCalled());
    expect(window.location.reload).toHaveBeenCalled();
    await waitFor(() =>
      expect(sessionStorage.getItem(WORKSPACE_NOTICE_KEY)).toBe('Workspace data deleted.'),
    );
    expect(sessionStorage.getItem(WORKSPACE_HISTORY_NOT_ERASED_KEY)).toBeNull();
  });

  it('a POST-2xx local-cleanup failure still reloads and does NOT surface a "delete failed" error', async () => {
    // The server clear committed (2xx); a throw from post-commit local cleanup (e.g. clearAllStores) must not be reported as "couldn't delete workspace data" (it was deleted server-side) and must still hard reload so the app converges on the cleared workspace.
    clearWorkspaceMock.mockResolvedValue({ ok: true, historyErased: true });
    const { clearAllStores } = await import('../db/store');
    (clearAllStores as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('IndexedDB blocked'),
    );
    await openConfirmDialog();
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    await waitFor(() => expect(window.location.reload).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retries the local wipe after a transient POST-2xx clearAllStores failure and converges', async () => {
    // A single failed wipe used to fall through to a silent reload, but the post-reload initialSync takes the applyBootstrap(false) fresh-device path (the cursor was reset to '0'), which fetches the empty snapshot without wiping local stores, so the deleted records survived. The wipe is retried: a transient failure recovers and the reload fires only once the stores are clear.
    clearWorkspaceMock.mockResolvedValue({ ok: true, historyErased: true });
    const { clearAllStores } = await import('../db/store');
    (clearAllStores as ReturnType<typeof vi.fn>).mockReset();
    (clearAllStores as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('IndexedDB blocked'))
      .mockResolvedValue(undefined);
    await openConfirmDialog();
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    await waitFor(() => expect(window.location.reload).toHaveBeenCalled());
    expect(
      (clearAllStores as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the user on the page with an honest message (no silent reload) when every local wipe attempt fails', async () => {
    // The server clear committed but clearAllStores fails on every attempt: the flow must not silently reload (applyBootstrap(false) would not re-wipe, leaving deleted aggregates visible) nor show the pre-commit "couldn't delete workspace data" copy.
    clearWorkspaceMock.mockResolvedValue({ ok: true, historyErased: true });
    const { clearAllStores } = await import('../db/store');
    (clearAllStores as ReturnType<typeof vi.fn>).mockReset();
    (clearAllStores as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('IndexedDB blocked'),
    );
    await openConfirmDialog();
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn't finish clearing it from this device/i,
      ),
    );
    expect(screen.queryByText(/couldn't delete workspace data/i)).toBeNull();
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(
      (clearAllStores as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(1);
    expect(
      screen.getByRole('button', { name: /Delete workspace data/i }),
    ).toBeEnabled();
  });

  it('a POST-2xx SyncContext cleanup failure (WorkspaceClearCleanupError) shows the honest recovery copy — NOT the pre-commit copy — and never wipes/reloads', async () => {
    // The server clear committed (2xx) but SyncContext.clearWorkspace could not finish its local sync-state cleanup even after bounded retries, so it rejected with the typed WorkspaceClearCleanupError and left the poll suspended. The card must tell this apart from a pre-commit rejection: no "couldn't delete workspace data" (it was deleted server-side), and no reload, since a resumed poll could re-push the still-queued mutations.
    clearWorkspaceMock.mockRejectedValue(
      new WorkspaceClearCleanupError({ ok: true, historyErased: true }),
    );
    const { clearAllStores } = await import('../db/store');
    await openConfirmDialog();
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn't finish clearing it from this device/i,
      ),
    );
    expect(screen.queryByText(/couldn't delete workspace data/i)).toBeNull();
    expect(clearAllStores).not.toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('suppressDemoModal')).toBeNull();
    expect(
      screen.getByRole('button', { name: /Delete workspace data/i }),
    ).toBeEnabled();
  });

  it('a non-2xx clearWorkspace is fail-safe: surfaces the error, preserves the queue, and does NOT wipe/reload/suppress-demo', async () => {
    clearWorkspaceMock.mockRejectedValue(new Error('Current password is incorrect.'));
    const { clearAllStores, clearMutationQueue } = await import('../db/store');
    await openConfirmDialog();
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn't delete workspace data/i,
      ),
    );
    expect(clearAllStores).not.toHaveBeenCalled();
    expect(clearMutationQueue).not.toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('suppressDemoModal')).toBeNull();
    expect(sessionStorage.getItem(WORKSPACE_HISTORY_NOT_ERASED_KEY)).toBeNull();
  });

  it('the counts + erase-history confirm dialog has no a11y violations', async () => {
    await openConfirmDialog();
    // The dialog and its React Aria checkbox are portaled to document.body.
    await expectNoA11yViolations(document.body);
  });

  it('after a historyErased:false reload, "Try erasing backups again" runs a PURGE-ONLY clear (no sweep, no local wipe)', async () => {
    // Simulate the post-reload mount: the latch is present.
    sessionStorage.setItem(WORKSPACE_HISTORY_NOT_ERASED_KEY, '1');
    clearWorkspaceMock.mockResolvedValue({ ok: true, historyErased: true });
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    const { clearAllStores } = await import('../db/store');
    renderPage({ verifyPassword });
    const retryBtn = await screen.findByRole('button', {
      name: /Try erasing backups again/i,
    });
    fireEvent.click(retryBtn);
    await waitFor(() =>
      expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'correct-pw' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Erase backups/i }));
    await waitFor(() =>
      expect(clearWorkspaceMock).toHaveBeenCalledWith({
        currentPassword: 'correct-pw',
        eraseHistory: true,
        purgeHistoryOnly: true,
      }),
    );
    // The purge-only retry must not sweep local data, which a full-clear retry would, losing resumed post-reload work.
    expect(clearAllStores).not.toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(/backup history was erased/i)).toBeInTheDocument(),
    );
  });
});

describe('WorkspacePage Workspace tools — Clear data on this device', () => {
  let originalLocation: Location;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearAllLocalData } = await import('../lib/local-data');
    (clearAllLocalData as any).mockReset();
    (clearAllLocalData as any).mockResolvedValue(undefined);
    // jsdom no-ops reload() without a spy; mock it so the hard reload firing last is assertable.
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: vi.fn() },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('clicking Clear data on this device opens the confirm dialog with reassuring copy', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear data on this device' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear data on this device' }));
    await waitFor(() =>
      expect(screen.getByRole('alertdialog')).toHaveTextContent(/Clear data on this device\?/i),
    );
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      /your data on our servers stay safe/i,
    );
  });

  it('confirming clear signs out first, then full-nukes, then hard-reloads — now gated on the proven verdict', async () => {
    const order: string[] = [];
    const signOutForDeviceClear = vi.fn().mockImplementation(async () => {
      order.push('signOut');
      return { proven: true };
    });
    const { clearAllLocalData } = await import('../lib/local-data');
    (clearAllLocalData as any).mockImplementation(async () => {
      order.push('clear');
    });
    (window.location.reload as any).mockImplementation(() => {
      order.push('reload');
    });
    renderPage({ signOutForDeviceClear });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear data on this device' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear data on this device' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Clear and sign out' }));
    await waitFor(() => expect(window.location.reload).toHaveBeenCalled());
    expect(clearAllLocalData).toHaveBeenCalledWith();
    expect(signOutForDeviceClear).toHaveBeenCalled();
    expect(order).toEqual(['signOut', 'clear', 'reload']);
  });

  it('an ambiguous verdict (proven: false) does not wipe or reload, names the failure, and re-enables Clear', async () => {
    const signOutForDeviceClear = vi
      .fn()
      .mockResolvedValue({ proven: false, reason: "We couldn't reach the server." });
    const { clearAllLocalData } = await import('../lib/local-data');
    renderPage({ signOutForDeviceClear });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear data on this device' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear data on this device' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Clear and sign out' }));

    const alert = await screen.findByRole('alert');
    // Bind to the meaning (names the failure, points to the browser's site-data settings), not one exact sentence.
    expect(alert).toHaveTextContent(/We couldn't reach the server/i);
    expect(alert).toHaveTextContent(/still saved in this browser/i);
    expect(alert).toHaveTextContent(/browser's settings/i);
    expect(clearAllLocalData).not.toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Clear data on this device' }),
    ).not.toBeDisabled();
  });

  it('a definitive-rejection verdict (proven: true) clears and reloads, exactly like the 204 case', async () => {
    const signOutForDeviceClear = vi.fn().mockResolvedValue({ proven: true });
    const { clearAllLocalData } = await import('../lib/local-data');
    renderPage({ signOutForDeviceClear });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear data on this device' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear data on this device' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Clear and sign out' }));

    await waitFor(() => expect(window.location.reload).toHaveBeenCalled());
    expect(clearAllLocalData).toHaveBeenCalledWith();
  });

  it('an unexpected signOutForDeviceClear() rejection resets the clearing state and shows a recoverable error, instead of stranding the UI', async () => {
    const signOutForDeviceClear = vi.fn().mockRejectedValue(new Error('boom'));
    const { clearAllLocalData } = await import('../lib/local-data');
    renderPage({ signOutForDeviceClear });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear data on this device' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear data on this device' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Clear and sign out' }));

    await waitFor(() => expect(screen.getByText(/Couldn't clear data on this device: boom/)).toBeInTheDocument());
    expect(clearAllLocalData).not.toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear data on this device' })).not.toBeDisabled(),
    );
  });

  it('Cancel on the confirm dialog leaves the device alone', async () => {
    const signOutForDeviceClear = vi.fn();
    const { clearAllLocalData } = await import('../lib/local-data');
    renderPage({ signOutForDeviceClear });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear data on this device' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear data on this device' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(clearAllLocalData).not.toHaveBeenCalled();
    expect(signOutForDeviceClear).not.toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
  });
});

describe('WorkspacePage Workspace tools — Reload from server', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // `clearAllMocks` wipes the resolved value too; restore the success default, per-test overrides use `mockResolvedValueOnce`.
    forceRefreshMock.mockReset();
    forceRefreshMock.mockResolvedValue({ ok: true, wiped: true });
    recacheHdkMock.mockReset();
    recacheHdkMock.mockResolvedValue(undefined);
    // Default to no un-synced edits; a test exercising the warn-before-discard naming reassigns before rendering.
    pendingMutationsMock = [];
    conflictMutationsMock = [];
    failedErrorMutationsMock = [];
    const { clearSelectedScenario } = await import('../db/store');
    const { clearMonteCarloCache } = await import('../db/monte-carlo-cache');
    (clearSelectedScenario as any).mockResolvedValue(undefined);
    (clearMonteCarloCache as any).mockResolvedValue(undefined);
  });

  async function openFullSyncConfirm() {
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reload from server' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload from server' }));
    await waitFor(() =>
      expect(screen.getByRole('alertdialog')).toHaveTextContent(/Reload from server\?/i),
    );
  }

  it('renders the Reload-from-server button in the Workspace tools card and the confirm names the consequence', async () => {
    renderPage();
    await openFullSyncConfirm();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      /unsynced edits on this device will be lost/i,
    );
  });

  it('names the un-synced edits it will discard in the Reload confirm (warn-before-discard)', async () => {
    conflictMutationsMock = [
      {
        id: 'c1',
        aggregateId: 'agg-1',
        aggregateType: 'scenario',
        operation: 'update',
        expectedVersion: 1,
        schemaVersion: 1,
        payload: {},
        timestamp: Date.now(),
        deviceId: 'd',
        status: 'failed-conflict',
        reason: 'CONFLICT',
      },
    ];
    renderPage();
    await openFullSyncConfirm();
    const dialog = screen.getByRole('alertdialog');
    // The confirm lists exactly what a Reload would drop: a count line and a per-edit descriptor (via REASON_LABEL); the item's resolved name is asynchronous (raw-id fallback here), while the count and descriptor render with the list.
    expect(dialog).toHaveTextContent(/1 unsynced edit on this device will be permanently lost/i);
    await waitFor(() => expect(dialog).toHaveTextContent(/changed on another device/i));
  });

  it('shows no extra un-synced list in the Reload confirm when there are none (reads as today)', async () => {
    renderPage();
    await openFullSyncConfirm();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).not.toHaveTextContent(/will be permanently lost/i);
    expect(dialog).not.toHaveTextContent(/changed on another device/i);
  });

  it('confirm + { ok: true, wiped: true }: calls forceRefresh, clears local caches, and re-caches the HDK', async () => {
    forceRefreshMock.mockResolvedValueOnce({ ok: true, wiped: true });
    const { clearSelectedScenario } = await import('../db/store');
    const { clearMonteCarloCache } = await import('../db/monte-carlo-cache');
    renderPage();
    await openFullSyncConfirm();
    const dialog = screen.getByRole('alertdialog');
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Reload from server',
    );
    if (!confirm) throw new Error('confirm button not found');
    fireEvent.click(confirm);

    await waitFor(() => expect(forceRefreshMock).toHaveBeenCalled());
    await waitFor(() => expect(clearMonteCarloCache).toHaveBeenCalled());
    expect(clearSelectedScenario).toHaveBeenCalled();
    expect(recacheHdkMock).toHaveBeenCalledTimes(1);
  });

  it('confirm + { ok: false, wiped: false }: pre-wipe error message, clears NOT called', async () => {
    forceRefreshMock.mockResolvedValueOnce({ ok: false, wiped: false });
    const { clearSelectedScenario } = await import('../db/store');
    const { clearMonteCarloCache } = await import('../db/monte-carlo-cache');
    renderPage();
    await openFullSyncConfirm();
    const dialog = screen.getByRole('alertdialog');
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Reload from server',
    );
    if (!confirm) throw new Error('confirm button not found');
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /your data was not changed/i,
      ),
    );
    expect(clearMonteCarloCache).not.toHaveBeenCalled();
    expect(clearSelectedScenario).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reload from server' })).not.toBeDisabled();
  });

  it('confirm + { ok: false, wiped: true }: post-wipe re-sync message, clears NOT called', async () => {
    forceRefreshMock.mockResolvedValueOnce({ ok: false, wiped: true });
    const { clearSelectedScenario } = await import('../db/store');
    const { clearMonteCarloCache } = await import('../db/monte-carlo-cache');
    renderPage();
    await openFullSyncConfirm();
    const dialog = screen.getByRole('alertdialog');
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Reload from server',
    );
    if (!confirm) throw new Error('confirm button not found');
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /trying again from the server/i,
      ),
    );
    expect(clearMonteCarloCache).not.toHaveBeenCalled();
    expect(clearSelectedScenario).not.toHaveBeenCalled();
  });

  it('cancelling the Reload-from-server confirm is a no-op', async () => {
    renderPage();
    await openFullSyncConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(forceRefreshMock).not.toHaveBeenCalled();
  });
});
