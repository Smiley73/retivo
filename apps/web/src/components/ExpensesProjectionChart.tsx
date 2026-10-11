/**
 * Expenses projection chart: two stacked area bands (Essential baseline +
 * Discretionary above, Total implied by combined stack height) from the
 * selected scenario's retirement year through the last surviving member's
 * projected end-of-life.
 *
 * Values are shown in today's dollars (factor 1.0): the page passes
 * `inflation: { ratePct: 0 }` so the chart matches the header totals
 * card above. Underlying expense list is the canonical one —
 * scenario-only `added` / `removed` overrides do NOT apply on this
 * page.
 *
 * Mirrors the cashflow band's death-marker conventions so the two
 * charts feel like siblings: per-member colour-coded vertical dashed
 * reference lines, label stagger when markers sit within 4 fractional
 * years of each other. Death is modelled on Dec 31 of `deathYear` (the
 * integer life-expectancy year); this always-monthly chart maps each
 * death marker to the December sample (`deathYear + 11/12`) — the last
 * monthly data point — so the marker hugs the data with no floating gap.
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
  /** When set, render a single line with this legend / tooltip label
   *  (the `total` series) instead of the Total / Essential /
   *  Discretionary breakdown. The single-expense form preview passes
   *  `"This expense"`; the Expenses list page omits it and keeps the
   *  two stacked-area breakdown (byte-identical — no prop, no change). */
  singleSeriesLabel?: string;
  /** Pass `false` to disable drag-zoom. Single-expense form preview
   *  opts out; the Expenses list page keeps the default `true`. */
  enableZoom?: boolean;
  /** Zoom-state props injected by useChartZoom in the host section. */
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
  // When enableZoom is false (form preview), omit zoom props so the
  // Inner chart has no drag handlers and no marquee.
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
