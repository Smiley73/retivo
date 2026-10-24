/** "Income breakdown" band: stacked income chart and disclaimer. */
import React, { useCallback, useMemo } from 'react';
import {
  IncomeBreakdownChart,
  type IncomeBreakdownPoint,
} from '../components/IncomeBreakdownChart';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import type { CashflowGranularity } from '../lib/view-deflator';
import type { TooltipMember } from '../components/tooltip-member';
import { useChartZoom } from '../lib/use-chart-zoom';
import { ChartZoomReset } from '../components/ChartZoomReset';
import { CARD_SECTION_CLASS } from './balance-projection-page-constants';

const SECTION_H3_CLASS =
  'm-0 text-base font-semibold text-ink';

export interface YearlyIncomeBreakdownBandProps {
  readonly breakdownChartRows: ReadonlyArray<IncomeBreakdownPoint>;
  readonly chartMarkers: ReadonlyArray<CashflowChartMarker>;
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
  readonly depletionYear: number | null;
  readonly incomeBreakdownGranularity: CashflowGranularity;
  readonly onGranularityChange: (g: CashflowGranularity) => void;
  readonly methodLabel: string;
}

export const YearlyIncomeBreakdownBand: React.FC<YearlyIncomeBreakdownBandProps> = ({
  breakdownChartRows,
  chartMarkers,
  tooltipMembers,
  depletionYear,
  incomeBreakdownGranularity,
  onGranularityChange,
  methodLabel,
}) => {
  // Hook lives in the section, not the lazy Inner.
  const xDomainFull = useMemo((): [number, number] => {
    if (breakdownChartRows.length === 0) return [0, 0];
    return [
      breakdownChartRows[0].fractionalYear,
      breakdownChartRows[breakdownChartRows.length - 1].fractionalYear,
    ];
  }, [breakdownChartRows]);

  const rowsForY = useMemo(
    () => breakdownChartRows.map((r) => ({ x: r.fractionalYear })),
    [breakdownChartRows],
  );

  const computeY = useCallback(
    (visibleRows: readonly { x: number }[]): [number, number] | null => {
      const xs = new Set(visibleRows.map((r) => r.x));
      const visible = breakdownChartRows.filter((r) => xs.has(r.fractionalYear));
      if (visible.length < 2) return null;
      // `total` is the stacked sum; `expenses` is the overlay line.
      const vals = visible.flatMap((r) => [r.total, r.expenses]);
      const yMax = Math.max(...vals);
      if (yMax <= 0) return null;
      return [0, yMax];
    },
    [breakdownChartRows],
  );

  const zoom = useChartZoom({ xDomainFull, rowsForY, computeY });

  return (
    <section className={CARD_SECTION_CLASS} aria-label="Income breakdown">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h3 className={SECTION_H3_CLASS}>Income breakdown ({methodLabel})</h3>
          <ChartInfoPopover label="About the Income breakdown chart">
            <p className="m-0">
              Stacked income sources over the same retirement horizon as the
              cashflow band above: Social Security on the bottom, then pension
              annuities, part-time / earned, one-off lump sums, and Portfolio
              withdrawal on top (drawdown engine output under the selected method
              tab above). Compare against the cashflow chart above to see whether
              the income stack reaches each year&apos;s spend.
            </p>
          </ChartInfoPopover>
        </div>
        <div className="report-print-hide flex items-center gap-2">
          <ChartZoomReset isZoomed={zoom.isZoomed} onReset={zoom.reset} />
          <SegmentedRadioGroup<CashflowGranularity>
            size="sm"
            ariaLabel="Income breakdown chart granularity"
            value={incomeBreakdownGranularity}
            onChange={onGranularityChange}
            options={[
              {
                value: 'yearly',
                label: 'Yearly',
                title:
                  'One point per year (December anchor), flat streams read constant and match the year-by-year table.',
              },
              {
                value: 'monthly',
                label: 'Monthly',
                title:
                  'Month-precise detail, intra-year timing, deflated per month.',
              },
            ]}
          />
        </div>
      </div>
      <IncomeBreakdownChart
        rows={breakdownChartRows.map((r) => ({ ...r }))}
        markers={[...chartMarkers]}
        depletionYear={depletionYear}
        members={[...tooltipMembers]}
        granularity={incomeBreakdownGranularity}
        xDomain={zoom.xDomain}
        yDomain={zoom.yDomain}
        dragSelection={zoom.dragSelection}
        mouseHandlers={zoom.mouseHandlers}
        isDragging={zoom.isDragging}
      />
    </section>
  );
};
