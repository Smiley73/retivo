/**
 * Roth conversions chart on the Balance Projection page.
 * Plots, per conversion year, the amount moved from pre-tax savings into
 * a Roth account under the income cap's Fill mode (one bar per year). A
 * conversion is an internal pre-tax → Roth transfer, not income or a
 * portfolio flow, so it is shown only here — never as a
 * Portfolio-Flow / Income-Breakdown series. The series is already
 * deflated to the page's display-dollars basis by the caller, so the
 * bars sum to the adjacent "Total Roth converted" tile.
 *
 * Lazy-imported SVG-engine impl. See `RothConversionsChartInner.tsx`.
 */
import React, { Suspense, lazy } from 'react';
import type { TooltipMember } from './tooltip-member';

/** Per-year converted-dollars row consumed by the Roth conversions chart.
 *  `dollars` is already deflated to the page's display-dollars basis. */
export interface RothConversionsChartRow {
  readonly year: number;
  /** Amount converted from pre-tax to Roth that year (dollars, > 0),
   *  already deflated to the page basis by the caller. */
  readonly dollars: number;
}

interface Props {
  rows: ReadonlyArray<RothConversionsChartRow>;
  /** Household members shown in tooltip header — "<First> (age N)". */
  members?: ReadonlyArray<TooltipMember>;
}

const InnerChart = lazy(() => import('./RothConversionsChartInner'));

const ChartFallback: React.FC = () => (
  <div
    role="status"
    aria-busy="true"
    className="flex h-80 items-center justify-center text-sm text-muted"
  >
    Loading Roth conversions chart…
  </div>
);

export const RothConversionsChart: React.FC<Props> = ({ rows, members }) => {
  return (
    <Suspense fallback={<ChartFallback />}>
      <InnerChart rows={rows} members={members} />
    </Suspense>
  );
};
