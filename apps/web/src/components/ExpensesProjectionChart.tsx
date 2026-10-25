/**
 * Expenses projection: Essential and Discretionary bands from the retirement year to the last survivor's end of life,
 * in today's dollars; scenario-only `added` / `removed` overrides do not apply here.
 */
import React, { Suspense, lazy } from 'react';
import type { ExpenseProjectionMonthlyPoint } from '../lib/expense-projection';
import type { CashflowChartMarker } from './CashflowProjectionChart';
import type { TooltipMember } from './tooltip-member';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';

export type { TooltipMember };

interface Props {
  rows: ExpenseProjectionMonthlyPoint[];
  markers?: CashflowChartMarker[];
  members?: TooltipMember[];
  /**
   * Renders a single line with this label (the `total` series) instead of the breakdown, e.g.
   * `"This expense"` in the form preview.
   */
  singleSeriesLabel?: string;
  /** Set `false` to disable drag-zoom; default `true`. */
  enableZoom?: boolean;
  /** Zoom state injected by `useChartZoom`. */
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

const InnerChart = lazy(() => import('./ExpensesProjectionChartInner'));

const ChartFallback: React.FC = () => (
  <div
    role="status"
    aria-busy="true"
    className="flex h-80 items-center justify-center text-muted"
  >
    Loading projection chart…
  </div>
);

export const ExpensesProjectionChart: React.FC<Props> = ({
  rows,
  markers,
  members,
  singleSeriesLabel,
  enableZoom = true,
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging,
}) => {
  if (rows.length === 0) {
    return (
      <p className="m-0 text-muted">
        No retirement-year expenses to chart yet.
      </p>
    );
  }
  // Without zoom the Inner chart gets no drag handlers or marquee.
  const zoomProps = enableZoom
    ? { xDomain, yDomain, dragSelection, mouseHandlers, isDragging }
    : {};
  return (
    <Suspense fallback={<ChartFallback />}>
      <InnerChart
        rows={rows}
        markers={markers ?? []}
        members={members ?? []}
        singleSeriesLabel={singleSeriesLabel}
        {...zoomProps}
      />
    </Suspense>
  );
};
