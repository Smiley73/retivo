/**
 * Dashboard — the household's landing page (Graphite Spectrum mock).
 *
 * Shows where the household stands today and where the active-scenario
 * plan is heading, top to bottom:
 *
 *   1. A page header.
 *   2. The plan-health block (`DashboardPlanHealthBlock`) — a hero
 *      plan-success tile beside a Typical / Pessimistic ending-balance +
 *      depletion-year grid. A page-level `McProgressBar` sits above it
 *      while a Monte Carlo run is in flight; a cache hit never shows it.
 *   3. The point-of-use simulation disclaimer.
 *   4. A three-up row of cards: the small "Plan basics" card
 *      (`DashboardPlanBasicsCard`), the Portfolio allocation card, and
 *      the By-account-type card, side by side on wide viewports and
 *      stacked on narrow ones.
 *   5. A full-width "Balance projection" chart card with an "Open full
 *      projection →" link, embedding the same `<ProjectionChart>` the
 *      Balance Projection page renders.
 *
 * Every financial number reuses the shared projection view-model for the
 * active scenario (see `useDashboardProjection`) — the dashboard never
 * re-implements or approximates the engine. The cheap aggregates (net
 * worth, allocation) paint immediately; the plan-success % + the
 * MC-derived grid fill in when the Monte-Carlo worker settles and show
 * the projection page's "—" loading affordance until then. The plan
 * basics card renders even on a config error (its net worth is a
 * deterministic figure, not view-model-derived); only the plan-health
 * block is withheld then.
 *
 * Read-only. When the household has no accounts the page falls back to
 * the set-up prompt rather than rendering empty KPIs.
 */
import React from 'react';
import { textLinkClass } from '../components/TextLink';
import { Link } from 'react-router';
import { Card } from '../components/Card';
import { Skeleton, SkeletonText } from '../components/Skeleton';
import { PageHeader } from '../components/PageHeader';
import { Alert } from '../components/Alert';
import {
  ProjectionChart,
  type ProjectionMcOverlay,
  type ProjectionMethod,
} from '../components/ProjectionChart';
import { InlineDisclaimerCard } from '../components/InlineDisclaimerCard';
import { McProgressBar } from '../components/McProgressBar';
import { useDashboardProjection } from './use-dashboard-projection';
import { DashboardAllocationCard } from './DashboardAllocationCard';
import { DashboardByAccountTypeCard } from './DashboardByAccountTypeCard';
import { DashboardPlanHealthBlock } from './DashboardPlanHealthBlock';
import { DashboardPlanBasicsCard } from './DashboardPlanBasicsCard';

const BALANCE_PROJECTION_ROUTE = '/balance-projection';

const PROJECTION_LINK_CLASS = `${textLinkClass} inline-flex items-center gap-1 text-sm font-semibold`;

// Shared card surface (matches the plan-health, plan-basics + allocation
// cards) so the first-paint skeleton has the same shape as the real
// content it stands in for.
const CARD_SURFACE_CLASS =
  'rounded-2xl border border-line bg-surface-raised p-6 shadow-sm';

/**
 * First-paint loading shell. Until the IndexedDB read settles (`ready`
 * is false) the real figures don't exist yet — without this the page
 * would render the populated branch with an empty chart and "—" cards,
 * so a returning user with a funded plan briefly sees what looks like an
 * empty / broken dashboard. Render a dimmed, layout-shaped skeleton
 * instead (the shared `Skeleton` primitive) in the same five-section
 * order as the real content, with a `role="status"` announcement so the
 * first frame reads "loading", not "empty". The visual shells are
 * `aria-hidden`; the sr-only line carries the state for assistive tech.
 */
function DashboardLoading(): React.ReactElement {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading your dashboard…</span>
      {/* Plan-health block shell: heading, hero number, grid. */}
      <section className={`mb-4 ${CARD_SURFACE_CLASS}`} aria-hidden="true">
        <Skeleton className="mb-4 h-5 w-44" />
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-10 w-24" />
            <Skeleton className="h-4 w-36" />
          </div>
          <div className="flex-1">
            <SkeletonText lines={3} />
          </div>
        </div>
      </section>
      {/* Disclaimer shell: one short line. */}
      <div className="mb-4" aria-hidden="true">
        <Skeleton className="h-4 w-full" />
      </div>
      {/* Three-up card row shell. */}
      <div
        className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3"
        aria-hidden="true"
      >
        <div className={`flex flex-col gap-4 ${CARD_SURFACE_CLASS}`}>
          <Skeleton className="h-5 w-32" />
          <SkeletonText lines={3} />
        </div>
        <div className={`flex flex-col gap-4 ${CARD_SURFACE_CLASS}`}>
          <Skeleton className="h-5 w-40" />
          <SkeletonText lines={2} />
        </div>
        <div className={`flex flex-col gap-4 ${CARD_SURFACE_CLASS}`}>
          <Skeleton className="h-5 w-40" />
          <SkeletonText lines={2} />
        </div>
      </div>
      {/* Chart shell. */}
      <section className={CARD_SURFACE_CLASS} aria-hidden="true">
        <Skeleton className="mb-4 h-5 w-40" />
        <Skeleton className="h-80 w-full" />
      </section>
    </div>
  );
}

export const DashboardPage: React.FC = () => {
  const {
    ready,
    error,
    configError,
    accountCount,
    netWorth,
    allocation,
    allocationByType,
    projectedAtRetirement,
    vm,
  } = useDashboardProjection();

  const hasAccounts = accountCount > 0;
  // The TWR/Planned fallback the view-model owns determines which
  // deterministic series the chart draws; `enabledCalculatedMethods`
  // gates the TWR line on real contributing accounts.
  const enabledMethods: ReadonlySet<Exclude<ProjectionMethod, 'planned'>> =
    vm?.enabledCalculatedMethods ?? new Set();

  // The dashboard chart is always the deterministic Planned/TWR line. When a
  // FRESH Monte-Carlo result exists for the active scenario, overlay two
  // extra solid lines — MC Typical (P50) + MC Pessimistic (P25) — on top of
  // it (no fan bands). While the run is stale (scenario just changed) or
  // still computing, omit the overlay; the deterministic line stands alone.
  // The dashboard basis is today's-dollars (real), so read `percentilesReal`.
  const mcResult =
    vm && !vm.stressVm.isStale && !vm.stressVm.isRunning
      ? vm.stressVm.result
      : null;
  const mcOverlay: ProjectionMcOverlay | null = mcResult
    ? {
        firstYear: mcResult.firstYear,
        typical: mcResult.percentilesReal.p50,
        pessimistic: mcResult.percentilesReal.p25,
      }
    : null;

  return (
    <section aria-labelledby="dashboard-heading">
      <PageHeader
        title={<span id="dashboard-heading">Dashboard</span>}
        subtitle="Where the household stands today and where the plan is heading."
      />

      {error && <Alert tone="error">{error}</Alert>}
      {configError && <Alert tone="warning">{configError}</Alert>}

      {!ready ? (
        <DashboardLoading />
      ) : !hasAccounts ? (
        <Card>
          <p className="m-0 text-muted">
            No accounts yet.{' '}
            <Link to="/household" className={textLinkClass}>
              Set up your household
            </Link>{' '}
            or{' '}
            <Link to="/accounts?new" className={textLinkClass}>
              add your first account
            </Link>
            .
          </p>
        </Card>
      ) : (
        <>
          {/* Page-level progress indicator: the only Monte-Carlo
              "running" affordance on this page — no Cancel button, no error
              toast. A cache hit never sets `status` to 'running', so no bar
              appears on a cache hit. */}
          {vm && vm.stressVm.isRunning && (
            <div
              className="mb-4 flex flex-wrap items-center gap-3"
              role="status"
              aria-live="polite"
            >
              <McProgressBar
                done={vm.stressVm.progressDone}
                total={vm.stressVm.progressTotal}
              />
            </div>
          )}

          {/* The block's own root is `m-0`; the page owns the band spacing
              (same `mb-4` as every other band here and as the skeleton's
              block shell) so the block and the disclaimer card don't sit
              flush. */}
          {vm && (
            <div className="mb-4">
              <DashboardPlanHealthBlock vm={vm.stressVm} />
            </div>
          )}

          {/* Point-of-use disclaimer: the dashboard's most
              individualized figure. The shared card supplies the canonical
              lead + closing; the scope slot below carries the
              plan-health-specific middle. */}
          <InlineDisclaimerCard
            ariaLabel="Retirement readiness disclaimer"
            className="mb-4"
          >
            {'The percentage shows how often simulated markets sustained this plan across many randomized runs — a statistical illustration, not advice or a promise about your future. Actual results will differ.'}
          </InlineDisclaimerCard>

          {/* Three-up row: the small plan-basics card, Portfolio allocation
              and By account type render as direct siblings, stacking to a
              single column on narrow viewports. Default `stretch` alignment
              so the three cards share one height across the row. */}
          <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <DashboardPlanBasicsCard
              netWorth={netWorth}
              projectedAtRetirement={projectedAtRetirement}
              retirementYear={vm?.primaryRetirementYear ?? null}
            />
            <DashboardAllocationCard allocation={allocation} />
            <DashboardByAccountTypeCard allocation={allocationByType} />
          </div>

          <section
            className="mb-4 flex flex-col gap-3 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm"
            aria-labelledby="dashboard-projection-heading"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2
                id="dashboard-projection-heading"
                className="m-0 text-lg font-semibold text-ink"
              >
                Balance projection
              </h2>
              <Link
                to={BALANCE_PROJECTION_ROUTE}
                className={PROJECTION_LINK_CLASS}
              >
                Open full projection →
              </Link>
            </div>
            <ProjectionChart
              rows={vm ? [...vm.displayRows] : []}
              enabledCalculatedMethods={new Set(enabledMethods)}
              retirementMarkers={vm ? [...vm.retirementMarkers] : []}
              lifeExpectancyMarkers={
                vm ? [...vm.expenseChartMarkers] : []
              }
              tooltipMembers={vm ? [...vm.tooltipMembers] : []}
              mcOverlay={mcOverlay}
            />
          </section>
        </>
      )}
    </section>
  );
};
