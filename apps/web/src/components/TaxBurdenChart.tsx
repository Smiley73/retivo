/**
 * Tax & Health-Cost Burden chart on the Balance Projection page.
 * Plots per-year federal income tax and IRMAA surcharge above zero, and
 * ACA-PTC subsidy below zero (a benefit reducing net cost).
 *
 * Rendered for every named withdrawal strategy — the tax engines run on all of
 * them.
 *
 * Lazy-imported SVG-engine impl. See `TaxBurdenChartInner.tsx`.
 */
import React, { Suspense, lazy } from 'react';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';

/** Per-year data row consumed by the Tax Burden chart. */
export interface TaxBurdenChartRow {
  readonly year: number;
  /** Federal income tax owed (dollars, ≥ 0). */
  readonly federalTax: number;
  /** IRMAA Medicare surcharge (dollars, ≥ 0). */
  readonly irmaaSurcharge: number;
  /**
   * ACA-PTC subsidy received (dollars, stored as a NEGATIVE value so
   * the chart engine renders the bar below zero — benefit convention
   * mirrors the Portfolio Flows "withdrawals" bar).
   */
  readonly acaPtcSubsidy: number;
  /** Fractional X position. Always omitted now — death = Dec 31 of
   *  `deathYear` (the terminal year), so every bar (including the
   *  death-year bar) is a full year at its integer `year`; the chart
   *  falls back to `year`. The integer-`deathYear` death marker lands on
   *  the last bar. */
  readonly fractionalYear?: number;
}

interface Props {
  rows: TaxBurdenChartRow[];
  /** Household members shown in tooltip header — "<First> (age N)". */
  members?: ReadonlyArray<TooltipMember>;
  /** Retirement + death markers rendered as dashed reference lines. */
  markers?: ReadonlyArray<CashflowChartMarker>;
  /** Zoom-state props injected by useChartZoom in the host section. */
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
