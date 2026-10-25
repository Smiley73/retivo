/**
 * Per-year line chart of projected portfolio balance under each return method, with an optional Monte Carlo overlay.
 * Lazy-loads the SVG chart-engine renderer and shows a placeholder meanwhile.
 */
import React, { Suspense, lazy, useMemo } from 'react';
import type { TooltipMember } from './tooltip-member';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';

export type ProjectionMethod = 'planned' | 'twr';

/**
 * One row of the per-year chart. Each method splits into `*Solid` and `*Dashed` channels
 * (pre-retirement solid, retirement year dashed); the boundary year carries both so the series
 * join. `x` is `year + 1`, because integer ticks are calendar boundaries and `year` is a year-end
 * value.
 */
export interface ProjectionChartRow {
  year: number;
  x: number;
  /**
   * Month anchor for display deflation; omitted means December, a fractional retirement snapshot
   * sets its real month.
   */
  valueMonthIndex?: number;
  plannedSolid: number | null;
  plannedDashed: number | null;
  twrSolid: number | null;
  twrDashed: number | null;
  /**
   * Pre-retirement investment gains summed across projected accounts; `null` for synthesized rows
   * or when no account contributes.
   */
  plannedGrowth: number | null;
  twrGrowth: number | null;
  /**
   * Monte Carlo representative-run channel, in the display basis; `null` or absent for
   * deterministic bases. `mcGrowth` feeds the pre-retirement Gains column.
   */
  mcSolid?: number | null;
  mcDashed?: number | null;
  mcGrowth?: number | null;
}

/** A vertical reference line at the fractional retirement moment. */
export interface RetirementMarker {
  /** `year + m` for the in-year fraction `m`. */
  fractionalYear: number;
  label: string;
}

/**
 * A vertical reference line at a member's projected end of life, shaped like the cashflow chart's
 * death marker.
 */
export interface LifeExpectancyMarker {
  fractionalYear: number;
  label: string;
  color: string;
}

/**
 * Monte Carlo overlay drawn as two extra lines, Typical (P50) and Pessimistic (P25), without fan
 * bands. Arrays are per-year values from `firstYear` in the chart's real-dollar basis; the overlay
 * never extends the deterministic domain.
 */
export interface ProjectionMcOverlay {
  firstYear: number;
  typical: number[];
  pessimistic: number[];
}

interface ProjectionChartProps {
  rows: ProjectionChartRow[];
  /**
   * Methods with at least one contributing account; absent methods draw no series, so no flat zero
   * line suggests the household is broke.
   */
  enabledCalculatedMethods: Set<Exclude<ProjectionMethod, 'planned'>>;
  retirementMarkers: RetirementMarker[];
  /** Per-member end-of-life markers, shown only when the post-retirement portion is visible. */
  lifeExpectancyMarkers?: LifeExpectancyMarker[];
  /** Household members for the tooltip's "<First> (age N)" rows. */
  tooltipMembers?: TooltipMember[];
  yScale?: 'linear' | 'log';
  /** Zoom state injected by `useChartZoom`. */
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
  /** Monte Carlo overlay lines drawn over the Planned / TWR lines. */
  mcOverlay?: ProjectionMcOverlay | null;
  /** Representative-run line (solid pre-retirement, dashed after) in the tier `color`. */
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
