/**
 * Per-year federal income tax and IRMAA surcharge above zero and the ACA-PTC subsidy below it, for every withdrawal
 * strategy. Lazy-loads `TaxBurdenChartInner.tsx`.
 */
import React, { Suspense, lazy } from 'react';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';

export interface TaxBurdenChartRow {
  readonly year: number;
  /** Federal income tax owed (dollars, ≥ 0). */
  readonly federalTax: number;
  /** IRMAA Medicare surcharge (dollars, ≥ 0). */
  readonly irmaaSurcharge: number;
  /**
   * ACA-PTC subsidy received (dollars), stored negative so the engine renders it below zero, like
   * the Portfolio Flows withdrawals bar.
   */
  readonly acaPtcSubsidy: number;
  /** The ACA credit applied to premiums (dollars, ≥ 0); already inside the `acaPtcSubsidy` bar. */
  readonly acaCreditApplied: number;
  /**
   * Fractional X position; always omitted now, since death is Dec 31 of the terminal year and every
   * bar sits at its integer `year`.
   */
  readonly fractionalYear?: number;
}

interface Props {
  rows: TaxBurdenChartRow[];
  members?: ReadonlyArray<TooltipMember>;
  markers?: ReadonlyArray<CashflowChartMarker>;
  /** Zoom state injected by `useChartZoom`. */
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

const InnerChart = lazy(() => import('./TaxBurdenChartInner'));

const ChartFallback: React.FC = () => (
  <div
    role="status"
    aria-busy="true"
    className="flex h-80 items-center justify-center text-sm text-muted"
  >
    Loading tax burden chart…
  </div>
);

export const TaxBurdenChart: React.FC<Props> = ({
  rows,
  members,
  markers,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging,
}) => {
  if (rows.length === 0) {
    return (
      <p className="m-0 text-sm text-muted">
        No tax data to chart yet.
      </p>
    );
  }
  return (
    <Suspense fallback={<ChartFallback />}>
      <InnerChart
        rows={rows}
        members={members}
        markers={markers}
        xDomain={xDomain}
        yDomain={yDomain}
        dragSelection={dragSelection}
        mouseHandlers={mouseHandlers}
        isDragging={isDragging}
      />
    </Suspense>
  );
};
