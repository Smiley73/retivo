/**
 * "Portfolio flows" chart on the Balance Projection page. Plots the
 * year-by-year inflows (contributions + investment gains + lump-sum
 * deposits) above zero and withdrawals below zero, with a net-change
 * line overlay. Distinct from the cashflow + income-breakdown bands:
 * those are the household-budget view; this is the portfolio's own
 * "money in / money out" view.
 *
 * Lazy-imported SVG-engine impl. See `PortfolioFlowsChartInner.tsx`.
 */
import React, { Suspense, lazy } from 'react';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';

export interface PortfolioFlowsChartRow {
  year: number;
  contributions: number;
  gains: number;
  deposits: number;
  /** Portfolio withdrawal that funds spending = gross draw net of any
   *  reinvested/held RMD surplus. Negative so the engine renders below zero;
   *  matches the income-breakdown withdrawal. */
  withdrawals: number;
  /** Qualified Charitable Distribution outflow for the year — the charitable
   *  gift directed from a traditional IRA. Negative so the engine renders it
   *  below zero as its own stripe alongside the spending withdrawal; 0 in
   *  non-QCD years. Included in `netChange`. */
  qcd: number;
  netChange: number;
  /** Fractional X position. Always omitted now — death = Dec 31 of
   *  `deathYear` (the terminal year), so every bar (including the
   *  death-year bar) is a full year at its integer `year`; the chart
   *  falls back to `year`. The integer-`deathYear` death marker lands on
   *  the last bar. */
  fractionalYear?: number;
}

interface Props {
  rows: PortfolioFlowsChartRow[];
  markers?: CashflowChartMarker[];
  /** First year withdrawal < net need; drives the dashed depletion
   *  marker. Null when the portfolio survives the horizon. */
  depletionYear?: number | null;
  members?: TooltipMember[];
  /** Zoom-state props injected by useChartZoom in the host section. */
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

const InnerChart = lazy(() => import('./PortfolioFlowsChartInner'));

const ChartFallback: React.FC = () => (
  <div
    role="status"
    aria-busy="true"
    className="flex h-80 items-center justify-center text-muted"
  >
    Loading portfolio flows chart…
  </div>
);

export const PortfolioFlowsChart: React.FC<Props> = ({
  rows,
  markers,
  depletionYear,
  members,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging,
}) => {
  if (rows.length === 0) {
    return (
      <p className="m-0 text-muted">
        No portfolio flows to chart yet.
      </p>
    );
  }
  return (
    <Suspense fallback={<ChartFallback />}>
      <InnerChart
        rows={rows}
        markers={markers ?? []}
        depletionYear={depletionYear ?? null}
        members={members ?? []}
        xDomain={xDomain}
        yDomain={yDomain}
        dragSelection={dragSelection}
        mouseHandlers={mouseHandlers}
        isDragging={isDragging}
      />
    </Suspense>
  );
};
