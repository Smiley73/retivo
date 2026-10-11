/**
 * Balance Projection page — projected per-account balances at each
 * household member's retirement date under the sidebar-selected
 * scenario.
 *
 * Surface: a pinned controls strip (Basis select + reroll, Recalculate /
 * progress, Today's/Future dollars toggle, methodology explainer) and a
 * "Projection views" tab row (Overview / Cash flow / Accounts / Taxes &
 * distributions / Safe withdrawal rate, `?view=`-driven) sitting
 * above five force-mounted panels that each compose named section
 * components. Page-owned state
 * (`yScale`, `displayMode`, `activeMethod`, `activeMcBasis`) is read across
 * views and threaded down as props, not re-scoped per panel. One data-load
 * hook (`useBalanceProjectionData`) keeps this file a presentation +
 * orchestration layer. The pure pipeline helpers live in
 * `balance-projection-page-pipeline.ts`.
 *
 * BPP's deterministic chart, year-by-year table, portfolio-flow, and
 * account-balance-stack surfaces all come from the shared projection
 * runner (`runBalanceProjectionForPage`, via `loadPageData`) — the same
 * engine the stress test and optimizer use, so the page can't silently
 * disagree with them. The at-horizon stat card shares the
 * `computePlannedAtHorizonToday` helper with the runner. The Plan Stress
 * Test card builds its `MonteCarloInput` via `runBalanceProjectionMc` from
 * the same runner module. The income/expense cashflow chart is a distinct
 * non-drawdown surface and stays on its own page-side series builder
 * (`buildPageCashflowSeries`).
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, Tab, TabList, TabPanel, Tabs, type Key } from 'react-aria-components';
import {
  PlanStressTestStatusRow,
  PlanStressTestRecalcButton,
  PlanStressTestSuccessCard,
} from '../components/PlanStressTestSection';
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
import {
  loadPageData,
  type PipelineData,
  type McBasis,
} from './balance-projection-page-pipeline';
import { TaxIntegrationInvalidInputError } from '../lib/balance-projection-runner-tax';
import { friendlyProjectionErrorMessage } from '../lib/tax-integration';
import { buildReportTimestamp } from '../lib/report-format';
import { BalanceProjectionAccountStackSection } from './balance-projection-page-account-stack-section';
import { BalanceProjectionCharts } from './balance-projection-page-charts';
import { BalanceProjectionSwrSection } from './balance-projection-page-swr';
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
  // `activeMethod` is the deterministic series the per-account tables +
  // account-balance chart render (planned / twr only). The header
  // `<select>` ("Basis") is the single control that drives it — the old
  // buried tablist is removed. The view model can also re-point it (e.g.
  // when TWR is unavailable it falls back to planned), so the select
  // binds straight to `activeMethod` and its label tracks any such
  // fallback automatically.
  const [activeMethod, setActiveMethod] = useState<ProjectionMethod>('twr');
  // `activeMcBasis` is the Monte Carlo tier (Typical / Pessimistic / Bad-luck)
  // selected from the header Basis select's "Monte Carlo" optgroup, or null for
  // a deterministic basis. When set it drives every per-year surface that
  // varies with market/inflation luck; `activeMethod` is held for the
  // deterministic-only surfaces (per-account table, Account Balance Stack,
  // income breakdown). The view model resets this to null if the stress result
  // disappears.
  const [activeMcBasis, setActiveMcBasis] = useState<McBasis | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => {
    if (typeof window === 'undefined') return 'today';
    return parseDisplayMode(window.localStorage.getItem(DISPLAY_MODE_STORAGE_KEY));
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(DISPLAY_MODE_STORAGE_KEY, displayMode);
  }, [displayMode]);
  // Captured once per mount so the print header timestamp is stable across
  // the page's lifetime (mirrors the Report-page generated-at pattern).
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
  // The income-breakdown card owns an independent granularity toggle
  // ("one toggle per card"); the two may drift out of sync.
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

  // The selected view lives only in `?view=` — an absent or unrecognised
  // value renders Overview, and the page never writes the URL on mount to
  // normalise it (a mount-time write would add a replace entry on every load
  // and make deep-link behavior depend on render timing). `scrollAnchorRef`
  // wraps the pinned strip + the five panels: a sticky element can't scroll
  // itself into view (once stuck, its rect top is already 0), so a
  // user-initiated switch scrolls this plain, non-sticky ancestor instead —
  // its top edge is where the strip sits when unstuck. `stripRef` is the
  // sticky container itself: while it is stuck it paints over the panel
  // content beneath, so a control reached by keyboard inside a panel is
  // scrolled clear of the strip's MEASURED bottom edge (WCAG 2.2 AA 2.4.11 —
  // see the hook for why a fixed document `scroll-padding` reserve cannot do
  // this: the strip's height varies with wrapping and the in-flight row, and
  // a reserve that covers the stuck strip makes the browser scroll the page
  // every time focus enters one of the strip's own controls).
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseBalanceProjectionView(searchParams.get('view'));
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  useFocusClearOfPinnedStrip(scrollAnchorRef, stripRef);
  // Set by a user-initiated switch, consumed by the layout effect below. The
  // switch scroll has to be measured against the INCOMING view: done inside
  // the handler it measures the outgoing one, and from a short view the
  // document cannot scroll far enough — the strip stops short of the top and
  // the taller view then renders beneath it as a visible jump.
  const switchScrollPendingRef = useRef(false);
  const handleViewChange = (key: Key): void => {
    const next = String(key) as BalanceProjectionViewId;
    // React Aria re-fires onSelectionChange for the already-selected key;
    // re-clicking the current tab must not scroll the reader back to the
    // strip or rewrite the URL.
    if (next === view) return;
    switchScrollPendingRef.current = true;
    // Always write the param explicitly, including for Overview — one
    // code path rather than a delete-vs-set branch, so a copied URL always
    // lands where the sender was. The functional updater preserves any other
    // future param; `replace: true` means Back leaves the page.
    setSearchParams(
      (prev) => {
        const nextParams = new URLSearchParams(prev);
        nextParams.set('view', next);
        return nextParams;
      },
      { replace: true },
    );
  };
  // Fires only for a genuine switch (click, or Enter/Space with
  // keyboardActivation="manual") — never for the initial mount, a deep-linked
  // load or Back/Forward, none of which set the flag. A layout effect
  // runs once the new view is in the DOM and before paint, so the strip lands
  // at the viewport top against the layout that is actually shown. Only when
  // the strip has scrolled out of view above, though: near the top of the
  // page the new view already starts beneath the visible strip, and scrolling
  // would push the page title away for nothing.
  useLayoutEffect(() => {
    if (!switchScrollPendingRef.current) return;
    switchScrollPendingRef.current = false;
    const anchor = scrollAnchorRef.current;
    if (anchor && anchor.getBoundingClientRect().top < 0) {
      anchor.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
  }, [view]);

  // Single real-clock anchor captured ONCE per render so the engines +
  // view-deflator can't drift apart across a clock-minute boundary.
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
    // nowYear/nowMonthIndex are captured per render but are stable
    // within a month; including them in the deps array (below) re-fires
    // only on a month boundary, not on every paint. The other deps gate
    // freshness on aggregate edits.
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

  // Kept as one object (rather than destructured straight off the hook call)
  // so the new SWR panel can take the SAME already-resolved view model every
  // other tab reads, never a second `useBalanceProjectionViewModel()` call.
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

  // Primary member's birth year drives the MC "Depletes — age N" line.
  // `tooltipMembers` is ordered primary-first; fall back to null when no
  // member has a usable birthdate (the MC card then shows the year).
  const primaryBirthYear = tooltipMembers[0]?.birthYear ?? null;

  // Label for the active deterministic method (Planned / TWR). Suffixed onto
  // the per-account breakdown table heading + the Income-breakdown chart (whose
  // sources are market-independent plan inputs).
  const activeMethodLabel = METHOD_LABELS[activeMethod];
  // The Account Balance Stack + RMD charts + the breakdown-table note key
  // off the RESOLVED basis — truthy only when an MC tier is selected AND its
  // representative run is non-null (the VM auto-swaps `activeMcBasis` to null
  // when a tier's run disappears, so `activeRepresentativeRun` is the precise
  // resolved-to-MC signal).
  const isMcBasisActive = activeRepresentativeRun !== null;
  // Label for the basis the resolved-drawdown surfaces actually reflect: the
  // active MC tier (Typical / Pessimistic / Bad-luck) when an MC basis is
  // selected, else the deterministic method label. Suffixed onto the
  // MC-driven titles (Expected cashflow, Income breakdown, Annual Portfolio
  // Flow, Tax & Health-Cost Burden) so each names the basis driving it.
  const activeBasisLabel = resolvedBasisLabel(activeMcBasis, activeMethod);

  // A Monte Carlo basis option is disabled until its representative run is
  // available (no stress result → every tier null → all three disabled).
  const mcDisabled = (basis: McBasis): boolean =>
    !representativeByBasis || representativeByBasis[basis] == null;

  // Ring the Stress-test outcomes card while a Monte Carlo basis drives the
  // screen, foregrounding the card that explains the scenario.
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

  // Onboarding empty state. Persist the "enter a balance" prompt until a real
  // (non-zero) balance exists anywhere in the active portfolio. An auto-$0
  // seed account projects, so `data.rows.length === 0` is now false for a
  // seed-only portfolio — the empty-state signal is `!data.hasAnyRealBalance`,
  // not the row count. A mixed portfolio (≥1 real balance + new $0 accounts)
  // falls through to the projection as normal.
  if (!data.hasAnyRealBalance) {
    return <BalanceProjectionNoHistoryState heading={heading} />;
  }

  return (
    <section
      aria-labelledby="balance-projection-heading"
      className="print-projection"
    >
      <header className="mb-4 flex flex-col gap-3">
        {/* Row 1: the page title + the Print button. The report metadata
            block (Generated / Created-with / dollar-mode note) sits below it
            and is PRINT-ONLY — hidden on screen, revealed in `@media print`
            (see styles.css `@layer base` reveal). The controls strip
            (Basis + reroll, Recalculate / progress, display unit, explainer)
            plus the view tabs live below the disclaimer/CBP-banner block, in
            their own pinned group — see the `role="group"` container below. */}
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
        {/* Print-only metadata block — hidden on screen via `hidden`, revealed
            only in `@media print`. Carries generated-at + provenance lines
            so a printed/saved copy is self-describing; the dollar-mode note is page-specific (the Report
            page has no display-unit toggle). */}
        <div hidden className="bp-print-header">
          <p className="m-0 text-sm text-muted">
            {buildReportTimestamp(generatedAt)}
          </p>
          <p className="m-0 text-xs text-muted">
            Created with {APP_NAME_PROSE} &middot; {REPO_URL}
          </p>
          {/* Open-source line — print-only, so a plain link. */}
          <p className="m-0 text-xs text-muted">
            <a href={REPO_URL}>{OPEN_SOURCE_TEXT}</a>
          </p>
          <p className="m-0 text-xs text-muted">
            {displayMode === 'today'
              ? "Values in today's dollars (inflation-adjusted)"
              : 'Values in future nominal dollars'}
          </p>
          {/* Per-page legal line so a printed schedule (pages 2+ detach from
              the on-screen disclaimer card) still carries the notice. */}
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
        {/* The scroll anchor for a user-initiated view switch: a sticky
            element can't scroll itself into view (once stuck its rect top is
            already 0), so this plain, non-sticky div — wrapping the pinned
            strip AND the five panels — is the scroll target instead; its top
            edge is where the strip sits when unstuck (see
            `handleViewChange`). It is also the container
            `useFocusClearOfPinnedStrip` watches for keyboard focus landing
            under the stuck strip (`stripRef`, the sticky div just inside). */}
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
                    // A Monte Carlo pick selects a representative-run tier (and
                    // holds the last deterministic method for the surfaces that
                    // can't go MC); a deterministic pick clears the MC basis.
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
                {/* Reroll the basis line to a different card-consistent path from
                    the current sample — beside the basis selector since it only
                    changes the MC line, not the cards. Disabled (aria-only,
                    stays focusable) when no MC basis is active or the active tier
                    has <2 card-consistent paths. */}
                <ShowAnotherPathButton
                  enabled={canShowAnotherPath}
                  onShowAnotherPath={showAnotherPath}
                />
              </div>
              <span className="hidden h-5 w-px bg-line sm:block" aria-hidden="true" />
              {/* While a stress run is in flight OR has errored, the
                  controls strip shows PlanStressTestStatusRow (progress + Cancel
                  when running; error toast when errored); idle/done shows
                  Recalculate. This status lives here — outside every tabbed
                  view — because a `role="status"`/`role="alert"` region inside a
                  non-selected force-mounted panel is not announced. */}
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
            {/* View tabs: arrow keys move focus along the row without
                switching; Enter/Space switches (`keyboardActivation="manual"`
                on the <Tabs> root above). Picking a Monte Carlo basis above
                leaves the person on whichever tab they're on — nothing
                here reacts to `activeMcBasis`. */}
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

          {/* Every panel force-mounts: print is pure CSS with no
              `beforeprint` hook anywhere in this app, so a panel React Aria
              unmounted would simply be absent from the printout. A
              non-selected panel is hidden on screen by the `[data-inert]`-
              keyed screen-only rule in styles.css (`.bp-view-panel`) —
              preserving layout width so its charts never measure 0 and print
              stretched. A force-mounted, non-selected panel carries no
              `role="tabpanel"` / `id` / `aria-labelledby` / `tabIndex`; do not
              look one up by role or id. */}
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
        </div>
      </Tabs>
    </section>
  );
};
