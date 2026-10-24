/**
 * Adapters turning already display-transformed view-model rows into jspdf-autotable `{ head, body }` specs.
 * They never deflate: the view-model has applied `viewDeflator` / `basisDeflator`, and a second pass would double-apply it.
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

/** Whole-dollar string of an already-display-basis value; `null` renders as an em dash. */
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
function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(1)}%`;
}

/** Year-by-year detail table; cells are read verbatim from the view-model rows. */
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

/** Annual portfolio-flow table; rows are already deflated upstream. */
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

// An employer row is a recorded Roth rollover basis, not a tax-free amount (a nonqualified
// designated-Roth distribution is pro-rata basis and earnings), so no cell calls it tax-free.
// Generated cells in this file are ASCII plus an em dash: jsPDF's standard font has no glyph for
// other punctuation.
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

/**
 * Sum `fields` of `rows` per calendar year in first-seen order; rows already one-per-year pass
 * through.
 */
function aggregateByYear<K extends string>(
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

// The shared boundary year carries both channels; solid wins.
function coalesceChannel(
  solid: number | null | undefined,
  dashed: number | null | undefined,
): number | null {
  if (solid !== null && solid !== undefined) return solid;
  if (dashed !== null && dashed !== undefined) return dashed;
  return null;
}

/**
 * Balance-projection line table (mirrors `ProjectionChart`); the TWR column only when Historical is
 * enabled, Monte Carlo only when an MC basis is active.
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

/** Per-year percentiles of the stress-test fan; the MC engine exposes only P10, P25 and P50. */
export interface StressTestYearPercentiles {
  readonly year: number;
  readonly badLuck: number;
  readonly pessimistic: number;
  readonly typical: number;
}

/** Stress-test fan table: Year, Bad-luck (P10), Pessimistic (P25), Typical (P50), as plotted. */
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

/** Expected-cashflow table (mirrors `CashflowProjectionChart`), aggregated to annual. */
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
 * Income-breakdown table (mirrors `IncomeBreakdownChart`); all-zero stripes are dropped as the
 * chart does.
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
 * Tax & health-cost burden table; the chart stores the ACA credit as a negative, so the sign is
 * flipped to read as a positive amount.
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

/**
 * RMD table (mirrors `RmdChart`); an `of which surplus` column appears when any year retains
 * surplus, clamped to RMD met.
 */
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

/**
 * QCD table (mirrors `QcdChart`); a zero net-taxable value renders `$0`, as the on-screen
 * tax-detail table does.
 */
export function buildQcdTableSpec(rows: ReadonlyArray<QcdPdfRow>): PdfTableSpec {
  const head = [['Year', 'QCD distributed', 'Net taxable IRA RMD']];
  const body = rows.map((r) => [
    String(r.year),
    formatDollars(r.qcdDollars),
    formatDollars(r.netTaxableRmd),
  ]);
  return { head, body };
}

/** Account metadata the account-stack table groups by. */
export interface StackTableAccount {
  readonly id: string;
  readonly name: string;
  readonly ownerDisplayName: string;
  readonly type: import('../../db/types').AccountType;
  readonly taxTreatment?: import('../../db/types').AccountTaxTreatment;
}

/**
 * Account-balances-by-type table: one column per non-all-zero bucket, bucketed by the injected
 * `bucketFor`.
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

/** Account-balances-by-account table: one column per account. */
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

/**
 * Expense-overview table (mirrors `ExpensesProjectionChart`); reads the annual totals from
 * `projectExpensesByYear` so partial years tie out.
 */
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
 * Expenses-by-category table (mirrors `ExpensesCategoryChart`); all-zero categories are omitted.
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

const WITHDRAWAL_GUIDANCE_NOTES: ReadonlyArray<string> = [
  'Required min. shown per account is a display attribution; the binding amount is the "Required minimum" instruction row.',
  'After-tax spendable already nets withheld Medicare/IRMAA, ACA credits, and reinvested required-distribution surplus; it is not Withdrawn minus Tax & Medicare.',
];

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

// An absent optional field yields no parenthetical rather than `$NaN`.
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
 * Withdrawal-guidance table from display-basis rows: per year a summary row, RMD group instruction
 * rows and per-account sub-rows, then the notes once.
 */
function buildWithdrawalGuidanceTableSpec(
  displayRows: ReadonlyArray<GuidanceYearRow>,
  ownerNameById: ReadonlyMap<string, string>,
): PdfTableSpec {
  const body: string[][] = [];
  for (const row of displayRows) {
    body.push([
      `${row.year}${row.hasRmdShortfall ? ' — RMD shortfall' : ''}`,
      formatDollars(row.totalWithdrawnDollars),
      '—',
      '—',
      formatDollars(row.taxAndMedicareDollars),
      formatDollars(row.spendableDollars),
    ]);
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

/** One-row note spec, used for the MC-basis and no-withdrawal disclaimers. */
function buildGuidanceNoteSpec(note: string): PdfTableSpec {
  return {
    head: [[pdfSectionTitle('table-withdrawal-guidance')]],
    body: [[note]],
  };
}

/** The MC-basis disclaimer note (the projected withdrawals are deterministic-only). */
const WITHDRAWAL_GUIDANCE_MC_NOTE =
  'Projected withdrawals reflect the deterministic projection; not available for Monte Carlo bases.';

/** The no-withdrawal disclaimer note (a projectable scenario with no draws). */
const WITHDRAWAL_GUIDANCE_EMPTY_NOTE =
  'No portfolio withdrawals are projected for this scenario.';

/**
 * Choose the section content: the MC note when an MC basis is active (checked first), the empty
 * note when there are no draws, else the full table.
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

/** Per-account pre-tax / post-tax balance breakdown; null balances render as an em dash. */
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
