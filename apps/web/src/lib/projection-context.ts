/**
 * Shared projection context — anchors every engine (deterministic
 * Balance Projection, Monte Carlo, stress-test card) and downstream
 * view-model to the same "today" + retirement-boundary + horizon in
 * absolute-month units. Engines emit nominal balances internally and
 * the page deflates at the display boundary via `realDeflatorAt(...)`.
 *
 * Nominal internals + month-precise inflation/deflation
 * via shared context with explicit absolute `asOfMonth` field.
 *
 * Pure module — no IndexedDB, no React, no Date.now(). Callers pass
 * the anchor explicitly so tests stay deterministic.
 */
export interface ProjectionContext {
  /** Calendar year of "today" — the projection's anchor year. */
  readonly asOfYear: number;
  /** 0-11 month index of "today" within `asOfYear` (Jan = 0, Dec = 11).
   *  Display-side convenience; absolute math reads `asOfMonth`. */
  readonly asOfMonthIndex: number;
  /** Absolute month index of "today": `asOfYear * 12 + asOfMonthIndex`.
   *  Carries the unique anchor for all month-precise math. */
  readonly asOfMonth: number;
  /** Absolute month index of the first month the projection emits.
   *  Typically equal to `asOfMonth`. */
  readonly firstProjectionMonth: number;
  /** Absolute month index at which the primary member retires —
   *  household-drawdown boundary. */
  readonly primaryRetirementMonth: number;
  /** Last month inclusive in the projection horizon. */
  readonly horizonMonth: number;
  /** Annual inflation rate, percent (e.g. 3 for 3 %/yr). 0 yields the
   *  identity factor at every (year, monthIndex). */
  readonly inflationPct: number;
}

/**
 * Inflation factor at (year, monthIndex) relative to the context's
 * anchor month. Multiply a today's-dollar amount by this factor to
 * express it in nominal dollars at the target month.
 *
 * Targets later than the anchor yield factors > 1 (prices rose);
 * earlier targets yield < 1.
 */
export function inflationFactorAt(
  ctx: ProjectionContext,
  year: number,
  monthIndex: number,
): number {
  if (ctx.inflationPct === 0) return 1;
  const targetMonth = year * 12 + monthIndex;
  const monthsFromAnchor = targetMonth - ctx.asOfMonth;
  return Math.pow(1 + ctx.inflationPct / 100, monthsFromAnchor / 12);
}

/**
 * Multiplicative inverse of `inflationFactorAt`. Multiply a nominal
 * dollar value at (year, monthIndex) by this deflator to express it
 * in today's-dollar (anchor-month) terms.
 */
export function realDeflatorAt(
  ctx: ProjectionContext,
  year: number,
  monthIndex: number,
): number {
  if (ctx.inflationPct === 0) return 1;
  const targetMonth = year * 12 + monthIndex;
  const monthsFromAnchor = targetMonth - ctx.asOfMonth;
  return Math.pow(1 + ctx.inflationPct / 100, -monthsFromAnchor / 12);
}
