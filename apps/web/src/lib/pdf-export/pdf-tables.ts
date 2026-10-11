/**
 * Adapters turning ALREADY display-transformed view-model rows into
 * jspdf-autotable-compatible `{ head, body }` specs.
 *
 * CRITICAL: these adapters NEVER deflate. The view-model
 * (`deriveBalanceProjectionDisplayData`) has already applied `viewDeflator` /
 * `basisDeflator` to every row before it reaches here, so the adapters only
 * format the already-display-basis numbers into table cells. Re-deflating here
 * would double-apply the factor (and, worse, flatten away a high-CPI MC path's
 * own-CPI deflation back onto the flat scenario rate — the exact bug these
 * adapters exist to avoid).
 *
 * Return shape is plain data (`{ head: string[][]; body: string[][] }`) so the
 * autotable call itself stays in `build-pdf.ts` — no jspdf-autotable import
 * here. Framework-free: pure functions, no React / DOM.
 */
import type { YearlyTableRow } from '../../pages/balance-projection-page-yearly';
import type { PortfolioFlowYear } from '../../pages/balance-projection-page-yearly-builders';
import type {
  ReportAccount,
  ReportExpense,
  ReportIncomeStream,
} from '../report-data';
import type { ReportRothTaxFreeRow } from '../report-roth-tax-free';
import type {
  ProjectionChartRow,
  ProjectionMethod,
} from '../../components/ProjectionChart';
import type { CashflowMonthlyPoint } from '../cashflow-chart-types';
import type { IncomeBreakdownPoint } from '../../components/IncomeBreakdownChart';
import type { TaxBurdenChartRow } from '../../components/TaxBurdenChart';
import type { RmdChartRow } from '../../components/RmdChart';
import type { RothConversionsChartRow } from '../../components/RothConversionsChart';
import type { QcdPdfRow } from '../../pages/balance-projection-burden-rows';
import type {
  StackBandYear,
  StackBandAccountYear,
} from '../account-balance-stack-timeline';
import type {
  ExpenseProjectionPoint,
  ExpenseCategoryYearPoint,
} from '../expense-projection';
import type { GuidanceYearRow } from '../../pages/withdrawal-guidance-data';
import type { RmdAggregationGroup } from '../rmd-aggregation-groups';
import { aggregationTypeLabel } from '../../pages/withdrawal-guidance-labels';
import { PROJECTION_METHOD_LABELS } from '../projection-method-labels';
import {
  sortReportAccounts,
  sortReportExpenses,
  sortReportIncomeStreams,
} from '../report-table-ordering';
import { pdfSectionTitle } from './section-manifest';

/** A table spec autotable consumes: header/body matrices plus an optional footer. */
export interface PdfTableSpec {
  readonly head: string[][];
  readonly body: string[][];
  readonly foot?: string[][];
}

/** Format an already-display-basis dollar value (no deflation) as a whole
 *  dollar string. `null` renders as an em dash. */
export function formatDollars(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const rounded = Math.round(value);
  return rounded.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/** Format a percent value (already a percent, e.g. `5.5`) to one decimal. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(1)}%`;
}

/**
 * Year-by-year detail adapter. Reads the view-model's `YearlyTableRow` cells
 * verbatim (each already in the display basis: the MC-sourced Balance + Gains
 * columns are `basisDeflator`-deflated upstream, NOT re-deflated here).
 */
export function buildYearByYearTableSpec(
  rows: ReadonlyArray<YearlyTableRow>,
  activeMethod: 'planned' | 'twr',
): PdfTableSpec {
  const head = [
    ['Year', 'Balance', 'Income', 'Withdrawal', 'Expenses', 'Shortfall', 'Gains'],
  ];
  const body = rows.map((r) => [
    String(r.year),
    formatDollars(r.balanceByMethod[activeMethod]),
    formatDollars(r.totalIncome),
    formatDollars(r.withdrawal),
    formatDollars(r.expenses),
    formatDollars(r.shortfall),
    formatDollars(r.gains),
  ]);
  return { head, body };
}

/**
 * Annual portfolio-flow adapter. The flow rows are already deflated upstream
 * (deterministic flows by `viewDeflator`, MC drawdown flows by `basisDeflator`)
 * — pass them through unchanged.
 */
export function buildPortfolioFlowsTableSpec(
  rows: ReadonlyArray<PortfolioFlowYear>,
): PdfTableSpec {
  const head = [
    [
      'Year',
      'Contributions',
      'Gains',
      'Deposits',
      'Withdrawals',
      'Charitable (QCD)',
      'Net change',
    ],
  ];
  const body = rows.map((r) => [
    String(r.year),
    formatDollars(r.contributions),
    formatDollars(r.gains),
    formatDollars(r.deposits),
    formatDollars(r.withdrawals),
    formatDollars(r.qcd),
    formatDollars(r.netChange),
  ]);
  return { head, body };
}

/** Report accounts inventory adapter (current values, today's dollars). */
/** Human labels for an account's tax treatment. */
const TAX_TREATMENT_LABELS: Record<string, string> = {
  PRE_TAX: 'Pre-tax',
  POST_TAX: 'Post-tax',
  MIXED: 'Mixed',
  HSA: 'HSA',
  ROTH: 'Roth',
};

export function buildReportAccountsTableSpec(
  accounts: ReadonlyArray<ReportAccount>,
): PdfTableSpec {
  const head = [
    [
      'Account',
      'Type',
      'Tax',
      'Balance',
      'Planned Return',
      'Historical Return',
      'Annual contributions',
    ],
  ];
  const body = sortReportAccounts(accounts).map((a) => [
    a.name,
    a.type,
    TAX_TREATMENT_LABELS[a.taxTreatment] ?? a.taxTreatment,
    formatDollars(a.currentBalance),
    formatPercent(a.configuredReturnPct),
    formatPercent(a.historicalReturnPct),
    formatDollars(a.plannedContributionPreTax + a.plannedContributionPostTax),
  ]);
  return { head, body };
}

/**
 * Roth tax-free amounts adapter. The two row kinds state DIFFERENT
 * things and must be described accordingly (see `report-roth-tax-free.ts`):
 * a person row is what comes out tax-free FIRST from that member's own Roth
 * IRAs (contribution basis plus remaining conversion-lot principal); an
 * employer row is a plan's recorded Roth rollover BASIS, not an amount
 * withdrawable tax-free (a nonqualified designated-Roth distribution is
 * pro-rata between basis and earnings). No header or cell describes the
 * employer figure as tax-free. Generated cells are ASCII, em dash only
 * (jsPDF's standard font has no glyph for other punctuation).
 */
const ROTH_TAX_FREE_DESCRIPTIONS: Record<ReportRothTaxFreeRow['kind'], string> = {
  person:
    'Contributions and past conversions — what comes out tax-free first.',
  employer:
    "The plan's recorded Roth rollover basis — not tax-free by itself: a withdrawal before the plan qualifies is part basis, part earnings.",
};

export function buildRothTaxFreeTableSpec(
  rows: ReadonlyArray<ReportRothTaxFreeRow>,
): PdfTableSpec {
  const head = [['Person or account', 'What this amount is', 'Amount']];
  const body = rows.map((r) => [
    r.label,
    ROTH_TAX_FREE_DESCRIPTIONS[r.kind],
    formatDollars(r.amount),
  ]);
  return { head, body };
}

/** Report expenses inventory adapter (annual amounts, today's dollars). */
export function buildReportExpensesTableSpec(
  expenses: ReadonlyArray<ReportExpense>,
): PdfTableSpec {
  const head = [['Expense', 'Category', 'Type', 'Annual amount', 'Starts', 'Ends']];
  const body = sortReportExpenses(expenses).map((e) => [
    e.name,
    e.categoryName,
    e.classification === 'essential' ? 'Essential' : 'Discretionary',
    formatDollars(e.annualAmount),
    e.startLabel,
    e.endLabel,
  ]);
  return { head, body };
}

/** Report income inventory adapter (annual amounts, today's dollars). */
export function buildReportIncomeTableSpec(
  streams: ReadonlyArray<ReportIncomeStream>,
): PdfTableSpec {
  const head = [['Income', 'Owner', 'Annual amount', 'Schedule', 'Grows with']];
  const body = sortReportIncomeStreams(streams).map((s) => [
    s.name,
    s.memberName,
    formatDollars(s.annualAmount),
    s.scheduleLabel,
    s.tracksInflation
      ? 'Inflation'
      : s.colaPct != null
        ? `${s.colaPct}% COLA`
        : 'Fixed',
  ]);
  return { head, body };
}

// ---------------------------------------------------------------------------
// Per-chart data tables (rendered UNDER each chart in the PDF). Every table is
// per calendar year and mirrors the SAME display-basis numbers its chart plots
// — the monthly chart series are aggregated to annual via `aggregateByYear`,
// the already-annual series (balance line, portfolio flows, burden/RMD/Roth,
// account stack) are projected column-by-column. NEVER re-deflated.
// ---------------------------------------------------------------------------

/** Sum the selected numeric `fields` of `rows` per calendar `year`, preserving
 *  first-seen year order. The single annual aggregation helper the monthly
 *  chart tables (cashflow, income breakdown, expenses) share; rows that are
 *  already one-per-year (the yearly-granularity cashflow/breakdown series)
 *  pass through with each year's lone value. */
export function aggregateByYear<K extends string>(
  rows: ReadonlyArray<{ year: number } & Record<K, number>>,
  fields: ReadonlyArray<K>,
): Array<{ year: number } & Record<K, number>> {
  const byYear = new Map<number, { year: number } & Record<string, number>>();
  const order: number[] = [];
  for (const row of rows) {
    let acc = byYear.get(row.year);
    if (!acc) {
      acc = { year: row.year };
      for (const f of fields) acc[f] = 0;
      byYear.set(row.year, acc);
      order.push(row.year);
    }
    for (const f of fields) acc[f] += row[f];
  }
  return order.map((y) => byYear.get(y)!) as Array<
    { year: number } & Record<K, number>
  >;
}

/** Coalesce a method's `*Solid` / `*Dashed` channels to a single per-year
 *  value (whichever is non-null; the shared boundary year carries both and the
 *  solid wins). Returns `null` when the method has no value that year. */
function coalesceChannel(
  solid: number | null | undefined,
  dashed: number | null | undefined,
): number | null {
  if (solid !== null && solid !== undefined) return solid;
  if (dashed !== null && dashed !== undefined) return dashed;
  return null;
}

/**
 * Balance-projection line table (mirrors `ProjectionChart`'s `displayRows`).
 * One row per calendar year; each method's Solid/Dashed channels coalesce to a
 * single value. The TWR column is included only when Historical is enabled, and
 * the Monte Carlo column only when an MC basis is active (matches which lines
 * the chart draws). Values are already display-basis.
 */
export function buildBalanceTableSpec(
  rows: ReadonlyArray<ProjectionChartRow>,
  enabledCalculatedMethods: ReadonlySet<Exclude<ProjectionMethod, 'planned'>>,
  isMcBasisActive: boolean,
): PdfTableSpec {
  const showTwr = enabledCalculatedMethods.has('twr');
  const head = [
    [
      'Year',
      PROJECTION_METHOD_LABELS.planned,
      ...(showTwr ? [PROJECTION_METHOD_LABELS.twr] : []),
      ...(isMcBasisActive ? ['Monte Carlo'] : []),
    ],
  ];
  const body = rows.map((r) => {
    const cells = [
      String(r.year),
      formatDollars(coalesceChannel(r.plannedSolid, r.plannedDashed)),
    ];
    if (showTwr) cells.push(formatDollars(coalesceChannel(r.twrSolid, r.twrDashed)));
    if (isMcBasisActive) cells.push(formatDollars(coalesceChannel(r.mcSolid, r.mcDashed)));
    return cells;
  });
  return { head, body };
}

/** One per-year percentile triple the stress-test fan plots. Mirrors the
 *  on-screen stress data table (`p10`/`p25`/`p50` at `firstYear + i`) — the MC
 *  engine exposes only these three percentiles (no P75/P90). */
export interface StressTestYearPercentiles {
  readonly year: number;
  readonly badLuck: number;
  readonly pessimistic: number;
  readonly typical: number;
}

/**
 * Stress-test (Monte Carlo fan) table. Columns mirror the chart's plotted
 * percentile bands AND the on-screen stress data table: Year, Bad-luck (P10),
 * Pessimistic (P25), Typical (P50). The caller reads the SAME
 * `percentilesReal`/`percentilesNominal` series the fan draws (display basis) —
 * no statistic is recomputed here.
 */
export function buildStressTestTableSpec(
  rows: ReadonlyArray<StressTestYearPercentiles>,
): PdfTableSpec {
  const head = [['Year', 'Bad-luck', 'Pessimistic', 'Typical']];
  const body = rows.map((r) => [
    String(r.year),
    formatDollars(r.badLuck),
    formatDollars(r.pessimistic),
    formatDollars(r.typical),
  ]);
  return { head, body };
}

/**
 * Expected-cashflow table (mirrors `CashflowProjectionChart`). The chart's
 * per-sample rows are aggregated to annual. Columns: Year, Essential,
 * Discretionary, Taxes, Total income, Shortfall (the `shortfallHeight` band).
 */
export function buildCashflowTableSpec(
  rows: ReadonlyArray<CashflowMonthlyPoint>,
): PdfTableSpec {
  const annual = aggregateByYear(rows, [
    'essential',
    'discretionary',
    'taxes',
    'totalIncome',
    'shortfallHeight',
  ]);
  const head = [
    ['Year', 'Essential', 'Discretionary', 'Taxes', 'Total income', 'Shortfall'],
  ];
  const body = annual.map((r) => [
    String(r.year),
    formatDollars(r.essential),
    formatDollars(r.discretionary),
    formatDollars(r.taxes),
    formatDollars(r.totalIncome),
    formatDollars(r.shortfallHeight),
  ]);
  return { head, body };
}

/** The income-breakdown stripes, in chart stack order, with their column
 *  labels. A stripe whose annual values are all zero across the horizon is
 *  omitted from the table (matches the chart suppressing an empty stripe). */
const INCOME_BREAKDOWN_STRIPES: ReadonlyArray<{
  readonly field: keyof Pick<
    IncomeBreakdownPoint,
    'ss' | 'pensionAnnuity' | 'partTime' | 'oneOff' | 'portfolioAdd' | 'withdrawal'
  >;
  readonly label: string;
}> = [
  { field: 'ss', label: 'Social Security' },
  { field: 'pensionAnnuity', label: 'Pension/annuity' },
  { field: 'partTime', label: 'Part-time' },
  { field: 'oneOff', label: 'One-off' },
  { field: 'portfolioAdd', label: 'Portfolio additions' },
  { field: 'withdrawal', label: 'Withdrawal' },
];

/**
 * Income-breakdown table (mirrors `IncomeBreakdownChart`). Per-sample rows
 * aggregate to annual; a column is emitted only for stripes that are non-zero
 * somewhere in the horizon (an all-zero stripe is dropped — the chart hides it
 * too).
 */
export function buildIncomeBreakdownTableSpec(
  rows: ReadonlyArray<IncomeBreakdownPoint>,
): PdfTableSpec {
  const fields = INCOME_BREAKDOWN_STRIPES.map((s) => s.field);
  const annual = aggregateByYear(rows, fields);
  const active = INCOME_BREAKDOWN_STRIPES.filter((s) =>
    annual.some((r) => (r[s.field] as number) !== 0),
  );
  const head = [['Year', ...active.map((s) => s.label)]];
  const body = annual.map((r) => [
    String(r.year),
    ...active.map((s) => formatDollars(r[s.field] as number)),
  ]);
  return { head, body };
}

/**
 * Tax & health-cost burden table (mirrors `TaxBurdenChart`). Columns: Year,
 * Federal tax, IRMAA surcharge, ACA premium tax credit. The chart stores the
 * ACA-PTC as a negative value (below-zero benefit); the table flips its sign so
 * the credit reads as a positive dollar amount.
 */
export function buildTaxBurdenTableSpec(
  rows: ReadonlyArray<TaxBurdenChartRow>,
): PdfTableSpec {
  const head = [
    ['Year', 'Federal tax', 'IRMAA surcharge', 'ACA premium tax credit'],
  ];
  const body = rows.map((r) => [
    String(r.year),
    formatDollars(r.federalTax),
    formatDollars(r.irmaaSurcharge),
    formatDollars(-r.acaPtcSubsidy),
  ]);
  return { head, body };
}

/** RMD table (mirrors `RmdChart`): Year, RMD met, Shortfall. When any year
 *  retains surplus (`rmdRetained > 0`, same gate as the in-app chart split),
 *  an `of which surplus` sub-column is inserted between RMD met and Shortfall —
 *  the retained portion of the met figure, clamped to the met total so it
 *  never exceeds RMD met. Otherwise the table stays the three-column form. */
export function buildRmdTableSpec(
  rows: ReadonlyArray<RmdChartRow>,
): PdfTableSpec {
  const split = rows.some((r) => r.rmdRetained > 0);
  if (!split) {
    const head = [['Year', 'RMD met', 'Shortfall']];
    const body = rows.map((r) => [
      String(r.year),
      formatDollars(r.rmdMet),
      formatDollars(r.rmdShortfall),
    ]);
    return { head, body };
  }
  const head = [['Year', 'RMD met', 'of which surplus', 'Shortfall']];
  const body = rows.map((r) => {
    const retainedDisplay = Math.min(Math.max(0, r.rmdRetained), r.rmdMet);
    return [
      String(r.year),
      formatDollars(r.rmdMet),
      formatDollars(retainedDisplay),
      formatDollars(r.rmdShortfall),
    ];
  });
  return { head, body };
}

/** Roth-conversions table (mirrors `RothConversionsChart`): Year, Converted. */
export function buildRothConversionsTableSpec(
  rows: ReadonlyArray<RothConversionsChartRow>,
): PdfTableSpec {
  const head = [['Year', 'Converted']];
  const body = rows.map((r) => [String(r.year), formatDollars(r.dollars)]);
  return { head, body };
}

/** QCD table (mirrors `QcdChart`): Year, QCD distributed, Net taxable IRA RMD.
 *  The net-taxable column renders `$0` (not `—`) for a zero value, matching
 *  the on-screen tax-detail table exactly. Each row carries the
 *  already-deflated `qcdDollars` and `netTaxableRmd` values — never re-deflated
 *  here. */
export function buildQcdTableSpec(rows: ReadonlyArray<QcdPdfRow>): PdfTableSpec {
  const head = [['Year', 'QCD distributed', 'Net taxable IRA RMD']];
  const body = rows.map((r) => [
    String(r.year),
    formatDollars(r.qcdDollars),
    formatDollars(r.netTaxableRmd),
  ]);
  return { head, body };
}

/** Account metadata the account-stack table groups by (structurally the band's
 *  `AccountMeta`). */
export interface StackTableAccount {
  readonly id: string;
  readonly name: string;
  readonly ownerDisplayName: string;
  readonly type: import('../../db/types').AccountType;
  readonly taxTreatment?: import('../../db/types').AccountTaxTreatment;
}

/**
 * Account-balances-by-type table (mirrors the by-type `AccountBalanceStackBand`
 * grouping). One row per year, one column per non-all-zero type bucket
 * (Tax-deferred / Tax-free (Roth) / Taxable / Tax-free (HSA) / Cash). Uses the
 * SAME `stackTypeBucketsForYear` helper the band's per-type rows use, so the
 * columns tie out to the chart exactly. `bucketFor` is injected to keep this
 * adapter framework-free (no page import). Already display-basis.
 */
export function buildAccountBalancesByTypeTableSpec(
  rows: ReadonlyArray<StackBandYear>,
  accounts: ReadonlyArray<StackTableAccount>,
  bucketFor: (
    accounts: ReadonlyArray<StackTableAccount>,
    yr: StackBandYear,
  ) => { preTax: number; roth: number; taxable: number; hsa: number; cash: number },
): PdfTableSpec {
  const columns: ReadonlyArray<{
    key: 'preTax' | 'roth' | 'taxable' | 'hsa' | 'cash';
    label: string;
  }> = [
    { key: 'preTax', label: 'Tax-deferred' },
    { key: 'roth', label: 'Tax-free (Roth)' },
    { key: 'taxable', label: 'Taxable' },
    { key: 'hsa', label: 'Tax-free (HSA)' },
    { key: 'cash', label: 'Cash' },
  ];
  const buckets = rows.map((yr) => bucketFor(accounts, yr));
  const active = columns.filter((c) => buckets.some((b) => b[c.key] !== 0));
  const head = [['Year', ...active.map((c) => c.label)]];
  const body = rows.map((yr, i) => [
    String(yr.year),
    ...active.map((c) => formatDollars(buckets[i][c.key])),
  ]);
  return { head, body };
}

/**
 * Account-balances-by-account table (mirrors the per-account
 * `AccountBalanceStackBand` grouping). One row per year, one column per account
 * (the band's per-account balances). Wide tables wrap in autotable.
 */
export function buildAccountBalancesByAccountTableSpec(
  rows: ReadonlyArray<StackBandYear>,
  accounts: ReadonlyArray<StackTableAccount>,
): PdfTableSpec {
  const orderedAccounts = sortReportAccounts(accounts);
  const head = [['Year', ...orderedAccounts.map((a) => a.name)]];
  const body = rows.map((yr) => {
    const balMap: ReadonlyMap<string, StackBandAccountYear> = yr.accountBalances;
    return [
      String(yr.year),
      ...orderedAccounts.map((a) => formatDollars(balMap.get(a.id)?.balance ?? 0)),
    ];
  });
  return { head, body };
}

/** Expense-overview table (mirrors `ExpensesProjectionChart`). Reads the
 *  ANNUAL (headline) essential/discretionary totals straight from
 *  `projectExpensesByYear` — the same source-of-truth math the year-by-year
 *  table uses — so the figures tie out in every display basis, including
 *  partial (mid-year / trimmed-death) years where a monthly run-rate rollup
 *  would diverge from the engine. Already display-basis. Columns: Year,
 *  Essential, Discretionary. */
export function buildExpensesTotalTableSpec(
  annual: ReadonlyArray<ExpenseProjectionPoint>,
): PdfTableSpec {
  const head = [['Year', 'Essential', 'Discretionary']];
  const body = annual.map((r) => [
    String(r.year),
    formatDollars(r.essential),
    formatDollars(r.discretionary),
  ]);
  return { head, body };
}

/**
 * Expenses-by-category table (mirrors `ExpensesCategoryChart`). Reads the
 * ANNUAL per-category totals straight from `projectExpensesByCategoryYear`
 * (the headline math, same as the overview table) so the figures tie out in
 * every display basis. Columns: Year + one per category in `categoryMeta`
 * order. A category that is all-zero across the horizon is omitted (the chart
 * hides an empty band). Already display-basis.
 */
export function buildExpensesByCategoryTableSpec(
  annual: ReadonlyArray<ExpenseCategoryYearPoint>,
  categoryMeta: ReadonlyArray<{ id: string; name: string }>,
): PdfTableSpec {
  const active = categoryMeta.filter((c) =>
    annual.some((r) => (r.byCategoryId[c.id] ?? 0) !== 0),
  );
  const head = [['Year', ...active.map((c) => c.name)]];
  const body = annual.map((r) => [
    String(r.year),
    ...active.map((c) => formatDollars(r.byCategoryId[c.id] ?? 0)),
  ]);
  return { head, body };
}

// ---------------------------------------------------------------------------
// Projected withdrawals table (the PDF's final section). Mirrors the on-screen
// Projected withdrawals page: per year a summary row, then the binding RMD
// aggregation-group instruction rows, then indented per-account sub-rows, then
// trailing clarifying notes. The input rows are ALREADY display-basis (deflated
// upstream by `deflateGuidanceRows`) — this builder NEVER deflates; it only
// formats. Every GENERATED label/structure cell is ASCII (em dash `—` only);
// embedded user account / member names pass through verbatim like every other
// PDF table. All builders are TOTAL — non-throwing on every input.
// ---------------------------------------------------------------------------

/** The withdrawal-guidance table's six columns. */
const WITHDRAWAL_GUIDANCE_HEAD: string[][] = [
  [
    'Year / Account',
    'Withdrawn',
    'Ending balance',
    'Required min.',
    'Tax & Medicare',
    'After-tax spendable',
  ],
];

/** The trailing clarifying note rows, appended once after all years. The
 *  note text sits in the first cell; the other five cells are empty. */
const WITHDRAWAL_GUIDANCE_NOTES: ReadonlyArray<string> = [
  'Required min. shown per account is a display attribution; the binding amount is the "Required minimum" instruction row.',
  'After-tax spendable already nets withheld Medicare/IRMAA, ACA credits, and reinvested required-distribution surplus; it is not Withdrawn minus Tax & Medicare.',
];

/** The binding instruction text for one RMD aggregation group. Owner name is
 *  prefixed (possessive) when available in `ownerNameById`. ASCII only. */
function rmdGroupInstruction(
  group: RmdAggregationGroup,
  ownerNameById: ReadonlyMap<string, string>,
): string {
  const typeLabel = aggregationTypeLabel(group.accountType);
  const ownerName = ownerNameById.get(group.ownerId);
  const ownerPrefix = ownerName ? `${ownerName}'s ` : '';
  if (group.kind === 'aggregatable') {
    const names = group.accounts.map((a) => a.name).join(', ');
    return `Required minimum: projected from any of ${ownerPrefix}${typeLabel}${names ? ` (${names})` : ''}`;
  }
  const name = group.accounts[0]?.name ?? typeLabel;
  return `Required minimum: projected from ${ownerPrefix}${name} (${typeLabel} — required minimum must come from this account)`;
}

/** The display-basis parenthetical appended to an account sub-row's name cell
 *  (HSA medical/reserve split, MIXED pre-tax/post split, or the MIXED
 *  split-unavailable note). Derived from the SAME presence gate the data layer
 *  uses — an absent optional field yields no parenthetical (never `$NaN`). */
function guidanceAccountSplit(account: GuidanceYearRow['accounts'][number]): string {
  if (
    account.hsaMedicalQualifiedDollars !== undefined ||
    account.hsaEmergencyReserveDollars !== undefined
  ) {
    return ` (medical ${formatDollars(account.hsaMedicalQualifiedDollars)}; reserve ${formatDollars(account.hsaEmergencyReserveDollars)})`;
  }
  if (account.isMixed) {
    if (account.preTaxWithdrawnDollars !== undefined) {
      return ` (pre-tax ${formatDollars(account.preTaxWithdrawnDollars)}; ${account.postLabel ?? 'post-tax'} ${formatDollars(account.postWithdrawnDollars)})`;
    }
    return ' (mixed; split unavailable)';
  }
  return '';
}

/**
 * Build the withdrawal-guidance table spec from ALREADY-display-basis rows.
 * Per year: a summary row, then one row per RMD aggregation group
 * (the binding instruction), then one indented sub-row per acted-on account,
 * then (once, after all years) the trailing clarifying note rows. Pure +
 * never-deflate + total (non-throwing on every input).
 */
export function buildWithdrawalGuidanceTableSpec(
  displayRows: ReadonlyArray<GuidanceYearRow>,
  ownerNameById: ReadonlyMap<string, string>,
): PdfTableSpec {
  const body: string[][] = [];
  for (const row of displayRows) {
    // Summary row for the year.
    body.push([
      `${row.year}${row.hasRmdShortfall ? ' — RMD shortfall' : ''}`,
      formatDollars(row.totalWithdrawnDollars),
      '—',
      '—',
      formatDollars(row.taxAndMedicareDollars),
      formatDollars(row.spendableDollars),
    ]);
    // Binding RMD aggregation-group instruction rows.
    for (const group of row.rmdGroups) {
      body.push([
        `  ${rmdGroupInstruction(group, ownerNameById)}`,
        '—',
        '—',
        formatDollars(group.requiredCents / 100),
        '—',
        '—',
      ]);
    }
    // Indented per-account sub-rows.
    for (const account of row.accounts) {
      body.push([
        `    ${account.accountName}${guidanceAccountSplit(account)}`,
        formatDollars(account.withdrawnDollars),
        formatDollars(account.endingBalanceDollars),
        account.rmdDollars > 0 ? formatDollars(account.rmdDollars) : '—',
        '—',
        '—',
      ]);
    }
  }
  for (const note of WITHDRAWAL_GUIDANCE_NOTES) {
    body.push([note, '', '', '', '', '']);
  }
  return { head: WITHDRAWAL_GUIDANCE_HEAD.map((r) => [...r]), body };
}

/**
 * A one-row note spec (single header cell + single body cell), reusing the
 * existing autotable `table`-kind path. Used for the MC-basis and
 * no-withdrawal disclaimers in place of the full table.
 */
export function buildGuidanceNoteSpec(note: string): PdfTableSpec {
  // Derive the head title from the section manifest (single source of truth)
  // rather than a second hardcoded copy, so a future rename can't leave the
  // note spec's header drifting from the section's own name.
  return {
    head: [[pdfSectionTitle('table-withdrawal-guidance')]],
    body: [[note]],
  };
}

/** The MC-basis disclaimer note (the projected withdrawals are deterministic-only). */
export const WITHDRAWAL_GUIDANCE_MC_NOTE =
  'Projected withdrawals reflect the deterministic projection; not available for Monte Carlo bases.';

/** The no-withdrawal disclaimer note (a projectable scenario with no draws). */
export const WITHDRAWAL_GUIDANCE_EMPTY_NOTE =
  'No portfolio withdrawals are projected for this scenario.';

/**
 * The pure section-selection helper. Precedence (total function):
 *   1. an active Monte Carlo basis → the MC note (guidance is deterministic-
 *      only) — checked FIRST, so MC-active-and-zero-rows still yields the MC
 *      note;
 *   2. else the no-withdrawal predicate true → the empty note;
 *   3. else the full table from the (already-display-basis) rows.
 *
 * The no-withdrawal predicate matches the on-screen "no draws" state: no rows,
 * or every row has no withdrawal, no acted-on accounts, and no RMD shortfall.
 */
export function buildWithdrawalGuidanceSectionSpec(params: {
  readonly isMcBasisActive: boolean;
  readonly displayRows: ReadonlyArray<GuidanceYearRow>;
  readonly ownerNameById: ReadonlyMap<string, string>;
}): PdfTableSpec {
  if (params.isMcBasisActive) {
    return buildGuidanceNoteSpec(WITHDRAWAL_GUIDANCE_MC_NOTE);
  }
  const noWithdrawal =
    params.displayRows.length === 0 ||
    params.displayRows.every(
      (r) => !r.hasWithdrawal && r.accounts.length === 0 && !r.hasRmdShortfall,
    );
  if (noWithdrawal) {
    return buildGuidanceNoteSpec(WITHDRAWAL_GUIDANCE_EMPTY_NOTE);
  }
  return buildWithdrawalGuidanceTableSpec(params.displayRows, params.ownerNameById);
}

/** Per-account pre-tax / post-tax balance breakdown (current values, today's
 *  dollars). Columns with null balances render as an em dash. */
export function buildAccountBreakdownTableSpec(
  accounts: ReadonlyArray<ReportAccount>,
): PdfTableSpec {
  const head = [[
    'Account',
    'As of',
    'Total contributions',
    'Total gains',
    'Total balance',
    'Pre-tax',
    'Post-tax',
    'Tax-free',
  ]];
  const body = sortReportAccounts(accounts).map((a) => [
    a.name,
    // Full "Balance as of" date (year/month/day) when recorded, falling back to
    // the bare year, then an em dash when the account has no balance history.
    a.balanceAsOfDate ?? (a.balanceAsOfYear != null ? String(a.balanceAsOfYear) : '—'),
    formatDollars(a.totalContributions),
    formatDollars(a.totalGains),
    formatDollars(a.currentBalance),
    formatDollars(a.currentBalancePreTax),
    formatDollars(a.currentBalancePostTax),
    formatDollars(a.currentBalanceTaxFree),
  ]);
  const sum = (read: (account: ReportAccount) => number | null): string =>
    formatDollars(accounts.reduce((total, account) => total + (read(account) ?? 0), 0));
  const foot = [[
    'Total',
    '—',
    sum((a) => a.totalContributions),
    sum((a) => a.totalGains),
    sum((a) => a.currentBalance),
    sum((a) => a.currentBalancePreTax),
    sum((a) => a.currentBalancePostTax),
    sum((a) => a.currentBalanceTaxFree),
  ]];
  return { head, body, foot };
}
