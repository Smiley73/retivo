/**
 * QCD → net-taxable IRA RMD split chart on the Balance Projection page. Plots,
 * per GIFT year that carries a gross IRA RMD, one stacked bar = that year's
 * gross traditional-IRA required minimum, split into the part the charitable
 * gift (QCD) covered (tax-free, amber `qcdOffset` token — deliberately NOT
 * the gift chart's pink) and the part that stays
 * taxable (teal `rmdMet` token). RMD years WITHOUT a gift are not plotted
 * (`netTaxableRmdCents` is only stamped in QCD years), so the chart spans the
 * gift window, not the RMD horizon — the aggregate RMD chart covers that; the
 * heading + `(i)` prose state this in plain English. A QCD offsets only
 * the IRA-pool RMD, so this is a separate chart from the aggregate RMD chart
 * (which spans IRA + employer plans) — never a segment folded into it.
 *
 * The bar height equals the gross IRA RMD exactly: the offset slice caps at
 * `min(gift, gross)` per owner, so an excess gift never overshoots the bar.
 * Rows arrive already deflated to the page's display-dollars basis
 * (both slices on the RMD's year-end `basisDeflator`), so the amber
 * column-sum ties to the "RMD covered by QCD" tile and the teal
 * column-sum ties to the "Net taxable IRA RMD" tile.
 *
 * Lazy-imported SVG-engine impl. See `QcdRmdSplitChartInner.tsx`. Mirrors the
 * `RmdChart` stacked-bar precedent.
 */
import React, { Suspense, lazy } from 'react';
import type { TooltipMember } from './tooltip-member';

/** Per-year split-bar row consumed by the QCD-RMD split chart. Single canonical
 *  shape used from the `qcdTotals` memo through props to the inner datum — the
 *  memo maps `buildQcdRows`' `netTaxableRmd` → `netTaxableDollars` at the
 *  boundary, so no `netTaxableRmd` alias travels downstream. Both fields are
 *  already deflated to the page's display-dollars basis by the caller. */
export interface QcdRmdSplitRow {
  readonly year: number;
  /** The part of the gross IRA RMD the gift covered (tax-free, ≥ 0). */
  readonly rmdOffsetDollars: number;
  /** The part of the gross IRA RMD that stays taxable (≥ 0). */
  readonly netTaxableDollars: number;
}

interface Props {
  rows: ReadonlyArray<QcdRmdSplitRow>;
  /** Household members shown in tooltip header — "<First> (age N)". */
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
