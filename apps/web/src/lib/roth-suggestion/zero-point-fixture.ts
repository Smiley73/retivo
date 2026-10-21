/**
 * The engine's own zero point for a window year, for tests of the derived
 * "income before the conversion": the plan's ladder with that one year's
 * target Roth pointed at an account that does not exist. The engine then takes
 * its documented degrade-to-withdrawal-only path in that year, converting $0
 * while the ceiling still steers withdrawals, and every earlier year runs as
 * in the plan, so the year's reported income is what the conversion was added to.
 */
import type { MagiCapWindow } from '../../db/types';
import type { DrawdownYear } from '../drawdown-engine-types';
import { createProjectionRunner } from './projection';
import type { RothSuggestionRequest } from './types';
import type { YearDetailRow } from './year-detail-types';

const MISSING_TARGET = 'no-such-roth';

export interface ZeroPoint {
  /** Income on the limit's line, dollars. */
  readonly incomeDollars: number;
  readonly taxableSsDollars: number;
  readonly ssTier: NonNullable<DrawdownYear['ssTaxationTier']>;
}

/** The engine's year with that year's conversion removed, for each window year
 *  of `ladder`. */
export async function zeroPointByYear(
  request: RothSuggestionRequest,
  ladder: readonly MagiCapWindow[],
): Promise<Map<number, ZeroPoint>> {
  const runner = createProjectionRunner(request, 1);
  const out = new Map<number, ZeroPoint>();
  for (const [i, window] of ladder.entries()) {
    if (window.start.kind !== 'year') continue;
    const year = window.start.year;
    const without = ladder.map((w, j) => (j === i ? { ...w, targetRothAccountId: MISSING_TARGET } : w));
    const plan = await runner.project(without);
    const row = plan?.years.find((r) => r.year === year);
    if (row === undefined) throw new Error(`no row for ${year}`);
    if ((row.rothConvertedCents ?? 0) !== 0) throw new Error(`${year} still converted`);
    out.set(year, {
      incomeDollars: (row.magiCents ?? 0) / 100,
      taxableSsDollars: (row.taxableSsCents ?? 0) / 100,
      ssTier: row.ssTaxationTier ?? 'none',
    });
  }
  return out;
}

/** How far a plan row's derived income before the conversion sits from the
 *  engine's own zero point, split into the two parts it is made of. */
export interface ZeroPointGaps {
  /** Other income before the conversion (income on the line less taxable Social
   *  Security): the part the conversion's tax draw can add to. */
  readonly otherDollars: number;
  /** Taxable Social Security before the conversion: the §86 rule on that other income. */
  readonly socialSecurityDollars: number;
}

export function gapsFromZeroPoint(
  row: Pick<YearDetailRow, 'incomeBeforeDollars' | 'extraTaxableSsDollars' | 'taxableSsDollars'>,
  zero: ZeroPoint,
): ZeroPointGaps {
  const ssBefore = row.taxableSsDollars - (row.extraTaxableSsDollars ?? NaN);
  const otherBefore = (row.incomeBeforeDollars ?? NaN) - ssBefore;
  return {
    otherDollars: otherBefore - (zero.incomeDollars - zero.taxableSsDollars),
    socialSecurityDollars: ssBefore - zero.taxableSsDollars,
  };
}
