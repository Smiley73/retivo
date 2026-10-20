/**
 * The conversion window and the ladder built over it. The window is the span
 * the Roth conversion comparison page's retirement Fill window already uses:
 * the primary's retirement year through the year before the primary reaches
 * the RMD trigger age. The ladder is one year-anchored Fill window per year in
 * the persisted `MagiCapWindow` shape, so saving it stores the object that was
 * ranked.
 */
import type { AccountPayload, Aggregate, MagiCapWindow } from '../../db/types';
import { isWorkingYearsRothConversionTarget } from '../roth-conversion-eligibility';
import { rmdTriggerAge } from '../rmd';

export interface ConversionWindow {
  readonly startYear: number;
  /** Last year inside the window (the cap window's own end is exclusive). */
  readonly endYear: number;
}

/**
 * Retirement year through the year before the RMD trigger age, clipped to the
 * horizon. The cap window ends at the month the member reaches the trigger
 * age, and the engine collapses that to whole tax years, so the trigger year
 * itself is outside. Null when the span is empty or the birth year is unusable.
 */
export function conversionWindow(args: {
  readonly primaryBirthYear: number;
  readonly retirementYear: number;
  readonly horizonYear: number;
}): ConversionWindow | null {
  const { primaryBirthYear, retirementYear, horizonYear } = args;
  if (!Number.isInteger(primaryBirthYear) || !Number.isInteger(retirementYear)) return null;
  const lastBeforeTrigger = primaryBirthYear + rmdTriggerAge(primaryBirthYear) - 1;
  const endYear = Math.min(lastBeforeTrigger, horizonYear);
  return endYear < retirementYear ? null : { startYear: retirementYear, endYear };
}

/** True when the engine's Fill step can convert into this account: the same
 *  test `findTargetRothIndex` applies (active, own, not inherited Roth IRA). */
export function isValidFillTarget(
  accounts: readonly Aggregate<AccountPayload>[],
  accountId: string,
): boolean {
  const account = accounts.find((a) => a.id === accountId);
  return account !== undefined && isWorkingYearsRothConversionTarget(account.payload);
}

/** One Fill window per year, whole-dollar ceiling, on the IRMAA MAGI line. */
export function buildLadder(
  ceilings: readonly { readonly year: number; readonly ceilingDollars: number }[],
  targetRothAccountId: string,
): MagiCapWindow[] {
  return ceilings.map(({ year, ceilingDollars }) => ({
    start: { kind: 'year', year },
    end: { kind: 'year', year },
    magiCeilingAnnualDollars: Math.max(0, Math.floor(ceilingDollars)),
    capMode: 'fill',
    capMagiLine: 'irmaa',
    targetRothAccountId,
  }));
}
