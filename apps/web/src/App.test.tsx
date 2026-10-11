/**
 * AppShell — first-login bootstrap-timing tests.
 *
 * Guards the regression where the first-run demo prompt only appeared after a
 * manual refresh: on first login the sync badge reaches `kind: 'synced'` while
 * `lastSyncedAt` transitions null→timestamp (the first real server round-trip)
 * WITHOUT a `kind` change. The effects must re-run on that transition, so the
 * empty-database demo prompt fires without a reload. The companion guard
 * is that neither effect runs while `lastSyncedAt` is still null —
 * firing early would re-create demo aggregates under fresh UUIDs (duplicates).
 *
 * The heavy shell children (sidebar, drawer, Monte Carlo provider, the lazy
 * route table) are stubbed so the test exercises only the bootstrap effects.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The first-run effect reads/clears the signup-profile handoff via these
// helpers (single source of truth in AuthContext). Back them with the
// real localStorage implementation so the existing localStorage-driven test
// setup keeps working.
const SIGNUP_PROFILE_PREFIX = 'retivo:signup-profile:';
vi.mock('./auth/AuthContext', () => ({
  useAuth: vi.fn(),
  readSignupProfile: (userId: string) => {
    const raw = localStorage.getItem(`${SIGNUP_PROFILE_PREFIX}${userId}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        typeof parsed.firstName === 'string' &&
        typeof parsed.lastName === 'string' &&
        typeof parsed.birthdate === 'string'
      ) {
        return {
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          birthdate: parsed.birthdate,
        };
      }
      return null;
    } catch {
      return null;
    }
  },
  clearSignupProfile: (userId: string) => {
    localStorage.removeItem(`${SIGNUP_PROFILE_PREFIX}${userId}`);
  },
}));
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

const SIGNUP_PROFILE_KEY = 'retivo:signup-profile:u-1';
const SIGNUP_PROFILE = JSON.stringify({
  firstName: 'Jane',
  lastName: 'Smith',
  birthdate: '1980-04-15',
});

function setSync(state: SyncState, notifyPending = vi.fn()) {
  // runDestructive fences the post-reload re-seed (scenario + expense
  // categories) against the background poll; the real impl runs the callback
  // inside the sync mutex. The mock just invokes it so the bootstrap effect
  // proceeds.
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
    authMock.mockReturnValue({
      logout: vi.fn(),
      householdId: 'hh-1',
      me: { id: 'u-1', email: 'me@example.test', displayName: 'Me' },
    });
    // Empty local workspace — no household members, no scenarios.
    listAggregatesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('opens the demo prompt when lastSyncedAt flips null→timestamp with kind unchanged', async () => {
    // First render: synced but the initial round-trip has not completed.
    setSync({ kind: 'synced', lastSyncedAt: null });
    const { rerender } = renderShell();

    // Guard: nothing fires while lastSyncedAt is null, so the modal
    // stays closed and we never read the local store.
    await waitFor(() => expect(listAggregatesMock).not.toHaveBeenCalled());
    expect(screen.queryByTestId('first-run-modal')).toBeNull();

    // The first real server round-trip lands: lastSyncedAt becomes non-null
    // while kind stays 'synced'. The effect must re-run on this transition.
    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });
    rerender(shellTree());

    // Regression assertion: with the old `[…, syncState.kind]` deps this never
    // fired (kind never changed); the modal now opens on the empty database.
    expect(await screen.findByTestId('first-run-modal')).toBeInTheDocument();
    expect(listAggregatesMock).toHaveBeenCalledWith('householdMember');
  });

  it('skips the demo prompt and clears the flag when suppressDemoModal is set', async () => {
    // Post-reset state: zero members (the prompt's normal trigger) but the
    // user deliberately emptied the workspace via "Delete workspace data".
    // The reset handler set sessionStorage.suppressDemoModal before its
    // reload; the first-run effect must consume it (clear + skip).
    sessionStorage.setItem('suppressDemoModal', '1');
    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });
    renderShell();

    await waitFor(() =>
      expect(listAggregatesMock).toHaveBeenCalledWith('householdMember'),
    );
    // Modal stays closed despite the empty workspace, and the one-shot flag
    // is consumed so a later reload doesn't keep suppressing.
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
    await waitFor(() =>
      expect(sessionStorage.getItem('suppressDemoModal')).toBeNull(),
    );
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
  beforeEach(() => {
    authMock.mockReturnValue({
      logout: vi.fn(),
      householdId: 'hh-1',
      me: { id: 'u-1', email: 'me@example.test', displayName: 'Me' },
    });
    listAggregatesMock.mockResolvedValue([]);
    queueLocalMutationMock.mockResolvedValue(undefined);
    shouldShowReadyBannerMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('seeds the primary member + shows the banner (no modal) when the signup profile is present', async () => {
    localStorage.setItem(SIGNUP_PROFILE_KEY, SIGNUP_PROFILE);
    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });
    renderShell();

    await waitFor(() => expect(queueLocalMutationMock).toHaveBeenCalledTimes(1));
    expect(queueLocalMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'householdMember',
        operation: 'create',
        expectedVersion: 0,
        householdId: 'hh-1',
        payload: expect.objectContaining({
          isPrimary: true,
          firstName: 'Jane',
          lastName: 'Smith',
          birthdate: '1980-04-15',
        }),
      }),
    );
    expect(await screen.findByTestId('ready-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
    // One-shot profile key consumed; reload-banner key armed.
    expect(localStorage.getItem(SIGNUP_PROFILE_KEY)).toBeNull();
    expect(
      localStorage.getItem('retivo:household-ready-banner-pending:hh-1'),
    ).toBe('1');
  });

  it('falls back to the demo modal (no seeding) when the signup profile is absent', async () => {
    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });
    renderShell();

    await waitFor(() => expect(listAggregatesMock).toHaveBeenCalledWith('householdMember'));
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
    expect(await screen.findByTestId('first-run-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('ready-banner')).toBeNull();
  });

  it('reshows the banner on reload (pending key set, dismissed absent) without re-seeding', async () => {
    shouldShowReadyBannerMock.mockReturnValue(true);
    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });
    renderShell();

    expect(await screen.findByTestId('ready-banner')).toBeInTheDocument();
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
    // The reload path returns before the zero-members check, so the
    // householdMember store is never read (the scenarios bootstrap effect
    // still reads 'scenario' — unrelated).
    expect(listAggregatesMock).not.toHaveBeenCalledWith('householdMember');
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
  });

  it('clears the signup profile when members already exist (returning user)', async () => {
    // Returning user: a stale one-shot signup profile lingers in localStorage
    // but the workspace already has a household member, so no seeding occurs.
    localStorage.setItem(SIGNUP_PROFILE_KEY, SIGNUP_PROFILE);
    listAggregatesMock.mockResolvedValue([
      { id: 'm-1', aggregateType: 'householdMember' },
    ]);
    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });
    renderShell();

    await waitFor(() => expect(listAggregatesMock).toHaveBeenCalledWith('householdMember'));
    // Stale profile cleared (PII not persisted indefinitely)…
    await waitFor(() => expect(localStorage.getItem(SIGNUP_PROFILE_KEY)).toBeNull());
    // …and no re-seeding for the existing-members path.
    expect(queueLocalMutationMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
    expect(screen.queryByTestId('ready-banner')).toBeNull();
  });
});

describe('retired legal addresses are unknown addresses', () => {
  // The old acceptance page and the public Terms / Privacy pages are gone:
  // signed in each is the shell's not-found screen, signed out each goes to
  // /login like any unknown address — no redirect or special route. The shell
  // also never asks the network layer about legal status. Asserted at the
  // fetch boundary, so a leftover probe would fail this even if no component
  // rendered it.
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
    });
    // A returning user with data: the first-run effects settle without a modal.
    listAggregatesMock.mockResolvedValue([{ id: 'm-1', aggregateType: 'householdMember' }]);
    setSync({ kind: 'synced', lastSyncedAt: '2026-06-04T00:00:00.000Z' });

    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '404: Not found' })).toBeInTheDocument();
    // The shell ran its normal startup (scenario bootstrap) and still made no
    // legal request.
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

// Today's toast surface (VersionBanner, mounted inside AppShell) is unreachable from the
// signed-out auth routes, since AppShell only renders behind RequireAuth. The
// shared region (`AppToastRegion`) is mounted in `App`, above the routed
// subtree, specifically so a throttled request on one of these routes still
// shows the wait notice. Asserted at the ROUTE level (rendering the real
// `<App>` tree and driving a real page's submit), not by rendering
// `AppToastRegion` directly — mounting the region in the wrong place (e.g.
// back inside AppShell) is exactly the regression this guards against.
// `apiRequest` is the real, unmocked module (this file mocks `AuthContext`,
// not `api/client`), so the assertion exercises the real header-read +
// raise seam in `api/client.ts`, not a stand-in.
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

    // Blocks nothing: the form's submit control is left enabled (not
    // stuck disabled/"Sending…"), and focus never moved onto the toast.
    const submit = screen.getByRole('button', { name: 'Send reset link' });
    expect(submit).toBeEnabled();
    expect(document.activeElement).not.toBe(notice);
    expect(notice.contains(document.activeElement)).toBe(false);
  });
});
