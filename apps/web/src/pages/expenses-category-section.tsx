/**
 * Expenses page — "Expenses by Category" chart section card.
 * Hosts ExpensesCategoryChart + zoom state. Tab switcher lives in
 * ExpensesPage.tsx; only the per-tab body lives here.
 */
import React, { useCallback, useMemo } from 'react';
import { ExpensesCategoryChart } from '../components/ExpensesCategoryChart';
import type { TooltipMember } from '../components/ExpensesProjectionChart';
import { ChartZoomReset } from '../components/ChartZoomReset';
import { useChartZoom } from '../lib/use-chart-zoom';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import type { ExpenseCategoryMonthlyPoint } from '../lib/expense-projection';

export interface ExpensesCategorySectionProps {
  readonly categoryRows: ReadonlyArray<ExpenseCategoryMonthlyPoint>;
  readonly categoryMeta: ReadonlyArray<{ id: string; name: string; color: string }>;
  readonly markers: ReadonlyArray<CashflowChartMarker>;
  readonly members: ReadonlyArray<TooltipMember>;
  readonly tabs?: React.ReactNode;
}

export const ExpensesCategorySection: React.FC<ExpensesCategorySectionProps> = ({
  categoryRows,
  categoryMeta,
  markers,
  members,
  tabs,
}) => {
  const xDomainFull = useMemo((): [number, number] => {
    if (categoryRows.length === 0) return [0, 0];
    return [
      categoryRows[0].fractionalYear,
      categoryRows[categoryRows.length - 1].fractionalYear,
    ];
  }, [categoryRows]);

  const rowsForY = useMemo(
    () => categoryRows.map((r) => ({ x: r.fractionalYear })),
    [categoryRows],
  );

  // Y-range for visible category expense values so the y-axis auto-fits on zoom.
  const computeY = useCallback(
    (visibleRows: readonly { x: number }[]): [number, number] | null => {
      const xs = new Set(visibleRows.map((r) => r.x));
      const visible = categoryRows.filter((r) => xs.has(r.fractionalYear));
      if (visible.length < 2) return null;
      const vals = visible.map((r) => r.total);
      const yMax = Math.max(...vals);
      if (yMax <= 0) return null;
      return [0, yMax];
    },
    [categoryRows],
  );

  const zoom = useChartZoom({ xDomainFull, rowsForY, computeY });

  return (
    <section
      className="mb-4 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm"
      aria-labelledby="expenses-category-heading"
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <h2
          id="expenses-category-heading"
          className="m-0 text-base font-semibold text-ink"
        >
          Expenses by Category
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <ChartZoomReset isZoomed={zoom.isZoomed} onReset={zoom.reset} />
          {tabs}
        </div>
      </div>
      <ExpensesCategoryChart
        rows={[...categoryRows]}
        categories={[...categoryMeta]}
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
