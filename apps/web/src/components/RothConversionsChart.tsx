/**
 * Per-year bar of the amount converted from pre-tax to Roth, shown only here since a conversion is neither income nor
 * a portfolio flow. Rows are deflated by the caller; lazy-loads the Inner chart.
 */
import React, { Suspense, lazy } from 'react';
import type { TooltipMember } from './tooltip-member';

/** Per-year converted-dollars row, already deflated to the display basis. */
export interface RothConversionsChartRow {
  readonly year: number;
  /** Amount converted from pre-tax to Roth that year (dollars, > 0). */
  readonly dollars: number;
}

interface Props {
  rows: ReadonlyArray<RothConversionsChartRow>;
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
