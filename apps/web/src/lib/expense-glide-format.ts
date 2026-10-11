/**
 * Pure helpers for the Expense glide path Configure card/modal. No
 * React, no DOM — parallels expense-format.ts / income-format.ts so the
 * card stays under the shape limit. Display + neutral-state + clamp
 * concerns for `DiscretionaryGlideOverride`.
 */
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
/** Glide percentage ceiling: 200 = double the entered amount. `<100`
 *  declines, `100` is neutral, `>100` rises. Shared single source of
 *  truth — the engine `clampPct` in `expense-glide.ts` imports this so
 *  the form (0–200) and engine (fraction 0–2) cannot drift. */
export const PCT_MAX = 200;
export const NEUTRAL_END_PCT = 100;
export const NEUTRAL_FLOOR_PCT = 100;

export const neutralAnchor = (): GlideAnchor => ({
  kind: 'age',
  memberId: 'primary',
  years: 0,
  months: 0,
});

/**
 * The value-equivalent "off" glide (ND15b): `endMultiplierPct: 100`
 * with no effective floor ⇒ the engine multiplier is `1` every active
 * month. A scenario patch uses this to clear an inherited glide —
 * `undefined` is not a delete-marker (it would mean "inherit"), and a
 * patch can only *set* a value, never delete an inherited key.
 */
export const neutralGlide = (): DiscretionaryGlideOverride => ({
  endMultiplierPct: NEUTRAL_END_PCT,
  glideStart: neutralAnchor(),
  glideEnd: neutralAnchor(),
});

/**
 * Direction-aware floor/ceiling effectiveness — the ONE shared predicate
 * (also consumed by `report-format.ts`'s glide summary) so the two
 * surfaces can never diverge on the ceiling case. The post-glide-end
 * plateau is effective when it actually moves spending off the glide-end
 * level: for a declining glide (`end < 100`) a *floor* steps down when
 * `floor% < end%`; for a rising glide (`end > 100`) the same field is a
 * *ceiling* and is effective when it caps higher than the glide end,
 * `floor% > end%`. At `end === 100` (neutral end) any `floor% < 100`
 * still steps spending down, so a below-100 floor stays effective.
 */
export function hasEffectiveFloor(g: DiscretionaryGlideOverride): boolean {
  if (!g.floor) return false;
  if (g.endMultiplierPct > NEUTRAL_END_PCT) {
    return g.floor.multiplierPct > g.endMultiplierPct;
  }
  return g.floor.multiplierPct < g.endMultiplierPct;
}

/**
 * True when this glide is a mathematical no-op (the value-equivalent
 * "off"): the glide is flat (`endMultiplierPct === 100`, neither a
 * decline nor a rise) AND no effective floor/ceiling. The end test
 * tightened from `>= 100` to `=== 100` so a rising glide
 * (`end > 100`) is never treated as neutral; the `noFloor` clause is
 * retained verbatim via the shared `hasEffectiveFloor` predicate so the
 * `continuousContribution` fast-path guard still routes an
 * `end=100 + floor<100` step-down through the per-month sum.
 */
export function isNeutralGlide(g: DiscretionaryGlideOverride): boolean {
  const isFlat = g.endMultiplierPct === NEUTRAL_END_PCT;
  const noFloor = !hasEffectiveFloor(g);
  return isFlat && noFloor;
}

/** An `age` anchor with no entered years is the "unresolved /
 *  empty" state; every other kind is inherently set. */
export function anchorResolved(a: GlideAnchor): boolean {
  return a.kind === 'age' ? a.years > 0 : true;
}

export function clampPct(n: number): number {
  return Math.max(PCT_MIN, Math.min(PCT_MAX, n));
}

/**
 * Glide-anchor member label. Intentionally NOT delegated to
 * `schedule-format.ts`'s `resolveMemberLabel`: that helper requires a
 * concrete `HouseholdRole` plus a caller-supplied fallback string,
 * whereas a glide `age` anchor's `memberId` is optionally `undefined`
 * (defaults to primary) and the capitalised `'Primary'` / `'Secondary'`
 * fallback is baked in here. Forcing the shared helper would lose the
 * undefined-role default — kept distinct on purpose.
 */
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

/**
 * Glide validation (ND12, identical in canonical and scenario-patch
 * mode). Single source of truth shared by the Expense form's Save path
 * AND the live projection preview. Both resolve the glide context under
 * the same scenario in **all three modes** (canonical, scenario-patch,
 * scenario-only-add — the Save path now threads the add-target), so
 * the inline preview warning fires exactly when Save is blocked — the
 * two can never disagree. Rejects:
 *   - an `age` anchor (glide-start / glide-end / floor) left at
 *     `years <= 0` — that resolves to the member's birth month, a
 *     silently-wrong full curve (uses the shared `anchorResolved`);
 *   - unresolvable glide / floor anchors;
 *   - a glide-start that resolves **before the expense's own start** —
 *     the glide describes a rise or fall OF this expense over its own
 *     life, so a glide that begins before the expense exists is
 *     degenerate (the curve would already be mid-ramp on the expense's
 *     first month and cannot be sensibly visualised);
 *   - a glide-end anchor that does not resolve strictly *after*
 *     glide-start;
 *   - the direction-aware plateau bound: `floor% > end%` for a decline,
 *     `ceiling% < end%` for a rise;
 *   - a floor/ceiling anchor not strictly after the glide-end anchor.
 *
 * `probe` is THIS expense's resolved start month (or a retirement-year
 * fallback — the real retirement month when it resolves, `month0: 0`
 * only when the retirement date itself can't resolve), so
 * `durationFromExpenseStart` anchors resolve against the real expense
 * start rather than a retirement-year stand-in. The engine is fail-safe
 * regardless (returns 1 on a bad anchor); this is the inline-error UX.
 * Returns the human cause or `null` when valid.
 */
type ResolvedMonth = { year: number; month0: number };

/**
 * An `age` anchor left at years <= 0 resolves to the member's birth
 * month — a silently-wrong full decline. Rejected before resolving so
 * the user sees the same message whether the anchor is unset or simply
 * unresolvable.
 */
function anchorUnsetProblem(g: DiscretionaryGlideOverride): string | null {
  const ageUnset = [g.glideStart, g.glideEnd, g.floor?.anchor].some(
    (a) => a !== undefined && !anchorResolved(a),
  );
  return ageUnset
    ? 'A glide point is missing an age. Enter an age for each.'
    : null;
}

/**
 * The glide can't begin before the expense itself begins. A
 * `durationFromExpenseStart` glide-start is offset forward from the
 * expense start (months ≥ 0) so it never trips this; only the absolute
 * kinds (retirementStart / year / age) can resolve earlier than the
 * expense's own start.
 */
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

/**
 * Glide-end must resolve strictly after glide-start. Mirror the
 * floor-after-end special-case: for a relative/relative pair compare
 * `.months` (they resolve per-expense), else compare absolute indices.
 */
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

/**
 * The post-glide-end plateau is direction-aware: a declining
 * glide (`end < 100`) treats the field as a *floor* and requires
 * `floor% ≤ end%`; a rising glide (`end > 100`) treats the same field as
 * a *ceiling* and requires `ceiling% ≥ end%`. The plateau anchor must
 * resolve and (best-effort) resolve strictly after glide-end. Same
 * relative/relative vs absolute comparison as `endAfterStartProblem`.
 */
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

/**
 * The `expenseEnd` glide-end can't resolve here — the expense has no
 * resolvable `end` (a one-off, or an `end` window that can't resolve in
 * this context). A distinct, non-age message: telling the user to
 * "enter an age" would be wrong (this anchor has no age input). Hard-
 * blocks Save and surfaces identically in the shared live preview.
 */
const EXPENSE_END_UNRESOLVABLE =
  "This expense's end can't be determined here. Pick a specific glide-end point instead.";

export function glideProblem(
  g: DiscretionaryGlideOverride,
  ctx: ScheduleResolveContext,
  probe: { year: number; month0: number },
  end?: ScheduleEnd,
): string | null {
  // Evaluation order is contractual (locked by tests): age-unset →
  // unresolvable gs/ge → before-expense → end-after-start → floor
  // checks. Each helper returns the first non-null cause.
  const unset = anchorUnsetProblem(g);
  if (unset) return unset;

  const gs = resolveGlideAnchorMonth(g.glideStart, probe, ctx, end);
  const ge = resolveGlideAnchorMonth(g.glideEnd, probe, ctx, end);
  if (!gs || !ge) {
    // `expenseEnd` has no age input, so the "missing an age" string
    // would be wrong — surface a tailored message instead. The
    // engine still independently fail-safes to multiplier 1.
    if (g.glideEnd.kind === 'expenseEnd' && !ge) {
      return EXPENSE_END_UNRESOLVABLE;
    }
    return 'A glide point is missing an age. Enter an age for each.';
  }

  // A floor must resolve strictly after glide-end. When glide-end is
  // `expenseEnd` a floor would have to start after the expense's own
  // end — it can never apply — so the floor sub-section is disabled in
  // the UI and its checks are skipped here (the value carries no floor).
  return (
    startBeforeExpenseProblem(g, gs, probe) ??
    endAfterStartProblem(g, gs, ge) ??
    (g.glideEnd.kind === 'expenseEnd'
      ? null
      : floorProblem(g, ge, probe, ctx, end))
  );
}
