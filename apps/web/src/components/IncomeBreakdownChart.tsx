/**
 * Per-year stacked-area breakdown of household income by source, with the portfolio withdrawal on top and a dashed
 * expense overlay. Shares the cashflow band's X axis and death markers.
 */
import React, { Suspense, lazy } from 'react';
import type { TooltipMember } from './tooltip-member';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';

/**
 * Per-month income sample; amounts are annualized run-rates, so the stack steps at the actual claim
 * and start months.
 */
export interface IncomeBreakdownPoint {
  fractionalYear: number;
  year: number;
  month0: number;
  ss: number;
  pensionAnnuity: number;
  partTime: number;
  /** Untargeted one-off windfalls, spendable directly. */
  oneOff: number;
  /**
   * Targeted one-off windfalls and pension lump sums, which flow into the portfolio; sparse spikes.
   */
  portfolioAdd: number;
  /** Drawdown engine's per-year `withdrawn`, broadcast flat across the year's 12 months. */
  withdrawal: number;
  /** Total flow at this month (spendable income, portfolio additions and withdrawal). */
  total: number;
  /** Annualized expense run-rate; drives the overlay line. */
  expenses: number;
}

/**
 * Vertical line at a member's projected end of life; `death` markers carry the integer death year
 * and the inner chart remaps them.
 */
export interface IncomeBreakdownMarker {
  fractionalYear: number;
  label: string;
  color: string;
  kind?: 'death' | 'retirement';
}

interface Props {
  rows: IncomeBreakdownPoint[];
  markers?: IncomeBreakdownMarker[];
  /** First year withdrawal falls below net need; `null` when the portfolio survives. */
  depletionYear?: number | null;
  members?: TooltipMember[];
  /** `'yearly'` drops the month from the tooltip date. Defaults to `'monthly'`. */
  granularity?: 'monthly' | 'yearly';
  /** Zoom state injected by `useChartZoom`. */
  xDomain?: [number, number] | null;
  yDomain?: [number, number] | null;
  dragSelection?: [number, number] | null;
  mouseHandlers?: ChartMouseHandlers;
  isDragging?: boolean;
}

const InnerChart = lazy(() => import('./IncomeBreakdownChartInner'));

const ChartFallback: React.FC = () => (
  <div
    role="status"
    aria-busy="true"
    className="flex h-80 items-center justify-center text-muted"
  >
    Loading income breakdown…
  </div>
);

export const IncomeBreakdownChart: React.FC<Props> = ({
  rows,
  markers,
  depletionYear,
  members,
  granularity = 'monthly',
  xDomain,
  yDomain,
  dragSelection,
  mouseHandlers,
  isDragging,
}) => {
  if (rows.length === 0) {
    return (
      <p className="m-0 text-muted">
        No income rows to chart yet. Add Social Security, a pension, or
        part-time income on the Income page.
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
        xDomain={xDomain}
        yDomain={yDomain}
        dragSelection={dragSelection}
        mouseHandlers={mouseHandlers}
        isDragging={isDragging}
      />
    </Suspense>
  );
};
