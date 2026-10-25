/** Expenses page "Total expenses" chart section: ExpensesProjectionChart plus zoom state; the tab switcher lives in ExpensesPage.tsx. */
import React, { useCallback, useMemo } from 'react';
import {
  ExpensesProjectionChart,
  type TooltipMember,
} from '../components/ExpensesProjectionChart';
import { ChartZoomReset } from '../components/ChartZoomReset';
import { useChartZoom } from '../lib/use-chart-zoom';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import type { ExpenseProjectionMonthlyPoint } from '../lib/expense-projection';

export interface ExpensesProjectionSectionProps {
  readonly rows: ReadonlyArray<ExpenseProjectionMonthlyPoint>;
  readonly markers: ReadonlyArray<CashflowChartMarker>;
  readonly members: ReadonlyArray<TooltipMember>;
  readonly tabs?: React.ReactNode;
}

export const ExpensesProjectionSection: React.FC<ExpensesProjectionSectionProps> = ({
  rows,
  markers,
  members,
  tabs,
}) => {
  const xDomainFull = useMemo((): [number, number] => {
    if (rows.length === 0) return [0, 0];
    return [
      rows[0].fractionalYear,
      rows[rows.length - 1].fractionalYear,
    ];
  }, [rows]);

  const rowsForY = useMemo(
    () => rows.map((r) => ({ x: r.fractionalYear })),
    [rows],
  );

  const computeY = useCallback(
    (visibleRows: readonly { x: number }[]): [number, number] | null => {
      const xs = new Set(visibleRows.map((r) => r.x));
      const visible = rows.filter((r) => xs.has(r.fractionalYear));
      if (visible.length < 2) return null;
      // Stacked area: the Essential baseline is y = 0, so use the stack-top total for yMax and floor at 0 to avoid clipping the bottom during zoom.
      const yMax = Math.max(...visible.map((r) => r.total));
      if (yMax === 0) return null;
      return [0, yMax];
    },
    [rows],
  );

  const zoom = useChartZoom({ xDomainFull, rowsForY, computeY });

  return (
    <section
      className="mb-4 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm"
      aria-labelledby="expenses-total-heading"
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <h2
          id="expenses-total-heading"
          className="m-0 text-base font-semibold text-ink"
        >
          Total expenses
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <ChartZoomReset isZoomed={zoom.isZoomed} onReset={zoom.reset} />
          {tabs}
        </div>
      </div>
      <ExpensesProjectionChart
        rows={[...rows]}
        markers={[...markers]}
        members={[...members]}
        xDomain={zoom.xDomain}
        yDomain={zoom.yDomain}
        dragSelection={zoom.dragSelection}
        mouseHandlers={zoom.mouseHandlers}
        isDragging={zoom.isDragging}
      />
    </section>
  );
};
