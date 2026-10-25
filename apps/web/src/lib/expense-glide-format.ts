// Pure helpers for the expense glide Configure card: display, neutral-state and clamp logic for `DiscretionaryGlideOverride`.

import type {
  Aggregate,
  DiscretionaryGlideOverride,
  GlideAnchor,
  HouseholdMemberPayload,
  ScheduleEnd,
} from '../db/types';
import {
  monthIndex,
  resolveGlideAnchorMonth,
  type ScheduleResolveContext,
} from './schedule-resolution';

export const PCT_MIN = 0;
/** Glide percentage ceiling (200 = double). The engine's `clampPct` imports it so the form and engine cannot drift. */
export const PCT_MAX = 200;
export const NEUTRAL_END_PCT = 100;
export const NEUTRAL_FLOOR_PCT = 100;

export const neutralAnchor = (): GlideAnchor => ({
  kind: 'age',
  memberId: 'primary',
  years: 0,
  months: 0,
});

/** The value-equivalent "off" glide, which a scenario patch uses to clear an inherited one (`undefined` would mean "inherit"). */
export const neutralGlide = (): DiscretionaryGlideOverride => ({
  endMultiplierPct: NEUTRAL_END_PCT,
  glideStart: neutralAnchor(),
  glideEnd: neutralAnchor(),
});

/**
 * Whether the post-glide-end floor (or, for a rising glide, ceiling) actually
 * moves spending off the glide-end level. Shared with `report-format.ts`'s glide
 * summary so the two surfaces cannot diverge.
 */
export function hasEffectiveFloor(g: DiscretionaryGlideOverride): boolean {
  if (!g.floor) return false;
  if (g.endMultiplierPct > NEUTRAL_END_PCT) {
    return g.floor.multiplierPct > g.endMultiplierPct;
  }
  return g.floor.multiplierPct < g.endMultiplierPct;
}

/** True when the glide is flat (`end === 100`) with no effective floor, so it multiplies by 1 every month. */
export function isNeutralGlide(g: DiscretionaryGlideOverride): boolean {
  const isFlat = g.endMultiplierPct === NEUTRAL_END_PCT;
  const noFloor = !hasEffectiveFloor(g);
  return isFlat && noFloor;
}

function anchorResolved(a: GlideAnchor): boolean {
  return a.kind === 'age' ? a.years > 0 : true;
}

export function clampPct(n: number): number {
  return Math.max(PCT_MIN, Math.min(PCT_MAX, n));
}

// Not `schedule-format.ts`'s `resolveMemberLabel`: a glide anchor's `memberId` may be undefined (primary).
export function memberName(
  role: 'primary' | 'secondary' | undefined,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  const wantPrimary = role !== 'secondary';
  const m = members.find((x) => x.payload.isPrimary === wantPrimary);
  const name = m?.payload.firstName?.trim();
  if (name) return name;
  return wantPrimary ? 'Primary' : 'Secondary';
}

type ResolvedMonth = { year: number; month0: number };

// An `age` anchor at years <= 0 would resolve to the member's birth month, a silently wrong curve.
function anchorUnsetProblem(g: DiscretionaryGlideOverride): string | null {
  const ageUnset = [g.glideStart, g.glideEnd, g.floor?.anchor].some(
    (a) => a !== undefined && !anchorResolved(a),
  );
  return ageUnset
    ? 'A glide point is missing an age. Enter an age for each.'
    : null;
}

function startBeforeExpenseProblem(
  g: DiscretionaryGlideOverride,
  gs: ResolvedMonth,
  probe: ResolvedMonth,
): string | null {
  if (
    g.glideStart.kind !== 'durationFromExpenseStart' &&
    monthIndex(gs.year, gs.month0) < monthIndex(probe.year, probe.month0)
  ) {
    return 'The spending glide starts before the expense does. Set the glide start to on or after the expense’s start.';
  }
  return null;
}

// Two relative anchors resolve per expense, so they compare `.months`; otherwise absolute indices.
function endAfterStartProblem(
  g: DiscretionaryGlideOverride,
  gs: ResolvedMonth,
  ge: ResolvedMonth,
): string | null {
  let endAfterStart: boolean | null;
  if (
    g.glideStart.kind === 'durationFromExpenseStart' &&
    g.glideEnd.kind === 'durationFromExpenseStart'
  ) {
    endAfterStart = g.glideEnd.months > g.glideStart.months;
  } else {
    const gsIdx = monthIndex(gs.year, gs.month0);
    const geIdx = monthIndex(ge.year, ge.month0);
    endAfterStart =
      Number.isFinite(gsIdx) && Number.isFinite(geIdx) ? geIdx > gsIdx : null;
  }
  return endAfterStart === false
    ? 'The glide must end after it starts. Adjust the glide start or end.'
    : null;
}

function floorProblem(
  g: DiscretionaryGlideOverride,
  ge: ResolvedMonth,
  probe: ResolvedMonth,
  ctx: ScheduleResolveContext,
  end: ScheduleEnd | undefined,
): string | null {
  if (!g.floor) return null;
  const rising = g.endMultiplierPct > NEUTRAL_END_PCT;
  if (rising && g.floor.multiplierPct < g.endMultiplierPct) {
    return "The ceiling percentage can't be lower than the end percentage.";
  }
  if (!rising && g.floor.multiplierPct > g.endMultiplierPct) {
    return "The floor percentage can't be higher than the end percentage.";
  }
  const fm = resolveGlideAnchorMonth(g.floor.anchor, probe, ctx, end);
  if (!fm) {
    return rising
      ? 'The ceiling is missing an age. Enter it.'
      : 'The floor is missing an age. Enter it.';
  }
  let after: boolean | null;
  if (
    g.glideEnd.kind === 'durationFromExpenseStart' &&
    g.floor.anchor.kind === 'durationFromExpenseStart'
  ) {
    after = g.floor.anchor.months > g.glideEnd.months;
  } else {
    const geIdx = monthIndex(ge.year, ge.month0);
    const fIdx = monthIndex(fm.year, fm.month0);
    after =
      Number.isFinite(geIdx) && Number.isFinite(fIdx) ? fIdx > geIdx : null;
  }
  if (after === false) {
    return rising
      ? 'The ceiling must begin after the glide ends. Adjust the ceiling or glide end.'
      : 'The floor must begin after the glide ends. Adjust the floor or glide end.';
  }
  return null;
}

const EXPENSE_END_UNRESOLVABLE =
  "This expense's end can't be determined here. Pick a specific glide-end point instead.";

/**
 * The human cause a glide is invalid, or `null`. One validator for the form's Save
 * path and the live preview, resolved under the same scenario in every mode, so
 * the preview warning fires exactly when Save is blocked. `probe` is this
 * expense's resolved start month (or a retirement-year fallback).
 */
export function glideProblem(
  g: DiscretionaryGlideOverride,
  ctx: ScheduleResolveContext,
  probe: { year: number; month0: number },
  end?: ScheduleEnd,
): string | null {
  // Evaluation order is contractual (locked by tests).
  const unset = anchorUnsetProblem(g);
  if (unset) return unset;

  const gs = resolveGlideAnchorMonth(g.glideStart, probe, ctx, end);
  const ge = resolveGlideAnchorMonth(g.glideEnd, probe, ctx, end);
  if (!gs || !ge) {
    // `expenseEnd` has no age input, so the "missing an age" message would be wrong.
    if (g.glideEnd.kind === 'expenseEnd' && !ge) {
      return EXPENSE_END_UNRESOLVABLE;
    }
    return 'A glide point is missing an age. Enter an age for each.';
  }

  // With an `expenseEnd` glide-end a floor could never apply, so its checks are skipped.
  return (
    startBeforeExpenseProblem(g, gs, probe) ??
    endAfterStartProblem(g, gs, ge) ??
    (g.glideEnd.kind === 'expenseEnd'
      ? null
      : floorProblem(g, ge, probe, ctx, end))
  );
}
