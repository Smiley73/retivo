/**
 * IncomeStream form draft shape + start/end defaults & validators.
 * Pure data/validation module (no JSX) split out of the income form so
 * both `IncomeFormPage` (state + submit) and `IncomeSchedulePickers`
 * (the schedule UI) depend on it without an import cycle, and so each
 * file stays under the 400-line shape limit.
 *
 * v1 form exposes a narrower subset of the partTime start/end
 * vocabulary; the data model still supports the full ScheduleStart /
 * ScheduleEnd discriminated unions.
 */
import type {
  IncomeStreamKind,
  JointAndSurvivorPct,
  OneOffIncomeSource,
  PensionPayoutType,
  ScheduleEnd,
  ScheduleStart,
} from '../db/types';
import {
  monthIndex,
  resolveEndMonth,
  resolveStartMonth,
  type ScheduleResolveContext,
} from './schedule-resolution';

export interface FormDraft {
  name: string;
  notes: string;
  memberId: string;
  kind: IncomeStreamKind;

  payoutType: PensionPayoutType;
  monthlyBenefit: string;
  /** True = use scenario inflation rate (tracksInflation = true);
   *  false = use explicit pensionColaPct (tracksInflation = false). */
  pensionTracksInflation: boolean;
  pensionColaPct: string;
  jointAndSurvivorPct: JointAndSurvivorPct;
  linkedCbpAccountId: string;

  lumpSumAmount: string;
  lumpSumTargetAccountId: string;

  annualAmount: string;
  /** True = use scenario inflation rate (tracksInflation = true);
   *  false = use explicit partTimeColaPct (tracksInflation = false). */
  partTimeTracksInflation: boolean;
  partTimeColaPct: string;

  oneOffAmount: string;
  oneOffSource: OneOffIncomeSource;
  oneOffTargetAccountId: string;

  /** Unified start anchor — every income kind. Owner-implicit (no
   *  memberId on the age variant) for annuity/lumpSum/oneOff; partTime
   *  may set memberId explicitly to anchor to the non-owner spouse. */
  start: ScheduleStart;
  /** End anchor — partTime only. */
  end?: ScheduleEnd;

  taxable: boolean;
}

export const defaultStartFor = (
  kind: IncomeStreamKind,
  currentYear: number,
): ScheduleStart => {
  switch (kind) {
    case 'pension':
      return { kind: 'age', years: 65, months: 0 };
    case 'partTime':
      return { kind: 'age', years: 67, months: 0 };
    case 'oneOff':
      return { kind: 'year', year: currentYear + 5 };
  }
};

export const defaultEndForPartTime = (): ScheduleEnd => ({
  kind: 'durationFromStart',
  months: 60,
});

const YEAR_MIN = 1900;
const YEAR_MAX = 2200;

export function validateStart(start: ScheduleStart): string | null {
  if (start.kind === 'year') {
    if (start.year < YEAR_MIN || start.year > YEAR_MAX) {
      return `Year must be between ${YEAR_MIN} and ${YEAR_MAX}.`;
    }
  }
  return null;
}

export function validateEnd(end: ScheduleEnd): string | null {
  if (end.kind === 'year') {
    if (end.year < YEAR_MIN || end.year > YEAR_MAX) {
      return `End year must be between ${YEAR_MIN} and ${YEAR_MAX}.`;
    }
  }
  if (end.kind === 'durationFromStart' && end.months <= 0) {
    return 'Duration must be greater than 0.';
  }
  return null;
}

/**
 * Cross-field schedule check: the resolved end must fall after the
 * resolved start. `resolveEndMonth` returns the EXCLUSIVE end boundary
 * (the first inactive month), so a non-empty window needs
 * `endIdx > startIdx`; on-or-before the start is the "end before start"
 * bug this guards.
 *
 * Returns `null` (no error) when the schedule is fine OR when either
 * anchor can't be resolved to a concrete month — a member with no
 * birthdate (`age` / `lifetime`) or an unresolved owner retirement year
 * (`retirementStart` / `endOfRetirementYear`, which surface as a NaN
 * year). The projection engine already fail-safes broken anchors, so the
 * form must not hard-block on an anchor it simply couldn't resolve here.
 */
export function validateSchedule(
  start: ScheduleStart,
  end: ScheduleEnd,
  ctx: ScheduleResolveContext,
): string | null {
  const startM = resolveStartMonth(start, ctx);
  if (!startM || !Number.isFinite(startM.year)) return null;
  const endM = resolveEndMonth(end, startM, ctx);
  if (!endM || !Number.isFinite(endM.year)) return null;
  if (
    monthIndex(endM.year, endM.month0) <= monthIndex(startM.year, startM.month0)
  ) {
    return 'This income ends before it starts. Set the end after the start.';
  }
  return null;
}
