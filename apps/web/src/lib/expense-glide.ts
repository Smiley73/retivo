// Per-expense spending glide (real spending rising or falling over retirement), multiplied into essential and discretionary contributions on each expense's own clock.
// Curve: 100% to glide-start, linear to `endMultiplierPct` by glide-end, then flat or the plateau (floor for a fall, ceiling for a rise) if strictly after it; no override or an unresolvable anchor gives 1.

import type { ExpensePayload } from '../db/types';
import { hasEffectiveFloor, PCT_MAX, PCT_MIN } from './expense-glide-format';
import {
  monthIndex,
  resolveGlideAnchorMonth,
  resolveStartMonth,
  type ScheduleResolveContext,
} from './schedule-resolution';

// Only the fields the glide reads.
type GlideExpense = Pick<
  ExpensePayload,
  'start' | 'discretionaryGlide' | 'frequency' | 'end'
>;

// Shares `PCT_MAX` with the form so the engine fraction (0-2) and the form percentage cannot drift.
const clampPct = (pct: number): number =>
  Math.max(PCT_MIN, Math.min(PCT_MAX, pct)) / 100;

/** Multiplier for one expense at an absolute month index (`year * 12 + month0`), in `[0, 2]`, or exactly 1 on every fail-safe path. */
export function glideMultiplierFor(
  expense: GlideExpense,
  atMonthIndex: number,
  ctx: ScheduleResolveContext,
): number {
  const glide = expense.discretionaryGlide;
  if (!glide) return 1;
  // A glide is a multi-period curve, meaningless for a lump sum: a one-off ignores any stored or inherited glide.
  if (expense.frequency === 'oneOff') return 1;

  // The expense's own start seeds `durationFromExpenseStart` anchors; unresolvable means glide off.
  const expenseStart = resolveStartMonth(expense.start, ctx);
  if (!expenseStart) return 1;

  const gs = resolveGlideAnchorMonth(
    glide.glideStart,
    expenseStart,
    ctx,
    expense.end,
  );
  const ge = resolveGlideAnchorMonth(
    glide.glideEnd,
    expenseStart,
    ctx,
    expense.end,
  );
  if (!gs || !ge) return 1;

  const gsIdx = monthIndex(gs.year, gs.month0);
  const geIdx = monthIndex(ge.year, ge.month0);
  const endMult = clampPct(glide.endMultiplierPct);

  // The step applies only when the plateau is effective (the shared `hasEffectiveFloor`, so the engine and
  // `isNeutralGlide` agree on wrong-side data-import values) and resolves strictly after glide-end for this
  // expense; save-time validation cannot catch every per-expense case. Otherwise fall through to the glide curve.
  if (glide.floor && hasEffectiveFloor(glide)) {
    const fm = resolveGlideAnchorMonth(
      glide.floor.anchor,
      expenseStart,
      ctx,
      expense.end,
    );
    if (!fm) return 1;
    const fIdx = monthIndex(fm.year, fm.month0);
    if (fIdx > geIdx && atMonthIndex >= fIdx) {
      return clampPct(glide.floor.multiplierPct);
    }
  }

  if (atMonthIndex < gsIdx) return 1;

  if (gsIdx >= geIdx) return endMult;

  if (atMonthIndex >= geIdx) return endMult;

  const t = (atMonthIndex - gsIdx) / (geIdx - gsIdx);
  return 1 + (endMult - 1) * t;
}
