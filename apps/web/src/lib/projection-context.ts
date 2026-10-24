// Shared projection context anchoring every engine to the same "today", retirement boundary and horizon in absolute-month units.
// Engines emit nominal balances and the page deflates at the display boundary via `realDeflatorAt`. Pure: callers pass the anchor, so tests stay deterministic.

export interface ProjectionContext {
  readonly asOfYear: number;
  /** 0-11 within `asOfYear`; display convenience, absolute math reads `asOfMonth`. */
  readonly asOfMonthIndex: number;
  /** `asOfYear * 12 + asOfMonthIndex`: the anchor for all month-precise math. */
  readonly asOfMonth: number;
  /** First month the projection emits; typically `asOfMonth`. */
  readonly firstProjectionMonth: number;
  /** The primary member's retirement month: the household drawdown boundary. */
  readonly primaryRetirementMonth: number;
  readonly horizonMonth: number;
  /** Annual inflation percent; 0 gives the identity factor. */
  readonly inflationPct: number;
}

/** Factor to express a today's-dollar amount in nominal dollars at (year, monthIndex): above 1 after the anchor, below 1 before it. */
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

/** Inverse of `inflationFactorAt`: expresses a nominal amount at (year, monthIndex) in today's dollars. */
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
