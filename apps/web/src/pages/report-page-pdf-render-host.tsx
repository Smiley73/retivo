/** Off-screen host that renders the Balance Projection charts from the page's already-computed data and hands each `<svg>` back via onReady, keyed by section-manifest id, for svg2pdf.
* Rendered off-canvas with a fixed non-zero width (never display:none, which makes the SVG engine measure 0) inside a forced-light ThemeProvider, since the PDF is always light-palette (see "Chart colours" in docs/ui-conventions.md). */
import React, { useEffect, useRef } from 'react';
import { ForcedThemeProvider } from '../contexts/ThemeContext';
import { PdfCaptureContext } from '../components/charts/engine/pdf-capture-context';
import { ProjectionChart } from '../components/ProjectionChart';
import type {
  ProjectionChartRow,
  ProjectionMethod,
  RetirementMarker,
} from '../components/ProjectionChart';
import {
  CashflowProjectionChart,
  type CashflowChartMarker,
  type CashflowMonthlyPoint,
} from '../components/CashflowProjectionChart';
import {
  IncomeBreakdownChart,
  type IncomeBreakdownPoint,
} from '../components/IncomeBreakdownChart';
import {
  PortfolioFlowsChart,
  type PortfolioFlowsChartRow,
} from '../components/PortfolioFlowsChart';
import { TaxBurdenChart, type TaxBurdenChartRow } from '../components/TaxBurdenChart';
import { RmdChart, type RmdChartRow } from '../components/RmdChart';
import {
  RothConversionsChart,
  type RothConversionsChartRow,
} from '../components/RothConversionsChart';
import { QcdChart } from '../components/QcdChart';
import type { QcdPdfRow } from './balance-projection-burden-rows';
import { PlanStressTestChart } from '../components/PlanStressTestChart';
import type { PlanStressTestVm } from '../components/PlanStressTestSection';
import type { TooltipMember } from '../components/tooltip-member';
import type { CategoryMeta } from '../lib/category-palette';
import { AccountBalanceStackBand } from './balance-projection-page-account-balance-stack';
import type { StackBandYear } from './balance-projection-page-account-balance-stack';
import type { AccountType, AccountTaxTreatment } from '../db/types';
import { ExpensesProjectionChart } from '../components/ExpensesProjectionChart';
import { ExpensesCategoryChart } from '../components/ExpensesCategoryChart';
import type { ExpenseProjectionMonthlyPoint } from '../lib/expense-projection';
import type { ExpenseCategoryMonthlyPoint } from '../lib/expense-projection';

/** Account metadata the account-balance bands group by (mirrors
 *  `AccountBalanceStackBandProps.accounts`). */
interface RenderHostAccount {
  readonly id: string;
  readonly name: string;
  readonly ownerDisplayName: string;
  readonly type: AccountType;
  readonly taxTreatment?: AccountTaxTreatment;
}

export interface ReportPagePdfRenderHostProps {
  /** Per-year display rows for the balance line chart (already deflated to the
   *  active display basis — the page's `displayRows`). */
  readonly displayRows: ReadonlyArray<ProjectionChartRow>;
  /** Calculated methods that have a contributing account (drives which lines
   *  the per-year chart draws). */
  readonly enabledCalculatedMethods: ReadonlySet<Exclude<ProjectionMethod, 'planned'>>;
  /** Retirement reference-line markers for the per-year chart. */
  readonly retirementMarkers: ReadonlyArray<RetirementMarker>;
  /** Life-expectancy / death markers shared across the charts. */
  readonly lifeExpectancyMarkers: ReadonlyArray<CashflowChartMarker>;
  /** Household members for the chart tooltips' "<First> (age N)" rows. */
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
  /** Resolved accounts for the account-balance bands. */
  readonly accounts: ReadonlyArray<RenderHostAccount>;
  /** Scenario-visible accounts for only the per-account band, already ordered. */
  readonly byAccountAccounts: ReadonlyArray<RenderHostAccount>;
  /** Unified, display-deflated account-balance timeline (the page's
   *  `accountStackTimeline`). */
  readonly accountStackTimeline: ReadonlyArray<StackBandYear>;
  /** Last actual (historical) year — the dashed actual→projected boundary. */
  readonly accountStackBoundaryYear: number | null;
  /** Markers for the account-balance bands. */
  readonly accountStackMarkers: ReadonlyArray<CashflowChartMarker>;
  /** Custom drawdown tiers (per-tier grouping) or null for per-type. */
  readonly customTiers: ReadonlyArray<ReadonlyArray<string>> | null;
  /** Excluded account ids under a customOrder strategy. */
  readonly excludedAccountIds: ReadonlyArray<string>;
  /** Basis label suffixed onto the band titles. */
  readonly methodLabel: string;
  /** Active deterministic method (Planned / TWR). */
  readonly activeMethod: ProjectionMethod;
  /** MC representative-run line color + label, or null for a deterministic basis. */
  readonly mcLine?: { color: string; label: string } | null;
  /** Monthly expense projection rows for the expense-overview chart. */
  readonly expenseRows: ReadonlyArray<ExpenseProjectionMonthlyPoint>;
  /** Monthly per-category expense rows for the expenses-by-category chart. */
  readonly expenseCategoryRows: ReadonlyArray<ExpenseCategoryMonthlyPoint>;
  /** Display metadata for each active category (id, name, colour). */
  readonly expenseCategoryMeta: ReadonlyArray<{ id: string; name: string; color: string }>;
  /** Life-expectancy markers for the expense charts. */
  readonly expenseMarkers: ReadonlyArray<CashflowChartMarker>;
  /** Stress-test (Monte Carlo fan) view model. The chart only renders — and is
   *  only captured — when it has a result (`!hasNoAccounts`, CBP-valid,
   *  `result` non-null); otherwise no stress page is emitted. */
  readonly stressVm: PlanStressTestVm;
  /** Per-year expected-cashflow rows (`incomeView.cashflowChartRows`). */
  readonly cashflowRows: ReadonlyArray<CashflowMonthlyPoint>;
  /** Per-year income-breakdown rows (`incomeView.breakdownChartRows`). */
  readonly breakdownRows: ReadonlyArray<IncomeBreakdownPoint>;
  /** First-depleted year for the cashflow / income-breakdown dashed marker. */
  readonly depletionYear: number | null;
  /** Active expense categories for the cashflow "by category" stack. */
  readonly categoryMeta: ReadonlyArray<CategoryMeta>;
  /** Annual portfolio-flow rows (`vm.portfolioFlowsByYear`). */
  readonly portfolioRows: ReadonlyArray<PortfolioFlowsChartRow>;
  /** Tax & health-cost burden rows (already built via the Part-B builder). */
  readonly taxBurdenRows: ReadonlyArray<TaxBurdenChartRow>;
  /** RMD rows (already built via the Part-B builder). */
  readonly rmdRows: ReadonlyArray<RmdChartRow>;
  /** Roth-conversion rows (already built via the Part-B builder). */
  readonly rothRows: ReadonlyArray<RothConversionsChartRow>;
  /** QCD per-year rows (already built via `buildQcdRows`). */
  readonly qcdRows: ReadonlyArray<QcdPdfRow>;
  /** Called once every chart's geometry has committed and its `<svg>` node is
   *  captured, keyed by `section-manifest.ts` section id. */
  readonly onReady: (svgMap: Record<string, SVGElement>) => void;
  /** Called when geometry never commits or a capture throws. */
  readonly onError: (err: Error) => void;
}

const CAPTURE_WIDTH_PX = 800;

const SECTION_BALANCE = 'chart-balance';
const SECTION_STRESS_TEST = 'chart-stress-test';
const SECTION_CASHFLOW = 'chart-cashflow';
const SECTION_INCOME_BREAKDOWN = 'chart-income-breakdown';
const SECTION_PORTFOLIO_FLOWS = 'chart-portfolio-flows';
const SECTION_TAX_HEALTH_COST = 'chart-tax-health-cost';
const SECTION_RMD = 'chart-rmd';
const SECTION_QCD = 'chart-qcd';
const SECTION_ROTH_CONVERSIONS = 'chart-roth-conversions';
const SECTION_ACCT_TIER = 'chart-account-balances-tier';
const SECTION_ACCT_ACCOUNT = 'chart-account-balances-account';
const SECTION_EXPENSE_TOTAL = 'chart-expenses-total';
const SECTION_EXPENSE_CATEGORY = 'chart-expenses-category';

// True when the stress-test VM has a renderable Monte Carlo result. Mirrors
// `PlanStressTestChart`'s own render gates: no accounts → null; a failed CBP
// validation → a remediation banner (no fan svg); otherwise a fan renders only
// when `result` is non-null. Only then is a stress page captured/emitted.
function stressHasResult(vm: PlanStressTestVm): boolean {
  if (vm.hasNoAccounts) return false;
  if (vm.cbpValidation && !vm.cbpValidation.ok) return false;
  return vm.result !== null;
}

const GEOMETRY_TIMEOUT_MS = 10_000;

// Skips decorative icon SVGs inside a Button (e.g. ChartInfoPopover) to land on the chart SVG.
function findChartSvg(container: Element | null): SVGElement | null {
  if (!container) return null;
  const found = Array.from(container.querySelectorAll('svg')).find(
    (s) => !s.closest('button'),
  );
  return (found as SVGElement | undefined) ?? null;
}

export const ReportPagePdfRenderHost: React.FC<ReportPagePdfRenderHostProps> = ({
  displayRows,
  enabledCalculatedMethods,
  retirementMarkers,
  lifeExpectancyMarkers,
  tooltipMembers,
  accounts,
  byAccountAccounts,
  accountStackTimeline,
  accountStackBoundaryYear,
  accountStackMarkers,
  customTiers,
  excludedAccountIds,
  methodLabel,
  onReady,
  onError,
  activeMethod,
  mcLine,
  expenseRows,
  expenseCategoryRows,
  expenseCategoryMeta,
  expenseMarkers,
  stressVm,
  cashflowRows,
  breakdownRows,
  depletionYear,
  categoryMeta,
  portfolioRows,
  taxBurdenRows,
  rmdRows,
  rothRows,
  qcdRows,
}) => {
  const balanceRef = useRef<HTMLDivElement | null>(null);
  const stressRef = useRef<HTMLDivElement | null>(null);
  const cashflowRef = useRef<HTMLDivElement | null>(null);
  const breakdownRef = useRef<HTMLDivElement | null>(null);
  const portfolioRef = useRef<HTMLDivElement | null>(null);
  const taxRef = useRef<HTMLDivElement | null>(null);
  const rmdRef = useRef<HTMLDivElement | null>(null);
  const qcdRef = useRef<HTMLDivElement | null>(null);
  const rothRef = useRef<HTMLDivElement | null>(null);
  const tierRef = useRef<HTMLDivElement | null>(null);
  const accountRef = useRef<HTMLDivElement | null>(null);
  const expenseTotalRef = useRef<HTMLDivElement | null>(null);
  const expenseCategoryRef = useRef<HTMLDivElement | null>(null);

  const showStress = stressHasResult(stressVm);

  useEffect(() => {
    let cancelled = false;
    const start = Date.now();

    // Poll on rAF: each container needs an <svg> with a non-zero viewBox width (set from the measured width), and lazy chart impls need ticks to resolve their dynamic import.
    const collectSvgs = (): Record<string, SVGElement> | null => {
      const balanceSvg = findChartSvg(balanceRef.current);
      const tierSvg = findChartSvg(tierRef.current);
      const accountSvg = findChartSvg(accountRef.current);
      if (!balanceSvg || !tierSvg || !accountSvg) return null;
      const map: Record<string, SVGElement> = {
        [SECTION_BALANCE]: balanceSvg,
        [SECTION_ACCT_TIER]: tierSvg,
        [SECTION_ACCT_ACCOUNT]: accountSvg,
      };
      // An optional chart blocks readiness only while it has data to render; with no data it is never mounted.
      const optional: Array<{
        render: boolean;
        ref: React.RefObject<HTMLDivElement | null>;
        id: string;
      }> = [
        { render: showStress, ref: stressRef, id: SECTION_STRESS_TEST },
        { render: cashflowRows.length > 0, ref: cashflowRef, id: SECTION_CASHFLOW },
        { render: breakdownRows.length > 0, ref: breakdownRef, id: SECTION_INCOME_BREAKDOWN },
        { render: portfolioRows.length > 0, ref: portfolioRef, id: SECTION_PORTFOLIO_FLOWS },
        { render: taxBurdenRows.length > 0, ref: taxRef, id: SECTION_TAX_HEALTH_COST },
        { render: rmdRows.length > 0, ref: rmdRef, id: SECTION_RMD },
        { render: qcdRows.length > 0, ref: qcdRef, id: SECTION_QCD },
        { render: rothRows.length > 0, ref: rothRef, id: SECTION_ROTH_CONVERSIONS },
      ];
      for (const o of optional) {
        if (!o.render) continue;
        const svg = findChartSvg(o.ref.current);
        if (!svg) return null;
        map[o.id] = svg;
      }
      if (expenseRows.length > 0) {
        const expenseTotalSvg = findChartSvg(expenseTotalRef.current);
        const expenseCategorySvg = findChartSvg(expenseCategoryRef.current);
        if (!expenseTotalSvg || !expenseCategorySvg) return null;
        map[SECTION_EXPENSE_TOTAL] = expenseTotalSvg;
        map[SECTION_EXPENSE_CATEGORY] = expenseCategorySvg;
      }
      return map;
    };

    const tick = (): void => {
      if (cancelled) return;
      try {
        const svgs = collectSvgs();
        if (svgs) {
          onReady(svgs);
          return;
        }
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      if (Date.now() - start > GEOMETRY_TIMEOUT_MS) {
        onError(new Error('PDF chart geometry did not commit in time.'));
        return;
      }
      // jsdom shims rAF to a macrotask so the lazy chart import resolves between ticks.
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(tick);
      } else {
        setTimeout(tick, 16);
      }
    };
    tick();

    return () => {
      cancelled = true;
    };
  }, [
    onReady,
    onError,
    displayRows,
    accountStackTimeline,
    accounts,
    byAccountAccounts,
    customTiers,
    expenseRows,
    expenseCategoryRows,
    showStress,
    cashflowRows,
    breakdownRows,
    portfolioRows,
    taxBurdenRows,
    rmdRows,
    rothRows,
    qcdRows,
  ]);

  return (
    <div
      data-testid="pdf-render-host"
      aria-hidden="true"
      className="pointer-events-none"
      // eslint-disable-next-line no-restricted-syntax -- runtime-computed geometry: off-screen non-zero-width capture surface the token scale can't express (must not be display:none or the chart engine measures width 0)
      style={{ position: 'fixed', left: -99999, top: 0, width: CAPTURE_WIDTH_PX }}
    >
      <ForcedThemeProvider resolvedTheme="light">
        {/* Capture flag: every chart below renders an in-SVG legend so it
            reaches the PDF (svg2pdf captures only the `<svg>`). */}
        <PdfCaptureContext.Provider value={true}>
          <div ref={balanceRef} data-section={SECTION_BALANCE}>
            <ProjectionChart
              rows={[...displayRows]}
              enabledCalculatedMethods={new Set(enabledCalculatedMethods)}
              retirementMarkers={[...retirementMarkers]}
              lifeExpectancyMarkers={[...lifeExpectancyMarkers]}
              tooltipMembers={[...tooltipMembers]}
              mcLine={mcLine ?? null}
            />
          </div>
          {showStress && (
            <div ref={stressRef} data-section={SECTION_STRESS_TEST}>
              <PlanStressTestChart
                vm={stressVm}
                dataTableOpen={false}
                onToggleDataTable={() => {}}
              />
            </div>
          )}
          {cashflowRows.length > 0 && (
            <div ref={cashflowRef} data-section={SECTION_CASHFLOW}>
              <CashflowProjectionChart
                rows={[...cashflowRows]}
                markers={[...accountStackMarkers]}
                members={[...tooltipMembers]}
                depletionYear={depletionYear}
                granularity="yearly"
                categoryMeta={categoryMeta}
              />
            </div>
          )}
          {breakdownRows.length > 0 && (
            <div ref={breakdownRef} data-section={SECTION_INCOME_BREAKDOWN}>
              <IncomeBreakdownChart
                rows={[...breakdownRows]}
                markers={[...accountStackMarkers]}
                members={[...tooltipMembers]}
                depletionYear={depletionYear}
                granularity="yearly"
              />
            </div>
          )}
          {portfolioRows.length > 0 && (
            <div ref={portfolioRef} data-section={SECTION_PORTFOLIO_FLOWS}>
              <PortfolioFlowsChart
                rows={[...portfolioRows]}
                markers={[...accountStackMarkers]}
                members={[...tooltipMembers]}
                depletionYear={depletionYear}
              />
            </div>
          )}
          {taxBurdenRows.length > 0 && (
            <div ref={taxRef} data-section={SECTION_TAX_HEALTH_COST}>
              <TaxBurdenChart
                rows={[...taxBurdenRows]}
                markers={[...accountStackMarkers]}
                members={[...tooltipMembers]}
              />
            </div>
          )}
          {rmdRows.length > 0 && (
            <div ref={rmdRef} data-section={SECTION_RMD}>
              <RmdChart
                rows={[...rmdRows]}
                markers={[...accountStackMarkers]}
                members={[...tooltipMembers]}
              />
            </div>
          )}
          {qcdRows.length > 0 && (
            <div ref={qcdRef} data-section={SECTION_QCD}>
              <QcdChart
                rows={qcdRows.map((r) => ({ year: r.year, dollars: r.qcdDollars }))}
                members={[...tooltipMembers]}
              />
            </div>
          )}
          {rothRows.length > 0 && (
            <div ref={rothRef} data-section={SECTION_ROTH_CONVERSIONS}>
              <RothConversionsChart
                rows={[...rothRows]}
                members={[...tooltipMembers]}
              />
            </div>
          )}
          <div ref={tierRef} data-section={SECTION_ACCT_TIER}>
            <AccountBalanceStackBand
              accounts={accounts}
              rows={accountStackTimeline}
              boundaryYear={accountStackBoundaryYear}
              customTiers={customTiers}
              excludedAccountIds={excludedAccountIds}
              markers={accountStackMarkers}
              members={tooltipMembers}
              methodLabel={methodLabel}
              showExcludedToggle={false}
            />
          </div>
          <div ref={accountRef} data-section={SECTION_ACCT_ACCOUNT}>
            <AccountBalanceStackBand
              accounts={byAccountAccounts}
              rows={accountStackTimeline}
              boundaryYear={accountStackBoundaryYear}
              customTiers={customTiers}
              excludedAccountIds={excludedAccountIds}
              markers={accountStackMarkers}
              members={tooltipMembers}
              methodLabel={methodLabel}
              showExcludedToggle={false}
              initialGroupBy="account"
            />
          </div>
          <div ref={expenseTotalRef} data-section={SECTION_EXPENSE_TOTAL}>
            <ExpensesProjectionChart
              rows={[...expenseRows]}
              markers={[...expenseMarkers]}
              members={[...tooltipMembers]}
              enableZoom={false}
            />
          </div>
          <div ref={expenseCategoryRef} data-section={SECTION_EXPENSE_CATEGORY}>
            <ExpensesCategoryChart
              rows={[...expenseCategoryRows]}
              categories={expenseCategoryMeta}
              markers={[...expenseMarkers]}
              members={[...tooltipMembers]}
            />
          </div>
          <span hidden>{activeMethod}</span>
        </PdfCaptureContext.Provider>
      </ForcedThemeProvider>
    </div>
  );
};
