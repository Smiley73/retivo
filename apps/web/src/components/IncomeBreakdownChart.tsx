/**
 * Per-year stacked-area income breakdown rendered beneath the cashflow
 * band on the Balance Projection page. Splits the household's gross
 * income into five sources so the user can see the shape of each:
 *
 *   - **Social Security** — combined primary + secondary household
 *     SS benefit per year (already incorporates spousal / survivor
 *     floors).
 *   - **Pension annuity** — every IncomeStream of kind=pension,
 *     payoutType=annuity, including J&S survivor reductions.
 *   - **Part-time / earned** — every kind=partTime stream.
 *   - **One-off / spendable** — sparse spikes from untargeted oneOff
 *     windfalls that fund spending directly (no `targetAccountId`).
 *   - **Portfolio additions** — sparse spikes from targeted oneOff
 *     windfalls + pension lump-sum payouts. These flow into the
 *     portfolio rather than offsetting net-need, so they sit on their
 *     own stripe.
 *   - **Portfolio withdrawal** — drawdown engine's per-year `withdrawn`
 *     under the user-selected Income method, stacked on top in a neutral
 *     slate fill so it reads as "the leftover, sourced from savings."
 *
 * A dashed expense overlay line plots `essential + discretionary` total
 * for the year, so the eye can confirm at a glance whether the stack
 * reaches the household's spend.
 *
 * Same X axis as the cashflow band above (5-year ticks, retirement →
 * `lastDeathYear`) and the same colour-coded death markers, so the two
 * charts read as a vertical stack.
 */
import React, { Suspense, lazy } from 'react';
import type { TooltipMember } from './tooltip-member';
import type { ChartMouseHandlers } from '../lib/use-chart-zoom';

/** Per-month income breakdown sample. Amounts are annualized run-rates
 *  ($/yr at that month), so the stack steps up/down at the actual SS
 *  claim month, pension start month, etc. */
export interface IncomeBreakdownPoint {
  fractionalYear: number;
  year: number;
  month0: number;
  ss: number;
  pensionAnnuity: number;
  partTime: number;
  /** Untargeted oneOff windfalls — spendable income that funds
   *  net-need directly. */
  oneOff: number;
  /** **Portfolio additions** — targeted oneOff windfalls + pension
   *  lump-sum payouts. Rendered as its own stripe.
   *  Sparse spikes only — most months are 0. */
  portfolioAdd: number;
  /** Drawdown engine's per-year `withdrawn` under the selected method,
   *  broadcast as a flat run-rate across all 12 months of each year. */
  withdrawal: number;
  /** Total flow at this month (spendable income + portfolio additions
   *  + withdrawal). The chart stacks the six sources. */
  total: number;
  /** Annualized expense run-rate at this month — drives the expense
   *  overlay line. */
  expenses: number;
}

/** Vertical reference line at a household member's projected
 *  end-of-life. Same shape as the cashflow chart's death marker so the
 *  same array can feed both. `kind: 'death'` markers are the integer
 *  death year (death = Dec 31 of `deathYear`) and the inner chart
 *  remaps them to the terminal data point per granularity. */
export interface IncomeBreakdownMarker {
  fractionalYear: number;
  label: string;
  color: string;
  kind?: 'death' | 'retirement';
}

interface Props {
  rows: IncomeBreakdownPoint[];
  markers?: IncomeBreakdownMarker[];
  /** First year withdrawal < net need under the selected method (null
   *  when the portfolio survives). Renders as a dashed vertical
   *  reference line on the chart. */
  depletionYear?: number | null;
  /** Household members for the hover tooltip's "<First> (age N)" line. */
  members?: TooltipMember[];
  /** Chart granularity. `'yearly'` (one Dec-anchored point/year) drops
   *  the month from the tooltip date; `'monthly'` keeps `MMM YYYY`.
   *  Defaults to `'monthly'` to preserve the prior behaviour for any
   *  caller that doesn't pass it. */
  granularity?: 'monthly' | 'yearly';
  /** Zoom-state props injected by useChartZoom in the host section. */
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
