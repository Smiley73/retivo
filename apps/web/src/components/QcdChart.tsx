/**
 * Qualified Charitable Distributions (QCD) chart on the Balance Projection
 * page. Plots, per year, the amount given directly from a traditional IRA to
 * charity (one bar per year). A QCD counts toward the required minimum
 * withdrawal but is left out of taxable income, so it is shown here
 * as its own single-series chart — never folded into a Portfolio-Flow /
 * Income-Breakdown series. The series is already deflated to the page's
 * display-dollars basis by the caller, so the bars sum to the adjacent "QCD
 * distributed" tile.
 *
 * Lazy-imported SVG-engine impl. See `QcdChartInner.tsx`. Mirrors the
 * `RothConversionsChart` precedent exactly.
 */
import React, { Suspense, lazy } from 'react';
import type { TooltipMember } from './tooltip-member';

/** Per-year QCD-dollars row consumed by the charitable-distributions chart.
 *  `dollars` is already deflated to the page's display-dollars basis. */
export interface QcdChartRow {
  readonly year: number;
  /** Amount given directly from the IRA to charity that year (dollars, > 0),
   *  already deflated to the page basis by the caller. */
  readonly dollars: number;
}

interface Props {
  rows: ReadonlyArray<QcdChartRow>;
  /** Household members shown in tooltip header — "<First> (age N)". */
  members?: ReadonlyArray<TooltipMember>;
}

const InnerChart = lazy(() => import('./QcdChartInner'));

const ChartFallback: React.FC = () => (
  <div
    role="status"
    aria-busy="true"
    className="flex h-80 items-center justify-center text-sm text-muted"
  >
    Loading charitable distributions chart…
  </div>
);

export const QcdChart: React.FC<Props> = ({ rows, members }) => {
  return (
    <Suspense fallback={<ChartFallback />}>
      <InnerChart rows={rows} members={members} />
    </Suspense>
  );
};
