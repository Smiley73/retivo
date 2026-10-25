// Owner-aware `GlideAnchor` to `ScheduleStart` bridge: the one place the shared `<ScheduleAnchorPicker>` is
// widened inbound and narrowed outbound. An omitted `age.memberId` means the stream's owner (income relies on it).

import type {
  GlideAnchor,
  HouseholdRole,
  MagiCapWindow,
  ScheduleStart,
} from '../db/types';

// Fallback end age for a cap-window END anchor that cannot be narrowed.
const DEFAULT_MAGI_CAP_END_AGE = 65;

/** Widens a `ScheduleStart` to the picker's `GlideAnchor`; an `age` memberId resolves to the stored role, else `memberRole`, else primary. */
export function scheduleStartToGlideAnchor(
  start: ScheduleStart,
  opts: { memberRole?: HouseholdRole } = {},
): GlideAnchor {
  switch (start.kind) {
    case 'retirementStart':
      return { kind: 'retirementStart' };
    case 'year':
      return { kind: 'year', year: start.year };
    case 'age':
      return {
        kind: 'age',
        memberId: start.memberId ?? opts.memberRole ?? 'primary',
        years: start.years,
        months: start.months,
      };
  }
}

/**
 * Narrows a picker `GlideAnchor` to a `ScheduleStart`. `age.memberId` is omitted
 * when the member select is hidden or the role is `ownerRole`, and kept only for a
 * picked non-owner; Expense passes neither option, so it is always kept. The
 * glide-only kinds fall back to `retirementStart`.
 */
export function glideAnchorToScheduleStart(
  anchor: GlideAnchor,
  opts: { memberSelectable?: boolean; ownerRole?: HouseholdRole } = {},
): ScheduleStart {
  const { memberSelectable = true, ownerRole } = opts;
  switch (anchor.kind) {
    case 'retirementStart':
      return { kind: 'retirementStart' };
    case 'year':
      return { kind: 'year', year: anchor.year };
    case 'age': {
      const role = anchor.memberId ?? 'primary';
      const omit = !memberSelectable || role === ownerRole;
      return omit
        ? { kind: 'age', years: anchor.years, months: anchor.months }
        : {
            kind: 'age',
            memberId: role,
            years: anchor.years,
            months: anchor.months,
          };
    }
    case 'durationFromExpenseStart':
    case 'expenseEnd':
      // Gated off the Start picker; fall back to the safest default.
      return { kind: 'retirementStart' };
  }
}

/** A cap window's START anchor has the same static kinds as `ScheduleStart`. */
export type MagiCapStartAnchor = MagiCapWindow['start'];
export type MagiCapEndAnchor = MagiCapWindow['end'];

/** Widens a cap-window END anchor to the picker's `GlideAnchor`; cap windows always carry an explicit `age.memberId`. */
export function magiCapEndToGlideAnchor(end: MagiCapEndAnchor): GlideAnchor {
  if (end.kind === 'year') return { kind: 'year', year: end.year };
  return {
    kind: 'age',
    memberId: end.memberId ?? 'primary',
    years: end.years,
    months: end.months,
  };
}

/** Narrows an END-picker anchor to a cap-window END anchor, falling back to a whole-year `age` for the gated-off kinds; `age.memberId` is always kept. */
export function glideAnchorToMagiCapEnd(anchor: GlideAnchor): MagiCapEndAnchor {
  if (anchor.kind === 'year') return { kind: 'year', year: anchor.year };
  if (anchor.kind === 'age') {
    return {
      kind: 'age',
      memberId: anchor.memberId ?? 'primary',
      years: anchor.years,
      months: anchor.months,
    };
  }
  // retirementStart and the glide-only kinds are gated off the END picker; fall back to a whole-year age.
  return {
    kind: 'age',
    memberId: 'primary',
    years: DEFAULT_MAGI_CAP_END_AGE,
    months: 0,
  };
}

/** Narrows a START-picker anchor to a cap-window START anchor by delegating to `glideAnchorToScheduleStart`; `memberSelectable: true` with no `ownerRole` keeps `age.memberId`. */
export function glideAnchorToMagiCapStart(anchor: GlideAnchor): MagiCapStartAnchor {
  return glideAnchorToScheduleStart(anchor, {
    memberSelectable: true,
  }) as MagiCapStartAnchor;
}

export function magiCapStartToGlideAnchor(start: MagiCapStartAnchor): GlideAnchor {
  return scheduleStartToGlideAnchor(start);
}
