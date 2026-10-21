/**
 * Words and formatted figures for the year-by-year table. Nominal dollars:
 * the limits and the cliffs are fixed amounts for the year, which is the only
 * basis the hand check closes on. The figures a person adds up (the amount,
 * the income before, the Social Security, the margin) carry cents so the sum
 * lands on the amount.
 */
import { formatCurrency, formatCurrencyExact } from '../../lib/format-currency';
import type {
  YearDetailRow,
  YearLimitKind,
} from '../../lib/roth-suggestion/year-detail-types';

const LIMIT_LABELS: Record<YearLimitKind, string> = {
  bracket: 'Bracket top',
  irmaa: 'Medicare surcharge (IRMAA) line',
  aca: 'Health-subsidy (ACA) line',
  'outside-window': 'Outside the window, no conversion tried',
  'already-over': 'Already over the ceiling',
  'pre-tax-ran-out': 'Pre-tax money ran out',
  'no-target': 'No target Roth IRA found',
  'plan-setting': "The current plan's own setting",
  'under-ceiling': 'Under the ceiling, reason not recorded',
};

const SS_TIERS = { none: 'None taxed', fifty: 'Up to 50%', 'eighty-five': 'Up to 85%' } as const;
const ACA_TIERS = {
  'below-fpl': 'Below the poverty line',
  sliding: 'Credit on a sliding scale',
  'cap-applies': 'Contribution capped',
  'above-400-cliff': 'Over the 400% cliff, no credit',
} as const;

const NOT_APPLIED = 'Not applied';

function line(value: number | null): string {
  return value === null ? NOT_APPLIED : formatCurrency(value);
}

/** What the engine did with spending withdrawals in the year, in words. */
function withdrawalText(row: YearDetailRow): string {
  const parts: string[] = [];
  if (row.reroutedDollars > 0) {
    parts.push(`Moved ${formatCurrency(row.reroutedDollars)} to a later account`);
  }
  if (row.breachedDollars > 0) {
    parts.push(`Could not hold the ceiling by ${formatCurrency(row.breachedDollars)}`);
  }
  return parts.length === 0 ? 'None' : parts.join('; ');
}

interface YearDetailCrossingView {
  readonly intro: string;
  readonly medicare: string;
  readonly credit: string;
}

export interface YearDetailView {
  readonly year: number;
  readonly filing: string;
  readonly amount: string;
  readonly limitKind: YearLimitKind;
  readonly stoppedBy: string;
  readonly bracketLine: string;
  readonly medicareLine: string;
  readonly creditLine: string;
  readonly limit: string;
  readonly incomeBefore: string;
  readonly extraSs: string;
  readonly keptUnder: string;
  readonly withdrawals: string;
  readonly incomeTax: string;
  readonly taxableSs: string;
  readonly surchargePaid: string;
  readonly surchargeSet: string;
  readonly credit: string;
  readonly preTaxEnd: string;
  readonly crossing: YearDetailCrossingView | null;
}

function exactOrDash(value: number | null): string {
  return value === null ? '—' : formatCurrencyExact(value);
}

function crossingView(row: YearDetailRow): YearDetailCrossingView | null {
  const note = row.crossingNote;
  if (note === null) return null;
  const where = note.line === 'irmaa' ? 'the Medicare surcharge line' : 'the health-subsidy line';
  return {
    intro: `Converting ${formatCurrency(note.extraConvertedDollars)} more would have gone over ${where}.`,
    medicare: `Medicare surcharge two years later: ${formatCurrency(note.medicareSurchargeDollars)}`,
    credit: `ACA credit lost, at full value: ${formatCurrency(note.acaCreditLostDollars)}`,
  };
}

export function toYearDetailView(row: YearDetailRow): YearDetailView {
  const lines = row.lines;
  return {
    year: row.year,
    filing: row.filingStatus ?? '—',
    amount: formatCurrencyExact(row.amountDollars),
    limitKind: row.limitKind,
    stoppedBy: LIMIT_LABELS[row.limitKind],
    bracketLine: lines === null ? '—' : line(lines.bracketDollars),
    medicareLine: lines === null ? '—' : line(lines.irmaaDollars),
    creditLine: lines === null ? '—' : line(lines.acaDollars),
    limit: row.limitDollars === null ? '—' : formatCurrency(row.limitDollars),
    incomeBefore: exactOrDash(row.incomeBeforeDollars),
    extraSs: exactOrDash(row.extraTaxableSsDollars),
    keptUnder: exactOrDash(row.keptUnderDollars),
    withdrawals: withdrawalText(row),
    incomeTax: formatCurrency(row.incomeTaxDollars),
    taxableSs: `${formatCurrency(row.taxableSsDollars)} (${SS_TIERS[row.ssTier]})`,
    surchargePaid: formatCurrency(row.irmaaPaidDollars),
    surchargeSet: row.irmaaSetDollars === null ? '—' : formatCurrency(row.irmaaSetDollars),
    credit: `${formatCurrency(row.acaCreditDollars)} (${ACA_TIERS[row.acaTier]})`,
    preTaxEnd: formatCurrency(row.preTaxEndDollars),
    crossing: crossingView(row),
  };
}
