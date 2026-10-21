/**
 * The per-year record a person can check by hand: the ceiling and the limit
 * that set it, then what the engine's row shows for that year, in nominal
 * cents. Window years carry the ladder's ceiling; the year after the window is
 * included so "the window ended" can be shown as the reason conversions stop.
 */
import type { AccountPayload } from '../../db/types';
import type { DrawdownYear } from '../drawdown-engine-types';
import { isQualifyingAccount } from '../rmd';
import type { ConversionWindow } from './ladder';
import type { YearLimits, YearRecord, YearStop } from './types';

const CENTS_PER_DOLLAR = 100;
/** Fill bisects to $1 and rounds, so MAGI within this of the ceiling is "at" it. */
const AT_CEILING_SLACK_DOLLARS = 2;
/** The search leaves at most this many dollars of the row's MAGI under the
 *  limit it lands on: the offset margin, the solver's $1 step and rounding. */
const AT_LIMIT_SLACK_DOLLARS = 6;
/** Pre-tax money below this many dollars counts as exhausted. */
const EXHAUSTED_DOLLARS = 1;

export type AccountsById = ReadonlyMap<string, AccountPayload>;

/** Pre-tax and mixed account money (the RMD-qualifying set) at the end of a
 *  row, nominal dollars. Roth, brokerage and HSA are excluded. */
export function preTaxDollarsAtRowEnd(row: DrawdownYear, accounts: AccountsById): number {
  let total = 0;
  for (const [id, balance] of row.accountBalances ?? []) {
    const payload = accounts.get(id);
    if (payload !== undefined && isQualifyingAccount(payload.type, payload.taxTreatment)) {
      total += balance.preEnd;
    }
  }
  return total;
}

/** `ceilingDollars` is what the Fill step compares the MAGI it can see with;
 *  the row's MAGI also carries the taxable-account interest and dividends it
 *  cannot see, so it lands at `limitDollars` instead. That is the line a year
 *  that ran out of pre-tax money has to be at to count as stopped by a limit. */
function classifyStop(
  row: DrawdownYear,
  limits: YearLimits,
  accounts: AccountsById,
): YearStop {
  if (row.rothConversionDegradedNoTarget === true) return 'no-target';
  if ((row.magiCapBreachDollars ?? 0) > 0) return 'breach';
  const magiDollars = (row.magiCents ?? 0) / CENTS_PER_DOLLAR;
  const exhausted = preTaxDollarsAtRowEnd(row, accounts) < EXHAUSTED_DOLLARS;
  if (magiDollars >= limits.ceilingDollars - AT_CEILING_SLACK_DOLLARS) {
    if ((row.rothConvertedCents ?? 0) > 0) {
      const atLimit = magiDollars >= limits.limitDollars - AT_LIMIT_SLACK_DOLLARS;
      return exhausted && !atLimit ? 'pre-tax-exhausted' : 'limit';
    }
    return exhausted ? 'pre-tax-exhausted' : 'withdrawals-at-ceiling';
  }
  return exhausted ? 'pre-tax-exhausted' : 'unused-headroom';
}

function buildRecord(args: {
  row: DrawdownYear;
  lookbackRow: DrawdownYear | undefined;
  inWindow: boolean;
  limits: YearLimits | undefined;
  accounts: AccountsById;
}): YearRecord {
  const { row, lookbackRow, inWindow, limits, accounts } = args;
  let stop: YearStop | null = null;
  if (!inWindow) stop = 'window-ended';
  else if (limits !== undefined) stop = classifyStop(row, limits, accounts);
  return {
    year: row.year,
    inWindow,
    ceilingDollars: limits?.ceilingDollars ?? null,
    binding: limits?.binding ?? null,
    limits: limits ?? null,
    stop,
    convertedCents: row.rothConvertedCents ?? 0,
    magiCents: row.magiCents ?? 0,
    taxableSsCents: row.taxableSsCents ?? 0,
    ssTaxationTier: row.ssTaxationTier ?? 'none',
    federalTaxCents: row.federalTaxCents ?? 0,
    irmaaSurchargeCents: row.irmaaSurchargeCents ?? 0,
    irmaaTier: row.irmaaTier ?? 'none',
    lookbackIrmaaTier: lookbackRow === undefined ? null : (lookbackRow.irmaaTier ?? 'none'),
    lookbackIrmaaSurchargeCents:
      lookbackRow === undefined ? null : (lookbackRow.irmaaSurchargeCents ?? 0),
    acaPtcSubsidyCents: row.acaPtcSubsidyCents ?? 0,
    acaPtcTier: row.acaPtcTier ?? 'below-fpl',
    reroutedDollars: row.magiCapTierOverrideDollars ?? 0,
    breachedDollars: row.magiCapBreachDollars ?? 0,
  };
}

/**
 * Records for each window year plus the year after it (when the projection
 * reaches it). `limits` is null on the reference candidate, whose ladder is
 * the scenario's own and has no limits of ours to show.
 */
export function buildYearRecords(args: {
  years: readonly DrawdownYear[];
  window: ConversionWindow;
  limits: readonly YearLimits[] | null;
  accounts: AccountsById;
}): YearRecord[] {
  const { years, window, limits, accounts } = args;
  const rowByYear = new Map(years.map((row) => [row.year, row]));
  const limitsByYear = new Map((limits ?? []).map((l) => [l.year, l]));
  const records: YearRecord[] = [];
  for (let year = window.startYear; year <= window.endYear + 1; year += 1) {
    const row = rowByYear.get(year);
    if (row === undefined) continue;
    records.push(
      buildRecord({
        row,
        lookbackRow: rowByYear.get(year + 2),
        inWindow: year <= window.endYear,
        limits: limitsByYear.get(year),
        accounts,
      }),
    );
  }
  return records;
}
