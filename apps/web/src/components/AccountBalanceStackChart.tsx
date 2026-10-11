/**
 * Account Balance Stack chart on the Balance Projection page.
 * Stacked-area chart visualizing projected account balances over time.
 *
 * The section wrapper (`balance-projection-page-account-balance-stack`)
 * owns grouping logic (per-tier / per-AccountType / per-account) and
 * passes a flat `series` + `rows` pair. This component is the lazy shell.
 *
 * Lazy-imported SVG-engine impl. See `AccountBalanceStackChartInner.tsx`.
 */
import React, { Suspense, lazy } from 'react';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';
import type {
  AccountBalanceStackBoundary,
  AccountBalanceStackRow,
  AccountBalanceStackSeries,
} from './AccountBalanceStackChartInner';

export type {
  AccountBalanceStackSeries,
  AccountBalanceStackRow,
} from './AccountBalanceStackChartInner';

interface Props {
  rows: AccountBalanceStackRow[];
  series: AccountBalanceStackSeries[];
  /** Household members shown in tooltip header — "<First> (age N)". */
  members?: ReadonlyArray<TooltipMember>;
  /** Retirement + death markers rendered as dashed reference lines. */
  markers?: ReadonlyArray<CashflowChartMarker>;
  /** Dashed actual→projected boundary marker (last actual year). */
  boundary?: AccountBalanceStackBoundary | null;
  /** Zoom-state props injected by useChartZoom in the host section. */
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

const InnerChart = lazy(() => import('./AccountBalanceStackChartInner'));

const ChartFallback: React.FC = () => (
  <div
    role="status"
    aria-busy="true"
    className="flex h-80 items-center justify-center text-sm text-muted"
  >
    Loading account balance chart…
  </div>
);

export const AccountBalanceStackChart: React.FC<Props> = ({
  rows,
  series,
  members,
  markers,
  boundary,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging,
}) => {
  if (rows.length === 0 || series.length === 0) {
    return (
      <p className="m-0 text-sm text-muted">
        No account balance data to chart yet.
      </p>
    );
  }
  return (
    <Suspense fallback={<ChartFallback />}>
      <InnerChart
        rows={rows}
        series={series}
        members={members}
        markers={markers}
        boundary={boundary}
        xDomain={xDomain}
        yDomain={yDomain}
        dragSelection={dragSelection}
        mouseHandlers={mouseHandlers}
        isDragging={isDragging}
      />
    </Suspense>
  );
};
