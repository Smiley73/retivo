/**
 * The engine's own zero point for a window year, for tests: the plan's ladder
 * with that year's target Roth pointed at a missing account, so the engine
 * converts $0 there while the ceiling still steers withdrawals.
 */
import type { MagiCapWindow } from '../../db/types';
import type { DrawdownYear } from '../drawdown-engine-types';
import { createProjectionRunner } from './projection';
import type { RothSuggestionRequest } from './types';

const MISSING_TARGET = 'no-such-roth';

export interface ZeroPoint {
  /** Income on the limit's line, dollars. */
  readonly incomeDollars: number;
  readonly taxableSsDollars: number;
  readonly ssTier: NonNullable<DrawdownYear['ssTaxationTier']>;
}

/** The engine's year with its conversion removed, for each window year of `ladder`. */
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
