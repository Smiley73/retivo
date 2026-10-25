/**
 * Yearly ending balance and return % line charts for the per-account Balances page; lazy-loads the SVG renderer.
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
  /** Zoom state injected by `useChartZoom`. */
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
