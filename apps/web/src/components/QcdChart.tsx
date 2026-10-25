/**
 * Per-year bar of the amount given from a traditional IRA to charity; a QCD counts toward the RMD but not taxable
 * income, so it is its own chart. Rows are deflated by the caller; lazy-loads the Inner chart.
 */
import React, { Suspense, lazy } from 'react';
import type { TooltipMember } from './tooltip-member';

/** Per-year QCD-dollars row, already deflated to the display basis. */
export interface QcdChartRow {
  readonly year: number;
  /** Amount given from the IRA to charity that year (dollars, > 0). */
  readonly dollars: number;
}

interface Props {
  rows: ReadonlyArray<QcdChartRow>;
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
