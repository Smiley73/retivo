// AppShell first-login bootstrap timing: on first login the sync badge stays `synced` while `lastSyncedAt` goes null to timestamp, so
// the demo-prompt effects must re-run on that transition and must not run while it is null (duplicate demo aggregates). Heavy children are stubbed.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('./sync/SyncContext', () => ({ useSync: vi.fn() }));
vi.mock('./db/store', () => ({ listAggregates: vi.fn() }));
vi.mock('./pages/LoginPage', () => ({ LoginPage: () => <div data-testid="login-page" /> }));
vi.mock('./lib/scenario-bootstrap', () => ({
  ensureBaseScenario: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./lib/expense-categories-bootstrap', () => ({
  ensureDefaultExpenseCategories: vi.fn().mockResolvedValue(undefined),
  backfillSeededMedicalFlag: vi.fn().mockResolvedValue(false),
}));
vi.mock('./lib/scenario-mutations', () => ({
  reconcileScenarios: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./layout/Sidebar', () => ({ Sidebar: () => <nav data-testid="sidebar" /> }));
vi.mock('./components/MobileNavDrawer', () => ({
  MobileNavDrawer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./monte-carlo/MonteCarloProvider', () => ({
  MonteCarloProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./monte-carlo/MonteCarloProgressChip', () => ({ MonteCarloProgressChip: () => null }));
vi.mock('./components/VersionBanner', () => ({ VersionBanner: () => null }));
// The assistant session the shell reads; `null` is a build without the provider.
const assistantMock = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('./assistant/AssistantContext', () => ({
  useOptionalAssistant: () => assistantMock.value,
  useAssistant: () => assistantMock.value,
}));
vi.mock('./components/FirstRunDemoModal', () => ({
  FirstRunDemoModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="first-run-modal" /> : null,
}));
vi.mock('./sync/mutation-queue', () => ({
  queueLocalMutation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./components/HouseholdReadyBanner', () => ({
  HouseholdReadyBanner: () => <div data-testid="ready-banner" />,
  bannerPendingKey: (hh: string) => `retivo:household-ready-banner-pending:${hh}`,
  shouldShowReadyBanner: vi.fn().mockReturnValue(false),
}));

import { App, AppShell } from './App';
import { apiRequest } from './api/client';
import { useAuth } from './auth/AuthContext';
import { useSync } from './sync/SyncContext';
import { listAggregates } from './db/store';
import { queueLocalMutation } from './sync/mutation-queue';
import { shouldShowReadyBanner } from './components/HouseholdReadyBanner';
import { ensureBaseScenario } from './lib/scenario-bootstrap';
import { ensureDefaultExpenseCategories } from './lib/expense-categories-bootstrap';
import { reconcileScenarios } from './lib/scenario-mutations';
import { assistantValue } from './test/assistant-context';

type SyncState =
  | { kind: 'synced'; lastSyncedAt: string | null }
  | { kind: 'syncing-pull' };

const authMock = useAuth as unknown as ReturnType<typeof vi.fn>;
const syncMock = useSync as unknown as ReturnType<typeof vi.fn>;
const listAggregatesMock = listAggregates as unknown as ReturnType<typeof vi.fn>;
const ensureBaseScenarioMock = ensureBaseScenario as unknown as ReturnType<typeof vi.fn>;
const ensureDefaultExpenseCategoriesMock =
  ensureDefaultExpenseCategories as unknown as ReturnType<typeof vi.fn>;
const reconcileScenariosMock = reconcileScenarios as unknown as ReturnType<typeof vi.fn>;
const queueLocalMutationMock = queueLocalMutation as unknown as ReturnType<typeof vi.fn>;
const shouldShowReadyBannerMock = shouldShowReadyBanner as unknown as ReturnType<typeof vi.fn>;

const fetchAccountRecordMock = vi.fn();
const SEEDED_FLAG_KEY = 'retivo:primary-member-seeded:hh-1';
const PENDING_BANNER_KEY = 'retivo:household-ready-banner-pending:hh-1';
const EMAIL_ONLY_RECORD = { email: 'me@example.test' };
const FULL_RECORD = {
  email: 'me@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  birthdate: '1985-12-10',
};

// `me` is a fresh object on every call, like a token refresh.
function authValue(overrides: Record<string, unknown> = {}) {
  return {
    logout: vi.fn(),
    householdId: 'hh-1',
    me: { id: 'u-1', email: 'me@example.test', displayName: 'Me' },
    fetchAccountRecord: fetchAccountRecordMock,
    ...overrides,
  };
}

function setSync(state: SyncState, notifyPending = vi.fn()) {
  // The real runDestructive runs the callback inside the sync mutex; the mock just invokes it so the bootstrap effect proceeds.
  syncMock.mockReturnValue({
    state,
    notifyPending,
    runDestructive: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    pendingMutations: [],
    conflictMutations: [],
    failedErrorMutations: [],
  });
  return notifyPending;
}

function shellTree() {
  return (
    <StrictMode>
      <MemoryRouter initialEntries={['/']}>
        <AppShell />
      </MemoryRouter>
    </StrictMode>
  );
}

function renderShell() {
  return render(shellTree());
}

describe('AppShell first-run demo prompt', () => {
  beforeEach(() => {
    authMock.mockReturnValue(authValue());
    fetchAccountRecordMock.mockReset();
    fetchAccountRecordMock.mockResolvedValue(EMAIL_ONLY_RECORD);
    listAggregatesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('opens the demo prompt when lastSyncedAt flips null→timestamp with kind unchanged', async () => {
    setSync({ kind: 'synced', lastSyncedAt: null });
    const { rerender } = renderShell();

    await waitFor(() => expect(listAggregatesMock).not.toHaveBeenCalled());
    expect(screen.queryByTestId('first-run-modal')).toBeNull();

    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });
    rerender(shellTree());

    expect(await screen.findByTestId('first-run-modal')).toBeInTheDocument();
    expect(listAggregatesMock).toHaveBeenCalledWith('householdMember');
  });

  it('skips the demo prompt and clears the flag when suppressDemoModal is set', async () => {
    // After "Delete workspace data" the reset handler sets sessionStorage.suppressDemoModal before reloading; the first-run effect must consume it (clear and skip).
    sessionStorage.setItem('suppressDemoModal', '1');
    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });
    renderShell();

    await waitFor(() =>
      expect(listAggregatesMock).toHaveBeenCalledWith('householdMember'),
    );
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
    await waitFor(() =>
      expect(sessionStorage.getItem('suppressDemoModal')).toBeNull(),
    );
    expect(localStorage.getItem(SEEDED_FLAG_KEY)).toBe('1');
    expect(fetchAccountRecordMock).not.toHaveBeenCalled();
  });

  it('does not open the demo prompt when local members already exist', async () => {
    listAggregatesMock.mockResolvedValue([{ id: 'm-1', aggregateType: 'householdMember' }]);
    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });
    renderShell();

    await waitFor(() => expect(listAggregatesMock).toHaveBeenCalledWith('householdMember'));
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
  });

  it('opens the demo prompt when syncedAt is already present on StrictMode mount', async () => {
    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });
    renderShell();

    expect(await screen.findByTestId('first-run-modal')).toBeInTheDocument();
    expect(listAggregatesMock).toHaveBeenCalledWith('householdMember');
  });

  it('runs scenario bootstrap when syncedAt is already present on StrictMode mount', async () => {
    const notifyPendingMock = setSync({
      kind: 'synced',
      lastSyncedAt: '2026-06-04T00:00:00.000Z',
    });
    renderShell();

    await waitFor(() => expect(ensureBaseScenarioMock).toHaveBeenCalledWith('hh-1'));
    await waitFor(() =>
      expect(ensureDefaultExpenseCategoriesMock).toHaveBeenCalledWith('hh-1'),
    );
    await waitFor(() => expect(reconcileScenariosMock).toHaveBeenCalled());
    await waitFor(() => expect(notifyPendingMock).toHaveBeenCalled());
  });
});

describe('AppShell first-login household seeding', () => {
  const SYNCED = { kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' } as const;

  beforeEach(() => {
    authMock.mockReturnValue(authValue());
    fetchAccountRecordMock.mockReset();
    fetchAccountRecordMock.mockResolvedValue(FULL_RECORD);
    listAggregatesMock.mockResolvedValue([]);
    queueLocalMutationMock.mockResolvedValue(undefined);
    shouldShowReadyBannerMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('seeds the primary member from the account record + shows the banner (no modal), once', async () => {
    setSync(SYNCED);
    renderShell();

    await waitFor(() => expect(queueLocalMutationMock).toHaveBeenCalledTimes(1));
    expect(queueLocalMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'householdMember',
        operation: 'create',
        expectedVersion: 0,
        householdId: 'hh-1',
        payload: {
          isPrimary: true,
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'me@example.test',
          birthdate: '1985-12-10',
        },
      }),
    );
    expect(await screen.findByTestId('ready-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
    expect(localStorage.getItem(PENDING_BANNER_KEY)).toBe('1');
    expect(localStorage.getItem(SEEDED_FLAG_KEY)).toBe('1');
    // A silent background check raises no wait toast on a 429, and issues exactly one request though StrictMode mounted the effect twice.
    expect(fetchAccountRecordMock).toHaveBeenCalledTimes(1);
    expect(fetchAccountRecordMock).toHaveBeenCalledWith({ raiseWaitNotice: false });
    expect(queueLocalMutationMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['firstName', { ...FULL_RECORD, firstName: undefined }],
    ['lastName', { ...FULL_RECORD, lastName: undefined }],
    ['birthdate', { ...FULL_RECORD, birthdate: undefined }],
  ])('falls back to the demo modal (no seeding, no flag) when the record lacks %s', async (_field, record) => {
    fetchAccountRecordMock.mockResolvedValue(record);
    setSync(SYNCED);
    renderShell();

    expect(await screen.findByTestId('first-run-modal')).toBeInTheDocument();
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ready-banner')).toBeNull();
    expect(localStorage.getItem(SEEDED_FLAG_KEY)).toBeNull();
    expect(localStorage.getItem(PENDING_BANNER_KEY)).toBeNull();
  });

  it('falls back to the demo modal for an email-only record', async () => {
    fetchAccountRecordMock.mockResolvedValue(EMAIL_ONLY_RECORD);
    setSync(SYNCED);
    renderShell();

    await waitFor(() => expect(listAggregatesMock).toHaveBeenCalledWith('householdMember'));
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
    expect(await screen.findByTestId('first-run-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('ready-banner')).toBeNull();
  });

  it('a failed account fetch shows and writes nothing, is not latched, and has one request in flight', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rejectFetch: (e: Error) => void = () => {};
    fetchAccountRecordMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    setSync(SYNCED);
    const memberReads = () =>
      listAggregatesMock.mock.calls.filter(([type]) => type === 'householdMember').length;
    const { rerender } = renderShell();
    await waitFor(() => expect(fetchAccountRecordMock).toHaveBeenCalledTimes(1));

    // A token refresh while the request is pending re-runs the effect, which must join the request in flight, not start another.
    const readsBefore = memberReads();
    authMock.mockReturnValue(authValue());
    rerender(shellTree());
    await waitFor(() => expect(memberReads()).toBeGreaterThan(readsBefore));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchAccountRecordMock).toHaveBeenCalledTimes(1);

    rejectFetch(new Error('offline'));
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[first-run]'),
        expect.any(Error),
      ),
    );
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
    expect(screen.queryByTestId('ready-banner')).toBeNull();
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(SEEDED_FLAG_KEY)).toBeNull();
    expect(localStorage.getItem(PENDING_BANNER_KEY)).toBeNull();

    fetchAccountRecordMock.mockResolvedValue(FULL_RECORD);
    authMock.mockReturnValue(authValue());
    rerender(shellTree());
    await waitFor(() => expect(fetchAccountRecordMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(queueLocalMutationMock).toHaveBeenCalledTimes(1));
  });

  it('creates nothing when another tab populated the workspace while the account fetch was pending', async () => {
    let resolveFetch: (r: typeof FULL_RECORD) => void = () => {};
    fetchAccountRecordMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    setSync(SYNCED);
    renderShell();
    await waitFor(() => expect(fetchAccountRecordMock).toHaveBeenCalledTimes(1));

    localStorage.setItem(SEEDED_FLAG_KEY, '1');
    listAggregatesMock.mockResolvedValue([{ id: 'm-1', aggregateType: 'householdMember' }]);
    const memberReads = () =>
      listAggregatesMock.mock.calls.filter(([type]) => type === 'householdMember').length;
    const readsBefore = memberReads();
    resolveFetch(FULL_RECORD);

    await waitFor(() => expect(memberReads()).toBeGreaterThan(readsBefore));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ready-banner')).toBeNull();
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
    expect(localStorage.getItem(PENDING_BANNER_KEY)).toBeNull();
  });

  it('creates nothing when the seeded flag appeared while the account fetch was pending', async () => {
    let resolveFetch: (r: typeof FULL_RECORD) => void = () => {};
    fetchAccountRecordMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    setSync(SYNCED);
    renderShell();
    await waitFor(() => expect(fetchAccountRecordMock).toHaveBeenCalledTimes(1));

    localStorage.setItem(SEEDED_FLAG_KEY, '1');
    resolveFetch(FULL_RECORD);

    expect(await screen.findByTestId('first-run-modal')).toBeInTheDocument();
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ready-banner')).toBeNull();
  });

  it('shows the prompt with no request when the seeded flag is set and the workspace is empty', async () => {
    localStorage.setItem(SEEDED_FLAG_KEY, '1');
    setSync(SYNCED);
    renderShell();

    expect(await screen.findByTestId('first-run-modal')).toBeInTheDocument();
    expect(fetchAccountRecordMock).not.toHaveBeenCalled();
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ready-banner')).toBeNull();
  });

  it('seeds once per browser: a fresh shell with the same localStorage shows the prompt and makes no request', async () => {
    setSync(SYNCED);
    const first = renderShell();
    await waitFor(() => expect(queueLocalMutationMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('ready-banner')).toBeInTheDocument();
    first.unmount();

    renderShell();
    expect(await screen.findByTestId('first-run-modal')).toBeInTheDocument();
    expect(fetchAccountRecordMock).toHaveBeenCalledTimes(1);
    expect(queueLocalMutationMock).toHaveBeenCalledTimes(1);
  });

  it('reshows the banner on reload (pending key set, dismissed absent) without re-seeding, and records the seed', async () => {
    shouldShowReadyBannerMock.mockReturnValue(true);
    setSync(SYNCED);
    renderShell();

    expect(await screen.findByTestId('ready-banner')).toBeInTheDocument();
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
    expect(fetchAccountRecordMock).not.toHaveBeenCalled();
    expect(listAggregatesMock).not.toHaveBeenCalledWith('householdMember');
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
    expect(localStorage.getItem(SEEDED_FLAG_KEY)).toBe('1');
  });

  it('records the flag and does not seed when members already exist (returning user)', async () => {
    listAggregatesMock.mockResolvedValue([
      { id: 'm-1', aggregateType: 'householdMember' },
    ]);
    setSync(SYNCED);
    renderShell();

    await waitFor(() => expect(listAggregatesMock).toHaveBeenCalledWith('householdMember'));
    await waitFor(() => expect(localStorage.getItem(SEEDED_FLAG_KEY)).toBe('1'));
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
    expect(fetchAccountRecordMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
    expect(screen.queryByTestId('ready-banner')).toBeNull();
  });
});

describe('retired legal addresses are unknown addresses', () => {
  // The acceptance and public Terms/Privacy pages are gone: signed in each is the not-found screen, signed out each goes to /login, and the shell never asks the network layer about legal status (asserted at the fetch boundary).
  const RETIRED_PATHS = ['/disclaimer', '/terms', '/privacy'];
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  function requestedUrls(): string[] {
    return fetchSpy.mock.calls.map(([url]) => String(url));
  }

  it.each(RETIRED_PATHS)('%s renders the shell not-found screen when signed in, with no legal request', async (path) => {
    authMock.mockReturnValue({
      isBooting: false,
      isAuthenticated: true,
      hasRole: () => true,
      logout: vi.fn(),
      householdId: 'hh-1',
      me: { id: 'u-1', email: 'me@example.test', displayName: 'Me' },
      fetchAccountRecord: fetchAccountRecordMock,
    });
    listAggregatesMock.mockResolvedValue([{ id: 'm-1', aggregateType: 'householdMember' }]);
    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });

    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '404: Not found' })).toBeInTheDocument();
    await waitFor(() => expect(ensureBaseScenarioMock).toHaveBeenCalledWith('hh-1'));
    expect(requestedUrls().filter((u) => u.includes('/auth/legal-'))).toEqual([]);
  });

  it.each(RETIRED_PATHS)('%s goes to /login when signed out, like any unknown address', async (path) => {
    authMock.mockReturnValue({
      isBooting: false,
      isAuthenticated: false,
      hasRole: () => false,
    });

    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('login-page')).toBeInTheDocument();
    expect(requestedUrls().filter((u) => u.includes('/auth/legal-'))).toEqual([]);
  });
});

// The first-run check is a background request: a throttled `GET /auth/me` must not raise the shared "Please wait" toast. `fetchAccountRecord` is the real `apiRequest`, so a forgotten opt-out fails here.
describe('first-run account fetch throttled with a Retry-After', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('raises no wait notice and shows no prompt or banner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    authMock.mockReturnValue(
      authValue({
        isBooting: false,
        isAuthenticated: true,
        hasRole: () => true,
        fetchAccountRecord: (opts?: { raiseWaitNotice?: boolean }) =>
          apiRequest('/api/v1/auth/me', opts),
      }),
    );
    listAggregatesMock.mockResolvedValue([]);
    shouldShowReadyBannerMock.mockReturnValue(false);
    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });

    render(
      <MemoryRouter initialEntries={['/nowhere']}>
        <App />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[first-run]'),
        expect.anything(),
      ),
    );
    expect(
      fetchSpy.mock.calls.filter(([url]) => String(url).includes('/auth/me')),
    ).toHaveLength(1);
    expect(screen.queryByTestId('wait-notice')).toBeNull();
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
    expect(screen.queryByTestId('ready-banner')).toBeNull();
    expect(localStorage.getItem(SEEDED_FLAG_KEY)).toBeNull();
  });
});

// AppToastRegion is mounted in `App`, above the routed subtree, so a throttled request on a signed-out auth route still shows the wait notice; asserted at the route level with the real `apiRequest`, since mounting the region inside AppShell is the regression.
describe('wait notice reaches a signed-out auth route', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows the shared "please wait" notice when /auth/request-password-reset is throttled with a Retry-After', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
          { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } },
        ),
      ),
    );
    authMock.mockReturnValue({
      isBooting: false,
      isAuthenticated: false,
      requestPasswordReset: (email: string) =>
        apiRequest('/api/v1/auth/request-password-reset', {
          method: 'POST',
          body: { email },
          auth: false,
        }),
    });

    render(
      <MemoryRouter initialEntries={['/auth/request-password-reset']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'me@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    const notice = await screen.findByTestId('wait-notice');
    expect(notice.textContent).toContain('Please wait');
    expect(notice.textContent).toContain('5');
    expect(notice.textContent).toContain('seconds before trying again.');

    // The form's submit control stays enabled and focus never moves onto the toast.
    const submit = screen.getByRole('button', { name: 'Send reset link' });
    expect(submit).toBeEnabled();
    expect(document.activeElement).not.toBe(notice);
    expect(notice.contains(document.activeElement)).toBe(false);
  });
});

describe('AppShell assistant indicator', () => {
  beforeEach(() => {
    authMock.mockReturnValue(authValue());
    fetchAccountRecordMock.mockReset();
    fetchAccountRecordMock.mockResolvedValue(EMAIL_ONLY_RECORD);
    listAggregatesMock.mockResolvedValue([]);
    setSync({ kind: 'synced', lastSyncedAt: null });
    // Keep the household "seeded" so the first-run prompt stays out of this test.
    localStorage.setItem(SEEDED_FLAG_KEY, 'true');
  });

  afterEach(() => {
    assistantMock.value = null;
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('adds nothing to the shell without an assistant session context', () => {
    const { container } = renderShell();
    expect(container.querySelector('[role="banner"]')?.querySelectorAll('button')).toHaveLength(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect assistant' })).not.toBeInTheDocument();
  });

  it('adds only the empty status region when the assistant is offered but no session runs', () => {
    assistantMock.value = assistantValue({ phase: 'idle', client: null, pairedAt: null });
    const { container } = renderShell();
    expect(container.querySelector('[role="banner"]')?.querySelectorAll('button')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('shows the indicator in the mobile banner, between the Menu button and the rest', () => {
    assistantMock.value = assistantValue();
    const { container } = renderShell();
    const banner = container.querySelector<HTMLElement>('[role="banner"]')!;
    const names = Array.from(banner.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['Open navigation', 'Assistant connected, reported as Claude Code. View activity', 'Disconnect assistant']);
  });
});
