/**
 * Two stacked line charts rendered at the bottom of the per-account
 * Balances page: yearly ending balance and yearly return %.
 *
 * Lazy-imports the SVG chart-engine renderer (mirrors `ProjectionChart`)
 * so the bundle stays out of the auth + dashboard critical path. A single
 * point of data still renders — the engine shows the point, just no line —
 * so the user sees something the moment they enter their first year.
 */
import React, { Suspense, lazy, useMemo } from 'react';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';

export interface AccountHistoryRow {
  year: number;
  endingBalance: number;
  returnPct: number;
}

interface Props {
  rows: AccountHistoryRow[];
  /** Zoom-state props injected by useChartZoom in the host section. */
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

const InnerCharts = lazy(() => import('./AccountHistoryChartsInner'));

function chartFallback(): React.ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex h-64 items-center justify-center text-muted"
    >
      Loading charts…
    </div>
  );
}

export const AccountHistoryCharts: React.FC<Props> = ({
  rows,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging,
}) => {
  const data = useMemo(
    () => [...rows].sort((a, b) => a.year - b.year),
    [rows],
  );
  if (data.length === 0) {
    return (
      <p className="m-0 text-muted">
        No history to chart yet.
      </p>
    );
  }
  return (
    <Suspense fallback={chartFallback()}>
      <InnerCharts
        rows={data}
        xDomain={xDomain}
        yDomain={yDomain}
        dragSelection={dragSelection}
        mouseHandlers={mouseHandlers}
        isDragging={isDragging}
      />
    </Suspense>
  );
};
