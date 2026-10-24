/** Per-account history chart section: ending balance and return % stacked line charts. Owns the useChartZoom call so the Reset button stays visible during the lazy-chart Suspense fallback. */
import React, { useCallback, useMemo } from 'react';
import {
  AccountHistoryCharts,
  type AccountHistoryRow,
} from '../components/AccountHistoryCharts';
import { ChartZoomReset } from '../components/ChartZoomReset';
import { useChartZoom } from '../lib/use-chart-zoom';

export interface AccountHistorySectionProps {
  readonly rows: ReadonlyArray<AccountHistoryRow>;
}

export const AccountHistorySection: React.FC<AccountHistorySectionProps> = ({
  rows,
}) => {
  // Hook lives in the section, not the lazy Inner. Sorted once for xDomainFull and rowsForY.
  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.year - b.year),
    [rows],
  );

  const xDomainFull = useMemo((): [number, number] => {
    if (sorted.length === 0) return [0, 0];
    return [sorted[0].year, sorted[sorted.length - 1].year];
  }, [sorted]);

  const rowsForY = useMemo(
    () => sorted.map((r) => ({ x: r.year })),
    [sorted],
  );

  const computeY = useCallback(
    (visibleRows: readonly { x: number }[]): [number, number] | null => {
      const xs = new Set(visibleRows.map((r) => r.x));
      const visible = sorted.filter((r) => xs.has(r.year));
      if (visible.length < 2) return null;
      const vals = visible.map((r) => r.endingBalance);
      const yMin = Math.min(...vals);
      const yMax = Math.max(...vals);
      if (yMin === yMax) return null;
      return [yMin, yMax];
    },
    [sorted],
  );

  const zoom = useChartZoom({ xDomainFull, rowsForY, computeY });

  return (
    <section
      className="mb-4 mt-4 flex flex-col gap-3 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm"
      aria-label="Historical balance and return"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-xl font-semibold text-ink">
          History
        </h2>
        <ChartZoomReset isZoomed={zoom.isZoomed} onReset={zoom.reset} />
      </div>
      <AccountHistoryCharts
        rows={sorted}
        xDomain={zoom.xDomain}
        yDomain={zoom.yDomain}
        dragSelection={zoom.dragSelection}
        mouseHandlers={zoom.mouseHandlers}
        isDragging={zoom.isDragging}
      />
    </section>
  );
};
