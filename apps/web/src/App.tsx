/**
 * Application shell + route table.
 *
 * Layout:
 * - Left-hand sidebar (collapsible sections) + main content area.
 * - On narrow viewports the sidebar collapses behind a toggle button in a
 *   secondary top bar. A backdrop scrim dismisses it on outside click.
 * - A skip link jumps keyboard users straight to main content
 *   (WCAG 2.2 AA - bypass blocks).
 *
 * Auth flow:
 *   /signup            → email + password → verification mail
 *   /auth/verify-email → consumes the verification token
 *   /login             → email + password (verified accounts only)
 *
 * The legacy setup wizard is gone — any user can sign up; there's no
 * "first user becomes admin" flow because there are no roles.
 */
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { textLinkClass } from './components/TextLink';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useAuth, clearSignupProfile } from './auth/AuthContext';
import type { AccountRecord } from './auth/types';
import { apiRequest } from './api/client';
import { RequireAuth } from './auth/RequireAuth';
import { AppToastRegion } from './components/AppToastRegion';
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
  queuePrimaryMember,
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

// Route components are lazy-loaded so each page lands in its own chunk
// (declarations in ./app-lazy-routes — extracted to keep this file
// under the shape limit). Cuts the initial
// bundle to shell + current route; ChunkLoadError handling lives in
// ErrorBoundary, the Suspense fallback below covers the in-flight gap.
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

// Centered main-column content frame (legacy `.main__content`): a
// readable max-width column with responsive horizontal padding.
const MAIN_CONTENT_CLASS = 'mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8';

const RouteFallback: React.FC = () => (
  <main className={MAIN_CONTENT_CLASS} aria-busy="true">
    <p>Loading…</p>
  </main>
);

/**
 * Root-path redirect. Authenticated -> /dashboard. Otherwise probes
 * /auth/setup-status: empty backend -> /signup (first-run UX), else
 * /login. Network failure falls through to /login (fail-safe — login
 * page exposes a Sign up footer link).
 */
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
      {/* The one shared toast region,
          mounted as a sibling of the routed subtree — not inside AppShell —
          so every route below, including the signed-out auth routes, has a
          toast surface. A sibling of <Routes>, outside the Suspense
          boundary: a lazy-chunk load must not hide an already-showing
          notice behind the route fallback. Deliberately does NOT render
          during the isBooting early return above — the only request in
          flight there is POST /auth/refresh, which never raises a wait notice. */}
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
          {/* Factor-change undo: reached from a mail
              link, usually signed out everywhere — outside RequireAuth like
              the other unauthenticated auth pages. */}
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

/**
 * The authenticated shell: sidebar + routed content. Mobile state is local
 * since nothing else needs to know whether the sidebar is open.
 *
 * Exported for the first-run/bootstrap effect tests (App.test.tsx); the app
 * itself only ever renders it through the `*` route in `App` above.
 */
export const AppShell: React.FC = () => {
  const { logout, householdId, me, fetchAccountRecord } = useAuth();
  const { state: syncState, notifyPending, runDestructive } = useSync();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [firstRunModalOpen, setFirstRunModalOpen] = useState(false);
  const [bannerVisible, setBannerVisible] = useState(false);
  const firstRunCheckedRef = useRef(false);
  // The one in-flight `GET /auth/me` for the first-run check, shared by every
  // run of the effect below (StrictMode double mount, token refresh mid-request).
  const accountRecordRef = useRef<Promise<AccountRecord> | null>(null);
  const scenarioBootstrapCheckedRef = useRef(false); // ensures base-scenario auto-create + reconcile run once per shell mount.

  // `lastSyncedAt` lives only on the `synced` variant of the SyncBadgeState
  // union, so narrow it once into a stable primitive. Both effects below guard
  // on it AND list it as a dependency: a bare `syncState.lastSyncedAt` in a dep
  // array does not type-check (TS2339 off the non-`synced` variants), and
  // depending on `syncState.kind` alone missed the null→timestamp transition
  // that completes the first real round-trip while `kind` stays `synced` — the
  // bug where the first-login demo prompt only appeared after a manual refresh.
  const syncedAt = syncState.kind === 'synced' ? syncState.lastSyncedAt : null;

  // Close the mobile sidebar on navigation so tapping a link doesn't leave
  // the drawer floating over the page.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // First-login demo prompt: once sync has settled in `synced` **and**
  // lastSyncedAt is non-null (= a real server round-trip completed),
  // check whether the local IndexedDB still has no household members.
  // If so, this is the user's first session on this browser — seed the
  // primary member from the account record (`GET /auth/me`) when it carries
  // first name, last name and birthdate, else offer the demo dataset.
  // Skipping it leaves the Household welcome card as the fallback path.
  //
  // The `lastSyncedAt` guard prevents a race where the SyncProvider's
  // initial `useState` seeds `kind: 'synced'` before `initialSync`
  // fires — without it the modal could open while bootstrap is still
  // in flight, re-creating all demo aggregates under new UUIDs and
  // producing duplicates.
  //
  // `firstRunCheckedRef` is latched only on a terminal outcome. A failed
  // account fetch is not one: nothing is shown or written and the check runs
  // again at the effect's next natural re-run (token refresh, sync, next open).
  useEffect(() => {
    if (firstRunCheckedRef.current) return;
    if (!householdId || !me) return;
    // Reload-visibility check (runs before the zero-members guard): the
    // primary member was already seeded on a prior mount (pending key written
    // only after a successful queueLocalMutation) and the user hasn't
    // dismissed the banner → just reshow it, do NOT re-seed or open the modal.
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
          // Stale one-shot profile key cleanup: always clear the signup
          // handoff (firstName/lastName/birthdate) when the user already
          // has household members — it was either already consumed on a
          // prior login or arrived for an account that doesn't need seeding.
          // Prevents indefinite PII persistence in localStorage.
          markPrimaryMemberSeeded(householdId);
          clearSignupProfile(me.id);
          firstRunCheckedRef.current = true;
          return;
        }
        // Post-reset suppression: a deliberate "Delete workspace data" reset
        // (Workspace page) leaves the workspace with zero members — the exact
        // trigger this effect watches for — but the user just chose an empty
        // workspace, so neither re-offering the demo dataset nor re-seeding a
        // primary member is wanted. The reset handler sets `suppressDemoModal`
        // in sessionStorage before its hard reload; consume it here (clear +
        // skip) so the offer fires once at most and never resurfaces on a later
        // reload. Gating at the source (App, not FirstRunDemoModal) prevents
        // the shell from ever setting firstRunModalOpen=true — a
        // mounted-but-hidden modal could otherwise resurface. A consumed flag
        // proves a deliberate wipe, so the per-browser seeded flag is written
        // too: the wipe sticks on later opens.
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
        // Zero members, never seeded here: a brand-new workspace. A failed
        // fetch is handled here and never reaches the catch below (which
        // latches and prompts) — it is not latched, so a later run retries.
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
        // Flag before the queue call: a throw inside it (which may have partly
        // written) must never lead to a second seed.
        markPrimaryMemberSeeded(householdId);
        await queuePrimaryMember(householdId, me.email, profile);
        if (cancelled) return;
        // Seed succeeded: consume the one-shot profile key and arm the banner
        // (pending key survives reloads until dismissed).
        clearSignupProfile(me.id);
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(bannerPendingKey(householdId), '1');
        }
        setBannerVisible(true);
        // Notify mounted routes (those subscribed to the `useAggregates` store
        // fine-signals + the coarse workspace channel) so they re-read IDB
        // after the seed — every other IDB bulk writer (demo-data-loader,
        // expense-categories-bootstrap, SyncContext) does the same. Fire
        // before notifyPending so re-reads see the new member.
        notifyWorkspaceChanged();
        notifyPending();
      } catch (e) {
        // The check failed (IDB read or the seed's write threw), so latch to
        // avoid retrying against a bad store; fall back to the demo modal so
        // the user is never stranded with neither banner nor modal.
        firstRunCheckedRef.current = true;
        console.warn('[first-run] primary-member seed failed', e);
        if (!cancelled) setFirstRunModalOpen(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [householdId, me, syncedAt, notifyPending, fetchAccountRecord]);

  // Scenarios bootstrap: after the first real sync round-trip, make
  // sure a base scenario exists, then run the reconciliation pass
  // against any state left behind by an interrupted promotion. Both
  // helpers are idempotent and safe to call repeatedly. Runs once per
  // shell mount; subsequent edits flow through the page-level reload.
  useEffect(() => {
    if (scenarioBootstrapCheckedRef.current) return;
    if (!householdId) return;
    if (!syncedAt) return;
    let cancelled = false;
    (async () => {
      try {
        // Run the re-seed inside the sync fence. ensureDefaultExpenseCategories
        // reads the tombstone set then queues `update @ tombstone.version` (or
        // `create @ 0`); a background poll `pull` interleaving between that read
        // and the flush can lift the tombstone's version, stranding the queued
        // mutation at a stale `expectedVersion` → the server rejects it →
        // exactly one `failed-conflict` row → the badge sticks on "Refresh
        // needed". This is the post-reload sibling of the reset/demo
        // enumeration race; fence the read+enqueue so the poll can't race it.
        // `notifyPending()` flushes AFTER the fence clears (it needs the mutex).
        await runDestructive(async () => {
          await ensureBaseScenario(householdId);
          await ensureDefaultExpenseCategories(householdId);
          // Flip an existing seeded `cat-medical` row that predates the
          // generic-medical-flag feature so it keeps its +2pp default on
          // deploy. Idempotent + tombstone-safe; runs inside the same fence.
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
      {/* Skip link — first focusable element (WCAG 2.4.1 bypass blocks).
          `sr-only` until focused, then revealed top-left for sighted keyboard
          users (WCAG 2.4.7 — the affordance must be visible when it has focus).
          The reveal is instant (no transition) and fixed-positioned, so it
          appears only while the link itself holds focus and cannot slide in
          over the page mid-edit (the prior transition-based reveal's bug). */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-ink focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>
      {/* App shell: flex row. Desktop renders the static <Sidebar>
          column (hidden < lg). Mobile uses the React Aria
          <MobileNavDrawer> overlay (focus trap + Esc + scrim +
          scroll-lock + focus-restore — the a11y gap the old
          CSS-transform scrim lacked). */}
      {/* Symptom: a document-level horizontal scrollbar appeared after
          the React Aria migration (body portals / wide fluid
          descendants). Exact origin not isolated; `overflow-x-clip`
          contains it at the shell. Inner scrollers (`<TableScroll>`
          `overflow-x:auto`) and `fixed` modals/drawers are unaffected. */}
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
                {/* Beta pages: the gate renders a "turn it on in Preferences"
                    notice while the feature is hidden (lib/feature-flags.ts). */}
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
            // Hard reload so every mounted page re-reads aggregates the
            // loader just queued — multi-page subscriptions to a
            // single workspaceChanged event were missing edges in
            // practice (sidebar picker not refreshing, projection
            // page sticking on stale rows). Reloading is heavy-handed
            // but it's a one-shot, user-initiated action.
            window.location.reload();
          }}
          onSkip={() => setFirstRunModalOpen(false)}
        />
      )}
    </MonteCarloProvider>
  );
};

// `clearSignupProfile` (key `retivo:signup-profile:<userId>`) is the single
// source of truth in AuthContext (imported above) — AuthContext still writes
// the profile after a successful login; the first-run effect here only clears
// it. Nothing reads it: the primary member comes from `GET /auth/me`.

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
