// Application shell and route table: sidebar plus content, a skip link, and the auth routes outside RequireAuth.
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { textLinkClass } from './components/TextLink';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useAuth } from './auth/AuthContext';
import type { AccountRecord } from './auth/types';
import { apiRequest } from './api/client';
import { RequireAuth } from './auth/RequireAuth';
import { AppToastRegion } from './components/AppToastRegion';
import { AssistantConsentHost } from './components/AssistantConsentHost';
import { AssistantSessionBadge } from './components/AssistantSessionBadge';
import { AssistantStatusAnnouncer } from './components/AssistantStatusAnnouncer';
import { BetaFeatureGate } from './components/BetaFeatureGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FirstRunDemoModal } from './components/FirstRunDemoModal';
import {
  HouseholdReadyBanner,
  bannerPendingKey,
  shouldShowReadyBanner,
} from './components/HouseholdReadyBanner';
import { VersionBanner } from './components/VersionBanner';
import { notifyWorkspaceChanged } from './lib/workspace-events';
import { hasPrimaryMemberSeeded, markPrimaryMemberSeeded } from './lib/first-run-seed-flag';
import {
  fetchRecordOnce,
  primaryMemberProfileFromRecord,
  seedPrimaryMemberOnce,
} from './lib/first-run-seed';
import { MonteCarloProvider } from './monte-carlo/MonteCarloProvider';
import { MonteCarloProgressChip } from './monte-carlo/MonteCarloProgressChip';
import { Sidebar } from './layout/Sidebar';
import { MobileNavDrawer } from './components/MobileNavDrawer';
import { useSync } from './sync/SyncContext';
import { listAggregates } from './db/store';
import { ensureBaseScenario } from './lib/scenario-bootstrap';
import {
  backfillSeededMedicalFlag,
  ensureDefaultExpenseCategories,
} from './lib/expense-categories-bootstrap';
import { reconcileScenarios } from './lib/scenario-mutations';
import type { ScenarioAggregate } from './lib/scenario-resolution';

// Lazy route components (./app-lazy-routes): one chunk per page, the Suspense fallback covers the load gap.
import {
  LoginPage,
  SignupPage,
  VerifyEmailPage,
  ApproveSignupPage,
  DeclineSignupPage,
  ChangeEmailConfirmPage,
  RequestPasswordResetPage,
  ResetPasswordPage,
  FactorUndoPage,
  DashboardPage,
  PreferencesPage,
  SecurityPage,
  WorkspacePage,
  HouseholdPage,
  AccountsPage,
  AccountBalancesPage,
  AccountBalancesListPage,
  AccountContributionsPage,
  SocialSecurityPage,
  ScenariosPage,
  ScenarioDetailPage,
  ScenarioExpenseOverridesPage,
  ScenarioIncomeOverridesPage,
  ScenarioContributionsPage,
  ScenarioReturnsPage,
  ScenarioInflationPage,
  ScenarioWithdrawalStrategyPage,
  ScenarioRothConversionsPage,
  ScenarioQcdPage,
  ScenarioFloorsPage,
  BalanceProjectionPage,
  WithdrawalGuidancePage,
  GuardrailsPage,
  ExpenseCategoriesPage,
  ExpensesPage,
  IncomePage,
  IncomeFormPage,
  ExpenseFormPage,
  ScenarioAssetMixPage,
  SsOptimizerPage,
  RothBETRPage,
  ReportPage,
  WhatsNewPage,
} from './app-lazy-routes';

const MAIN_CONTENT_CLASS = 'mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8';

const RouteFallback: React.FC = () => (
  <main className={MAIN_CONTENT_CLASS} aria-busy="true">
    <p>Loading…</p>
  </main>
);

// A failed setup-status probe falls through to /login, which links to sign-up.
const RootRedirect: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [hasUsers, setHasUsers] = useState<boolean | null>(null);

  useEffect(() => {
    if (isAuthenticated) return;
    let cancelled = false;
    apiRequest<{ hasUsers: boolean }>('/api/v1/auth/setup-status', { auth: false })
      .then((r) => {
        if (!cancelled) setHasUsers(r.hasUsers);
      })
      .catch(() => {
        if (!cancelled) setHasUsers(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
  if (hasUsers === null) {
    return (
      <main className={MAIN_CONTENT_CLASS} aria-busy="true">
        <p>Loading…</p>
      </main>
    );
  }
  return <Navigate to={hasUsers ? '/login' : '/signup'} replace />;
};

export const App: React.FC = () => {
  const { isBooting } = useAuth();

  if (isBooting) {
    return (
      <main className={MAIN_CONTENT_CLASS} aria-busy="true">
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <>
      {/* Sibling of <Routes>, outside Suspense: a lazy-chunk load must not hide a showing notice.
          Not rendered while booting: the only request then is the refresh, which raises no wait notice. */}
      <AppToastRegion />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/auth/verify-email" element={<VerifyEmailPage />} />
          <Route path="/auth/approve-signup" element={<ApproveSignupPage />} />
          <Route path="/auth/decline-signup" element={<DeclineSignupPage />} />
          <Route path="/auth/change-email/confirm" element={<ChangeEmailConfirmPage />} />
          <Route path="/auth/request-password-reset" element={<RequestPasswordResetPage />} />
          <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
          {/* Reached from a mail link, usually signed out everywhere, so outside RequireAuth. */}
          <Route path="/auth/factor-undo" element={<FactorUndoPage />} />
          <Route path="/" element={<RootRedirect />} />
          <Route
            path="*"
            element={
              <RequireAuth>
                <ErrorBoundary>
                  <AppShell />
                </ErrorBoundary>
              </RequireAuth>
            }
          />
        </Routes>
      </Suspense>
    </>
  );
};

/** The authenticated shell: sidebar plus routed content. */
export const AppShell: React.FC = () => {
  const { logout, householdId, me, fetchAccountRecord } = useAuth();
  const { state: syncState, notifyPending, runDestructive } = useSync();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [firstRunModalOpen, setFirstRunModalOpen] = useState(false);
  const [bannerVisible, setBannerVisible] = useState(false);
  const firstRunCheckedRef = useRef(false);
  // One in-flight `GET /auth/me` shared by every run of the first-run effect (StrictMode double mount, token refresh).
  const accountRecordRef = useRef<Promise<AccountRecord> | null>(null);
  const scenarioBootstrapCheckedRef = useRef(false);

  // Narrowed once into a primitive: a bare `syncState.lastSyncedAt` in a dep array does not type-check, and depending
  // on `kind` alone missed the null-to-timestamp transition (the first-login prompt only appeared after a refresh).
  const syncedAt = syncState.kind === 'synced' ? syncState.lastSyncedAt : null;

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // First-login prompt: once a real server round-trip completed (`synced` with non-null lastSyncedAt), an empty local
  // household means a first session on this browser. Seed the primary member from `GET /auth/me` when it carries name
  // and birthdate, else offer the demo dataset. The lastSyncedAt guard matters: the provider seeds `kind: 'synced'`
  // before initialSync fires, and opening the modal mid-bootstrap would create duplicate demo aggregates.
  // `firstRunCheckedRef` latches on a terminal outcome only; a failed account fetch re-runs at the next natural re-run.
  useEffect(() => {
    if (firstRunCheckedRef.current) return;
    if (!householdId || !me) return;
    // Seeded on a prior mount and the banner not dismissed: reshow it; do not re-seed or open the modal.
    if (shouldShowReadyBanner(householdId)) {
      firstRunCheckedRef.current = true;
      markPrimaryMemberSeeded(householdId);
      setBannerVisible(true);
      return;
    }
    if (!syncedAt) return;
    let cancelled = false;
    (async () => {
      try {
        const members = await listAggregates('householdMember');
        if (cancelled) return;
        if (members.length > 0) {
          markPrimaryMemberSeeded(householdId);
          firstRunCheckedRef.current = true;
          return;
        }
        // `suppressDemoModal` is set before a "Delete workspace data" reset's hard reload: the user chose an empty
        // workspace, so skip the demo offer and seeding. Consume it once and write the seeded flag so the wipe sticks.
        // Gated here, not in FirstRunDemoModal, so a mounted-but-hidden modal can never resurface.
        if (sessionStorage.getItem('suppressDemoModal')) {
          sessionStorage.removeItem('suppressDemoModal');
          markPrimaryMemberSeeded(householdId);
          firstRunCheckedRef.current = true;
          return;
        }
        // Zero members but this browser already saw the workspace populated (or
        // queued the seed): a wipe, not a new workspace. Prompt, no request.
        if (hasPrimaryMemberSeeded(householdId)) {
          firstRunCheckedRef.current = true;
          setFirstRunModalOpen(true);
          return;
        }
        // Brand-new workspace. A failed fetch is not latched, so a later run retries.
        let record: AccountRecord;
        try {
          record = await fetchRecordOnce(accountRecordRef, () =>
            fetchAccountRecord({ raiseWaitNotice: false }),
          );
        } catch (e) {
          console.warn('[first-run] account record unavailable; will retry', e);
          return;
        }
        if (cancelled) return;
        firstRunCheckedRef.current = true;
        const profile = primaryMemberProfileFromRecord(record);
        if (!profile) {
          // Old account / API-direct signup without the three fields.
          setFirstRunModalOpen(true);
          return;
        }
        // Another tab can finish its own seed while the record was in flight, so
        // the helper re-checks the store and flag under a cross-tab lock before
        // creating anything (and writes the flag before the queue call).
        const seed = await seedPrimaryMemberOnce(householdId, me.email, profile);
        if (seed === 'already-populated') {
          markPrimaryMemberSeeded(householdId);
          return;
        }
        if (seed === 'already-seeded') {
          if (!cancelled) setFirstRunModalOpen(true);
          return;
        }
        if (cancelled) return;
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(bannerPendingKey(householdId), '1');
        }
        setBannerVisible(true);
        // Notify mounted routes so they re-read IDB after the seed; before notifyPending so re-reads see the new
        // member.
        notifyWorkspaceChanged();
        notifyPending();
      } catch (e) {
        // Latch to avoid retrying against a bad store; fall back to the demo modal so the user is never stranded.
        firstRunCheckedRef.current = true;
        console.warn('[first-run] primary-member seed failed', e);
        if (!cancelled) setFirstRunModalOpen(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [householdId, me, syncedAt, notifyPending, fetchAccountRecord]);

  // After the first real sync round-trip: ensure a base scenario exists, then reconcile any interrupted promotion.
  useEffect(() => {
    if (scenarioBootstrapCheckedRef.current) return;
    if (!householdId) return;
    if (!syncedAt) return;
    let cancelled = false;
    (async () => {
      try {
        // Inside the sync fence: a background `pull` between the tombstone read and the flush can lift the tombstone's
        // version, stranding the queued mutation at a stale `expectedVersion` (one `failed-conflict` row, badge stuck
        // on "Refresh needed"). `notifyPending()` flushes after the fence clears because it needs the mutex.
        await runDestructive(async () => {
          await ensureBaseScenario(householdId);
          await ensureDefaultExpenseCategories(householdId);
          // Idempotent and tombstone-safe: gives a pre-existing seeded `cat-medical` row the medical flag.
          await backfillSeededMedicalFlag(householdId);
          if (cancelled) return;
          const scenarios = (await listAggregates('scenario')) as ScenarioAggregate[];
          await reconcileScenarios(scenarios, householdId);
        });
        if (cancelled) return;
        scenarioBootstrapCheckedRef.current = true;
        notifyPending();
      } catch (e) {
        console.warn('[scenarios] bootstrap or reconciliation failed', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [householdId, syncedAt, notifyPending, runDestructive]);

  const handleSignOut = useCallback(async () => {
    await logout();
    navigate('/login');
  }, [logout, navigate]);

  return (
    <MonteCarloProvider>
      {/* First focusable element (WCAG 2.4.1). Revealed instantly and fixed-positioned on focus, so it cannot
          slide in over the page mid-edit. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-ink focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>
      {/* Desktop: static <Sidebar>. Mobile: React Aria <MobileNavDrawer> (focus trap, Esc, scrim, scroll-lock, focus
          restore). */}
      {/* `overflow-x-clip` contains a document-level horizontal scrollbar that appeared with body portals and wide
          fluid descendants (origin not isolated). */}
      <div className="flex min-h-screen overflow-x-clip">
        <Sidebar
          onItemClick={() => setSidebarOpen(false)}
          onSignOut={handleSignOut}
        />
        <MobileNavDrawer
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        >
          <Sidebar
            drawer
            onItemClick={() => setSidebarOpen(false)}
            onSignOut={handleSignOut}
          />
        </MobileNavDrawer>
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface-raised px-4 py-2.5 lg:hidden"
            role="banner"
          >
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-ink outline-none hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((v) => !v)}
            >
              <MenuIcon />
              <span>Menu</span>
            </button>
            <AssistantSessionBadge variant="banner" />
            <div className="flex-1" />
            <MonteCarloProgressChip />
          </div>
          <main id="main" className={`${MAIN_CONTENT_CLASS} flex-1`} role="main">
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/report" element={<ReportPage />} />
                <Route path="/whats-new" element={<WhatsNewPage />} />

                <Route path="/profile" element={<PreferencesPage />} />
                <Route path="/security" element={<SecurityPage />} />
                <Route path="/workspace" element={<WorkspacePage />} />
                <Route path="/household" element={<HouseholdPage />} />
                <Route path="/account-balances" element={<AccountBalancesListPage />} />
                <Route path="/account-contributions" element={<AccountContributionsPage />} />
                <Route path="/accounts" element={<AccountsPage />} />
                <Route path="/accounts/:id/balances" element={<AccountBalancesPage />} />
                <Route path="/social-security" element={<SocialSecurityPage />} />
                <Route path="/optimizer" element={<SsOptimizerPage />} />
                <Route path="/roth-optimizer" element={<RothBETRPage />} />
                <Route path="/scenarios" element={<ScenariosPage />} />
                <Route path="/scenarios/:id" element={<ScenarioDetailPage />} />
                <Route
                  path="/scenarios/:id/expenses"
                  element={<ScenarioExpenseOverridesPage />}
                />
                <Route
                  path="/scenarios/:id/income"
                  element={<ScenarioIncomeOverridesPage />}
                />
                <Route
                  path="/scenarios/:id/contributions"
                  element={<ScenarioContributionsPage />}
                />
                <Route
                  path="/scenarios/:id/returns"
                  element={<ScenarioReturnsPage />}
                />
                <Route
                  path="/scenarios/:id/inflation"
                  element={<ScenarioInflationPage />}
                />
                <Route
                  path="/scenarios/:id/withdrawal-strategy"
                  element={<ScenarioWithdrawalStrategyPage />}
                />
                <Route
                  path="/scenarios/:id/roth-conversions"
                  element={<ScenarioRothConversionsPage />}
                />
                <Route
                  path="/scenarios/:id/qcd"
                  element={<ScenarioQcdPage />}
                />
                <Route
                  path="/scenarios/:id/floors"
                  element={<ScenarioFloorsPage />}
                />
                <Route path="/balance-projection" element={<BalanceProjectionPage />} />
                {/* Beta pages: the gate shows a "turn it on in Preferences" notice while the feature is hidden. */}
                <Route
                  path="/withdrawal-guidance"
                  element={
                    <BetaFeatureGate feature="projected-withdrawals">
                      <WithdrawalGuidancePage />
                    </BetaFeatureGate>
                  }
                />
                <Route
                  path="/guardrails"
                  element={
                    <BetaFeatureGate feature="guardrails">
                      <GuardrailsPage />
                    </BetaFeatureGate>
                  }
                />
                <Route
                  path="/projections/monte-carlo"
                  element={<Navigate to="/balance-projection" replace />}
                />
                <Route
                  path="/scenarios/:id/asset-mix"
                  element={<ScenarioAssetMixPage />}
                />
                <Route path="/expense-categories" element={<ExpenseCategoriesPage />} />
                <Route path="/expenses" element={<ExpensesPage />} />
                <Route path="/expenses/new" element={<ExpenseFormPage />} />
                <Route path="/expenses/scenario-entry" element={<ExpenseFormPage />} />
                <Route path="/expenses/:id/edit" element={<ExpenseFormPage />} />
                <Route path="/income" element={<IncomePage />} />
                <Route path="/income/new" element={<IncomeFormPage />} />
                <Route path="/income/scenario-entry" element={<IncomeFormPage />} />
                <Route path="/income/:id/edit" element={<IncomeFormPage />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
      <VersionBanner />
      {/* Here, not on Settings, so it opens on whatever route the person is on when the bridge proves itself. */}
      <AssistantConsentHost />
      {/* The one screen-reader announcement for the assistant session (the badges above exist twice). */}
      <AssistantStatusAnnouncer />
      {householdId && me && bannerVisible && (
        <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-2xl p-4">
          <HouseholdReadyBanner
            householdId={householdId}
            email={me.email}
            displayName={me.displayName || me.email}
            onDismiss={() => {
              setBannerVisible(false);
              // Demo load (when used) queued aggregates; nudge a sync.
              notifyPending();
            }}
          />
        </div>
      )}
      {householdId && me && (
        <FirstRunDemoModal
          open={firstRunModalOpen}
          householdId={householdId}
          email={me.email}
          displayName={me.displayName || me.email}
          onLoaded={() => {
            setFirstRunModalOpen(false);
            notifyPending();
            // Hard reload: multi-page subscriptions to one workspaceChanged event missed edges (stale sidebar picker
            // and projections).
            window.location.reload();
          }}
          onSkip={() => setFirstRunModalOpen(false)}
        />
      )}
    </MonteCarloProvider>
  );
};

const MenuIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="20" y2="17" />
  </svg>
);

const NotFound: React.FC = () => (
  <>
    <h1 className="mt-2 mb-3 text-2xl font-semibold text-ink">
      404: Not found
    </h1>
    <p className="text-muted">
      The page you're looking for doesn't exist.
    </p>
    <Link to="/dashboard" className={textLinkClass}>
      Go to dashboard
    </Link>
  </>
);
