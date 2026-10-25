/**
 * Stacked spending composition per year with 4% and 4.5% rule lines against the draw layer. The row type lives in
 * `lib/safe-withdrawal-rate-chart-types.ts` because Inner needs it back, which would cycle.
 */
import React, { Suspense, lazy } from 'react';
import type { SwrComparisonYearRow } from '../lib/safe-withdrawal-rate-chart-types';
import type { TooltipMember } from './tooltip-member';

interface Props {
  readonly rows: ReadonlyArray<SwrComparisonYearRow>;
  /**
   * Year the portfolio runs out, or `null` when nothing depletes; not derivable from `rows` alone.
   */
  readonly depletionYear: number | null;
  /** Tooltip header "<First> (age N)"; absent, the tooltip heads with the bare year. */
  readonly members?: ReadonlyArray<TooltipMember>;
}

const InnerChart = lazy(() => import('./SwrCompositionChartInner'));

const ChartFallback: React.FC = () => (
  <div
    role="status"
    aria-busy="true"
    className="flex h-80 items-center justify-center text-sm text-muted"
  >
    Loading spending composition chart…
  </div>
);

export const SwrCompositionChart: React.FC<Props> = ({ rows, depletionYear, members }) => (
  <Suspense fallback={<ChartFallback />}>
    <InnerChart rows={rows} depletionYear={depletionYear} members={members ?? []} />
  </Suspense>
);
