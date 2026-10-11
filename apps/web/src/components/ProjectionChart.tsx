/**
 * Per-year line chart of total portfolio projection under each return
 * method (Planned, TWR) plus an optional Monte Carlo representative-run
 * overlay. Rendered on the Balance Projection page beneath the totals +
 * breakdown table.
 *
 * Lazy-imports the SVG chart-engine renderer so it only loads when
 * the user visits this page (kept off the auth + dashboard critical
 * path). Renders a small placeholder while the import is in flight.
 */
import React, { Suspense, lazy, useMemo } from 'react';
import type { TooltipMember } from './tooltip-member';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';

export type ProjectionMethod = 'planned' | 'twr';

/**
 * A single row on the per-year line chart. Each method splits into
 * `*Solid` and `*Dashed` channels so we can render the pre-retirement
 * portion of the line as a solid stroke and the retirement year as
 * a dashed stroke (signals "partial-year math, no contribs after the
 * retirement date"). The shared boundary year (the year before
 * retirement) carries values in BOTH channels so the two `<Line>`
 * series visually connect into one continuous path.
 *
 * `year` is the calendar year that the row's value represents
 * (year-end balance of that year). `x` is its chart X position —
 * `year + 1`, because integer X ticks are calendar boundaries: the
 * "2033" tick is the start of 2033, so the year-end-2033 value is
 * plotted at X = 2034 ("end of 2033 / start of 2034"). This puts
 * the "year 2033" interval visually between the "2033" and "2034"
 * ticks, where mid-year retirement markers naturally sit.
 */
export interface ProjectionChartRow {
  year: number;
  x: number;
  /** Month anchor for display deflation. Omitted rows are year-end
   *  December values; fractional retirement snapshots set their real
   *  retirement month so today's-dollar display does not over-deflate
   *  a mid-year point. */
  valueMonthIndex?: number;
  plannedSolid: number | null;
  plannedDashed: number | null;
  twrSolid: number | null;
  twrDashed: number | null;
  /** Pre-retirement investment gains for the year under each method.
   *  Summed across every projected account whose `yearlyTotals` includes
   *  this year. `null` for synthesized rows (the fractional retirement-
   *  snapshot row) or when no account contributes to the method. The
   *  year-by-year table's Gains column reads these for rows outside the
   *  cashflow window (pre-retirement); inside the cashflow window the
   *  drawdown engine's growth supersedes them. */
  plannedGrowth: number | null;
  twrGrowth: number | null;
  /** Monte Carlo representative-run channel (nullable). Populated only when a
   *  Monte Carlo basis is active; the representative balance line draws solid
   *  pre-retirement (`mcSolid`) / dashed through the drawdown (`mcDashed`) in
   *  the tier color, and `mcGrowth` carries the run's per-year investment gains
   *  for the year-by-year table's pre-retirement Gains column. Already in the
   *  display basis (today's-dollars deflated by the PATH's own CPI, or nominal
   *  in Future-dollars). `null`/absent for deterministic bases. */
  mcSolid?: number | null;
  mcDashed?: number | null;
  mcGrowth?: number | null;
}

/**
 * A vertical reference line dropped on the chart at the actual
 * (fractional) retirement moment. Surfaces the partial-year boundary
 * the user would otherwise have to infer from the slope dip.
 */
export interface RetirementMarker {
  /** `year + m` where `m` is the in-year fraction. Drives the X position. */
  fractionalYear: number;
  /** Short human label, e.g. `Ana retires Mar 2033` or `Both retire Mar 2033`. */
  label: string;
}

/**
 * A vertical reference line at a household member's projected
 * end-of-life. Identical shape to the cashflow chart's death marker
 * so the same array can feed both charts without conversion.
 */
export interface LifeExpectancyMarker {
  fractionalYear: number;
  label: string;
  color: string;
}

/**
 * Optional Monte-Carlo overlay drawn on the deterministic projection chart
 * as two ADDITIONAL line series — "Typical" (P50) and "Pessimistic"
 * (P25), each solid pre-retirement and dashed past it like Planned/TWR.
 * Used by the Dashboard's chart card to show the fresh stress-test
 * outcome alongside the Planned line WITHOUT the fan bands. The arrays are per-year values starting at `firstYear`, in the
 * same basis (today's-dollars / real) as the chart's deterministic rows;
 * `typical[i]` / `pessimistic[i]` belong to calendar year `firstYear + i`.
 * Only the years the overlay covers are drawn — it never extends the
 * deterministic line's domain.
 */
export interface ProjectionMcOverlay {
  firstYear: number;
  typical: number[];
  pessimistic: number[];
}

interface ProjectionChartProps {
  rows: ProjectionChartRow[];
  /**
   * Calculated methods that have at least one account contributing.
   * Methods absent from this set are not drawn (no series, no legend
   * entry) — avoids a flat zero line whose tooltip suggests the
   * household is broke under that method.
   */
  enabledCalculatedMethods: Set<Exclude<ProjectionMethod, 'planned'>>;
  retirementMarkers: RetirementMarker[];
  /** Per-member projected end-of-life markers. Optional — only
   *  rendered when the post-retirement portion of the chart is
   *  visible (otherwise the markers would sit past the X-axis edge). */
  lifeExpectancyMarkers?: LifeExpectancyMarker[];
  /** Household members for the hover tooltip's "<First> (age N)"
   *  rows. Empty/omitted suppresses that line. */
  tooltipMembers?: TooltipMember[];
  /** Y-axis scale. Default 'linear'. */
  yScale?: 'linear' | 'log';
  /** Zoom-state props injected by useChartZoom in the host section. */
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
  /** Optional Monte-Carlo overlay (P50 Typical + P25 Pessimistic lines).
   *  When present, two extra solid line series are drawn over the
   *  deterministic Planned/TWR lines. `null`/omitted draws only the
   *  deterministic lines. */
  mcOverlay?: ProjectionMcOverlay | null;
  /** Representative-run line styling when a Monte Carlo basis is active. When
   *  present AND the rows carry `mcSolid`/`mcDashed`, one extra line is drawn
   *  (solid pre-retirement / dashed post) in the tier `color`, labelled by the
   *  tier name. `null`/omitted draws no representative line. */
  mcLine?: { color: string; label: string } | null;
}

const InnerChart = lazy(() => import('./ProjectionChartInner'));

function chartFallback(): React.ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex h-80 items-center justify-center text-muted"
    >
      Loading chart…
    </div>
  );
}

export const ProjectionChart: React.FC<ProjectionChartProps> = ({
  rows,
  enabledCalculatedMethods,
  retirementMarkers,
  lifeExpectancyMarkers,
  tooltipMembers,
  yScale = 'linear',
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging,
  mcOverlay,
  mcLine,
}) => {
  const data = useMemo(() => rows, [rows]);
  if (data.length === 0) {
    return (
      <p className="m-0 text-muted">
        No projection years to chart yet.
      </p>
    );
  }
  return (
    <Suspense fallback={chartFallback()}>
      <InnerChart
        rows={data}
        enabledCalculatedMethods={enabledCalculatedMethods}
        retirementMarkers={retirementMarkers}
        lifeExpectancyMarkers={lifeExpectancyMarkers ?? []}
        tooltipMembers={tooltipMembers ?? []}
        yScale={yScale}
        xDomain={xDomain}
        yDomain={yDomain}
        dragSelection={dragSelection}
        mouseHandlers={mouseHandlers}
        isDragging={isDragging}
        mcOverlay={mcOverlay ?? null}
        mcLine={mcLine ?? null}
      />
    </Suspense>
  );
};
