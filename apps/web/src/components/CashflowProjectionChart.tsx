/**
 * Per-year stacked-area cashflow band: expense stack, total-income overlay line, and a shortfall ribbon where income
 * falls below expenses. Read-only; the drawdown projection that combines these flows lives in `drawdown-engine.ts`.
 */
import React, { Suspense, lazy } from 'react';
import type { TooltipMember } from './tooltip-member';
import type { CategoryMeta } from '../lib/category-palette';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';
import type {
  CashflowChartMarker,
  CashflowMonthlyPoint,
} from '../lib/cashflow-chart-types';

export type { CashflowChartMarker, CashflowMonthlyPoint };

interface Props {
  rows: CashflowMonthlyPoint[];
  markers?: CashflowChartMarker[];
  /**
   * First year withdrawal falls below net need, drawing a dashed reference line; null when the
   * portfolio survives or no method has run.
   */
  depletionYear?: number | null;
  members?: TooltipMember[];
  /** `'yearly'` drops the month from the tooltip date. Defaults to `'monthly'`. */
  granularity?: 'monthly' | 'yearly';
  /**
   * `'total'` (default) renders essential / discretionary bands; `'category'` one band per
   * `categoryMeta` entry.
   */
  expenseMode?: 'total' | 'category';
  /**
   * Active expense categories in alphabetical-by-name order, which the residual allocation follows;
   * empty in Total mode.
   */
  categoryMeta?: ReadonlyArray<CategoryMeta>;
  /** Zoom state injected by `useChartZoom`. */
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

const InnerChart = lazy(() => import('./CashflowProjectionChartInner'));

const ChartFallback: React.FC = () => (
  <div
    role="status"
    aria-busy="true"
    className="flex h-80 items-center justify-center text-muted"
  >
    Loading cashflow band…
  </div>
);

export const CashflowProjectionChart: React.FC<Props> = ({
  rows,
  markers,
  depletionYear,
  members,
  granularity = 'monthly',
  expenseMode = 'total',
  categoryMeta = [],
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging,
}) => {
  if (rows.length === 0) {
    return (
      <p className="m-0 text-muted">
        No expense rows to chart yet. Add expenses on the Expenses page.
      </p>
    );
  }
  return (
    <Suspense fallback={<ChartFallback />}>
      <InnerChart
        rows={rows}
        markers={markers ?? []}
        depletionYear={depletionYear ?? null}
        members={members ?? []}
        granularity={granularity}
        expenseMode={expenseMode}
        categoryMeta={categoryMeta}
        xDomain={xDomain}
        yDomain={yDomain}
        dragSelection={dragSelection}
        mouseHandlers={mouseHandlers}
        isDragging={isDragging}
      />
    </Suspense>
  );
};
