// IncomeStream form draft shape and start/end defaults and validators; split out so the form page and the schedule pickers share it without an import cycle.
// The v1 form exposes a narrower subset of the partTime start/end vocabulary than the data model.

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
  /** True: scenario inflation rate; false: explicit `pensionColaPct`. */
  pensionTracksInflation: boolean;
  pensionColaPct: string;
  jointAndSurvivorPct: JointAndSurvivorPct;
  linkedCbpAccountId: string;

  lumpSumAmount: string;
  lumpSumTargetAccountId: string;

  annualAmount: string;
  /** True: scenario inflation rate; false: explicit `partTimeColaPct`. */
  partTimeTracksInflation: boolean;
  partTimeColaPct: string;

  oneOffAmount: string;
  oneOffSource: OneOffIncomeSource;
  oneOffTargetAccountId: string;

  /** Every income kind; the age variant is owner-implicit, except partTime may set `memberId` to anchor to the other spouse. */
  start: ScheduleStart;
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
 * Cross-field check that the resolved end falls after the resolved start
 * (`resolveEndMonth` is the exclusive boundary, so a window needs `endIdx > startIdx`).
 * Returns null when either anchor cannot resolve here (no birthdate, or an unresolved
 * retirement year giving NaN): the engine fail-safes broken anchors, so the form must not block on one.
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
