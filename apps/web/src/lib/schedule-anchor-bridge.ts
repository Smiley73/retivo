/**
 * Owner-aware `GlideAnchor ↔ ScheduleStart` bridge.
 *
 * The shared `<ScheduleAnchorPicker>` is typed in `GlideAnchor`, the
 * richer schedule-anchor vocabulary used by the discretionary glide.
 * Both forms' Start pickers model the narrower `ScheduleStart` (the same
 * 3 kinds: `retirementStart` / `age` / `year`). This module is the
 * single place that widens `ScheduleStart` → `GlideAnchor` inbound and
 * narrows `GlideAnchor` → `ScheduleStart` outbound, so the two forms
 * never re-implement the conversion or the owner-implicit `memberId`
 * policy.
 *
 * Owner-implicit rule (`db/types.ts` `ScheduleStart`): an
 * omitted `age.memberId` means the stream's owner. Income relies on
 * this; Expense always sets `memberId` explicitly. The bridge keeps
 * income owner-implicit by being owner-aware:
 * - Inbound: an income owner-implicit `age` resolves to `ownerRole` so
 *   the picker displays/bounds the actual owner instead of always
 *   defaulting to 'primary'.
 * - Outbound: `memberId` is omitted when the member `<select>` is hidden
 *   (`!memberSelectable`) OR the resolved role equals `ownerRole`, and
 *   kept only when the user explicitly picks the non-owner. Expense
 *   passes no `ownerRole` (and `memberSelectable` defaults true), so
 *   `memberId` is always kept.
 */
import type {
  GlideAnchor,
  HouseholdRole,
  MagiCapWindow,
  ScheduleStart,
} from '../db/types';

/** Default whole-year end age used when a cap-window END anchor can't be
 *  narrowed from the picker's `GlideAnchor` (the glide-only / `retirementStart`
 *  kinds are gated off the END picker; this is the defensive fallback).
 *  Extracted from the inline literal so the magic number has a single name. */
const DEFAULT_MAGI_CAP_END_AGE = 65;

/**
 * Widen a `ScheduleStart` into the `GlideAnchor` the shared picker
 * consumes (inbound). For an `age` start, `memberId` resolves to the
 * stored role, else the caller's `memberRole` (income passes its owner
 * role), else `'primary'`.
 */
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
 * Narrow a `GlideAnchor` from the shared picker back into a
 * `ScheduleStart` (outbound). The two glide-only kinds
 * (`durationFromExpenseStart` / `expenseEnd`) are impossible for a Start
 * picker — the component never offers them when `relativeKind` /
 * `expenseEndKind` are off — so this guards against them (falls back to
 * `retirementStart`).
 *
 * `age.memberId` keep/omit: omit when `!memberSelectable` OR the
 * resolved role equals `ownerRole`; keep it only when the user picked
 * the non-owner. Expense omits both options → `memberId` always kept.
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
      // Impossible for a Start picker (these kinds are gated off). Guard
      // exhaustively rather than trust the caller; fall back to the
      // safest default start.
      return { kind: 'retirementStart' };
  }
}

/** A cap window's START anchor is the same static subset as `ScheduleStart`
 *  (`retirementStart | age | year`). Alias for clarity at the cap call
 *  sites — the START picker is the default `ScheduleAnchorPicker`. */
export type MagiCapStartAnchor = MagiCapWindow['start'];
/** A cap window's END anchor (`age | year` only). */
export type MagiCapEndAnchor = MagiCapWindow['end'];

/** Widen a cap-window END anchor (`age | year`) into the `GlideAnchor` the
 *  shared picker consumes (inbound). Cap windows always carry an explicit
 *  `age.memberId` (migration seeds it; the UI writes it). */
export function magiCapEndToGlideAnchor(end: MagiCapEndAnchor): GlideAnchor {
  if (end.kind === 'year') return { kind: 'year', year: end.year };
  return {
    kind: 'age',
    memberId: end.memberId ?? 'primary',
    years: end.years,
    months: end.months,
  };
}

/** Narrow a `GlideAnchor` from the END picker (with `hideRetirementStart`) back
 *  into a cap-window END anchor (`age | year`). The glide-only kinds and
 *  `retirementStart` are gated off the END picker; this guards them defensively
 *  by falling back to an `age` anchor (the safe whole-year end). `age.memberId`
 *  is always KEPT — a cap window stores an explicit member on every age anchor
 *  so the resolver never needs an owner default. */
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
  // retirementStart / durationFromExpenseStart / expenseEnd are gated off the
  // END picker — guard exhaustively with a safe whole-year age fallback.
  return {
    kind: 'age',
    memberId: 'primary',
    years: DEFAULT_MAGI_CAP_END_AGE,
    months: 0,
  };
}

/** Narrow a `GlideAnchor` from the START picker back into a cap-window START
 *  anchor (`retirementStart | age | year`). Always KEEPS `age.memberId`
 *  (cap windows store an explicit member). The glide-only kinds are gated off
 *  the START picker; guarded defensively to `retirementStart`.
 *
 *  Delegates to `glideAnchorToScheduleStart` (the cap START subset is
 *  exactly `ScheduleStart`'s static kinds) rather than re-implementing the
 *  per-kind switch. `memberSelectable: true` + no `ownerRole` forces the
 *  keep-`memberId` branch (cap windows store an explicit member). The
 *  delegate's exhaustive guard maps the impossible glide-only kinds to
 *  `retirementStart`, so its `ScheduleStart` result is always one of the three
 *  static `MagiCapStartAnchor` kinds. */
export function glideAnchorToMagiCapStart(anchor: GlideAnchor): MagiCapStartAnchor {
  return glideAnchorToScheduleStart(anchor, {
    memberSelectable: true,
  }) as MagiCapStartAnchor;
}

/** Widen a cap-window START anchor into the picker's `GlideAnchor` (inbound). */
export function magiCapStartToGlideAnchor(start: MagiCapStartAnchor): GlideAnchor {
  return scheduleStartToGlideAnchor(start);
}
