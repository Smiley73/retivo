/**
 * Per-year required minimum distribution split into the amount met and any shortfall (red); pure display over
 * `DrawdownYear`. Lazy-loads `RmdChartInner.tsx`.
 */
import React, { Suspense, lazy } from 'react';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';

export interface RmdChartRow {
  readonly year: number;
  /** RMD met by projected withdrawals (dollars, ≥ 0), the bottom segment. */
  readonly rmdMet: number;
  /** Portion the projection could not fund (dollars, ≥ 0), the top red segment. */
  readonly rmdShortfall: number;
  /**
   * Portion of the met RMD retained rather than spent (dollars, ≥ 0); when > 0 the met band splits
   * into spent and kept.
   */
  readonly rmdRetained: number;
}

interface Props {
  rows: RmdChartRow[];
  members?: ReadonlyArray<TooltipMember>;
  markers?: ReadonlyArray<CashflowChartMarker>;
  /** Zoom state injected by `useChartZoom`. */
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
