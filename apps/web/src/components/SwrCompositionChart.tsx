/**
 * Balance Projection page — spending composition chart.
 *
 * Draws each plotted year's spending as a stack of up to four layers,
 * bottom to top: guaranteed income (Social Security + pensions), other
 * income (part-time / one-off, when present), the after-tax portfolio
 * draw, and the tax that draw funds — with the 4% and 4.5% safe-
 * withdrawal-rate rule lines drawn from the axis over the same frame,
 * compared against the after-tax draw layer alone. Each line plots
 * the value its own row carries: level under Today's-dollars, rising with
 * inflation under Future-dollars, where the layers beside it are nominal
 * too (the rows hold the rule flat in REAL terms — see `*Inner.tsx`).
 *
 * Lazy-imported SVG-engine impl, following the `*.tsx` / `*Inner.tsx`
 * chart precedent. The row shape lives in
 * `lib/safe-withdrawal-rate-chart-types.ts` (`SwrComparisonYearRow`),
 * not here — this wrapper
 * `lazy()`-imports Inner (a real runtime edge) and Inner needs the row type
 * back, which would otherwise cycle.
 *
 * This component computes nothing; it is mounted by
 * `pages/balance-projection-page-swr.tsx`.
 */
import React, { Suspense, lazy } from 'react';
import type { SwrComparisonYearRow } from '../lib/safe-withdrawal-rate-chart-types';
import type { TooltipMember } from './tooltip-member';

export type { SwrComparisonYearRow };

interface Props {
  readonly rows: ReadonlyArray<SwrComparisonYearRow>;
  /** Year the portfolio runs out, or `null` when nothing depletes. Not
   *  derivable from `rows` alone — carried through from the resolved
   *  drawdown/representative run (`SwrComparisonBundle.depletionYear`). */
  readonly depletionYear: number | null;
  /** "<First> (age N)" tooltip header line, wired through by `03`; absent
   *  the tooltip heads with the bare year. */
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
