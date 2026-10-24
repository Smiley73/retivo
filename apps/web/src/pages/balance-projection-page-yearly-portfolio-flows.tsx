/** "Annual Portfolio Flow" band: portfolio flows chart and disclaimer. */
import React, { useCallback, useMemo } from 'react';
import { PortfolioFlowsChart } from '../components/PortfolioFlowsChart';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import type { TooltipMember } from '../components/tooltip-member';
import { useChartZoom } from '../lib/use-chart-zoom';
import { ChartZoomReset } from '../components/ChartZoomReset';
import { CARD_SECTION_CLASS } from './balance-projection-page-constants';

const SECTION_H3_CLASS =
  'm-0 text-base font-semibold text-ink';


export interface YearlyPortfolioFlowsBandProps {
  readonly portfolioFlowsRows: ReadonlyArray<{
    readonly year: number;
    readonly contributions: number;
    readonly gains: number;
    readonly deposits: number;
    readonly withdrawals: number;
    readonly qcd: number;
    readonly netChange: number;
    readonly fractionalYear?: number;
  }>;
  readonly chartMarkers: ReadonlyArray<CashflowChartMarker>;
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
  readonly depletionYear: number | null;
  readonly methodLabel: string;
}

export const YearlyPortfolioFlowsBand: React.FC<YearlyPortfolioFlowsBandProps> = ({
  portfolioFlowsRows,
  chartMarkers,
  tooltipMembers,
  depletionYear,
  methodLabel,
}) => {
  // Hook lives in the section, not the lazy Inner.
  const xDomainFull = useMemo((): [number, number] => {
    if (portfolioFlowsRows.length === 0) return [0, 0];
    return [
      portfolioFlowsRows[0].year,
      portfolioFlowsRows[portfolioFlowsRows.length - 1].year,
    ];
  }, [portfolioFlowsRows]);

  const rowsForY = useMemo(
    () => portfolioFlowsRows.map((r) => ({ x: r.year })),
    [portfolioFlowsRows],
  );

  const computeY = useCallback(
    (visibleRows: readonly { x: number }[]): [number, number] | null => {
      const xs = new Set(visibleRows.map((r) => r.x));
      const visible = portfolioFlowsRows.filter((r) => xs.has(r.year));
      if (visible.length < 2) return null;
      // Withdrawals are already negative; include 0 as baseline so the withdrawal bar never gets a positive lower bound.
      const vals = visible.flatMap((r) => [
        r.contributions, r.gains, r.deposits, r.withdrawals, r.qcd, r.netChange,
      ]);
      const yMin = Math.min(0, ...vals);
      const yMax = Math.max(0, ...vals);
      if (yMin === yMax) return null;
      return [yMin, yMax];
    },
    [portfolioFlowsRows],
  );

  const zoom = useChartZoom({ xDomainFull, rowsForY, computeY });

  return (
    <section className={CARD_SECTION_CLASS} aria-label="Annual Portfolio Flow">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h3 className={SECTION_H3_CLASS}>
            Annual Portfolio Flow ({methodLabel})
          </h3>
          <ChartInfoPopover label="About the Annual Portfolio Flow chart">
            <p className="m-0">
              The portfolio&apos;s own money-in / money-out view, distinct from
              the household-budget bands above. Above the zero line: yearly
              contributions you&apos;re still adding (pre-retirement), investment
              gains under the selected method tab, and lump-sum income deposits
              (pension lump sums + one-off windfalls routed to accounts). Below
              the zero line: the portfolio withdrawal that funds your retirement
              spend — the actual cash drawn from your invested accounts. This can
              be a little different from the year-by-year table&apos;s Withdrawal
              (your budgeted need for the year) because the draw happens month by month and the
              timing doesn&apos;t line up exactly with the annual budget; it still
              counts once and isn&apos;t added back anywhere. A separate
              below-zero stripe shows any Qualified Charitable Distribution
              (QCD) — a charitable gift sent straight from a traditional IRA.
              That money leaves the portfolio for the charity, so it&apos;s its
              own outflow (not part of the spending withdrawal) and is included
              in net change. A required minimum
              distribution that forces out more than you spend isn&apos;t shown
              here — that excess just moves to a taxable account (or cash) and
              stays in the portfolio, so it nets to zero; the Required Minimum
              Distributions chart below covers it. The line is net change: above
              zero the portfolio is growing, below zero it&apos;s shrinking.
            </p>
          </ChartInfoPopover>
        </div>
        <span className="report-print-hide">
          <ChartZoomReset isZoomed={zoom.isZoomed} onReset={zoom.reset} />
        </span>
      </div>
      <PortfolioFlowsChart
        rows={[...portfolioFlowsRows]}
        markers={[...chartMarkers]}
        depletionYear={depletionYear}
        members={[...tooltipMembers]}
        xDomain={zoom.xDomain}
        yDomain={zoom.yDomain}
        dragSelection={zoom.dragSelection}
        mouseHandlers={zoom.mouseHandlers}
        isDragging={zoom.isDragging}
      />
    </section>
  );
};
