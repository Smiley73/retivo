/**
 * Year-by-year portfolio inflows above zero and withdrawals below it, with a net-change line; lazy-loads
 * `PortfolioFlowsChartInner.tsx`.
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
  /**
   * Portfolio withdrawal funding spending (gross draw net of reinvested RMD surplus), negative so
   * it renders below zero.
   */
  withdrawals: number;
  /**
   * Qualified Charitable Distribution outflow, negative so it renders below zero as its own stripe;
   * included in `netChange`.
   */
  qcd: number;
  netChange: number;
  /**
   * Fractional X position; always omitted now, since death is Dec 31 of the terminal year and every
   * bar sits at its integer `year`.
   */
  fractionalYear?: number;
}

interface Props {
  rows: PortfolioFlowsChartRow[];
  markers?: CashflowChartMarker[];
  /**
   * First year withdrawal falls below net need, drawing the dashed depletion marker; null when the
   * portfolio survives.
   */
  depletionYear?: number | null;
  members?: TooltipMember[];
  /** Zoom state injected by `useChartZoom`. */
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
