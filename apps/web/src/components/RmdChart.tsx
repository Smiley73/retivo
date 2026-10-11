/**
 * Required Minimum Distribution chart on the Balance Projection page.
 * Plots, per RMD year, the required minimum split into the amount MET
 * (bottom segment) and any SHORTFALL (top, red accent) so problem years
 * stand out at a glance. RMD data is already computed on `DrawdownYear`
 * (`rmdFloorCents` / `rmdShortfallCents`); this chart is pure display.
 *
 * Lazy-imported SVG-engine impl. See `RmdChartInner.tsx`.
 */
import React, { Suspense, lazy } from 'react';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';

/** Per-year data row consumed by the RMD chart. */
export interface RmdChartRow {
  readonly year: number;
  /** RMD met by the projected withdrawals (dollars, ≥ 0) — the bottom
   *  stacked segment. Equals `rmdFloor − rmdShortfall`. */
  readonly rmdMet: number;
  /** Portion of the RMD the projection could not fund (dollars, ≥ 0) —
   *  the top stacked segment, painted in the red shortfall accent. */
  readonly rmdShortfall: number;
  /** Portion of the met RMD retained rather than spent (dollars, ≥ 0) —
   *  surplus reinvested into a taxable account plus any held as cash. When
   *  > 0 the met band splits into used-for-spending + surplus (kept). */
  readonly rmdRetained: number;
}

interface Props {
  rows: RmdChartRow[];
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

const InnerChart = lazy(() => import('./RmdChartInner'));

const ChartFallback: React.FC = () => (
  <div
    role="status"
    aria-busy="true"
    className="flex h-80 items-center justify-center text-sm text-muted"
  >
    Loading RMD chart…
  </div>
);

export const RmdChart: React.FC<Props> = ({
  rows,
  members,
  markers,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging,
}) => {
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
