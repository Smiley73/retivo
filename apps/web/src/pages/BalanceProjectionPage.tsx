/** Balance Projection page: per-account balances at each member's retirement date under the selected scenario, with a pinned controls strip and six tabbed views. */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, Tab, TabList, TabPanel, Tabs, type Key } from 'react-aria-components';
import {
  PlanStressTestStatusRow,
  PlanStressTestRecalcButton,
} from '../components/PlanStressTestSection';
import { PlanStressTestSuccessCard } from '../components/PlanStressTestCards';
import { TAB_CLASS } from '../components/tab-chrome';
import {
  CASHFLOW_GRANULARITY_STORAGE_KEY,
  INCOME_BREAKDOWN_GRANULARITY_STORAGE_KEY,
  DISPLAY_MODE_STORAGE_KEY,
  parseCashflowGranularity,
  parseDisplayMode,
  type CashflowGranularity,
  type DisplayMode,
} from '../lib/view-deflator';
import { ProjectionMethodExplainer } from '../components/ProjectionMethodExplainer';
import { pageTitleClass } from '../components/PageHeader';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { Select } from '../components/Select';
import { ShowAnotherPathButton } from '../components/ShowAnotherPathButton';
import { useFocusClearOfPinnedStrip } from '../components/use-focus-clear-of-pinned-strip';
import { type ProjectionMethod } from '../components/ProjectionChart';
import { useTheme } from '../contexts/ThemeContext';
import { btnSecondarySmClass } from './accounts-page-chrome';
import { InlineDisclaimerCard } from '../components/InlineDisclaimerCard';
import { ONE_LINE_DISCLAIMER } from '../lib/disclaimer-fragments';
import { APP_NAME_PROSE, OPEN_SOURCE_TEXT, REPO_URL } from '../lib/brand';
import { useBalanceProjectionData } from './use-balance-projection-data';
import { BalanceProjectionCbpBanner } from './balance-projection-page-cbp-banner';
import { BalanceProjectionStats } from './balance-projection-page-stats';
import { BalanceProjectionChartSection } from './balance-projection-page-chart';
import { BalanceProjectionStressCard } from './balance-projection-page-stress-card';
import { BalanceProjectionYearlySection } from './balance-projection-page-yearly';
import { BalanceProjectionYearlyBands } from './balance-projection-page-yearly-bands';
import {
  METHOD_LABELS,
  METHOD_ORDER,
  VIEW_LABELS,
  VIEW_ORDER,
  parseBalanceProjectionView,
  resolvedBasisLabel,
  type BalanceProjectionViewId,
} from './balance-projection-page-constants';
import { loadPageData, type PipelineData } from './balance-projection-page-data';
import type { McBasis } from '../lib/monte-carlo';
import { TaxIntegrationInvalidInputError } from '../lib/balance-projection-runner-tax';
import { friendlyProjectionErrorMessage } from '../lib/tax-integration';
import { buildReportTimestamp } from '../lib/report-format';
import { BalanceProjectionAccountStackSection } from './balance-projection-page-account-stack-section';
import { BalanceProjectionCharts } from './balance-projection-page-charts';
import { BalanceProjectionSwrSection } from './balance-projection-page-swr';
import { BalanceProjectionCompareSection } from './balance-projection-page-compare';
import { useCompareWithAnchor } from './use-balance-projection-compare';
import { useBalanceProjectionViewModel } from './use-balance-projection-view-model';
import {
  BalanceProjectionErrorState,
  BalanceProjectionLoadingState,
  BalanceProjectionNoRetirementAgeState,
  BalanceProjectionNoAccountState,
  BalanceProjectionNoHistoryState,
} from './balance-projection-page-empty-states';

export const BalanceProjectionPage: React.FC = () => {
  const { resolvedTheme } = useTheme();
  const dataLoad = useBalanceProjectionData();
  const {
    scenarios: canonicalScenarios,
    selectedScenarioId,
    members: canonicalMembers,
    accounts: canonicalAccounts,
    balances: canonicalBalances,
    expenses: canonicalExpenses,
    expenseCategories: canonicalExpenseCategories,
    incomeStreams: canonicalIncome,
    ssBenefits,
    ready,
    error,
  } = dataLoad;

  const [data, setData] = useState<PipelineData | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  // activeMethod is the deterministic series the per-account tables and balance chart render; the Basis select drives it and the view model may re-point it (TWR unavailable falls back to planned).
  const [activeMethod, setActiveMethod] = useState<ProjectionMethod>('twr');
  // activeMcBasis is the Monte Carlo tier, or null for a deterministic basis; activeMethod is held for the deterministic-only surfaces.
  const [activeMcBasis, setActiveMcBasis] = useState<McBasis | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => {
    if (typeof window === 'undefined') return 'today';
    return parseDisplayMode(window.localStorage.getItem(DISPLAY_MODE_STORAGE_KEY));
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(DISPLAY_MODE_STORAGE_KEY, displayMode);
  }, [displayMode]);
  const [generatedAt] = useState(() => new Date());
  const [cashflowGranularity, setCashflowGranularity] =
    useState<CashflowGranularity>(() => {
      if (typeof window === 'undefined') return 'yearly';
      return parseCashflowGranularity(
        window.localStorage.getItem(CASHFLOW_GRANULARITY_STORAGE_KEY),
      );
    });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      CASHFLOW_GRANULARITY_STORAGE_KEY,
      cashflowGranularity,
    );
  }, [cashflowGranularity]);
  const [incomeBreakdownGranularity, setIncomeBreakdownGranularity] =
    useState<CashflowGranularity>(() => {
      if (typeof window === 'undefined') return 'yearly';
      return parseCashflowGranularity(
        window.localStorage.getItem(INCOME_BREAKDOWN_GRANULARITY_STORAGE_KEY),
      );
    });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      INCOME_BREAKDOWN_GRANULARITY_STORAGE_KEY,
      incomeBreakdownGranularity,
    );
  }, [incomeBreakdownGranularity]);
  const [breakdownTableOpen, setBreakdownTableOpen] = useState(false);
  const [yearTableOpen, setYearTableOpen] = useState(false);
  const [stressTableOpen, setStressTableOpen] = useState(false);
  const [yScale, setYScale] = useState<'linear' | 'log'>('linear');

  // The view lives only in ?view=: an absent or unknown value renders Overview, and mount never writes the URL (it would add a replace entry per load).
  // scrollAnchorRef wraps the strip and panels because a sticky element can't scroll itself into view; stripRef is the sticky container,
  // so focus inside a panel is scrolled clear of its bottom edge (WCAG 2.2 AA 2.4.11).
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseBalanceProjectionView(searchParams.get('view'));
  // Above the early returns: it must see a switch through a scenario that renders no panel.
  const compareWithAnchor = useCompareWithAnchor(selectedScenarioId);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  useFocusClearOfPinnedStrip(scrollAnchorRef, stripRef);
  // Set by a user-initiated switch, consumed by the layout effect: measuring in the handler measures the outgoing view and the taller incoming view would jump beneath the strip.
  const switchScrollPendingRef = useRef(false);
  const handleViewChange = (key: Key): void => {
    const next = String(key) as BalanceProjectionViewId;
    // React Aria re-fires onSelectionChange for the already-selected key; re-clicking the current tab must not scroll or rewrite the URL.
    if (next === view) return;
    switchScrollPendingRef.current = true;
    // Always write the param, including for Overview, so a copied URL lands where the sender was; replace: true so Back leaves the page.
    setSearchParams(
      (prev) => {
        const nextParams = new URLSearchParams(prev);
        nextParams.set('view', next);
        return nextParams;
      },
      { replace: true },
    );
  };
  // Only for a genuine switch (never mount, deep link or Back/Forward). Scrolls only when the strip is out of view above, so the title isn't pushed away needlessly.
  useLayoutEffect(() => {
    if (!switchScrollPendingRef.current) return;
    switchScrollPendingRef.current = false;
    const anchor = scrollAnchorRef.current;
    if (anchor && anchor.getBoundingClientRect().top < 0) {
      anchor.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
  }, [view]);

  const renderNow = new Date();
  const nowYear = renderNow.getFullYear();
  const nowMonthIndex = renderNow.getMonth();
  const nowDay = renderNow.getDate();

  useEffect(() => {
    if (!ready) return;
    if (canonicalScenarios.length === 0 || !selectedScenarioId) {
      setData(null);
      return;
    }
    if (!canonicalScenarios.some((s) => s.id === selectedScenarioId)) {
      setData(null);
      return;
    }
    // nowYear and nowMonthIndex are stable within a month, so the deps re-fire only on a month boundary.
    try {
      setConfigError(null);
      setData(
        loadPageData({
          scenarios: canonicalScenarios,
          selectedScenarioId,
          members: canonicalMembers,
          accounts: canonicalAccounts,
          balances: canonicalBalances,
          expenses: canonicalExpenses,
          incomeStreams: canonicalIncome,
          ssBenefits,
          categories: canonicalExpenseCategories,
          todayYear: nowYear,
          todayMonthIndex: nowMonthIndex,
        }),
      );
    } catch (e) {
      if (e instanceof TaxIntegrationInvalidInputError) {
        setData(null);
        setConfigError(
          friendlyProjectionErrorMessage(e) ??
            'This scenario can\'t be projected with its current settings.',
        );
      } else {
        throw e;
      }
    }
  }, [
    ready,
    selectedScenarioId,
    canonicalScenarios,
    canonicalMembers,
    canonicalAccounts,
    canonicalBalances,
    canonicalExpenses,
    canonicalExpenseCategories,
    canonicalIncome,
    ssBenefits,
    nowYear,
    nowMonthIndex,
  ]);

  const vm = useBalanceProjectionViewModel({
    data,
    selectedScenarioId,
    canonicalBalances,
    canonicalExpenses,
    expenseCategories: canonicalExpenseCategories,
    canonicalIncome,
    ssBenefits,
    displayMode,
    cashflowGranularity,
    incomeBreakdownGranularity,
    activeMethod,
    setActiveMethod,
    activeMcBasis,
    setActiveMcBasis,
    nowYear,
    nowMonthIndex,
    nowDay,
    resolvedTheme,
  });
  const {
    viewDeflator,
    basisDeflator,
    displayedTotals,
    enabledCalculatedMethods,
    fallbackAccounts,
    drawdownByMethod,
    representativeByBasis,
    activeRepresentativeRun,
    showAnotherPath,
    canShowAnotherPath,
    resolvedDrawdown,
    cbpValidation,
    stressVm,
    retirementMarkers,
    expenseChartMarkers,
    balanceProjectionChartMarkers,
    tooltipMembers,
    primaryRetirementYear,
    cashflowFromYear,
    lastDeathYear,
    lastDeathFractional,
    displayRows,
    incomeView,
    unifiedYearTableRows,
    portfolioFlowsByYear,
    magiCapBreachYears,
    isMagiCapActive,
    capFillActive,
    customTiers,
    excludedAccountIds,
    accountStackTimeline,
    accountStackBoundaryYear,
    accountRows,
    categoryMeta,
  } = vm;

  const primaryBirthYear = tooltipMembers[0]?.birthYear ?? null;

  const activeMethodLabel = METHOD_LABELS[activeMethod];
  // Truthy only when an MC tier is selected and its representative run is non-null (the VM resets activeMcBasis when the run disappears).
  const isMcBasisActive = activeRepresentativeRun !== null;
  const activeBasisLabel = resolvedBasisLabel(activeMcBasis, activeMethod);

  const mcDisabled = (basis: McBasis): boolean =>
    !representativeByBasis || representativeByBasis[basis] == null;

  const mcActive = activeMcBasis !== null;

  const scenarioName =
    data?.scenarios.find((s) => s.id === data.selectedScenarioId)?.payload
      .name ?? null;
  const heading = (
    <span id="balance-projection-heading">
      {scenarioName
        ? `Balance Projection - Scenario: ${scenarioName}`
        : 'Balance Projection'}
    </span>
  );

  if (error) {
    return <BalanceProjectionErrorState heading={heading} error={error} />;
  }

  if (configError) {
    return <BalanceProjectionErrorState heading={heading} error={configError} />;
  }

  if (!data) {
    return <BalanceProjectionLoadingState heading={heading} />;
  }

  const selectedScenario = data.scenarios.find(
    (s) => s.id === data.selectedScenarioId,
  );

  if (!data.resolved.retirementAge) {
    return (
      <BalanceProjectionNoRetirementAgeState
        heading={heading}
        scenarioId={selectedScenario?.id ?? null}
        scenarioName={selectedScenario?.payload.name ?? null}
      />
    );
  }

  if (
    data.rows.length === 0 &&
    data.hiddenZeroHistoryCount === 0 &&
    data.hiddenInactiveCount === 0
  ) {
    return <BalanceProjectionNoAccountState heading={heading} />;
  }

  // An auto-$0 seed account projects, so the empty-state signal is !hasAnyRealBalance, not the row count.
  if (!data.hasAnyRealBalance) {
    return <BalanceProjectionNoHistoryState heading={heading} />;
  }

  return (
    <section
      aria-labelledby="balance-projection-heading"
      className="print-projection"
    >
      <header className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className={pageTitleClass}>{heading}</h1>
          <Button
            type="button"
            onPress={() => window.print()}
            isDisabled={stressVm.isRunning}
            className={`report-print-hide ${btnSecondarySmClass}`}
          >
            Print / Save as PDF
          </Button>
        </div>
        {/* Print-only: hidden on screen, revealed in @media print so a printed copy is self-describing. */}
        <div hidden className="bp-print-header">
          <p className="m-0 text-sm text-muted">
            {buildReportTimestamp(generatedAt)}
          </p>
          <p className="m-0 text-xs text-muted">
            Created with {APP_NAME_PROSE} &middot; {REPO_URL}
          </p>
          <p className="m-0 text-xs text-muted">
            <a href={REPO_URL}>{OPEN_SOURCE_TEXT}</a>
          </p>
          <p className="m-0 text-xs text-muted">
            {displayMode === 'today'
              ? "Values in today's dollars (inflation-adjusted)"
              : 'Values in future nominal dollars'}
          </p>
          {/* Per-page legal line: printed pages 2+ detach from the on-screen disclaimer card. */}
          <p className="m-0 text-xs text-muted">{ONE_LINE_DISCLAIMER}</p>
        </div>
      </header>

      <div className="mt-1 grid grid-cols-1 items-stretch gap-3 md:grid-cols-5">
        <InlineDisclaimerCard
          ariaLabel="Projection disclaimer"
          size="sm"
          className="m-0 flex flex-col justify-center md:col-span-4"
        >
          Output is informational and does not constitute investment, tax, or
          legal advice. Past performance does not guarantee future results.
        </InlineDisclaimerCard>
        <PlanStressTestSuccessCard vm={stressVm} />
      </div>

      <BalanceProjectionCbpBanner
        validation={cbpValidation}
        accounts={data.accounts}
        members={data.members}
      />

      <Tabs
        selectedKey={view}
        onSelectionChange={handleViewChange}
        keyboardActivation="manual"
      >
        <div ref={scrollAnchorRef}>
          <div
            ref={stripRef}
            className="report-print-hide border-b border-line bg-surface lg:sticky lg:top-0 lg:z-20"
          >
            <div
              role="group"
              aria-label="Projection controls"
              className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-3"
            >
              <div className="flex items-center gap-2">
                <label
                  htmlFor="balance-projection-basis"
                  className="text-sm text-muted"
                >
                  Basis
                </label>
                <Select
                  id="balance-projection-basis"
                  className="w-auto min-w-44"
                  value={activeMcBasis ?? activeMethod}
                  onChange={(next) => {
                    if (
                      next === 'mc-typical' ||
                      next === 'mc-pessimistic' ||
                      next === 'mc-bad-luck'
                    ) {
                      setActiveMcBasis(next);
                    } else {
                      setActiveMcBasis(null);
                      setActiveMethod(next as ProjectionMethod);
                    }
                  }}
                  groups={[
                    {
                      label: 'Deterministic',
                      options: [
                        { value: 'planned', label: METHOD_LABELS.planned },
                        {
                          value: 'twr',
                          label: METHOD_LABELS.twr,
                          disabled: !enabledCalculatedMethods.has('twr'),
                        },
                      ],
                    },
                    {
                      label: 'Monte Carlo',
                      options: [
                        { value: 'mc-typical', label: 'Typical', disabled: mcDisabled('mc-typical') },
                        {
                          value: 'mc-pessimistic',
                          label: 'Pessimistic',
                          disabled: mcDisabled('mc-pessimistic'),
                        },
                        {
                          value: 'mc-bad-luck',
                          label: 'Bad-luck',
                          disabled: mcDisabled('mc-bad-luck'),
                        },
                      ],
                    },
                  ]}
                />
                <ShowAnotherPathButton
                  enabled={canShowAnotherPath}
                  onShowAnotherPath={showAnotherPath}
                />
              </div>
              <span className="hidden h-5 w-px bg-line sm:block" aria-hidden="true" />
              {/* Rendered outside every tabbed view because a role="status"/"alert" region inside a non-selected force-mounted panel is not announced. */}
              {(stressVm.isRunning || stressVm.error) ? (
                <PlanStressTestStatusRow vm={stressVm} />
              ) : (
                <PlanStressTestRecalcButton
                  vm={stressVm}
                  ariaLabel="Recalculate the example projection"
                />
              )}
              <span className="hidden h-5 w-px bg-line sm:block" aria-hidden="true" />
              <SegmentedRadioGroup<DisplayMode>
                size="sm"
                ariaLabel="Display unit"
                value={displayMode}
                onChange={setDisplayMode}
                options={[
                  {
                    value: 'today',
                    label: "Today's dollars",
                    title:
                      "What today's prices would buy, with inflation already pulled out.",
                  },
                  {
                    value: 'future',
                    label: 'Future dollars',
                    title:
                      'The actual amounts a statement will show, with inflation included.',
                  },
                ]}
              />
              <span className="hidden h-5 w-px bg-line sm:block" aria-hidden="true" />
              <ProjectionMethodExplainer />
            </div>
            {/* Arrow keys move focus without switching; Enter/Space switches (keyboardActivation="manual" on <Tabs>). */}
            <TabList
              aria-label="Projection views"
              className="flex flex-wrap gap-1 border-t border-line pt-2"
            >
              {VIEW_ORDER.map((id) => (
                <Tab key={id} id={id} className={TAB_CLASS}>
                  {VIEW_LABELS[id]}
                </Tab>
              ))}
            </TabList>
          </div>

          {/* Every panel force-mounts because print is pure CSS with no beforeprint hook; a non-selected panel is hidden by the [data-inert] screen-only rule in styles.css, keeping layout width. */}
          {/* A force-mounted, non-selected panel carries no role="tabpanel", id, aria-labelledby or tabIndex; do not look one up by role or id. */}
          <TabPanel id="overview" shouldForceMount className="bp-view-panel outline-none">
            <BalanceProjectionStats
              methodOrder={METHOD_ORDER}
              methodLabels={METHOD_LABELS}
              displayedTotals={displayedTotals}
              enabledCalculatedMethods={enabledCalculatedMethods}
              drawdownByMethod={drawdownByMethod}
              retirementYear={primaryRetirementYear}
              cashflowFromYear={cashflowFromYear}
              lastDeathYear={lastDeathYear}
              viewDeflator={viewDeflator}
              stressVm={stressVm}
              primaryBirthYear={primaryBirthYear}
            />

            <BalanceProjectionChartSection
              rows={displayRows}
              enabledCalculatedMethods={enabledCalculatedMethods}
              retirementMarkers={retirementMarkers}
              lifeExpectancyMarkers={expenseChartMarkers}
              tooltipMembers={tooltipMembers}
              yScale={yScale}
              onYScaleChange={setYScale}
              activeMcBasis={activeMcBasis}
              stressVm={stressVm}
              activeMethod={activeMethod}
              fallbackAccounts={fallbackAccounts}
            />

            <BalanceProjectionStressCard
              mcActive={mcActive}
              stressVm={stressVm}
              yScale={yScale}
              dataTableOpen={stressTableOpen}
              onToggleDataTable={() => setStressTableOpen((x) => !x)}
            />
          </TabPanel>

          <TabPanel id="cashflow" shouldForceMount className="bp-view-panel outline-none">
            <BalanceProjectionYearlyBands
              methodLabel={activeMethodLabel}
              resolvedLabel={activeBasisLabel}
              cashflowGranularity={cashflowGranularity}
              onGranularityChange={setCashflowGranularity}
              incomeBreakdownGranularity={incomeBreakdownGranularity}
              onIncomeBreakdownGranularityChange={setIncomeBreakdownGranularity}
              cashflowChartRows={incomeView?.cashflowChartRows ?? []}
              categoryMeta={categoryMeta}
              breakdownChartRows={incomeView?.breakdownChartRows ?? []}
              portfolioFlowsRows={portfolioFlowsByYear ?? []}
              chartMarkers={balanceProjectionChartMarkers}
              tooltipMembers={tooltipMembers}
              depletionYear={incomeView?.depletionYear ?? null}
            />
          </TabPanel>

          <TabPanel id="accounts" shouldForceMount className="bp-view-panel outline-none">
            <BalanceProjectionYearlySection
              accountRows={accountRows}
              activeMethod={activeMethod}
              displayedTotals={displayedTotals}
              isMcBasisActive={isMcBasisActive}
              hiddenInactiveCount={data.hiddenInactiveCount}
              hiddenZeroHistoryCount={data.hiddenZeroHistoryCount}
              primaryRetirementYear={primaryRetirementYear}
              viewDeflator={viewDeflator}
              breakdownTableOpen={breakdownTableOpen}
              onToggleBreakdownTable={() => setBreakdownTableOpen((x) => !x)}
              yearTableOpen={yearTableOpen}
              onToggleYearTable={() => setYearTableOpen((x) => !x)}
              yearTableRows={unifiedYearTableRows}
              displayMode={displayMode}
              magiCapBreachYears={magiCapBreachYears}
              isMagiCapActive={isMagiCapActive}
            />

            <BalanceProjectionAccountStackSection
              accounts={data.accounts}
              resolvedLabel={activeBasisLabel}
              isMcBasisActive={isMcBasisActive}
              customTiers={customTiers}
              excludedAccountIds={excludedAccountIds}
              accountStackTimeline={accountStackTimeline}
              accountStackBoundaryYear={accountStackBoundaryYear}
              markers={balanceProjectionChartMarkers}
              tooltipMembers={tooltipMembers}
            />
          </TabPanel>

          <TabPanel id="taxes" shouldForceMount className="bp-view-panel outline-none">
            <BalanceProjectionCharts
              drawdownByMethod={drawdownByMethod}
              activeMethod={activeMethod}
              resolvedDrawdown={resolvedDrawdown}
              resolvedLabel={activeBasisLabel}
              isMcBasisActive={isMcBasisActive}
              viewDeflator={viewDeflator}
              basisDeflator={basisDeflator}
              markers={balanceProjectionChartMarkers}
              tooltipMembers={tooltipMembers}
              displayMode={displayMode}
              lastDeathFractional={lastDeathFractional}
              capFillActive={capFillActive}
            />
          </TabPanel>

          <TabPanel id="swr" shouldForceMount className="bp-view-panel outline-none">
            <BalanceProjectionSwrSection
              data={data}
              vm={vm}
              selectedScenarioId={selectedScenarioId}
              canonicalIncome={canonicalIncome}
              canonicalExpenses={canonicalExpenses}
              ssBenefits={ssBenefits}
              displayMode={displayMode}
              activeMethod={activeMethod}
              activeMcBasis={activeMcBasis}
              nowYear={nowYear}
              nowMonthIndex={nowMonthIndex}
              resolvedLabel={activeBasisLabel}
              isMcBasisActive={isMcBasisActive}
              tooltipMembers={tooltipMembers}
            />
          </TabPanel>
          <TabPanel id="compare" shouldForceMount className="bp-view-panel outline-none">
            <BalanceProjectionCompareSection
              dataLoad={dataLoad} data={data} withAnchor={compareWithAnchor}
              isActive={view === 'compare'}
              nowYear={nowYear} nowMonthIndex={nowMonthIndex} stressVm={stressVm}
            />
          </TabPanel>
        </div>
      </Tabs>
    </section>
  );
};
