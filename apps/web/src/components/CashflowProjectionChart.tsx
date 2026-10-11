/**
 * Per-year stacked-area cashflow band rendered beneath the Balance
 * Projection chart. Carries three pieces of information for the
 * retirement window:
 *
 *   - **Expense stack** (Essential + Discretionary) — same data the
 *     prior expense-only band rendered.
 *   - **Total-income overlay line** — earned/promised income (SS +
 *     pension annuities + part-time + one-off) PLUS portfolio
 *     withdrawal under the user-selected method, drawn on top of the
 *     stack. In funded years the line tracks the stack top; in
 *     shortfall years it dips below.
 *   - **Shortfall ribbon** — red translucent fill between the income
 *     line and the expense stack top, populated only when total income
 *     < expenses. Combined with the dashed depletion marker, it makes
 *     the unfunded gap unmissable.
 *
 * Read-only chart; the at-retirement balance lines on the chart above
 * are still independent of these flows. The drawdown projection that
 * actually combines them lives in `drawdown-engine.ts` and surfaces in
 * the per-year table on the same page.
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
  /** First year withdrawal < net need under the selected method (i.e.
   *  portfolio depleted). null when the portfolio survives the horizon
   *  or no method has run yet. Renders as a dashed vertical reference
   *  line + label. */
  depletionYear?: number | null;
  /** Household members for the hover tooltip's "<First> (age N)" line. */
  members?: TooltipMember[];
  /** Chart granularity. `'yearly'` (one Dec-anchored point/year) drops
   *  the month from the tooltip date; `'monthly'` keeps `MMM YYYY`.
   *  Defaults to `'monthly'` to preserve the prior behaviour for any
   *  caller that doesn't pass it. */
  granularity?: 'monthly' | 'yearly';
  /** Expense-stack mode. `'total'` (default) renders the
   *  essential/discretionary bands; `'category'` replaces them with one
   *  stacked band per expense category from `categoryMeta`. */
  expenseMode?: 'total' | 'category';
  /** Active expense categories (id / name / palette colour), in the
   *  stable alphabetical-by-name order the residual allocation follows.
   *  Empty in Total mode. */
  categoryMeta?: ReadonlyArray<CategoryMeta>;
  /** Zoom-state props injected by useChartZoom in the host section. */
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
