/** Dashboard landing page: plan health, plan basics, allocation, by-account-type and a balance projection chart, all from the shared projection view model (useDashboardProjection). Read-only; with no accounts it falls back to the set-up prompt. */
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

const CARD_SURFACE_CLASS =
  'rounded-2xl border border-line bg-surface-raised p-6 shadow-sm';

// First-paint skeleton shown until the IndexedDB read settles, so a returning user doesn't briefly see an empty-looking dashboard; the shells are aria-hidden and the sr-only line carries role="status".
function DashboardLoading(): React.ReactElement {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading your dashboard…</span>
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
      <div className="mb-4" aria-hidden="true">
        <Skeleton className="h-4 w-full" />
      </div>
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
  const enabledMethods: ReadonlySet<Exclude<ProjectionMethod, 'planned'>> =
    vm?.enabledCalculatedMethods ?? new Set();

  // The Planned/TWR line always draws; a fresh MC result overlays Typical (P50) and Pessimistic (P25) lines (percentilesReal, since the basis is today's dollars), omitted while stale or computing.
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
          {/* The only MC "running" affordance on this page: no Cancel, no error toast, and no bar on a cache hit. */}
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

          {vm && (
            <div className="mb-4">
              <DashboardPlanHealthBlock vm={vm.stressVm} />
            </div>
          )}

          <InlineDisclaimerCard
            ariaLabel="Retirement readiness disclaimer"
            className="mb-4"
          >
            {'The percentage shows how often simulated markets sustained this plan across many randomized runs — a statistical illustration, not advice or a promise about your future. Actual results will differ.'}
          </InlineDisclaimerCard>

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
