/**
 * "Expenses by Category" stacked chart on the /expenses page. Lazily
 * loads the SVG chart-engine renderer. Same axis / marker conventions as
 * `ExpensesProjectionChart` so the two tabs feel like siblings.
 */
import React, { Suspense, lazy } from 'react';
import type { ExpenseCategoryMonthlyPoint } from '../lib/expense-projection';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';

interface Props {
  rows: ExpenseCategoryMonthlyPoint[];
  /** Display metadata for each categoryId that has non-zero data in
   *  the chart range. Order = stack order, bottom → top. */
  categories: ReadonlyArray<{ id: string; name: string; color: string }>;
  markers?: CashflowChartMarker[];
  members?: TooltipMember[];
  /** Zoom-state props injected by useChartZoom in the host section. */
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

const InnerChart = lazy(() => import('./ExpensesCategoryChartInner'));

const ChartFallback: React.FC = () => (
  <div
    role="status"
    aria-busy="true"
    className="flex h-80 items-center justify-center text-muted"
  >
    Loading category chart…
  </div>
);

export const ExpensesCategoryChart: React.FC<Props> = ({
  rows,
  categories,
  markers,
  members,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging,
}) => {
  if (rows.length === 0 || categories.length === 0) {
    return (
      <p className="m-0 text-muted">
        No retirement-year expenses to chart yet.
      </p>
    );
  }
  return (
    <Suspense fallback={<ChartFallback />}>
      <InnerChart
        rows={rows}
        categories={categories}
        markers={markers ?? []}
        members={members ?? []}
        xDomain={xDomain}
        yDomain={yDomain}
        dragSelection={dragSelection}
        mouseHandlers={mouseHandlers}
        isDragging={isDragging}
      />
    </Suspense>
  );
};
