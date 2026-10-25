/**
 * Per-gift-year bar splitting the gross IRA RMD into the QCD-covered and taxable parts; separate from the aggregate
 * RMD chart because a QCD offsets only the IRA-pool RMD. Lazy-loads the Inner chart.
 */
import React, { Suspense, lazy } from 'react';
import type { TooltipMember } from './tooltip-member';

/**
 * One split-bar row, already deflated to the display basis; `netTaxableDollars` is mapped from
 * `buildQcdRows`' `netTaxableRmd` at the boundary.
 */
export interface QcdRmdSplitRow {
  readonly year: number;
  /** The part of the gross IRA RMD the gift covered (tax-free, ≥ 0). */
  readonly rmdOffsetDollars: number;
  /** The part of the gross IRA RMD that stays taxable (≥ 0). */
  readonly netTaxableDollars: number;
}

interface Props {
  rows: ReadonlyArray<QcdRmdSplitRow>;
  members?: ReadonlyArray<TooltipMember>;
}

const InnerChart = lazy(() => import('./QcdRmdSplitChartInner'));

const ChartFallback: React.FC = () => (
  <div
    role="status"
    aria-busy="true"
    className="flex h-80 items-center justify-center text-sm text-muted"
  >
    Loading IRA required-withdrawal split chart…
  </div>
);

export const QcdRmdSplitChart: React.FC<Props> = ({ rows, members }) => {
  return (
    <Suspense fallback={<ChartFallback />}>
      <InnerChart rows={rows} members={members} />
    </Suspense>
  );
};
