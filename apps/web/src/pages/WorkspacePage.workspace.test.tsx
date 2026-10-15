/**
 * Component tests for the Workspace page's Workspace tools card: Load demo data
 * (the three-gate overwrite flow), Delete workspace data (full reset), Clear
 * data on this device, and Reload from server. Renders through WorkspacePage,
 * which hosts the card.
 */
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
// `runDestructive` fences the demo-overwrite wipe→load window in the real
// provider; here it just runs `fn` through so the handler's body executes.
const runDestructiveMock = vi.fn(async (fn: () => Promise<unknown>) => fn());
// `clearWorkspace` is the server-authoritative Delete-workspace-data endpoint
// call; the real provider fences it + clears the ZK freshness pin. Default:
// a 2xx that did NOT erase backup history — matching the real server, which
// returns `historyErased:false` for every clear where erase wasn't requested
// (the default, checkbox-unticked path). That is a success, not a failure.
const clearWorkspaceMock = vi
  .fn()
  .mockResolvedValue({ ok: true, historyErased: false });
// Configurable un-synced mutation lists surfaced by the sync inspector + the
// Reload-from-server warn-before-discard. Default empty (the Reload dialog reads
// as today); a test reassigns these before rendering to exercise the naming.
let pendingMutationsMock: unknown[] = [];
let conflictMutationsMock: unknown[] = [];
let failedErrorMutationsMock: unknown[] = [];
// Real typed error the card `instanceof`-checks to tell a POST-commit local
// cleanup failure (server DID sweep) from a PRE-commit rejection. Hoisted
// so the mocked SyncContext module can re-export the SAME class reference the
// card imports, and the test below can construct it.
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
    // Reset the syncRoundTrip mock fully — `clearAllMocks` clears call
    // counts but leaves any `mockResolvedValueOnce` queued from a prior
    // test in place. `mockReset` drains that queue; the
    // `mockResolvedValue` below restores the success default for tests
    // that don't override it.
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
    // Row actions carry the full intent as their accessible name
    // (aria-label) while the visible caption is the short verb
    // (Load / Sync / Clear) — the mock `.kv` key/value rows.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Clear data on this device' })).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    const dataIdx = headings.indexOf('Data');
    const workspaceIdx = headings.indexOf('Workspace tools');
    expect(dataIdx).toBeGreaterThan(-1);
    expect(workspaceIdx).toBeGreaterThan(dataIdx);
    // The Delete-account danger card moved to the Security page.
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
    // The flow hard-reloads (a jsdom no-op), so the notice is stashed in
    // sessionStorage rather than shown inline — otherwise the reload tears the
    // component down before the user sees it.
    await waitFor(() =>
      expect(sessionStorage.getItem(WORKSPACE_NOTICE_KEY)).toBe('Demo data loaded.'),
    );
    // On the next mount (post-reload) the notice surfaces once, then the key is
    // consumed so it never re-appears.
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

    // Stage 1: replace-everything warning.
    await waitFor(() =>
      expect(screen.getByText(/Replace all your data with demo data\?/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Yes, replace everything/i }));

    // Stage 1.5: password re-auth gate (mirrors the import flow).
    await waitFor(() =>
      expect(screen.getByText(/Confirm with your password/i)).toBeInTheDocument(),
    );
    expect(wipeWorkspaceForDemoReload).not.toHaveBeenCalled();
    expect(loadDemoData).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'correct-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(verifyPassword).toHaveBeenCalledWith('correct-pw'));

    // Stage 2: final-check dialog appears; nothing destructive has run yet.
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
    // wipe must precede load — otherwise the loader's precondition
    // would refuse on the existing account.
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
    // Modal still open, final-check dialog never reached.
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

    // Cancel from stage 2 — must close the dialog without wiping or loading.
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
  // listAggregates feeds the confirm-dialog local record count. The demo
  // primary member builds a representative non-zero count — the row itself is
  // always visible regardless of whether demo data is present.
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
    // Reset the local-wipe mock each test — `clearAllMocks` clears call counts
    // but leaves any `mockRejectedValue`/`mockRejectedValueOnce` queued from a
    // prior test in place (the retry-path tests below drive it to reject).
    (clearAllStores as any).mockReset();
    (clearAllStores as any).mockResolvedValue(undefined);
    clearWorkspaceMock.mockReset();
    // Default: a 2xx non-erase clear returns historyErased:false (the real
    // server's response when erase wasn't requested) — a success, not a latch.
    clearWorkspaceMock.mockResolvedValue({ ok: true, historyErased: false });
    sessionStorage.clear();
    // jsdom no-ops reload() without a spy — mock it so the 2xx-gated hard
    // reload is assertable (idiom from the Clear-data suite below).
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

  // Drive the flow up to the open counts-confirm dialog: click Delete → enter
  // password → Continue → confirm dialog. Returns the verifyPassword spy.
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
    // No demo data, nothing in any store — the row is still present.
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
    // Demo member visible + a handful of accounts so the count is non-zero.
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
    // No client-driven pre-clear sync; the server sweep is authoritative.
    expect(syncRoundTripMock).not.toHaveBeenCalled();
    // Counts confirmation: demoMembers (1 member) + 2 accounts = 3 records.
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/3 records/i);
    expect(dialog).toHaveTextContent(/anything not yet synced to this device/i);
    // Nothing destructive runs until the user confirms.
    expect(clearWorkspaceMock).not.toHaveBeenCalled();
  });

  it('confirming calls clearWorkspace (2xx), wipes local residue, suppresses the demo modal, stashes a notice, and reloads', async () => {
    const { clearAllStores, clearMutationQueue } = await import('../db/store');
    // The per-browser first-run seeded flag: "Delete workspace data" must leave
    // it, which is what makes the wipe stick on this browser (the first-run
    // check then shows the prompt with no request instead of re-seeding).
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
    // 2xx-gated local residue wipe.
    await waitFor(() => expect(clearAllStores).toHaveBeenCalled());
    // The mutation-queue clear moved INTO SyncContext.clearWorkspace's
    // destructive fence — which is mocked in this suite — so the card
    // itself no longer clears the queue. The atomic queue clear (a stale create
    // can't survive to re-push) is covered in SyncContext.test.tsx.
    expect(clearMutationQueue).not.toHaveBeenCalled();
    // First-run demo offer suppressed + a success notice survives the reload,
    // and the hard reload fired.
    await waitFor(() =>
      expect(sessionStorage.getItem('suppressDemoModal')).toBe('1'),
    );
    expect(localStorage.getItem(seededKey)).toBe('1');
    localStorage.removeItem(seededKey);
    expect(sessionStorage.getItem(WORKSPACE_NOTICE_KEY)).toBe('Workspace data deleted.');
    // Default path: erase-history was NOT requested (checkbox unticked, so
    // eraseHistory:false), so the server's historyErased:false is the normal
    // success case — the "couldn't erase backups" banner must NOT latch.
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
    // Tick "Also erase backup history" so the purge is genuinely requested
    // (eraseHistory:true). Only then does historyErased:false mean "the purge
    // failed" — on the default path it just means "you didn't ask me to erase".
    fireEvent.click(
      screen.getByRole('checkbox', { name: /erase backup history/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    // Still wipes + reloads (the clear DID commit server-side).
    await waitFor(() => expect(clearAllStores).toHaveBeenCalled());
    expect(window.location.reload).toHaveBeenCalled();
    // The honest banner is latched across the reload; no generic "deleted" toast.
    await waitFor(() =>
      expect(sessionStorage.getItem(WORKSPACE_HISTORY_NOT_ERASED_KEY)).toBe('1'),
    );
    expect(sessionStorage.getItem(WORKSPACE_NOTICE_KEY)).toBeNull();
  });

  it('a 2xx historyErased:false when erase-history was NOT requested is a plain success — normal notice, no failure latch', async () => {
    // The default (checkbox-unticked) path. The server returns
    // historyErased:false because erase wasn't requested — that is NOT a purge
    // failure, so the "couldn't erase backups" banner must never latch.
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
    // Wipes + reloads as usual.
    await waitFor(() => expect(clearAllStores).toHaveBeenCalled());
    expect(window.location.reload).toHaveBeenCalled();
    // Normal success notice, and NO failure latch.
    await waitFor(() =>
      expect(sessionStorage.getItem(WORKSPACE_NOTICE_KEY)).toBe('Workspace data deleted.'),
    );
    expect(sessionStorage.getItem(WORKSPACE_HISTORY_NOT_ERASED_KEY)).toBeNull();
  });

  it('a POST-2xx local-cleanup failure still reloads and does NOT surface a "delete failed" error', async () => {
    // The server clear committed (2xx); a throw from the post-commit local
    // cleanup (e.g. clearAllStores) must NOT be reported as "couldn't delete
    // workspace data" — the data WAS deleted server-side — and must still hard
    // reload so the app converges on the now-empty, already-cleared workspace.
    clearWorkspaceMock.mockResolvedValue({ ok: true, historyErased: true });
    const { clearAllStores } = await import('../db/store');
    (clearAllStores as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('IndexedDB blocked'),
    );
    await openConfirmDialog();
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    // The post-commit cleanup threw, but the flow still hard-reloads (the clear
    // committed either way — converging beats a false failure).
    await waitFor(() => expect(window.location.reload).toHaveBeenCalled());
    // No pre-commit "couldn't delete workspace data" error is surfaced.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retries the local wipe after a transient POST-2xx clearAllStores failure and converges', async () => {
    // A single failed wipe used to fall through to a silent reload — but the
    // post-reload initialSync takes the applyBootstrap(false) fresh-device path
    // (SyncContext.clearWorkspace reset the cursor to '0'), which fetches the
    // empty snapshot WITHOUT wiping local stores, so the deleted records would
    // survive. The wipe is now retried: a transient failure recovers and the
    // reload only fires once the stores are actually clear.
    clearWorkspaceMock.mockResolvedValue({ ok: true, historyErased: true });
    const { clearAllStores } = await import('../db/store');
    (clearAllStores as ReturnType<typeof vi.fn>).mockReset();
    (clearAllStores as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('IndexedDB blocked'))
      .mockResolvedValue(undefined);
    await openConfirmDialog();
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    await waitFor(() => expect(window.location.reload).toHaveBeenCalled());
    // The wipe was retried (called more than once) and ultimately succeeded —
    // the residue is actually cleared, not left behind by a silent reload.
    expect(
      (clearAllStores as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(1);
    // Not a false "delete failed" surface.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the user on the page with an honest message (no silent reload) when every local wipe attempt fails', async () => {
    // The server clear committed (2xx), but clearAllStores fails on EVERY
    // attempt. The flow must NOT silently reload — the post-reload
    // applyBootstrap(false) path would not re-wipe, so the deleted aggregates
    // would still be visible — and must NOT show the pre-commit "couldn't
    // delete workspace data" copy (the server DID commit).
    clearWorkspaceMock.mockResolvedValue({ ok: true, historyErased: true });
    const { clearAllStores } = await import('../db/store');
    (clearAllStores as ReturnType<typeof vi.fn>).mockReset();
    (clearAllStores as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('IndexedDB blocked'),
    );
    await openConfirmDialog();
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    // The honest, actionable recovery message appears.
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn't finish clearing it from this device/i,
      ),
    );
    // ...and it is NOT the pre-commit failure copy (the server committed).
    expect(screen.queryByText(/couldn't delete workspace data/i)).toBeNull();
    // No silent reload into the non-wiping bootstrap path.
    expect(window.location.reload).not.toHaveBeenCalled();
    // The wipe was actually retried (bounded), not attempted once.
    expect(
      (clearAllStores as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(1);
    // Delete button re-enabled so the user can retry.
    expect(
      screen.getByRole('button', { name: /Delete workspace data/i }),
    ).toBeEnabled();
  });

  it('a POST-2xx SyncContext cleanup failure (WorkspaceClearCleanupError) shows the honest recovery copy — NOT the pre-commit copy — and never wipes/reloads', async () => {
    // The server clear COMMITTED (2xx) but SyncContext.clearWorkspace could not
    // finish its local sync-state cleanup (cursor / freshness pin / mutation
    // queue) even after its bounded retries, so it rejected with the typed
    // WorkspaceClearCleanupError and left the poll suspended. The card must tell
    // this apart from a pre-commit rejection: it may NOT show "couldn't delete
    // workspace data" (the data WAS deleted server-side), and must NOT reload —
    // a resumed poll could re-push the still-queued mutations.
    clearWorkspaceMock.mockRejectedValue(
      new WorkspaceClearCleanupError({ ok: true, historyErased: true }),
    );
    const { clearAllStores } = await import('../db/store');
    await openConfirmDialog();
    fireEvent.click(screen.getByRole('button', { name: /Delete everything/i }));
    // Honest recovery copy (server committed, local cleanup couldn't finish).
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn't finish clearing it from this device/i,
      ),
    );
    // NOT the pre-commit "couldn't delete workspace data" copy.
    expect(screen.queryByText(/couldn't delete workspace data/i)).toBeNull();
    // The card never reaches its own post-commit residue wipe (clearWorkspace
    // threw), and must not silently reload into the non-wiping bootstrap path.
    expect(clearAllStores).not.toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('suppressDemoModal')).toBeNull();
    // Delete button re-enabled so the user can press Delete again to retry.
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
    // The dialog + its React Aria checkbox are portaled to document.body.
    await expectNoA11yViolations(document.body);
  });

  it('after a historyErased:false reload, "Try erasing backups again" runs a PURGE-ONLY clear (no sweep, no local wipe)', async () => {
    // Simulate the post-reload mount: the latch is present.
    sessionStorage.setItem(WORKSPACE_HISTORY_NOT_ERASED_KEY, '1');
    // The retry purge succeeds this time (historyErased:true), clearing the banner.
    clearWorkspaceMock.mockResolvedValue({ ok: true, historyErased: true });
    const verifyPassword = vi.fn().mockResolvedValue(undefined);
    const { clearAllStores } = await import('../db/store');
    renderPage({ verifyPassword });
    // The banner surfaces, offering the retry.
    const retryBtn = await screen.findByRole('button', {
      name: /Try erasing backups again/i,
    });
    fireEvent.click(retryBtn);
    // Password re-auth, then the purge-only retry.
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
    // The purge-only retry must NOT sweep local data — guards the data loss a
    // full-clear retry would cause to resumed post-reload work.
    expect(clearAllStores).not.toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
    // Success message, banner cleared.
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
    // jsdom no-ops reload() without a spy. Mock it (idiom from
    // VersionBanner.test.tsx / ErrorBoundary.test.tsx) so we can assert
    // the hard reload fires last.
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
    // Full wipe — no args (deviceId included).
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
    // Names the failure and points to the browser's own site-data settings —
    // bind to that meaning, not to one exact sentence.
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
    // The button is usable again — not stranded in the clearing state.
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
    // `clearAllMocks` wipes the resolved value too — restore the
    // success default; per-test overrides use `mockResolvedValueOnce`.
    forceRefreshMock.mockReset();
    forceRefreshMock.mockResolvedValue({ ok: true, wiped: true });
    recacheHdkMock.mockReset();
    recacheHdkMock.mockResolvedValue(undefined);
    // Default to no un-synced edits so the confirm reads as today; a test that
    // exercises the warn-before-discard naming reassigns before rendering.
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
    // The confirm now lists exactly what a Reload would drop: a count line + the
    // per-edit "what it was" descriptor (via REASON_LABEL). The item's resolved
    // name is asynchronous (raw-id fallback here); the count + descriptor render
    // synchronously with the list.
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
    // Button re-enabled (not stuck on "Reloading…").
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
