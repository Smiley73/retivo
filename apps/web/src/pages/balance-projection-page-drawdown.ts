/**
 * Balance Projection page — chart-row real-dollar deflator.
 *
 * The page-local drawdown pipeline (`buildDrawdownByMethod` + its
 * `simulateDrawdown` call site) was deleted in the runner migration:
 * the deterministic drawdown now comes from `runBalanceProjectionForPage`
 * via `drawdownByMethodFromPageResult` (balance-projection-page-data.ts).
 * The shared engine `simulateDrawdown` (drawdown-engine.ts) stays — the
 * runner consumes it. Only the per-year balance line-chart deflator
 * survives here; it stitches the runner's per-method drawdown balances
 * onto the accumulation chart rows and converts to today's dollars.
 */
import type {
  ProjectionChartRow,
  ProjectionMethod,
} from '../components/ProjectionChart';
import type {
  DrawdownByMethodResult,
  RepresentativeRun,
} from './balance-projection-page-data';
import type { DisplayMode } from '../lib/view-deflator';

const PROJECTION_CHART_TAIL_YEARS = 0;

/**
 * Read the representative run's per-year balance + growth in the active display
 * basis. In Today's-dollars (`today`) the run self-deflates by the PATH's own
 * sampled CPI (`realBalanceByYear` / `realGrowthByYear`) — NOT the
 * scenario's `viewDeflator`. In Future-dollars the nominal `years[]` values are
 * read verbatim. Returns `null` outside the run's horizon.
 */
function mcValuesForYear(
  run: RepresentativeRun,
  year: number,
  displayMode: DisplayMode,
): { balance: number | null; growth: number | null } {
  const idx = year - run.firstYear;
  if (idx < 0 || idx >= run.years.length) return { balance: null, growth: null };
  if (displayMode === 'today') {
    return {
      balance: run.realBalanceByYear[idx] ?? null,
      growth: run.realGrowthByYear[idx] ?? null,
    };
  }
  return { balance: run.years[idx].balance, growth: run.years[idx].growth };
}

export function deflateChartRows(opts: {
  readonly chartRows: ReadonlyArray<ProjectionChartRow>;
  readonly drawdownByMethod:
    | Record<ProjectionMethod, DrawdownByMethodResult | null>
    | null;
  readonly lastDeathYear: number | null;
  readonly retirementYear: number | null;
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** Active representative run when a Monte Carlo basis is selected; `null`
   *  for a deterministic basis. Drives the `mc` chart-row channel. */
  readonly representativeRun?: RepresentativeRun | null;
  /** Display basis — picks the run's real (today) vs nominal (future) series. */
  readonly displayMode?: DisplayMode;
}): ProjectionChartRow[] {
  const {
    chartRows,
    drawdownByMethod,
    lastDeathYear,
    retirementYear,
    viewDeflator,
    representativeRun = null,
    displayMode = 'today',
  } = opts;
  if (chartRows.length === 0) return [...chartRows];
  if (!drawdownByMethod || lastDeathYear === null || retirementYear === null) {
    return [...chartRows];
  }

  const deflate = (
    year: number,
    monthIndex: number | undefined,
    v: number | null,
  ): number | null =>
    v === null ? null : v * viewDeflator(year, monthIndex ?? 11);

  // Representative-run `mc` channel: the balance line draws solid before
  // retirement and dashed from the retirement year onward (mirroring the
  // deterministic split), in the run's own display basis. The retirement-year
  // integer row carries the value in BOTH channels so the two sub-paths join.
  const mcChannel = (
    year: number,
  ): { solid: number | null; dashed: number | null; growth: number | null } => {
    if (!representativeRun) return { solid: null, dashed: null, growth: null };
    const { balance, growth } = mcValuesForYear(representativeRun, year, displayMode);
    const solid = year <= retirementYear ? balance : null;
    const dashed = year >= retirementYear ? balance : null;
    return { solid, dashed, growth };
  };

  const out: ProjectionChartRow[] = chartRows.map((r) => {
    const mc = Number.isInteger(r.x) ? mcChannel(r.year) : { solid: null, dashed: null, growth: null };
    return {
      ...r,
      plannedSolid: deflate(r.year, r.valueMonthIndex, r.plannedSolid),
      plannedDashed: deflate(r.year, r.valueMonthIndex, r.plannedDashed),
      twrSolid: deflate(r.year, r.valueMonthIndex, r.twrSolid),
      twrDashed: deflate(r.year, r.valueMonthIndex, r.twrDashed),
      plannedGrowth: deflate(r.year, r.valueMonthIndex, r.plannedGrowth),
      twrGrowth: deflate(r.year, r.valueMonthIndex, r.twrGrowth),
      mcSolid: mc.solid,
      mcDashed: mc.dashed,
      mcGrowth: mc.growth,
    };
  });

  const retYearFactor = viewDeflator(retirementYear, 11);
  for (const row of out) {
    if (row.year !== retirementYear || !Number.isInteger(row.x)) continue;
    const planned0 = drawdownByMethod.planned?.years[0]?.balance ?? null;
    const twr0 = drawdownByMethod.twr?.years[0]?.balance ?? null;
    if (planned0 !== null) row.plannedDashed = planned0 * retYearFactor;
    if (twr0 !== null) row.twrDashed = twr0 * retYearFactor;
  }

  // `lastDeathYear` is the integer death year now (death = Dec 31 of
  // `deathYear`, the terminal year), so the drawdown rows end at
  // `deathYear` (tail = 0). The balance chart adds its own `year + 1`
  // convention so the death-year-end point renders at `deathYear + 1`.
  const tailEndYear = lastDeathYear + PROJECTION_CHART_TAIL_YEARS;
  const cleanBalance = (b: number | null | undefined): number | null =>
    b === null || b === undefined || b === 0 ? null : b;
  for (let y = retirementYear + 1; y <= tailEndYear; y += 1) {
    const idx = y - retirementYear;
    const planned = cleanBalance(
      drawdownByMethod.planned?.years[idx]?.balance,
    );
    const twr = cleanBalance(drawdownByMethod.twr?.years[idx]?.balance);
    const mcDashed = representativeRun
      ? cleanBalance(mcChannel(y).dashed)
      : null;
    if (planned === null && twr === null && mcDashed === null) continue;
    const yearFactor = viewDeflator(y, 11);
    out.push({
      year: y,
      x: y + 1,
      plannedSolid: null,
      plannedDashed: planned === null ? null : planned * yearFactor,
      twrSolid: null,
      twrDashed: twr === null ? null : twr * yearFactor,
      plannedGrowth: null,
      twrGrowth: null,
      mcSolid: null,
      // `mcChannel` already returned the value in display basis (real-deflated
      // for today / nominal for future) — do NOT re-apply `yearFactor`.
      mcDashed,
      mcGrowth: null,
    });
  }
  out.sort((a, b) => a.x - b.x);
  return out;
}
