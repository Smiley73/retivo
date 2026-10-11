/**
 * Export PDF page.
 *
 * This page is the single entry point for the unified PDF export. The old
 * on-screen report inventory (overview / accounts / expenses / income /
 * scenarios sections + the CSS print button) is gone — that content now lives
 * INSIDE the generated PDF. The page is a small control surface:
 *
 *   - a Scenario picker, a Basis picker (Planned / Historical / the three Monte
 *     Carlo tiers — un-projectable MC tiers disabled with a reason), and a
 *     Today's / Future display-mode segmented control;
 *   - a per-year PREVIEW chart of the selected example path (the same
 *     `ProjectionChart` the Balance Projection page draws), with a "Show
 *     another likely path" reroll;
 *   - an Export button (disabled + progress while a build is in flight) and a
 *     Cancel button.
 *
 * The export flow mounts the off-screen `ReportPagePdfRenderHost` ONLY while
 * exporting: it captures each chart's `<svg>` (forced-light, off-canvas), then
 * `buildPdfSectionModel` + `buildAndDownloadPdf` assemble + download one PDF.
 * A bounded timeout + a `finally` that always tears the host down and re-enables
 * Export guarantee the page can't get stuck mid-export; any failure surfaces a
 * typed error and never produces a partial download.
 *
 * Reactive reads: the page reads scenario / account / expense / income data via
 * `useAggregates(type)`; the selected-scenario *pointer* is not a store-subscription
 * slice, so it re-reads via the narrow `useSelectedScenarioRevision()` signal.
 *
 * Mounts its own `<MonteCarloProvider>` (the Balance Projection view model's
 * stress VM runs MC through it) wrapping both the preview and the render host.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { MonteCarloProvider } from '../monte-carlo/MonteCarloProvider';
import { useTheme } from '../contexts/ThemeContext';
import { useBetaFeatures } from '../contexts/BetaFeaturesContext';
import { hiddenBetaPdfSectionIds } from '../lib/feature-flags';
import { useAggregates } from '../lib/use-aggregates';
import { readSelectedScenario } from '../db/store';
import { useSelectedScenarioRevision } from '../lib/use-selected-scenario-revision';
import { pageTitleClass } from '../components/PageHeader';
import { Select } from '../components/Select';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { ShowAnotherPathButton } from '../components/ShowAnotherPathButton';
import { McProgressBar } from '../components/McProgressBar';
import { Alert } from '../components/Alert';
import { btnPrimarySmClass, btnSecondarySmClass } from './accounts-page-chrome';
import { ProjectionChart, type ProjectionMethod } from '../components/ProjectionChart';
import {
  DISPLAY_MODE_STORAGE_KEY,
  parseDisplayMode,
  type DisplayMode,
} from '../lib/view-deflator';
import { loadPageData, type PipelineData, type McBasis } from './balance-projection-page-pipeline';
import { TaxIntegrationInvalidInputError } from '../lib/balance-projection-runner-tax';
import { friendlyProjectionErrorMessage } from '../lib/tax-integration';
import { useBalanceProjectionViewModel } from './use-balance-projection-view-model';
import { resolvedBasisLabel, MC_BASIS_LABELS } from './balance-projection-page-constants';
import {
  PROJECTION_METHOD_LABELS,
  TWR_METHOD_LABEL,
} from '../lib/projection-method-labels';
import { useChartColors } from '../lib/use-chart-tokens';
import { buildReportData, type ReportData } from '../lib/report-data';
import {
  buildReportAccountMetrics,
  reportAccountOwnerDisplayName,
} from '../lib/report-account-metrics';
import { buildReportPdfAccountLists } from '../lib/report-table-ordering';
import { REPORT_DISCLAIMER } from '../lib/disclaimer-fragments';
import { medicalCategoryIdsFrom } from '../lib/expense-category-resolvers';
import {
  buildPdfSectionModel,
  buildAndDownloadPdf,
} from '../lib/pdf-export/build-pdf';
import {
  buildBalanceTableSpec,
  buildStressTestTableSpec,
  buildCashflowTableSpec,
  buildIncomeBreakdownTableSpec,
  buildPortfolioFlowsTableSpec,
  buildTaxBurdenTableSpec,
  buildRmdTableSpec,
  buildRothConversionsTableSpec,
  buildQcdTableSpec,
  buildAccountBalancesByTypeTableSpec,
  buildAccountBalancesByAccountTableSpec,
  buildExpensesTotalTableSpec,
  buildExpensesByCategoryTableSpec,
  buildWithdrawalGuidanceSectionSpec,
  type PdfTableSpec,
  type StressTestYearPercentiles,
} from '../lib/pdf-export/pdf-tables';
import {
  buildGuidanceYearRows,
  deflateGuidanceRows,
  type GuidanceAccountMeta,
} from './withdrawal-guidance-data';
import { stackTypeBucketsForYear } from './balance-projection-page-account-balance-stack';
import { buildPdfFilename } from '../lib/pdf-export/filename';
import type { PdfLibLoader } from '../lib/pdf-export/lazy-load';
import { ReportPagePdfRenderHost } from './report-page-pdf-render-host';
import {
  buildTaxBurdenRows,
  buildRmdRows,
  buildRothConversionsSeries,
  buildQcdRows,
} from './balance-projection-burden-rows';
import {
  STATUS_HEX,
  successTierForPct,
} from '../components/plan-stress-test-chrome';
import type {
  Aggregate,
  AccountBalancePayload,
  AccountPayload,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
  HouseholdPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { buildProjection } from './ExpensesPage';
import type { ExpenseRow } from './expense-group-card';

/** Bounded ceiling for a single export run before it self-aborts (D: the
 *  `finally` tears the host down + re-enables Export). */
const EXPORT_TIMEOUT_MS = 30_000;

/** Basis-picker MC tier keys. */
const MC_BASES: ReadonlyArray<McBasis> = ['mc-typical', 'mc-pessimistic', 'mc-bad-luck'];

function isMcBasisValue(v: string): v is McBasis {
  return (MC_BASES as ReadonlyArray<string>).includes(v);
}

/**
 * One "what this report assumed" panel: a labelled `role="note"` card with an
 * optional body and a trailing disclosure list.
 *
 * The filing, health-coverage, market-stress, and Roth/required-withdrawal
 * panels are all the same chrome around different bodies, so the card, its
 * accessible name wiring, and the disclosure list live here once — a new
 * assumption panel cannot ship with a missing `role`, a heading that is not
 * the accessible name, or a differently-styled bullet list.
 */
const ReportAssumptionsPanel: React.FC<{
  /** DOM id of the heading — also the panel's accessible name. */
  readonly headingId: string;
  readonly title: string;
  /** Standing disclosures. Rendered as the panel's closing bullet list. */
  readonly disclosures: ReadonlyArray<string>;
  /** Panel body (definition lists, lead paragraphs, warnings). Optional: a
   *  disclosure-only panel renders just the list. */
  readonly children?: React.ReactNode;
}> = ({ headingId, title, disclosures, children }) => (
  <div
    className="flex flex-col gap-2 rounded-lg border border-line bg-surface-raised p-4"
    role="note"
    aria-labelledby={headingId}
  >
    <h2 id={headingId} className="m-0 text-base font-semibold text-ink">
      {title}
    </h2>
    {children}
    <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-muted">
      {disclosures.map((d) => (
        <li key={d}>{d}</li>
      ))}
    </ul>
  </div>
);

/** Props injectable for tests: a mock PDF lib loader so jsdom never imports
 *  real jsPDF. */
export interface ReportPageProps {
  /** Test seam — the PDF library loader (defaults to the real lazy loader). */
  readonly pdfLibLoader?: PdfLibLoader;
}

export const ReportPage: React.FC<ReportPageProps> = (props) => (
  <MonteCarloProvider>
    <ExportPdfPageInner {...props} />
  </MonteCarloProvider>
);

const ExportPdfPageInner: React.FC<ReportPageProps> = ({ pdfLibLoader }) => {
  const { resolvedTheme } = useTheme();
  const { isBetaFeatureVisible } = useBetaFeatures();
  // Reactive reads: every slice re-reads on a write to its store, so a
  // sync bootstrap / demo fill while the page is open refreshes by construction.
  const scenarioAgg = useAggregates('scenario');
  const accountAgg = useAggregates('account');
  const balanceAgg = useAggregates('accountBalance');
  const memberAgg = useAggregates('householdMember');
  const expenseAgg = useAggregates('expense');
  const categoryAgg = useAggregates('expenseCategory');
  const incomeAgg = useAggregates('incomeStream');
  const ssAgg = useAggregates('socialSecurityBenefit');
  const householdAgg = useAggregates('household');
  // The selected-scenario pointer is not a store-subscription slice; re-read it
  // when the sidebar scenario switch fires so the default pick follows the
  // active selection.
  const selectedScenarioRevision = useSelectedScenarioRevision();

  const scenarios = scenarioAgg.aggregates as ReadonlyArray<ScenarioAggregate>;
  const accounts = accountAgg.aggregates as ReadonlyArray<Aggregate<AccountPayload>>;
  const balances = balanceAgg.aggregates as ReadonlyArray<Aggregate<AccountBalancePayload>>;
  const members = memberAgg.aggregates as ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  const expenses = expenseAgg.aggregates as ReadonlyArray<Aggregate<ExpensePayload>>;
  const categories = categoryAgg.aggregates as ReadonlyArray<Aggregate<ExpenseCategoryPayload>>;
  const incomeStreams = incomeAgg.aggregates as ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  const ssBenefits = ssAgg.aggregates as ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  const households = householdAgg.aggregates as ReadonlyArray<Aggregate<HouseholdPayload>>;

  const readyAll =
    scenarioAgg.ready &&
    accountAgg.ready &&
    balanceAgg.ready &&
    memberAgg.ready &&
    expenseAgg.ready &&
    categoryAgg.ready &&
    incomeAgg.ready &&
    ssAgg.ready &&
    householdAgg.ready;
  const readError =
    scenarioAgg.error ??
    accountAgg.error ??
    balanceAgg.error ??
    memberAgg.error ??
    expenseAgg.error ??
    categoryAgg.error ??
    incomeAgg.error ??
    ssAgg.error ??
    householdAgg.error ??
    null;

  // Default scenario: the sidebar selection if present, else the base.
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    let active = true;
    void (async () => {
      const sel = await readSelectedScenario();
      if (!active) return;
      const base = scenarios.find((s) => s.payload.isPrimary);
      const next =
        sel && scenarios.some((s) => s.id === sel.scenarioId)
          ? sel.scenarioId
          : (base?.id ?? null);
      // Keep an explicit user pick if it is still a valid scenario.
      setSelectedScenarioId((prev) =>
        prev && scenarios.some((s) => s.id === prev) ? prev : next,
      );
    })();
    return () => {
      active = false;
    };
  }, [scenarios, selectedScenarioRevision]);

  const chartColors = useChartColors();
  const [activeMethod, setActiveMethod] = useState<ProjectionMethod>('planned');
  const [activeMcBasis, setActiveMcBasis] = useState<McBasis | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => {
    if (typeof window === 'undefined') return 'today';
    return parseDisplayMode(window.localStorage.getItem(DISPLAY_MODE_STORAGE_KEY));
  });

  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [generatedAt] = useState(() => new Date());

  // Single render-clock anchor (mirrors the Balance Projection page).
  const renderNow = new Date();
  const nowYear = renderNow.getFullYear();
  const nowMonthIndex = renderNow.getMonth();
  const nowDay = renderNow.getDate();

  // Deterministic pipeline data for the selected scenario. Wrapped in
  // try/catch so an un-projectable scenario surfaces a typed error rather than
  // throwing into the render.
  const [configError, setConfigError] = useState<string | null>(null);
  const data = useMemo<PipelineData | null>(() => {
    if (!readyAll || !selectedScenarioId) return null;
    if (!scenarios.some((s) => s.id === selectedScenarioId)) return null;
    try {
      const result = loadPageData({
        scenarios,
        selectedScenarioId,
        members,
        accounts,
        balances,
        expenses,
        incomeStreams,
        ssBenefits,
        categories,
        todayYear: nowYear,
        todayMonthIndex: nowMonthIndex,
      });
      return result;
    } catch (e) {
      if (e instanceof TaxIntegrationInvalidInputError) return null;
      throw e;
    }
  }, [
    readyAll,
    selectedScenarioId,
    scenarios,
    members,
    accounts,
    balances,
    expenses,
    incomeStreams,
    ssBenefits,
    categories,
    nowYear,
    nowMonthIndex,
  ]);

  React.useEffect(() => {
    if (!readyAll || !selectedScenarioId) {
      setConfigError(null);
      return;
    }
    try {
      loadPageData({
        scenarios,
        selectedScenarioId,
        members,
        accounts,
        balances,
        expenses,
        incomeStreams,
        ssBenefits,
        categories,
        todayYear: nowYear,
        todayMonthIndex: nowMonthIndex,
      });
      setConfigError(null);
    } catch (e) {
      if (e instanceof TaxIntegrationInvalidInputError) {
        setConfigError(
          friendlyProjectionErrorMessage(e) ??
            "This scenario can't be projected with its current settings.",
        );
      }
    }
  }, [
    readyAll,
    selectedScenarioId,
    scenarios,
    members,
    accounts,
    balances,
    expenses,
    incomeStreams,
    ssBenefits,
    categories,
    nowYear,
    nowMonthIndex,
  ]);

  const vm = useBalanceProjectionViewModel({
    data,
    selectedScenarioId,
    canonicalBalances: balances,
    canonicalExpenses: expenses,
    expenseCategories: categories,
    canonicalIncome: incomeStreams,
    ssBenefits,
    displayMode,
    cashflowGranularity: 'yearly',
    incomeBreakdownGranularity: 'yearly',
    activeMethod,
    setActiveMethod,
    activeMcBasis,
    setActiveMcBasis,
    nowYear,
    nowMonthIndex,
    nowDay,
    resolvedTheme,
  });

  // An MC tier is selectable only once its representative run is available.
  const mcDisabled = useCallback(
    (basis: McBasis): boolean =>
      !vm.representativeByBasis || vm.representativeByBasis[basis] == null,
    [vm.representativeByBasis],
  );
  const allMcDisabled = MC_BASES.every((b) => mcDisabled(b));

  const scenarioName =
    scenarios.find((s) => s.id === selectedScenarioId)?.payload.name ?? '';
  const activeBasisLabel = resolvedBasisLabel(activeMcBasis, activeMethod);

  const mcLine = useMemo(() => {
    if (!activeMcBasis) return null;
    const color =
      activeMcBasis === 'mc-typical'
        ? chartColors.mcTypical
        : activeMcBasis === 'mc-pessimistic'
          ? chartColors.mcPessimistic
          : chartColors.mcBadLuck;
    return { color, label: MC_BASIS_LABELS[activeMcBasis] };
  }, [activeMcBasis, chartColors]);

  // Build the report inventory data for the PDF (current values).
  const reportData = useMemo<ReportData | null>(() => {
    if (!selectedScenarioId || !scenarios.some((s) => s.id === selectedScenarioId)) {
      return null;
    }
    const accountMetricsById = buildReportAccountMetrics(
      accounts,
      balances,
      members,
    );
    const categoryNameById = new Map<string, string>();
    for (const c of categories) categoryNameById.set(c.id, c.payload.name);
    return buildReportData(
      {
        household: households[0],
        members,
        accounts,
        balances,
        accountMetricsById,
        expenses,
        expenseCategoryNameById: categoryNameById,
        medicalCategoryIds: medicalCategoryIdsFrom([...categories]),
        incomeStreams,
        socialSecurity: ssBenefits,
        scenarios,
        activeScenarioId: selectedScenarioId,
      },
      generatedAt,
    );
  }, [
    selectedScenarioId,
    scenarios,
    balances,
    categories,
    households,
    members,
    accounts,
    expenses,
    incomeStreams,
    ssBenefits,
    generatedAt,
  ]);

  // Expense projection data for the PDF's expense chart sections.
  // Rendered at 'light' theme (PDF is always white-page, light palette).
  const expenseProjection = useMemo(() => {
    const categoryNameById = new Map<string, string>();
    for (const c of categories) categoryNameById.set(c.id, c.payload.name);
    const expenseRows: ExpenseRow[] = expenses.map((e) => ({
      id: e.id,
      version: e.version,
      payload: e.payload,
      categoryName: categoryNameById.get(e.payload.categoryId) ?? '',
    }));
    return buildProjection(
      expenseRows,
      [...categories],
      [...members],
      [...scenarios],
      selectedScenarioId,
      'light',
      displayMode,
      nowMonthIndex,
    );
  }, [expenses, categories, members, scenarios, selectedScenarioId, displayMode, nowMonthIndex]);

  // The off-screen host resolves its SVGs into this promise once geometry
  // commits; the export flow awaits it.
  const svgReadyRef = useRef<{
    resolve: (m: Record<string, SVGElement>) => void;
    reject: (e: Error) => void;
  } | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const runGenRef = useRef(0);

  const onHostReady = useCallback((svgMap: Record<string, SVGElement>) => {
    svgReadyRef.current?.resolve(svgMap);
  }, []);
  const onHostError = useCallback((err: Error) => {
    svgReadyRef.current?.reject(err);
  }, []);

  const accountsForHost = useMemo(
    () => {
      const memberById = new Map(
        members
          .filter((member) => !member.deletedAt)
          .map((member) => [member.id, member.payload]),
      );
      return (data?.accounts ?? []).map((a) => ({
        id: a.id,
        name: a.payload.name,
        ownerDisplayName: reportAccountOwnerDisplayName(a.payload, memberById),
        type: a.payload.type,
        taxTreatment: a.payload.taxTreatment,
        ownerId: a.payload.ownerId,
      }));
    },
    [data, members],
  );
  const { allAccounts: allAccountsForHost, byAccountAccounts } = useMemo(
    () => buildReportPdfAccountLists(accountsForHost, vm.excludedAccountIds),
    [accountsForHost, vm.excludedAccountIds],
  );

  // Withdrawal-guidance metadata: per-account meta keyed by id (carries the
  // RMD-grouping fields + tax treatment) and owner display names by member id,
  // for the PDF's withdrawal-guidance table (the final section).
  const guidanceAccountsById = useMemo<ReadonlyMap<string, GuidanceAccountMeta>>(
    () => {
      const m = new Map<string, GuidanceAccountMeta>();
      for (const a of allAccountsForHost) {
        m.set(a.id, {
          id: a.id,
          name: a.name,
          type: a.type,
          ownerId: a.ownerId,
          taxTreatment: a.taxTreatment,
        });
      }
      return m;
    },
    [allAccountsForHost],
  );
  const ownerNameById = useMemo<ReadonlyMap<string, string>>(() => {
    const m = new Map<string, string>();
    for (const member of members) {
      m.set(member.id, member.payload.firstName || 'Owner');
    }
    return m;
  }, [members]);

  // Nominal (pre-deflation) per-year guidance rows — built from the active
  // deterministic method's drawdown years (deterministic-only); empty under
  // an MC basis. Deflated to display basis only when the table is actually built.
  const guidanceRows = useMemo(() => {
    if (vm.isMcBasisActive) return [];
    const years = vm.drawdownByMethod?.[activeMethod]?.years ?? [];
    return buildGuidanceYearRows(years, guidanceAccountsById);
  }, [vm.isMcBasisActive, vm.drawdownByMethod, activeMethod, guidanceAccountsById]);

  // The withdrawal-guidance section spec (final PDF section): the MC note, the
  // empty note, or the full display-basis table — via the pure selection helper
  // applying the total-function precedence (MC → empty → table). Display dollars
  // use `vm.basisDeflator` for document-internal consistency.
  const withdrawalGuidanceTableSpec = useMemo<PdfTableSpec>(
    () =>
      buildWithdrawalGuidanceSectionSpec({
        isMcBasisActive: vm.isMcBasisActive,
        displayRows: vm.isMcBasisActive
          ? []
          : deflateGuidanceRows(guidanceRows, vm.basisDeflator),
        ownerNameById,
      }),
    [vm.isMcBasisActive, guidanceRows, vm.basisDeflator, ownerNameById],
  );

  // Burden-chart rows for the PDF render host — built from the view model's
  // resolved drawdown via the SAME pure builders the on-page charts use, so the
  // PDF's Tax / RMD / Roth charts derive identical rows (no drift). The RMD +
  // Roth builders fall back to the active deterministic method when no MC run is
  // resolved (mirrors `resolvedDrawdown ?? drawdownByMethod[activeMethod]`).
  const rmdDrawdown =
    vm.resolvedDrawdown ?? vm.drawdownByMethod?.[activeMethod] ?? null;
  const taxBurdenRows = useMemo(
    () =>
      buildTaxBurdenRows({
        resolvedDrawdown: vm.resolvedDrawdown,
        basisDeflator: vm.basisDeflator,
        lastDeathFractional: vm.lastDeathFractional,
        isMcBasisActive: vm.isMcBasisActive,
      }),
    [vm.resolvedDrawdown, vm.basisDeflator, vm.lastDeathFractional, vm.isMcBasisActive],
  );
  const rmdRows = useMemo(
    () =>
      buildRmdRows({
        drawdown: rmdDrawdown,
        basisDeflator: vm.basisDeflator,
        lastDeathFractional: vm.lastDeathFractional,
      }),
    [rmdDrawdown, vm.basisDeflator, vm.lastDeathFractional],
  );
  const rothRows = useMemo(
    () =>
      buildRothConversionsSeries({
        drawdown: rmdDrawdown,
        lastDeathFractional: vm.lastDeathFractional,
      }),
    [rmdDrawdown, vm.lastDeathFractional],
  );
  const qcdRows = useMemo(
    () =>
      buildQcdRows({
        drawdown: rmdDrawdown,
        basisDeflator: vm.basisDeflator,
        lastDeathFractional: vm.lastDeathFractional,
        displayMode,
      }),
    [rmdDrawdown, vm.basisDeflator, vm.lastDeathFractional, displayMode],
  );

  // Per-chart data tables for the PDF (rendered UNDER each chart). Each entry
  // is added ONLY when its chart actually renders — tied to the SAME
  // data-presence gates the render host uses (see `report-page-pdf-render-host`)
  // so there is never a table without its chart or vice-versa. All numbers are
  // already display-basis; the builders only format + aggregate to annual.
  const chartTablesBySection = useMemo<ReadonlyMap<string, PdfTableSpec>>(() => {
    const map = new Map<string, PdfTableSpec>();

    // Balance line — always present.
    map.set(
      'chart-balance',
      buildBalanceTableSpec(
        vm.displayRows,
        vm.enabledCalculatedMethods,
        vm.isMcBasisActive,
      ),
    );

    // Stress-test fan — only when the MC run has a renderable result.
    const stressResult = vm.stressVm.result;
    if (
      !vm.stressVm.hasNoAccounts &&
      !(vm.stressVm.cbpValidation && !vm.stressVm.cbpValidation.ok) &&
      stressResult
    ) {
      const p =
        displayMode === 'today'
          ? stressResult.percentilesReal
          : stressResult.percentilesNominal;
      const stressRows: StressTestYearPercentiles[] = p.p50.map((_, i) => ({
        year: stressResult.firstYear + i,
        badLuck: p.p10[i],
        pessimistic: p.p25[i],
        typical: p.p50[i],
      }));
      map.set('chart-stress-test', buildStressTestTableSpec(stressRows));
    }

    const cashflowRows = vm.incomeView?.cashflowChartRows ?? [];
    if (cashflowRows.length > 0) {
      map.set('chart-cashflow', buildCashflowTableSpec(cashflowRows));
    }

    const breakdownRows = vm.incomeView?.breakdownChartRows ?? [];
    if (breakdownRows.length > 0) {
      map.set(
        'chart-income-breakdown',
        buildIncomeBreakdownTableSpec(breakdownRows),
      );
    }

    if (vm.portfolioFlowsByYear && vm.portfolioFlowsByYear.length > 0) {
      map.set(
        'chart-portfolio-flows',
        buildPortfolioFlowsTableSpec(vm.portfolioFlowsByYear),
      );
    }

    if (taxBurdenRows.length > 0) {
      map.set('chart-tax-health-cost', buildTaxBurdenTableSpec(taxBurdenRows));
    }
    if (rmdRows.length > 0) {
      map.set('chart-rmd', buildRmdTableSpec(rmdRows));
    }
    if (qcdRows.length > 0) {
      map.set('chart-qcd', buildQcdTableSpec(qcdRows));
    }
    if (rothRows.length > 0) {
      map.set('chart-roth-conversions', buildRothConversionsTableSpec(rothRows));
    }

    // Account-balance bands — always present (the host always mounts them).
    map.set(
      'chart-account-balances-tier',
      buildAccountBalancesByTypeTableSpec(
        vm.accountStackTimeline,
        allAccountsForHost,
        stackTypeBucketsForYear,
      ),
    );
    map.set(
      'chart-account-balances-account',
      buildAccountBalancesByAccountTableSpec(
        vm.accountStackTimeline,
        byAccountAccounts,
      ),
    );

    // Expense charts — only when there are expense projection rows. The
    // tables read the ANNUAL (headline) totals from the same projection build,
    // so they tie out to the year-by-year math in every display basis (the
    // chart series themselves stay the monthly run-rate samples the host
    // plots).
    if (expenseProjection.rows.length > 0) {
      map.set(
        'chart-expenses-total',
        buildExpensesTotalTableSpec(expenseProjection.annualRows),
      );
      map.set(
        'chart-expenses-category',
        buildExpensesByCategoryTableSpec(
          expenseProjection.annualCategoryRows,
          expenseProjection.categoryMeta,
        ),
      );
    }

    return map;
  }, [
    vm.displayRows,
    vm.enabledCalculatedMethods,
    vm.isMcBasisActive,
    vm.stressVm,
    vm.incomeView,
    vm.portfolioFlowsByYear,
    vm.accountStackTimeline,
    displayMode,
    allAccountsForHost,
    byAccountAccounts,
    taxBurdenRows,
    rmdRows,
    rothRows,
    qcdRows,
    expenseProjection,
  ]);

  const cancelExport = useCallback(() => {
    exportAbortRef.current?.abort(new Error('Export cancelled.'));
  }, []);

  const runExport = useCallback(async () => {
    if (!reportData || !selectedScenarioId) {
      setExportError("This scenario can't be exported — its projection is unavailable.");
      return;
    }
    setExportError(null);
    setIsExporting(true);

    const gen = ++runGenRef.current;
    const ac = new AbortController();
    exportAbortRef.current = ac;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      // Timeout fires abort() which propagates to both the SVG-capture promise
      // and the build phase (checked before doc.save()), covering the full pipeline.
      timeoutId = setTimeout(() => {
        ac.abort(new Error('PDF export timed out.'));
      }, EXPORT_TIMEOUT_MS);

      // Resolves the moment the signal aborts — raced against both phases so a
      // cancel / timeout unblocks even a hung build (e.g. a stuck lib loader).
      const aborted = new Promise<never>((_, reject) => {
        ac.signal.addEventListener('abort', () => {
          reject(ac.signal.reason instanceof Error ? ac.signal.reason : new Error('Export aborted.'));
        }, { once: true });
      });
      // Never goes unhandled if the run completes before any abort.
      aborted.catch(() => undefined);

      const svgMap = await Promise.race([
        new Promise<Record<string, SVGElement>>((resolve, reject) => {
          svgReadyRef.current = { resolve, reject };
        }),
        aborted,
      ]);

      // Title-page + household-overview + Scenario-page detail for the active
      // scenario.
      const activeReportScenario = reportData.scenarios.find(
        (s) => s.id === selectedScenarioId,
      );

      // Standardized red/amber/green tier for the success figure on the
      // Scenario page (same thresholds as the Plan stress-test + Dashboard).
      const successProbability = vm.stressVm.result?.successProbability ?? null;
      const successProbabilityColor =
        STATUS_HEX.light[
          successTierForPct(
            successProbability == null ? null : Math.round(successProbability * 100),
          )
        ];

      const sectionModel = buildPdfSectionModel({
        scenarioName,
        activeMcBasis,
        activeMethod,
        displayMode,
        unifiedYearTableRows: vm.unifiedYearTableRows,
        portfolioFlowsByYear: vm.portfolioFlowsByYear,
        reportData,
        date: { year: nowYear, month: nowMonthIndex + 1, day: nowDay },
        chartTablesBySection,
        withdrawalGuidanceTableSpec,
        // A beta feature the user has not switched on stays out of the PDF
        // too — the export mirrors what the app shows.
        excludedSectionIds: hiddenBetaPdfSectionIds(isBetaFeatureVisible),
      });

      const svgElementsBySection = new Map<string, SVGElement>(
        Object.entries(svgMap),
      );

      await Promise.race([
        buildAndDownloadPdf({
          sectionModel,
          svgElementsBySection,
          filename: buildPdfFilename({
            scenarioName,
            basisKey: activeBasisLabel,
            date: { year: nowYear, month: nowMonthIndex + 1, day: nowDay },
          }),
          loader: pdfLibLoader,
          signal: ac.signal,
          disclaimer: REPORT_DISCLAIMER,
          overview: reportData.overview,
          successProbability,
          successProbabilityColor,
          atRetirementBalance:
            vm.unifiedYearTableRows.find((r) => r.year === vm.primaryRetirementYear)
              ?.balanceByMethod[activeMethod] ?? null,
          atHorizonBalance:
            vm.unifiedYearTableRows[vm.unifiedYearTableRows.length - 1]
              ?.balanceByMethod[activeMethod] ?? null,
          scenarioDescription: activeReportScenario?.description,
          scenarioNotes: activeReportScenario?.notes,
          scenarioSettingGroups: activeReportScenario?.settingGroups ?? [],
        }),
        aborted,
      ]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A user cancel is not an error surface.
      if (message !== 'Export cancelled.') setExportError(message);
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      exportAbortRef.current = null;
      // Only reset shared state if this run still owns the slot.
      if (runGenRef.current === gen) {
        svgReadyRef.current = null;
        setIsExporting(false);
      }
    }
  }, [
    reportData,
    selectedScenarioId,
    scenarioName,
    activeMcBasis,
    activeMethod,
    displayMode,
    activeBasisLabel,
    vm.unifiedYearTableRows,
    vm.portfolioFlowsByYear,
    vm.stressVm,
    vm.primaryRetirementYear,
    chartTablesBySection,
    withdrawalGuidanceTableSpec,
    isBetaFeatureVisible,
    nowYear,
    nowMonthIndex,
    nowDay,
    pdfLibLoader,
  ]);

  const hasScenarios = scenarios.length > 0;
  // The selected scenario's filing treatment + disclosures.
  const filingAssumptions =
    reportData && selectedScenarioId
      ? (reportData.scenarios.find((s) => s.id === selectedScenarioId)
          ?.filingAssumptions ?? null)
      : null;
  // The standing Roth / required-withdrawal disclosures, including
  // which accounts fell back to a cautious default and which have a WITHHELD
  // required-withdrawal estimate. Household-level (the facts are per account, not
  // per scenario), so it does not depend on the selected scenario.
  const taxProfileDisclosures = reportData?.taxProfileDisclosures ?? [];
  // The selected scenario's health-coverage assumptions:
  // who is on a Marketplace plan, which poverty guidelines size the subsidy,
  // which benchmark plan price was used, and which coverage months were stated.
  const healthAssumptions =
    reportData && selectedScenarioId
      ? (reportData.scenarios.find((s) => s.id === selectedScenarioId)
          ?.healthAssumptions ?? null)
      : null;
  // The selected scenario's market-stress assumptions: what
  // each named stress changes, and the standing no-forecast / approximation
  // disclosures.
  const marketStressAssumptions =
    reportData && selectedScenarioId
      ? (reportData.scenarios.find((s) => s.id === selectedScenarioId)
          ?.marketStressAssumptions ?? null)
      : null;

  return (
    <section aria-labelledby="export-pdf-heading" className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 id="export-pdf-heading" className={pageTitleClass}>
          Export PDF
        </h1>
        <p className="m-0 text-sm text-muted">
          Pick a scenario, basis, and dollar mode, then download a PDF of the
          full Balance Projection plus your report inventory.
        </p>
      </header>

      {readError ? (
        <Alert tone="error">
          We couldn&rsquo;t load your data. Please refresh the page and try
          again.
        </Alert>
      ) : null}

      {configError ? <Alert tone="error">{configError}</Alert> : null}

      {exportError ? (
        <Alert tone="error" role="alert">
          {exportError}
        </Alert>
      ) : null}

      {!hasScenarios && readyAll ? (
        <p className="m-0 text-sm text-muted">
          Add a scenario before exporting a report.
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="export-scenario" className="text-sm text-muted">
            Scenario
          </label>
          <Select
            id="export-scenario"
            className="w-auto min-w-44"
            disabled={isExporting}
            value={selectedScenarioId ?? ''}
            onChange={setSelectedScenarioId}
            options={scenarios.map((s) => ({ value: s.id, label: s.payload.name }))}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="export-basis" className="text-sm text-muted">
            Basis
          </label>
          <Select
            id="export-basis"
            className="w-auto min-w-44"
            disabled={isExporting}
            value={activeMcBasis ?? activeMethod}
            onChange={(next) => {
              if (isMcBasisValue(next)) {
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
                  { value: 'planned', label: PROJECTION_METHOD_LABELS.planned },
                  {
                    value: 'twr',
                    label: TWR_METHOD_LABEL,
                    disabled: !vm.enabledCalculatedMethods.has('twr'),
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
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted">Dollars</span>
          <SegmentedRadioGroup<DisplayMode>
            size="sm"
            ariaLabel="Display unit"
            disabled={isExporting}
            value={displayMode}
            onChange={setDisplayMode}
            options={[
              { value: 'today', label: "Today's dollars" },
              { value: 'future', label: 'Future dollars' },
            ]}
          />
        </div>

        {/* Export action sits to the right of the Dollars control. An invisible
            label mirrors the other fields' label row; the column stretches to
            the row height and the action centers within the control area, so the
            button lines up with the input controls' vertical center. Both
            progress bars (build + simulation) sit to the right of the button. */}
        <div className="flex flex-col gap-1 self-stretch">
          <span aria-hidden="true" className="select-none text-sm text-transparent">
            Export
          </span>
          <div className="flex flex-1 items-center gap-3">
            <Button
              type="button"
              onPress={() => void runExport()}
              isDisabled={!reportData || configError !== null || isExporting}
              className={btnPrimarySmClass}
            >
              Export PDF
            </Button>
            {isExporting ? (
              <>
                <McProgressBar
                  done={0}
                  total={0}
                  label="Building your PDF"
                  className="flex min-w-48 flex-col gap-1"
                />
                <Button type="button" onPress={cancelExport} className={btnSecondarySmClass}>
                  Cancel
                </Button>
              </>
            ) : allMcDisabled ? (
              <McProgressBar done={0} total={0} label="Simulation running…" />
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="m-0 text-base font-semibold text-ink">Preview</h2>
          <ShowAnotherPathButton
            enabled={vm.canShowAnotherPath && !isExporting}
            onShowAnotherPath={vm.showAnotherPath}
          />
        </div>
        <div className="rounded-lg border border-line bg-surface-raised p-4">
          <ProjectionChart
            rows={[...vm.displayRows]}
            enabledCalculatedMethods={new Set(vm.enabledCalculatedMethods)}
            retirementMarkers={[...vm.retirementMarkers]}
            lifeExpectancyMarkers={[...vm.expenseChartMarkers]}
            tooltipMembers={[...vm.tooltipMembers]}
            mcLine={mcLine}
          />
        </div>
      </div>

      {/* The filing treatment this scenario's projections used,
          with its standing approximation disclosures. Always rendered when a
          scenario is selected, so an exported report never presents a retained
          limitation (standard deduction only, federal tax only) as supported
          functionality. The assumption panels sit BELOW the chart so the
          preview is the first thing on screen after the export controls. */}
      {filingAssumptions ? (
        <ReportAssumptionsPanel
          headingId="report-filing-heading"
          title="Filing assumptions"
          disclosures={filingAssumptions.disclosures}
        >
          <dl className="m-0 flex flex-col gap-2 text-sm">
            <div className="flex flex-col gap-0.5">
              <dt className="font-medium text-ink">While both spouses are alive</dt>
              <dd className="m-0 text-muted">{filingAssumptions.whileBothAlive}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="font-medium text-ink">After a spouse dies</dt>
              <dd className="m-0 text-muted">{filingAssumptions.afterADeath}</dd>
            </div>
          </dl>
          {filingAssumptions.unresolvedLegacyDetail ? (
            <Alert tone="warning">
              {filingAssumptions.unresolvedLegacyDetail} The projections kept
              using that older setting unchanged.
            </Alert>
          ) : null}
        </ReportAssumptionsPanel>
      ) : null}

      {/* The health-coverage assumptions this
          scenario's projections used, with the standing rough-benchmark and
          Medicare-premium disclosures. Always rendered when a scenario is
          selected, so an exported report never presents the rough ACA estimate
          as an exchange quote or implies the base Medicare premium is modeled. */}
      {healthAssumptions ? (
        <ReportAssumptionsPanel
          headingId="report-health-heading"
          title="Health coverage assumptions"
          disclosures={healthAssumptions.disclosures}
        >
          <dl className="m-0 flex flex-col gap-2 text-sm">
            <div className="flex flex-col gap-0.5">
              <dt className="font-medium text-ink">Marketplace coverage</dt>
              <dd className="m-0 text-muted">{healthAssumptions.marketplaceCoverage}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="font-medium text-ink">Federal poverty guidelines</dt>
              <dd className="m-0 text-muted">{healthAssumptions.povertyGuidelines}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="font-medium text-ink">Benchmark plan price</dt>
              <dd className="m-0 text-muted">{healthAssumptions.benchmarkPrice}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="font-medium text-ink">Months of coverage</dt>
              <dd className="m-0 text-muted">{healthAssumptions.coverageMonths}</dd>
            </div>
          </dl>
        </ReportAssumptionsPanel>
      ) : null}

      {/* Market-stress assumptions. Always rendered when a
          report can be built, so an exported report never leaves a named stress
          ("higher fees") undefined for the reader. */}
      {marketStressAssumptions ? (
        <ReportAssumptionsPanel
          headingId="report-market-stress-heading"
          title="Market stress assumptions"
          disclosures={marketStressAssumptions.disclosures}
        >
          <dl className="m-0 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
            {marketStressAssumptions.cases.map((c) => (
              <div key={c.name} className="flex flex-col">
                <dt className="font-medium text-ink">{c.name}</dt>
                <dd className="m-0 text-muted">{c.changed}</dd>
              </div>
            ))}
          </dl>
        </ReportAssumptionsPanel>
      ) : null}

      {/* Roth / required-withdrawal disclosures. Always rendered when
          a report can be built, so an exported report never presents a cautious
          default (no recorded basis, an unmet five-year clock) or a withheld
          inherited-account estimate as a modeled fact. */}
      {taxProfileDisclosures.length > 0 ? (
        <ReportAssumptionsPanel
          headingId="report-tax-profile-heading"
          title="Roth and required-withdrawal assumptions"
          disclosures={taxProfileDisclosures}
        />
      ) : null}

      {/* Off-screen render host — mounted ONLY while exporting so the charts
          aren't rendered (and don't run the SVG engine) on every page view. */}
      {isExporting && reportData ? (
        <ReportPagePdfRenderHost
          displayRows={vm.displayRows}
          enabledCalculatedMethods={vm.enabledCalculatedMethods}
          retirementMarkers={vm.retirementMarkers}
          lifeExpectancyMarkers={vm.expenseChartMarkers}
          tooltipMembers={vm.tooltipMembers}
          accounts={allAccountsForHost}
          byAccountAccounts={byAccountAccounts}
          accountStackTimeline={vm.accountStackTimeline}
          accountStackBoundaryYear={vm.accountStackBoundaryYear}
          accountStackMarkers={vm.balanceProjectionChartMarkers}
          customTiers={vm.customTiers}
          excludedAccountIds={vm.excludedAccountIds}
          methodLabel={activeBasisLabel}
          activeMethod={activeMethod}
          mcLine={mcLine}
          expenseRows={expenseProjection.rows}
          expenseCategoryRows={expenseProjection.categoryRows}
          expenseCategoryMeta={expenseProjection.categoryMeta}
          expenseMarkers={expenseProjection.markers}
          stressVm={vm.stressVm}
          cashflowRows={vm.incomeView?.cashflowChartRows ?? []}
          breakdownRows={vm.incomeView?.breakdownChartRows ?? []}
          depletionYear={vm.incomeView?.depletionYear ?? null}
          categoryMeta={vm.categoryMeta}
          portfolioRows={vm.portfolioFlowsByYear ?? []}
          taxBurdenRows={taxBurdenRows}
          rmdRows={rmdRows}
          rothRows={rothRows}
          qcdRows={qcdRows}
          onReady={onHostReady}
          onError={onHostError}
        />
      ) : null}
    </section>
  );
};
