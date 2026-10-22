/**
 * The conversion window (retirement year through the year before the RMD
 * trigger age) and the ladder of persisted-shape Fill windows built over it.
 */
import type { AccountPayload, Aggregate, MagiCapWindow } from '../../db/types';
import { isWorkingYearsRothConversionTarget } from '../roth-conversion-eligibility';
import { rmdTriggerAge } from '../rmd';

export interface ConversionWindow {
  readonly startYear: number;
  /** Last year inside the window (the cap window's own end is exclusive). */
  readonly endYear: number;
}

/** Retirement year through the year before the RMD trigger age, clipped to the
 *  horizon and to today; null when the span is empty or the birth year unusable. */
export function conversionWindow(args: {
  readonly primaryBirthYear: number;
  readonly retirementYear: number;
  readonly horizonYear: number;
  readonly todayYear: number;
}): ConversionWindow | null {
  const { primaryBirthYear, retirementYear, horizonYear, todayYear } = args;
  if (!Number.isInteger(primaryBirthYear) || !Number.isInteger(retirementYear)) return null;
  const lastBeforeTrigger = primaryBirthYear + rmdTriggerAge(primaryBirthYear) - 1;
  const endYear = Math.min(lastBeforeTrigger, horizonYear);
  const startYear = Math.max(retirementYear, todayYear);
  return endYear < startYear ? null : { startYear, endYear };
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
