/**
 * Per-expense spending glide path — real spending can rise or fall over
 * retirement (a fall is the classic go-go → slow-go → no-go decline; a
 * rise models escalating costs such as later-life care). All net-new
 * curve math for the feature lives here: a bounded, pure,
 * React-free module the expense engine multiplies into both essential and
 * discretionary contributions (the glide is classification-agnostic).
 *
 * The multiplier is evaluated **per expense** against its own glide clock:
 * absolute anchors (`retirementStart` / `year` / `age`)
 * land at the same calendar point for every expense, while
 * `durationFromExpenseStart` is offset from each expense's own resolved
 * start; the glide-end-only `expenseEnd` anchor tracks the
 * expense's own resolved `end` window.
 *
 * One-off expenses are never glided: `glideMultiplierFor` early-returns
 * `1` for `frequency === 'oneOff'` (a glide is a multi-period rise/fall
 * curve, meaningless for a single lump-sum event). Any stored /
 * inherited glide on a one-off is left untouched and ignored.
 *
 * Curve, per expense, by absolute month index:
 *   • flat 100% before the glide-start anchor
 *   • linear interpolation 100% → `endMultiplierPct` between glide-start
 *     and glide-end (`endMultiplierPct < 100` falls, `> 100` rises)
 *   • flat at `endMultiplierPct` from glide-end until any plateau anchor
 *   • step to `floor.multiplierPct` from the plateau anchor onward —
 *     applied only when it resolves STRICTLY AFTER glide-end for this
 *     expense; an at-or-before-end plateau is ignored (fail-safe). The
 *     plateau is a *floor* for a falling glide, a *ceiling* for a rising
 *     one (direction-aware validation in `expense-glide-format.ts`).
 * A degenerate per-expense window (glide-start resolves ≥ glide-end)
 * snaps to `endMultiplierPct` from glide-start with no divide-by-zero.
 *
 * Fail-safe: absent override, or any required anchor
 * unresolvable for this expense ⇒ returns `1` (glide off for that expense
 * only, others unaffected, no console noise).
 */
import type { ExpensePayload } from '../db/types';
import { hasEffectiveFloor, PCT_MAX, PCT_MIN } from './expense-glide-format';
import {
  monthIndex,
  resolveGlideAnchorMonth,
  resolveStartMonth,
  type ScheduleResolveContext,
} from './schedule-resolution';

/** Subset of `ExpensePayload` the glide reads — the spec source is now
 *  the resolved expense's own `discretionaryGlide`, not a scenario-
 *  level context field. The projection engine passes the full payload;
 *  this keeps the contract explicit. `frequency` drives the one-off
 *  never-glided rule; `end` feeds the `expenseEnd` glide-end anchor. */
type GlideExpense = Pick<
  ExpensePayload,
  'start' | 'discretionaryGlide' | 'frequency' | 'end'
>;

// Ceiling sourced from the shared `PCT_MAX` constant (0–200 form domain)
// so the engine fraction (0–2) and the form percentage can never drift.
// `200 → 2.0` is double the entered amount.
const clampPct = (pct: number): number =>
  Math.max(PCT_MIN, Math.min(PCT_MAX, pct)) / 100;

/**
 * Resolved-multiplier for one expense (essential or discretionary) at one
 * absolute month index (`year * 12 + month0`). Returns a value in
 * `[0, 2]`, or exactly `1` on every fail-safe / no-op path.
 */
export function glideMultiplierFor(
  expense: GlideExpense,
  atMonthIndex: number,
  ctx: ScheduleResolveContext,
): number {
  const glide = expense.discretionaryGlide;
  if (!glide) return 1;
  // A spending glide is a multi-period rise/fall curve — conceptually
  // meaningless for a single lump-sum event. A one-off is never glided
  // (Decision: one-offs no longer scale by the multiplier). Any
  // stored / inherited glide on a one-off is left untouched and ignored
  // (same precedent as a stray recurring `end` after a freq→one-off
  // flip). The form also hides the glide section for one-offs; this is
  // the engine backstop for an inherited glide the UI never rendered.
  if (expense.frequency === 'oneOff') return 1;

  // The expense's own resolved start seeds `durationFromExpenseStart`
  // anchors; an unresolvable start (e.g. broken member ref — already
  // skipped upstream) is treated as glide-off for this expense.
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

  // Plateau step: a required anchor when configured — unresolvable ⇒
  // glide off for this expense (consistent with the glide anchors).
  // The save-time `floorAfterEnd()` check is best-effort and cannot
  // catch every per-expense case (mixed absolute/relative anchors,
  // `durationFromExpenseStart` resolving differently per expense), so
  // the engine is robust regardless: only apply the step when (a) the
  // plateau is direction-aware *effective* (the shared `hasEffectiveFloor`
  // predicate — a ceiling above the glide end for a rise, a floor below it
  // for a fall — so the engine and `isNeutralGlide` can never disagree on a
  // wrong-side / ineffective plateau reachable via verbatim data-import)
  // AND (b) it resolves STRICTLY AFTER glide-end FOR THIS EXPENSE
  // (`fIdx > geIdx`); otherwise ignore it and fall through to the bare
  // glide curve (fail-safe).
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

  // Before the glide starts: full real spend.
  if (atMonthIndex < gsIdx) return 1;

  // Degenerate window (glide-start ≥ glide-end): snap to the end
  // multiplier from glide-start instead of dividing by zero.
  if (gsIdx >= geIdx) return endMult;

  // Flat at the end multiplier once the glide has completed.
  if (atMonthIndex >= geIdx) return endMult;

  // Linear interpolation 1 → endMult across [gsIdx, geIdx).
  const t = (atMonthIndex - gsIdx) / (geIdx - gsIdx);
  return 1 + (endMult - 1) * t;
}
